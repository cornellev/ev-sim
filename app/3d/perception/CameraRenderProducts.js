import * as THREE from "three";

import { perceptionMetadataFromObject } from "../../autonomy/PerceptionTruthIndex.js";
import { getWebGL2Context, PixelPackSlot, withPixelPackBufferUnbound } from "../util/glReadback.js";

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function distortNormalizedPoint(point, distortion = []) {
    const x = finite(point?.x);
    const y = finite(point?.y);
    const [k1 = 0, k2 = 0, p1 = 0, p2 = 0, k3 = 0, k4 = 0, k5 = 0, k6 = 0] = distortion;
    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const radialNumerator = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const radialDenominator = 1 + k4 * r2 + k5 * r4 + k6 * r6;
    const radial = Math.abs(radialDenominator) > Number.EPSILON
        ? radialNumerator / radialDenominator
        : radialNumerator;
    return {
        x: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
        y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y,
    };
}

export function undistortNormalizedPoint(point, distortion = [], iterations = 8) {
    const target = { x: finite(point?.x), y: finite(point?.y) };
    let estimate = { ...target };
    for (let index = 0; index < iterations; index += 1) {
        const projected = distortNormalizedPoint(estimate, distortion);
        estimate.x += target.x - projected.x;
        estimate.y += target.y - projected.y;
    }
    return estimate;
}

export function distortPixel(point, intrinsics, distortion = []) {
    const fx = finite(intrinsics?.fx, 1);
    const fy = finite(intrinsics?.fy, 1);
    const cx = finite(intrinsics?.cx);
    const cy = finite(intrinsics?.cy);
    const normalized = distortNormalizedPoint({
        x: (finite(point?.x) - cx) / fx,
        y: (finite(point?.y) - cy) / fy,
    }, distortion);
    return { x: normalized.x * fx + cx, y: normalized.y * fy + cy };
}

function sampleNearest(data, width, height, channels, x, y, channel) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(y)));
    return data[(sy * width + sx) * channels + channel];
}

function sampleLinear(data, width, height, channels, x, y, channel) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = x - Math.floor(x);
    const ty = y - Math.floor(y);
    const a = data[(y0 * width + x0) * channels + channel];
    const b = data[(y0 * width + x1) * channels + channel];
    const c = data[(y1 * width + x0) * channels + channel];
    const d = data[(y1 * width + x1) * channels + channel];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Applies a Brown-Conrady warp. Destination pixels are inverse-mapped so RGB
 * can interpolate while depth and integer labels remain discontinuity-safe.
 */
export function warpBrownConrady({
    data,
    width,
    height,
    intrinsics,
    distortion = [],
    channels = 1,
    interpolation = "nearest",
    output = null,
}) {
    if (!data || distortion.every((value) => Number(value) === 0)) return data;
    const dest = output && output.length >= data.length
        ? output
        : new data.constructor(data.length);
    if (dest === data) {
        throw new Error("warpBrownConrady requires a separate output buffer.");
    }
    dest.fill?.(0);
    if (!dest.fill) {
        for (let index = 0; index < dest.length; index += 1) dest[index] = 0;
    }
    const fx = finite(intrinsics?.fx, 1);
    const fy = finite(intrinsics?.fy, 1);
    const cx = finite(intrinsics?.cx);
    const cy = finite(intrinsics?.cy);
    const sampler = interpolation === "linear" ? sampleLinear : sampleNearest;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sourceNormalized = undistortNormalizedPoint({
                x: (x - cx) / fx,
                y: (y - cy) / fy,
            }, distortion);
            const sourceX = sourceNormalized.x * fx + cx;
            const sourceY = sourceNormalized.y * fy + cy;
            if (sourceX < 0 || sourceX > width - 1 || sourceY < 0 || sourceY > height - 1) continue;
            for (let channel = 0; channel < channels; channel += 1) {
                const value = sampler(data, width, height, channels, sourceX, sourceY, channel);
                dest[(y * width + x) * channels + channel] = interpolation === "linear"
                    ? Math.round(value)
                    : value;
            }
        }
    }
    return dest;
}

export function flipRows(data, width, height, channels = 1, output = new data.constructor(data.length)) {
    const rowLength = width * channels;
    if (output === data) {
        throw new Error("flipRows requires a separate output buffer.");
    }
    for (let row = 0; row < height; row += 1) {
        output.set(
            data.subarray((height - row - 1) * rowLength, (height - row) * rowLength),
            row * rowLength,
        );
    }
    return output;
}

