import * as THREE from "three";
import {
    maskAllowsPixel,
    pixelInSliver,
} from "./BakeImageMask.js";

/**
 * @param {{ enabled?: boolean, xMin?: number, xMax?: number }|null} sliverBounds
 * @param {number} width
 * @returns {THREE.Vector2}
 */
export function sliverBoundsToUv(sliverBounds, width) {
    if (!sliverBounds?.enabled || !width) return new THREE.Vector2(0, 1);
    return new THREE.Vector2(
        THREE.MathUtils.clamp(sliverBounds.xMin / width, 0, 1),
        THREE.MathUtils.clamp(sliverBounds.xMax / width, 0, 1),
    );
}

function createDataTexture(image, { colorSpace = null, nearest = false } = {}) {
    const texture = new THREE.DataTexture(
        image.data,
        image.width,
        image.height,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
    );
    texture.needsUpdate = true;
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    texture.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    if (colorSpace) texture.colorSpace = colorSpace;
    return texture;
}

function createPolygonMaterial(texture, opacity) {
    return new THREE.MeshBasicMaterial({
        map: texture,
        transparent: opacity < 1,
        opacity,
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        toneMapped: false,
    });
}

function cameraSampleForPoint(point, intrinsics, cameraMatrix, invCameraMatrix) {
    const pixel = point.pixel;
    if (!pixel) return null;

    const world = point.world instanceof THREE.Vector3
        ? point.world
        : new THREE.Vector3(point.world.x, point.world.y, point.world.z);
    const cameraPoint = world.clone().applyMatrix4(invCameraMatrix);
    const depth = -cameraPoint.z;
    if (!Number.isFinite(depth) || depth <= 0) return null;

    return {
        px: pixel.px,
        py: pixel.py,
        depth,
        buildingId: point.buildingId ?? point.attributedBuildingId ?? "unattributed",
        world,
        cameraMatrix,
        intrinsics,
    };
}

function worldFromPixelDepth(px, py, depth, intrinsics, cameraMatrix, surfaceOffset = 0.02) {
    const calibrated = Boolean(intrinsics.visualCalibration);
    const cameraPoint = new THREE.Vector3(
        ((px - intrinsics.cx) * depth) / intrinsics.fx,
        (calibrated ? -1 : 1) * ((py - intrinsics.cy) * depth) / intrinsics.fy,
        -depth,
    );
    const world = cameraPoint.applyMatrix4(cameraMatrix);
    const cameraPosition = new THREE.Vector3().setFromMatrixPosition(cameraMatrix);
    const towardCamera = cameraPosition.sub(world).normalize();
    return world.addScaledVector(towardCamera, surfaceOffset);
}

function nearestSample(samples, px, py, maxDistancePx) {
    let nearest = null;
    let nearestDistanceSq = maxDistancePx * maxDistancePx;

    for (const sample of samples) {
        const dx = sample.px - px;
        const dy = sample.py - py;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq <= nearestDistanceSq) {
            nearestDistanceSq = distanceSq;
            nearest = sample;
        }
    }

    return nearest;
}

function interpolatedSample(samples, px, py, maxDistancePx, maxDepthDelta) {
    const nearest = nearestSample(samples, px, py, maxDistancePx);
    if (!nearest) return null;

    let weightedDepth = 0;
    let totalWeight = 0;
    for (const sample of samples) {
        if (sample.buildingId !== nearest.buildingId) continue;

        const dx = sample.px - px;
        const dy = sample.py - py;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq > maxDistancePx * maxDistancePx) continue;
        if (Math.abs(sample.depth - nearest.depth) > maxDepthDelta) continue;

        const weight = 1 / Math.max(1, distanceSq);
        weightedDepth += sample.depth * weight;
        totalWeight += weight;
    }

    return {
        ...nearest,
        depth: totalWeight > 0 ? weightedDepth / totalWeight : nearest.depth,
    };
}

function triangleIsContinuous(vertices, a, b, c, maxTriangleDepthDelta) {
    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];
    if (!va || !vb || !vc) return false;
    if (va.buildingId !== vb.buildingId || va.buildingId !== vc.buildingId) return false;

    const minDepth = Math.min(va.depth, vb.depth, vc.depth);
    const maxDepth = Math.max(va.depth, vb.depth, vc.depth);
    return maxDepth - minDepth <= maxTriangleDepthDelta;
}

