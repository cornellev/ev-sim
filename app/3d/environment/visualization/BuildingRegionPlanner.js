import * as THREE from "three";
import {
    DEFAULT_BEAUTY_PASS,
    resolveViewPasses,
} from "./BakePass.js";

/**
 * Count opaque white pixels in a binary mask buffer.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} minAlpha
 * @returns {number}
 */
export function countMaskPixels(rgba, minAlpha = 8) {
    let count = 0;
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] >= minAlpha && rgba[i] > 0) {
            count += 1;
        }
    }
    return count;
}

/**
 * @param {Object} policy
 * @param {Object} context
 * @param {string|null} [context.activeBuildingId]
 * @param {boolean} [context.hasVisibleBuilding]
 * @returns {import("./BakePass").BakePassDescriptor[]}
 */
export function resolvePassesForSample(policy = {}, context = {}) {
    const basePasses = [];
    const {
        beautyAlways = true,
        activeBuildingMask = true,
        contextMask = false,
        processAllVisibleBuildings = true,
    } = policy;

    if (beautyAlways) {
        basePasses.push({ ...DEFAULT_BEAUTY_PASS });
    }

    if (activeBuildingMask && context.hasVisibleBuilding) {
        const restrictToActive = processAllVisibleBuildings === false && context.activeBuildingId;
        basePasses.push({
            id: restrictToActive
                ? `mask_building_${context.activeBuildingId}`
                : "mask_buildings_visible",
            kind: "mask",
            includeTags: ["building"],
            excludeTags: [],
            buildingId: restrictToActive ? context.activeBuildingId : null,
            maskTags: ["building"],
            upload: true,
            processTag: "building",
            modelSeedKey: restrictToActive
                ? context.activeBuildingId
                : (context.visibleBuildingIds ?? []).join(",") || "visible-buildings",
        });
    }

    if (contextMask && context.hasVisibleContext) {
        basePasses.push({
            id: "mask_no_road_building",
            kind: "mask",
            includeTags: [],
            excludeTags: ["road", "building"],
            maskTags: ["no_road_building"],
            upload: true,
            processTag: "no_road_building",
        });
    }

    return resolveViewPasses(basePasses);
}

function effectiveBuildingId(object) {
    let current = object;
    while (current) {
        if (current.userData?.buildingId) return current.userData.buildingId;
        current = current.parent;
    }
    return null;
}

/**
 * Plans which building should be processed for each bake sample.
 */
export class BuildingRegionPlanner {
    /**
     * @param {import("./BakeRunConfig").BuildingRecord[]} buildings
     * @param {Object} [options]
     */
    constructor(buildings = [], options = {}) {
        this.buildings = buildings;
        this.rotationIndex = options.rotationIndex ?? 0;
    }

    /**
     * @param {THREE.Scene} scene
     * @param {THREE.PerspectiveCamera} camera
     * @returns {{ activeBuildingId: string|null, hasVisibleBuilding: boolean, visibleBuildingIds: string[] }}
     */
    planForView(scene, camera) {
        const visibleBuildingIds = [];
        const frustum = new THREE.Frustum();
        const matrix = new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        frustum.setFromProjectionMatrix(matrix);

        scene.traverse((object) => {
            if (!object.isMesh) return;
            const buildingId = effectiveBuildingId(object);
            if (!buildingId) return;

            const box = new THREE.Box3().setFromObject(object);
            if (!frustum.intersectsBox(box)) return;

            const projected = this._projectedArea(object, camera);
            if (projected <= 0) return;

            if (!visibleBuildingIds.includes(buildingId)) {
                visibleBuildingIds.push(buildingId);
            }
        });

        if (!visibleBuildingIds.length) {
            return {
                activeBuildingId: null,
                hasVisibleBuilding: false,
                visibleBuildingIds: [],
            };
        }

        const activeBuildingId = visibleBuildingIds[
            this.rotationIndex % visibleBuildingIds.length
        ];

        return {
            activeBuildingId,
            hasVisibleBuilding: true,
            visibleBuildingIds,
        };
    }

    /**
     * @param {THREE.Object3D} object
     * @param {THREE.PerspectiveCamera} camera
     * @returns {number}
     */
    _projectedArea(object, camera) {
        const box = new THREE.Box3().setFromObject(object);
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ];

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const ndc = new THREE.Vector3();

        for (const corner of corners) {
            ndc.copy(corner).project(camera);
            if (ndc.z < -1 || ndc.z > 1) continue;
            minX = Math.min(minX, ndc.x);
            minY = Math.min(minY, ndc.y);
            maxX = Math.max(maxX, ndc.x);
            maxY = Math.max(maxY, ndc.y);
        }

        if (!Number.isFinite(minX)) return 0;
        return Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    }

    /**
     * @param {number} frameIndex
     */
    advance(frameIndex) {
        this.rotationIndex = frameIndex;
    }
}