export function unpackRgbDepth(r, g, b, a) {
    const downscale = 255 / 256;
    return r * downscale / (256 ** 3)
        + g * downscale / (256 ** 2)
        + b * downscale / 256
        + a * downscale;
}

export function rgbaDepthToMetric(rgba, width, height, near, far, {
    flipScratch = null,
    output = null,
} = {}) {
    const flipped = flipRows(
        rgba,
        width,
        height,
        4,
        flipScratch && flipScratch.length >= rgba.length ? flipScratch : undefined,
    );
    const dest = output && output.length >= width * height
        ? output
        : new Float32Array(width * height);
    for (let index = 0; index < dest.length; index += 1) {
        const offset = index * 4;
        const depth = unpackRgbDepth(
            flipped[offset] / 255,
            flipped[offset + 1] / 255,
            flipped[offset + 2] / 255,
            flipped[offset + 3] / 255,
        );
        if (depth >= 1 - 1e-7) {
            dest[index] = Number.NaN;
            continue;
        }
        const viewZ = near * far / ((far - near) * depth - far);
        dest[index] = -viewZ;
    }
    return dest;
}

function packedMaterial(value, bytes) {
    const id = Number(value) >>> 0;
    const channels = [
        (id & 0xff) / 255,
        ((id >>> 8) & 0xff) / 255,
        bytes > 2 ? ((id >>> 16) & 0xff) / 255 : 0,
        bytes > 3 ? ((id >>> 24) & 0xff) / 255 : 1,
    ];
    return new THREE.ShaderMaterial({
        uniforms: { packedValue: { value: new THREE.Vector4(...channels) } },
        vertexShader: "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "uniform vec4 packedValue; void main() { gl_FragColor = packedValue; }",
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
        toneMapped: false,
    });
}

function decodePackedIds(rgba, width, height, bytes, ArrayType, {
    flipScratch = null,
    output = null,
} = {}) {
    const flipped = flipRows(
        rgba,
        width,
        height,
        4,
        flipScratch && flipScratch.length >= rgba.length ? flipScratch : undefined,
    );
    const dest = output && output.length >= width * height
        ? output
        : new ArrayType(width * height);
    for (let index = 0; index < dest.length; index += 1) {
        const offset = index * 4;
        let value = flipped[offset] | (flipped[offset + 1] << 8);
        if (bytes > 2) value |= flipped[offset + 2] << 16;
        if (bytes > 3) value = (value | (flipped[offset + 3] << 24)) >>> 0;
        dest[index] = value;
    }
    return dest;
}

function isRenderable(object) {
    return Boolean(object?.isMesh || object?.isLine || object?.isPoints || object?.isSprite);
}

function shouldExcludeFromSensorView(object, mode) {
    if (!object) return false;
    if (object.isSparkRenderer || object.constructor?.name === "SparkRenderer") return true;
    if (object.userData?.autonomyOverlay) return true;
    if (mode === "rgb" && object.isMesh && object.userData?.bakeIgnore) return true;
    return false;
}