function buildMaskPolygonGeometry({
    maskImage,
    imageWidth,
    imageHeight,
    intrinsics,
    matrixWorld,
    candidates,
    sliverBounds,
    cellSizePx = 10,
    maxPixelDistancePx = 16,
    maxDepthDelta = 1.5,
    maxTriangleDepthDelta = 1,
    surfaceOffset = 0.005,
}) {
    if (!maskImage?.data || !intrinsics || !matrixWorld?.length || !candidates?.length) {
        return null;
    }

    const cameraMatrix = new THREE.Matrix4().fromArray(matrixWorld);
    const invCameraMatrix = cameraMatrix.clone().invert();
    const samples = candidates
        .map((point) => cameraSampleForPoint(point, intrinsics, cameraMatrix, invCameraMatrix))
        .filter(Boolean);
    if (!samples.length) return null;

    const xMin = sliverBounds?.enabled ? sliverBounds.xMin : 0;
    const xMax = sliverBounds?.enabled ? sliverBounds.xMax : imageWidth;
    const cell = Math.max(2, Math.round(cellSizePx));
    const vertices = [];
    const vertexMeta = [];
    const uvs = [];
    const indices = [];
    const vertexByGrid = new Map();
    const columns = [];
    const rows = [];

    for (let x = xMin; x <= xMax; x += cell) columns.push(Math.min(imageWidth - 1, Math.round(x)));
    if (columns[columns.length - 1] !== xMax - 1) columns.push(Math.max(xMin, xMax - 1));
    for (let y = 0; y < imageHeight; y += cell) rows.push(Math.min(imageHeight - 1, Math.round(y)));
    if (rows[rows.length - 1] !== imageHeight - 1) rows.push(imageHeight - 1);

    for (let yi = 0; yi < rows.length; yi += 1) {
        const py = rows[yi];
        for (let xi = 0; xi < columns.length; xi += 1) {
            const px = columns[xi];
            if (!pixelInSliver(px, sliverBounds) || !maskAllowsPixel(maskImage, px, py)) continue;

            const sample = interpolatedSample(samples, px, py, maxPixelDistancePx, maxDepthDelta);
            if (!sample) continue;

            const world = worldFromPixelDepth(
                px,
                py,
                sample.depth,
                intrinsics,
                cameraMatrix,
                surfaceOffset,
            );
            const index = vertices.length / 3;
            vertices.push(world.x, world.y, world.z);
            vertexMeta.push({
                buildingId: sample.buildingId,
                depth: sample.depth,
            });
            uvs.push(px / Math.max(1, imageWidth - 1), py / Math.max(1, imageHeight - 1));
            vertexByGrid.set(`${xi}:${yi}`, index);
        }
    }

    for (let yi = 0; yi < rows.length - 1; yi += 1) {
        for (let xi = 0; xi < columns.length - 1; xi += 1) {
            const a = vertexByGrid.get(`${xi}:${yi}`);
            const b = vertexByGrid.get(`${xi + 1}:${yi}`);
            const c = vertexByGrid.get(`${xi}:${yi + 1}`);
            const d = vertexByGrid.get(`${xi + 1}:${yi + 1}`);

            if (
                a !== undefined
                && b !== undefined
                && c !== undefined
                && triangleIsContinuous(vertexMeta, a, b, c, maxTriangleDepthDelta)
            ) {
                indices.push(a, b, c);
            }
            if (
                b !== undefined
                && d !== undefined
                && c !== undefined
                && triangleIsContinuous(vertexMeta, b, d, c, maxTriangleDepthDelta)
            ) {
                indices.push(b, d, c);
            }
        }
    }

    if (vertices.length === 0 || indices.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return {
        geometry,
        vertexCount: vertices.length / 3,
        triangleCount: indices.length / 3,
    };
}

export class ProjectedBuildingTextureManager {
    /**
     * @param {THREE.Scene} scene
     * @param {{ ledger?: import("./BakeMemoryLedger.js").BakeMemoryLedger, maxProjections?: number }} [options]
     */
    constructor(scene, options = {}) {
        this.scene = scene;
        this.overlayGroup = new THREE.Group();
        this.overlayGroup.name = "BakeProjectedTextureOverlay";
        this.scene.add(this.overlayGroup);
        this.ledger = options.ledger ?? null;
        this.maxProjections = options.maxProjections ?? 64;
        this.entries = [];
        this.evictions = 0;
        this._clock = 0;
    }

    snapshot() {
        return {
            projections: this.entries.length,
            maxProjections: this.maxProjections,
            required: this.entries.filter((entry) => entry.required).length,
            evictions: this.evictions,
            bytes: this.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        };
    }

    reset() {
        for (const entry of this.entries) {
            if (entry.reservationId != null) this.ledger?.removeProjection(entry.reservationId);
            this._disposeEntry(entry);
        }
        this.overlayGroup.clear();
        this.entries = [];
        this.evictions = 0;
    }

    dispose() {
        this.reset();
        this.overlayGroup.removeFromParent();
        this.scene = null;
    }

    /**
     * @param {Object} options
     * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number, colorSpace?: string }} options.image
     * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }} options.maskImage
     * @param {Object[]} options.candidates
     * @param {Object} options.intrinsics
     * @param {number[]} options.matrixWorld
     * @param {{ enabled?: boolean, xMin?: number, xMax?: number }} [options.sliverBounds]
     * @param {number} [options.opacity]
     * @param {number} [options.cellSizePx]
     * @param {number} [options.maxPixelDistancePx]
     * @param {number} [options.maxDepthDelta]
     * @param {number} [options.maxTriangleDepthDelta]
     * @param {number} [options.surfaceOffset]
     * @param {boolean} [options.required]
     * @returns {{ updatedMeshes: number, vertexCount: number, triangleCount: number }}
     */
    applyProjection({
        image,
        maskImage,
        candidates = [],
        intrinsics,
        matrixWorld,
        sliverBounds = null,
        opacity = 1,
        cellSizePx = 10,
        maxPixelDistancePx = 16,
        maxDepthDelta = 1.5,
        maxTriangleDepthDelta = 1,
        surfaceOffset = 0.005,
        required = false,
    }) {
        if (!image?.data || !maskImage?.data || !intrinsics || !matrixWorld?.length) {
            return { updatedMeshes: 0, vertexCount: 0, triangleCount: 0 };
        }

        const polygon = buildMaskPolygonGeometry({
            maskImage,
            imageWidth: image.width,
            imageHeight: image.height,
            intrinsics,
            matrixWorld,
            candidates,
            sliverBounds,
            cellSizePx,
            maxPixelDistancePx,
            maxDepthDelta,
            maxTriangleDepthDelta,
            surfaceOffset,
        });
        if (!polygon) {
            return { updatedMeshes: 0, vertexCount: 0, triangleCount: 0 };
        }

        const bytes = projectionBytes(image, polygon);
        this._ensureCapacity({ bytes, required });

        const projectionTexture = createDataTexture(image, {
            colorSpace: image.colorSpace === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace,
        });
        const material = createPolygonMaterial(projectionTexture, opacity);
        const mesh = new THREE.Mesh(polygon.geometry, material);
        mesh.name = `BakeMaskPolygonProjection:${this.overlayGroup.children.length}`;
        mesh.renderOrder = 10;
        mesh.frustumCulled = false;
        this.overlayGroup.add(mesh);

        const reservationId = this.ledger?.addProjection(bytes) ?? null;
        this.entries.push({
            mesh,
            texture: projectionTexture,
            material,
            geometry: polygon.geometry,
            bytes,
            required,
            refs: required ? 1 : 0,
            lastUsed: this._clock += 1,
            reservationId,
        });

        return {
            updatedMeshes: 1,
            vertexCount: polygon.vertexCount,
            triangleCount: polygon.triangleCount,
        };
    }

    releaseProjection(mesh) {
        const entry = this.entries.find((candidate) => candidate.mesh === mesh);
        if (!entry) return;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsed = this._clock += 1;
    }

    _ensureCapacity({ bytes, required }) {
        const overCount = () => this.entries.length >= this.maxProjections;
        const overBytes = () => this.ledger && !this.ledger.canReserve(bytes);
        if (!overCount() && !overBytes()) {
            this.ledger?.assertProjectionBudget({ count: 1, bytes, required });
            return;
        }
        this._evictUnused();
        if (this.ledger) this.ledger.assertProjectionBudget({ count: 1, bytes, required });
        if (this.entries.length >= this.maxProjections) {
            this.ledger?.assertProjectionBudget({ count: 1, bytes, required: true });
        }
    }

    _evictUnused() {
        const unused = this.entries
            .filter((entry) => entry.refs === 0 && !entry.required)
            .sort((left, right) => left.lastUsed - right.lastUsed);
        for (const entry of unused) {
            this._removeEntry(entry);
            this.evictions += 1;
        }
    }

    _removeEntry(entry) {
        this.overlayGroup.remove(entry.mesh);
        this._disposeEntry(entry);
        this.entries = this.entries.filter((candidate) => candidate !== entry);
        if (entry.reservationId != null) this.ledger?.removeProjection(entry.reservationId);
    }

    _disposeEntry(entry) {
        entry.texture?.dispose?.();
        entry.material?.dispose?.();
        entry.geometry?.dispose?.();
    }
}

function projectionBytes(image, polygon) {
    const textureBytes = (image.width ?? 0) * (image.height ?? 0) * 4;
    const geometryBytes = (polygon.vertexCount * 32) + (polygon.triangleCount * 12);
    return textureBytes + geometryBytes;
}
