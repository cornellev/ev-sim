import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import {
    CoverageGrid,
    sampleColor,
    srgbToLinearColor,
    worldToPixel,
} from "./LidarSplatProjector";

/**
 * Incrementally builds a Spark Gaussian splat cloud from sequential bake frames.
 */
export class SplatAccumulator {
    /**
     * @param {THREE.Scene} scene
     * @param {Object} [options]
     */
    constructor(scene, options = {}) {
        this.scene = scene;
        this.maxSplats = options.maxSplats ?? 500000;
        this.coverageVoxelSize = options.coverageVoxelSize ?? 0.25;
        this.hideThreshold = options.hideThreshold ?? 50;

        this.coverageGrid = new CoverageGrid(this.coverageVoxelSize);
        /** @type {Map<string, number>} */
        this.buildingCounts = new Map();
        /** @type {Set<string>} */
        this.hiddenBuildings = new Set();

        this.mesh = new SplatMesh({
            maxSplats: this.maxSplats,
            editable: true,
        });
        this.ready = this.mesh.initialized;
        scene.add(this.mesh);
    }

    /**
     * @returns {number}
     */
    get splatCount() {
        return this.mesh?.packedSplats?.numSplats ?? 0;
    }

    /**
     * @param {Object[]} filteredPoints
     * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }} bakedImage
     * @param {Object} options
     * @returns {Promise<{ committed: number, buildingCounts: Map<string, number> }>}
     */
    async commitSliver(filteredPoints, bakedImage, options = {}) {
        await this.ready;

        const intrinsics = options.intrinsics;
        const matrixWorld = options.matrixWorld;
        const radius = options.radius ?? 0.06;
        const adaptiveRadius = options.adaptiveRadius !== false;
        const maxPointsPerFrame = options.maxPointsPerFrame ?? 20000;
        const buildingId = options.buildingId ?? null;

        // Raw framebuffer reads are already linear; decoded model PNGs are sRGB.
        const isSrgb = (bakedImage.colorSpace ?? "linear") === "srgb";

        const sorted = [...filteredPoints].sort((a, b) => a.distance - b.distance);
        const identityQuat = new THREE.Quaternion();
        let committed = 0;

        for (const point of sorted) {
            if (committed >= maxPointsPerFrame) break;
            if (this.coverageGrid.has(point.world)) continue;

            const pixel = worldToPixel(point.world, intrinsics, matrixWorld);
            if (!pixel) continue;

            const rgb = sampleColor(
                bakedImage.data,
                bakedImage.width,
                bakedImage.height,
                pixel.px,
                pixel.py,
            );
            if (!rgb) continue;

            const thetaRad = THREE.MathUtils.degToRad(point.thetaStepDeg ?? 0.1);
            const phiRad = THREE.MathUtils.degToRad(point.phiStepDeg ?? 0.1);
            const angularStep = Math.max(thetaRad, phiRad);
            const splatRadius = adaptiveRadius
                ? Math.max(radius, point.distance * angularStep * 0.5)
                : radius;
            const scales = new THREE.Vector3(splatRadius, splatRadius, splatRadius);
            const color = isSrgb
                ? srgbToLinearColor(rgb)
                : new THREE.Color(rgb.r, rgb.g, rgb.b);

            this.mesh.pushSplat(point.world, scales, identityQuat, 1.0, color);
            this.coverageGrid.add(point.world);
            committed += 1;

            if (buildingId && point.tagName === "building") {
                this.buildingCounts.set(
                    buildingId,
                    (this.buildingCounts.get(buildingId) ?? 0) + 1,
                );
            }
        }

        if (committed > 0) {
            this.mesh.numSplats = this.mesh.packedSplats.numSplats;
            this.mesh.updateVersion();
            this.mesh.packedSplats.needsUpdate = true;
        }

        return {
            committed,
            buildingCounts: this.buildingCounts,
        };
    }

    /**
     * Hide low-poly building meshes once enough splats exist for that building.
     * LiDAR triangles remain in ObjectDatabase.
     * @param {THREE.Scene} scene
     * @param {Object} [config]
     */
    hideBakedGeometry(scene, config = {}) {
        if (config.hideBakedGeometry === false) return;

        const threshold = config.hideThreshold ?? this.hideThreshold;

        scene.traverse((object) => {
            const buildingId = object.userData?.buildingId;
            if (!buildingId || !object.isMesh) return;

            const count = this.buildingCounts.get(buildingId) ?? 0;
            if (count < threshold) return;

            object.visible = false;
            this.hiddenBuildings.add(buildingId);
        });
    }

    dispose() {
        if (this.mesh?.parent) {
            this.mesh.parent.remove(this.mesh);
        }
        this.mesh = null;
    }
}