export class CameraRenderProducts {
    constructor({ renderer, scene, camera, width, height, near = 0.1, far = 200 } = {}) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.width = width;
        this.height = height;
        this.near = near;
        this.far = far;
        this.target = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
        });
        this.target.texture.colorSpace = THREE.SRGBColorSpace;
        this.pixelBuffer = new Uint8Array(width * height * 4);
        this.flipBuffer = new Uint8Array(width * height * 4);
        this.depthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            side: THREE.DoubleSide,
        });
        this.materials = new Map();
        this._slots = Object.create(null);
        this._inflight = null;
        this._asyncDisabled = false;
        this._depthScratch = new Float32Array(width * height);
        this._semanticScratch = new Uint16Array(width * height);
        this._instanceScratch = new Uint32Array(width * height);
        this._decodeFlipScratch = new Uint8Array(width * height * 4);
    }

    _ensureSlot(key) {
        if (this._asyncDisabled) return null;
        const gl = getWebGL2Context(this.renderer);
        if (!gl) return null;
        const byteLength = this.width * this.height * 4;
        const existing = this._slots[key];
        if (existing && existing.pack.byteLength === byteLength) return existing;
        existing?.pack?.dispose?.();
        this._slots[key] = {
            pack: new PixelPackSlot(gl, byteLength),
            cpu: new Uint8Array(byteLength),
        };
        return this._slots[key];
    }

    get pending() {
        return Boolean(this._inflight);
    }

    get usesAsyncReadback() {
        return !this._asyncDisabled && Boolean(getWebGL2Context(this.renderer));
    }

    _readPixels() {
        withPixelPackBufferUnbound(this.renderer, () => this.renderer.readRenderTargetPixels(
            this.target, 0, 0, this.width, this.height, this.pixelBuffer,
        ));
        return this.pixelBuffer;
    }

    _render({ mode = "rgb", pack = null } = {}) {
        const previousTarget = this.renderer.getRenderTarget();
        const previousBackground = this.scene.background;
        const previousColorSpace = this.target.texture.colorSpace;
        const previousClearColor = new THREE.Color();
        this.renderer.getClearColor(previousClearColor);
        const previousClearAlpha = this.renderer.getClearAlpha();
        const states = [];
        try {
            this.renderer.setRenderTarget(this.target);
            if (mode === "rgb") {
                this.target.texture.colorSpace = THREE.SRGBColorSpace;
                if (!this.scene.background) {
                    this.renderer.setClearColor(0x8fb4d4, 1);
                }
                this.scene.traverse((object) => {
                    if (!shouldExcludeFromSensorView(object, mode) || object.visible === false) return;
                    states.push({ object, visible: object.visible });
                    object.visible = false;
                });
            } else {
                this.target.texture.colorSpace = THREE.NoColorSpace;
                this.scene.background = null;
                this.renderer.setClearColor(0x000000, 0);
                const usedMaterials = new Set();
                this.scene.traverse((object) => {
                    if (shouldExcludeFromSensorView(object, mode) && object.visible) {
                        states.push({
                            object,
                            visible: object.visible,
                            material: object.material,
                            castShadow: object.castShadow,
                            receiveShadow: object.receiveShadow,
                        });
                        object.visible = false;
                        return;
                    }
                    if (!isRenderable(object)) return;
                    states.push({
                        object,
                        visible: object.visible,
                        material: object.material,
                        castShadow: object.castShadow,
                        receiveShadow: object.receiveShadow,
                    });
                    if (!object.isMesh || object.userData?.bakeIgnore) {
                        object.visible = false;
                        return;
                    }
                    const metadata = perceptionMetadataFromObject(object);
                    const value = mode === "semantic" ? metadata?.semanticId || 0 : metadata?.instanceId || 0;
                    const bytes = mode === "semantic" ? 2 : 4;
                    const key = `${mode}:${value}`;
                    if (!this.materials.has(key)) this.materials.set(key, packedMaterial(value, bytes));
                    usedMaterials.add(key);
                    object.material = mode === "depth" ? this.depthMaterial : this.materials.get(key);
                    object.castShadow = false;
                    object.receiveShadow = false;
                });
                if (mode === "semantic" || mode === "instance") {
                    this._pruneMaterials(usedMaterials, mode);
                }
            }
            this.renderer.clear?.();
            this.renderer.render(this.scene, this.camera);
            if (pack) {
                const gl = pack.gl;
                pack.begin(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE);
                return null;
            }
            return this._readPixels();
        } finally {
            for (const state of states) {
                state.object.visible = state.visible;
                if (state.material !== undefined) {
                    state.object.material = state.material;
                    state.object.castShadow = state.castShadow;
                    state.object.receiveShadow = state.receiveShadow;
                }
            }
            this.scene.background = previousBackground;
            this.target.texture.colorSpace = previousColorSpace;
            this.renderer.setClearColor(previousClearColor, previousClearAlpha);
            this.renderer.setRenderTarget(previousTarget);
        }
    }

    _pruneMaterials(usedKeys, modePrefix) {
        for (const [key, material] of [...this.materials.entries()]) {
            if (!key.startsWith(`${modePrefix}:`)) continue;
            if (usedKeys.has(key)) continue;
            material.dispose?.();
            this.materials.delete(key);
        }
    }

    _decodeProduct(key, rgba) {
        if (key === "rgb") return flipRows(rgba, this.width, this.height, 4, this.flipBuffer);
        if (key === "depth") {
            return rgbaDepthToMetric(rgba, this.width, this.height, this.near, this.far, {
                flipScratch: this._decodeFlipScratch,
                output: this._depthScratch,
            });
        }
        if (key === "semantic") {
            return decodePackedIds(rgba, this.width, this.height, 2, Uint16Array, {
                flipScratch: this._decodeFlipScratch,
                output: this._semanticScratch,
            });
        }
        if (key === "instance") {
            return decodePackedIds(rgba, this.width, this.height, 4, Uint32Array, {
                flipScratch: this._decodeFlipScratch,
                output: this._instanceScratch,
            });
        }
        return rgba;
    }

    poll() {
        if (!this._inflight) return null;
        for (const key of this._inflight) {
            const slot = this._slots[key];
            if (!slot?.pack.poll(slot.cpu)) {
                if (slot?.pack?.isStale?.()) {
                    slot.pack.reset?.();
                    this._inflight = null;
                }
                return null;
            }
        }
        const result = {};
        for (const key of this._inflight) {
            result[key] = this._decodeProduct(key, this._slots[key].cpu);
        }
        this._inflight = null;
        return result;
    }

    submit(products = {}) {
        if (this._inflight) return false;
        const keys = ["rgb", "depth", "semantic", "instance"].filter((key) => products[key]);
        if (keys.length === 0) return true;
        const gl = getWebGL2Context(this.renderer);
        if (!gl) return false;
        for (const key of keys) {
            const slot = this._ensureSlot(key);
            if (!slot) return false;
            try {
                this._render({ mode: key, pack: slot.pack });
            } catch {
                this._asyncDisabled = true;
                slot.pack.dispose();
                delete this._slots[key];
                return false;
            }
        }
        this._inflight = keys;
        return true;
    }

    capture(products = {}) {
        if (!this.usesAsyncReadback) return this._captureSync(products);
        if (this._inflight) {
            const polled = this.poll();
            if (!polled) return null;
            this.submit(products);
            return polled;
        }
        this.submit(products);
        return {};
    }

    _captureSync(products = {}) {
        const result = {};
        if (products.rgb) result.rgb = flipRows(this._render({ mode: "rgb" }), this.width, this.height, 4, this.flipBuffer);
        if (products.depth) {
            result.depth = rgbaDepthToMetric(
                this._render({ mode: "depth" }), this.width, this.height, this.near, this.far, {
                    flipScratch: this._decodeFlipScratch,
                    output: this._depthScratch,
                },
            );
        }
        if (products.semantic) {
            result.semantic = decodePackedIds(
                this._render({ mode: "semantic" }), this.width, this.height, 2, Uint16Array, {
                    flipScratch: this._decodeFlipScratch,
                    output: this._semanticScratch,
                },
            );
        }
        if (products.instance) {
            result.instance = decodePackedIds(
                this._render({ mode: "instance" }), this.width, this.height, 4, Uint32Array, {
                    flipScratch: this._decodeFlipScratch,
                    output: this._instanceScratch,
                },
            );
        }
        return result;
    }

    dispose() {
        this.target?.dispose?.();
        this.depthMaterial?.dispose?.();
        for (const material of this.materials.values()) material.dispose?.();
        this.materials.clear();
        for (const slot of Object.values(this._slots)) slot.pack?.dispose?.();
        this._slots = Object.create(null);
        this._inflight = null;
        this.pixelBuffer = null;
        this.flipBuffer = null;
        this._depthScratch = null;
        this._semanticScratch = null;
        this._instanceScratch = null;
        this._decodeFlipScratch = null;
        this._asyncDisabled = false;
    }
}

