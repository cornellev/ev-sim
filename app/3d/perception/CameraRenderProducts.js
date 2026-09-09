import * as THREE from "three";

import { perceptionMetadataFromObject } from "../../autonomy/PerceptionTruthIndex.js";
import {
    applyProjectionToThreeCamera,
    assertOwnedCaptureScene,
    assertVisualCameraCalibration,
    CORRECTED_VISUAL_CAPTURE_MODE,
    decodeAxialDepth,
    distortNormalizedPoint,
    distortPixel,
    flipRows,
    LEGACY_VISUAL_CAPTURE_MODE,
    unpackRgbDepth,
    undistortNormalizedPoint,
    warpBrownConrady,
} from "../environment/visual/VisualCapturePipeline.js";
import { AlignedCaptureProducts } from "../environment/visual/AlignedCaptureProducts.js";
import { isVisualPreviewObject } from "../environment/visual/VisualPreviewIsolation.js";
import { getWebGL2Context, PixelPackSlot, withPixelPackBufferUnbound } from "../util/glReadback.js";

export {
    distortNormalizedPoint,
    distortPixel,
    flipRows,
    unpackRgbDepth,
    undistortNormalizedPoint,
    warpBrownConrady,
};

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
    if (isVisualPreviewObject(object)) return true;
    if (object.isSparkRenderer || object.constructor?.name === "SparkRenderer") return true;
    if (object.userData?.autonomyOverlay) return true;
    if (mode === "rgb" && object.isMesh && object.userData?.bakeIgnore) return true;
    return false;
}

export class CameraRenderProducts {
    constructor({
        renderer,
        scene,
        camera,
        width,
        height,
        near = 0.1,
        far = 200,
        captureMode = LEGACY_VISUAL_CAPTURE_MODE,
        calibration = null,
        sceneHandle = null,
        analyticSceneHandle = null,
        authorizeSourceUse = null,
        renderPolicy = null,
        alignedReadback = null,
    } = {}) {
        this.renderer = renderer;
        this.camera = camera;
        this.captureMode = captureMode;
        this.calibration = null;
        this.sceneHandle = null;
        this.analyticSceneHandle = analyticSceneHandle;
        this.authorizeSourceUse = authorizeSourceUse;
        this.renderPolicy = renderPolicy;
        this.alignedReadback = alignedReadback;
        if (captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
            this.calibration = assertVisualCameraCalibration(calibration);
            this.sceneHandle = assertOwnedCaptureScene(sceneHandle, { role: "measured-appearance" });
            this.scene = this.sceneHandle.scene;
            this.width = this.calibration.image.width;
            this.height = this.calibration.image.height;
            this.near = this.calibration.clipping.near;
            this.far = this.calibration.clipping.far;
            applyProjectionToThreeCamera(this.camera, this.calibration);
        } else if (captureMode === LEGACY_VISUAL_CAPTURE_MODE) {
            this.scene = scene;
            this.width = width;
            this.height = height;
            this.near = near;
            this.far = far;
        } else {
            throw new Error(`Unsupported camera capture mode "${captureMode}".`);
        }
        this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
        });
        this.target.texture.colorSpace = THREE.SRGBColorSpace;
        this.pixelBuffer = new Uint8Array(this.width * this.height * 4);
        this.flipBuffer = new Uint8Array(this.width * this.height * 4);
        this.depthMaterial = new THREE.MeshDepthMaterial({
            depthPacking: THREE.RGBADepthPacking,
            side: THREE.DoubleSide,
        });
        this.materials = new Map();
        this._slots = Object.create(null);
        this._inflight = null;
        this._asyncDisabled = false;
        this._depthScratch = new Float32Array(this.width * this.height);
        this._depthValidityScratch = new Uint8Array(this.width * this.height);
        this._semanticScratch = new Uint16Array(this.width * this.height);
        this._instanceScratch = new Uint32Array(this.width * this.height);
        this._decodeFlipScratch = new Uint8Array(this.width * this.height * 4);
        this._alignedProducts = null;
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
        if (this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
            assertOwnedCaptureScene(this.sceneHandle);
        }
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
                if (mode === "depth" && this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
                    // RGBADepthPacking encodes the far plane as white. This
                    // makes corrected no-hit pixels decode to zero + invalid.
                    this.renderer.setClearColor(0xffffff, 1);
                } else {
                    this.renderer.setClearColor(0x000000, 0);
                }
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
            if (this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
                return decodeAxialDepth({
                    rgba,
                    calibration: this.calibration,
                    inputRows: "bottom-left",
                    output: this._depthScratch,
                    validity: this._depthValidityScratch,
                }).data;
            }
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
            if (key === "depth" && this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
                result.depthValidity = this._depthValidityScratch;
            }
        }
        this._inflight = null;
        return result;
    }

    submit(products = {}) {
        if (this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
            throw new Error("Corrected capture requires captureAlignedProducts() and explicit pass-family inputs.");
        }
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
        if (this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
            throw new Error("Corrected capture requires captureAlignedProducts() and explicit pass-family inputs.");
        }
        const result = {};
        if (products.rgb) result.rgb = flipRows(this._render({ mode: "rgb" }), this.width, this.height, 4, this.flipBuffer);
        if (products.depth) {
            const rgba = this._render({ mode: "depth" });
            if (this.captureMode === CORRECTED_VISUAL_CAPTURE_MODE) {
                const decoded = decodeAxialDepth({
                    rgba,
                    calibration: this.calibration,
                    inputRows: "bottom-left",
                    output: this._depthScratch,
                    validity: this._depthValidityScratch,
                });
                result.depth = decoded.data;
                result.depthValidity = decoded.validity;
            } else {
                result.depth = rgbaDepthToMetric(
                    rgba, this.width, this.height, this.near, this.far, {
                        flipScratch: this._decodeFlipScratch,
                        output: this._depthScratch,
                    },
                );
            }
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

    async captureAlignedProducts({
        visualPassSet,
        visualRenderables = new Map(),
        analyticPassSet = null,
        analyticRenderables = new Map(),
        signal,
    } = {}) {
        if (this.captureMode !== CORRECTED_VISUAL_CAPTURE_MODE) {
            throw new Error("Aligned products require calibrated-projection@1.");
        }
        if (!signal || typeof signal.aborted !== "boolean") {
            throw new Error("Aligned camera capture requires an AbortSignal.");
        }
        if (analyticPassSet && !this.analyticSceneHandle) {
            throw new Error("Analytic oracle products require a separate analytic-truth scene handle.");
        }
        this._alignedProducts ??= new AlignedCaptureProducts({
            renderer: this.renderer,
            camera: this.camera,
            visualSceneHandle: this.sceneHandle,
            analyticSceneHandle: this.analyticSceneHandle,
            authorizeSourceUse: this.authorizeSourceUse,
            renderPolicy: this.renderPolicy,
            readback: this.alignedReadback,
        });
        return this._alignedProducts.capture({
            visualPassSet,
            visualRenderables,
            analyticPassSet,
            analyticRenderables,
            signal,
        });
    }

    reset() {
        for (const slot of Object.values(this._slots)) slot.pack?.reset?.();
        this._inflight = null;
        this._asyncDisabled = false;
    }

    dispose() {
        this._alignedProducts?.dispose();
        this._alignedProducts = null;
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
        this._depthValidityScratch = null;
        this._semanticScratch = null;
        this._instanceScratch = null;
        this._decodeFlipScratch = null;
        this._asyncDisabled = false;
        this.analyticSceneHandle = null;
        this.authorizeSourceUse = null;
        this.renderPolicy = null;
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