export function projectTruthBoundsToImage(records, camera, width, height) {
    const projected = [];
    for (const record of records || []) {
        const bounds = record.worldBounds;
        if (!bounds) continue;
        const pixels = [];
        for (const x of [bounds.min.x, bounds.max.x]) {
            for (const y of [bounds.min.y, bounds.max.y]) {
                for (const z of [bounds.min.z, bounds.max.z]) {
                    const point = new THREE.Vector3(x, z, y).project(camera);
                    if (point.z < -1 || point.z > 1) continue;
                    pixels.push({
                        x: (point.x + 1) * 0.5 * width,
                        y: (1 - point.y) * 0.5 * height,
                    });
                }
            }
        }
        if (!pixels.length) continue;
        const minX = Math.max(0, Math.min(...pixels.map((point) => point.x)));
        const maxX = Math.min(width, Math.max(...pixels.map((point) => point.x)));
        const minY = Math.max(0, Math.min(...pixels.map((point) => point.y)));
        const maxY = Math.min(height, Math.max(...pixels.map((point) => point.y)));
        if (maxX <= minX || maxY <= minY) continue;
        projected.push({
            ...record,
            imageBounds: {
                center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
                size: { x: maxX - minX, y: maxY - minY },
            },
        });
    }
    return projected;
}
