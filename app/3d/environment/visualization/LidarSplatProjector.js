import * as THREE from "three";

const TAG_NAME_BY_ID = {
    0: "unknown",
    1: "building",
    2: "sign",
    3: "vehicle",
    4: "road",
    5: "barrel",
    6: "tire",
};

function decodeHitsFromBuffer(data, range) {
    if (!data) return [];

    const hits = [];
    for (let i = 0; i < data.length; i += 4) {
        const intensity = data[i];
        const normalizedTag = data[i + 1];
        const objectKindValue = data[i + 2];
        const hitFlag = data[i + 3];
        const hit = hitFlag > 0.5;
        const distance = hit ? (1.0 - intensity) * range : range;
        const tagId = Math.round(Math.max(0, Math.min(1, normalizedTag)) * 255);

        hits.push({
            distance,
            tagId,
            tagName: TAG_NAME_BY_ID[tagId] ?? "unknown",
            objectKind: hit
                ? (objectKindValue < 0.5 ? "triangle" : objectKindValue < 1.5 ? "box" : null)
                : null,
            hit,
        });
    }

    return hits;
}

/**
 * Quantize world positions so earlier frames do not duplicate splats.
 */
export class CoverageGrid {
    /**
     * @param {number} [voxelSize]
     */
    constructor(voxelSize = 0.25) {
        this.voxelSize = voxelSize;
        /** @type {Set<string>} */
        this.keys = new Set();
    }

    /**
     * @param {{ x: number, y: number, z: number }|THREE.Vector3} world
     * @returns {string}
     */
    key(world) {
        const x = Math.floor(world.x / this.voxelSize);
        const y = Math.floor(world.y / this.voxelSize);
        const z = Math.floor(world.z / this.voxelSize);
        return `${x},${y},${z}`;
    }

    /**
     * @param {{ x: number, y: number, z: number }|THREE.Vector3} world
     * @returns {boolean}
     */
    has(world) {
        return this.keys.has(this.key(world));
    }

    /**
     * True when this voxel OR any of its 26 neighbors is already covered.
     * Robust against sub-voxel drift between viewpoints, so the same surface
     * observed from successive frames does not deposit offset duplicate splats.
     * @param {{ x: number, y: number, z: number }|THREE.Vector3} world
     * @returns {boolean}
     */
    hasNeighbor(world) {
        const cx = Math.floor(world.x / this.voxelSize);
        const cy = Math.floor(world.y / this.voxelSize);
        const cz = Math.floor(world.z / this.voxelSize);

        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    if (this.keys.has(`${cx + dx},${cy + dy},${cz + dz}`)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * @param {{ x: number, y: number, z: number }|THREE.Vector3} world
     */
    add(world) {
        this.keys.add(this.key(world));
    }
}

/**
 * The bake LiDAR scans centered on its local +X axis (theta = phi = 0), but a
 * THREE.PerspectiveCamera with the same Euler rotation looks down its local -Z
 * axis. Without correcting for this the LiDAR ends up scanning ~90deg away from
 * where the camera looks, so almost no hits land inside the camera frustum and
 * nothing can be colored / splatted. A +90deg rotation about Y maps the LiDAR
 * forward (+X) onto the camera forward (-Z) so the two sensors stay aligned.
 */
const LIDAR_TO_CAMERA = new THREE.Matrix4().makeRotationY(Math.PI / 2);

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Build the world-space basis the bake LiDAR rays are cast in for a given
 * camera rotation. Must be kept identical to the matrix uploaded to the LiDAR
 * shader in BakeView._captureLidar so reconstructed points match real hits.
 * @param {THREE.Euler|{ x: number, y: number, z: number }} rotation
 * @returns {THREE.Matrix3}
 */
export function buildSensorRotationMatrix(rotation) {
    const euler = rotation instanceof THREE.Euler
        ? rotation
        : new THREE.Euler(rotation.x, rotation.y, rotation.z);
    const m4 = new THREE.Matrix4()
        .makeRotationFromEuler(euler)
        .multiply(LIDAR_TO_CAMERA);
    return new THREE.Matrix3().setFromMatrix4(m4);
}

/**
 * @param {Object} lidarFrame
 * @param {Object} extrinsics
 * @returns {Object[]}
 */
export function hitsToWorldPoints(lidarFrame, extrinsics) {
    if (!lidarFrame?.data || !extrinsics?.position) return [];

    const width = lidarFrame.width;
    const height = lidarFrame.height;
    const range = lidarFrame.range;
    const thetaRange = lidarFrame.thetaRange ?? [-45, 45];
    const phiRange = lidarFrame.phiRange ?? [-30, 30];
    const hits = lidarFrame.hits ?? decodeHitsFromBuffer(lidarFrame.data, range);
    const projection = lidarFrame.projection ?? "spherical";

    const origin = new THREE.Vector3(
        extrinsics.position.x,
        extrinsics.position.y,
        extrinsics.position.z,
    );
    const rotation = new THREE.Euler(
        extrinsics.rotation.x,
        extrinsics.rotation.y,
        extrinsics.rotation.z,
    );
    const sensorRotation = buildSensorRotationMatrix(rotation);

    const thetaStep = width > 1
        ? (thetaRange[1] - thetaRange[0]) / (width - 1)
        : 0;
    const phiStep = height > 1
        ? (phiRange[1] - phiRange[0]) / (height - 1)
        : 0;
    const shaderThetaStep = lidarFrame.thetaStep ?? thetaStep;
    const shaderPhiStep = lidarFrame.phiStep ?? phiStep;

    const points = [];

    for (let i = 0; i < hits.length; i += 1) {
        const hit = hits[i];
        if (!hit?.hit) continue;

        const thetaIndex = i % width;
        const phiIndex = Math.floor(i / width);
        const legacyThetaDeg = thetaRange[0] + thetaIndex * thetaStep;
        const legacyPhiDeg = phiRange[0] + phiIndex * phiStep;
        let reconThetaDeg;
        let reconPhiDeg;
        let cameraPlane = null;
        let localDir;

        if (projection === "pinhole") {
            const u = (thetaIndex + 0.5) / width;
            const v = (phiIndex + 0.5) / height;
            const xPlane = lerp(
                Math.tan(THREE.MathUtils.degToRad(thetaRange[0])),
                Math.tan(THREE.MathUtils.degToRad(thetaRange[1])),
                u,
            );
            const yPlane = lerp(
                Math.tan(THREE.MathUtils.degToRad(phiRange[0])),
                Math.tan(THREE.MathUtils.degToRad(phiRange[1])),
                v,
            );
            cameraPlane = { x: xPlane, y: yPlane };
            reconThetaDeg = THREE.MathUtils.radToDeg(Math.atan(xPlane));
            reconPhiDeg = THREE.MathUtils.radToDeg(Math.atan(yPlane));
            localDir = new THREE.Vector3(1, yPlane, xPlane).normalize();
        } else {
            // Legacy spherical ray grid. Kept for old captured frames/tests.
            reconThetaDeg = thetaRange[0] + thetaIndex * shaderThetaStep;
            reconPhiDeg = phiRange[0] + phiIndex * shaderPhiStep;
            const thetaRad = THREE.MathUtils.degToRad(reconThetaDeg);
            const phiRad = THREE.MathUtils.degToRad(reconPhiDeg);
            localDir = new THREE.Vector3(
                Math.cos(phiRad) * Math.cos(thetaRad),
                Math.sin(phiRad),
                Math.cos(phiRad) * Math.sin(thetaRad),
            );
        }
        const dir = localDir.applyMatrix3(sensorRotation).normalize();
        const world = origin.clone().add(dir.multiplyScalar(hit.distance));

        points.push({
            index: i,
            world,
            distance: hit.distance,
            tagName: hit.tagName,
            tagId: hit.tagId,
            thetaIndex,
            phiIndex,
            thetaStepDeg: shaderThetaStep,
            phiStepDeg: shaderPhiStep,
            thetaDeg: legacyThetaDeg,
            phiDeg: legacyPhiDeg,
            shaderThetaStepDeg: shaderThetaStep,
            shaderPhiStepDeg: shaderPhiStep,
            shaderThetaDeg: reconThetaDeg,
            shaderPhiDeg: reconPhiDeg,
            projection,
            cameraPlane,
        });
    }

    return points;
}

/**
 * @param {Object[]} points
 * @param {Object} [options]
 * @returns {Object[]}
 */
export function filterForSplatting(points, options = {}) {
    const excludeTags = (options.excludeTags ?? ["road"]).map((tag) => tag.toLowerCase());
    const bandNear = options.bandNear ?? 0;
    const bandFar = options.bandFar ?? 15;
    const maxSplatDistance = options.maxSplatDistance ?? 60;

    return points.filter((point) => {
        if (!point?.world) return false;
        if (excludeTags.includes(String(point.tagName).toLowerCase())) return false;
        if (point.distance < bandNear || point.distance > bandFar) return false;
        if (point.distance > maxSplatDistance) return false;
        return true;
    });
}

/**
 * Missing attribution is allowed because some meshes only carry building ids on
 * ancestors; an explicit different attribution is rejected.
 * @param {string|null|undefined} activeBuildingId
 * @param {string|null|undefined} attributedBuildingId
 * @returns {boolean}
 */
export function activeBuildingAllowsPoint(activeBuildingId, attributedBuildingId) {
    if (!activeBuildingId || !attributedBuildingId) return true;
    return activeBuildingId === attributedBuildingId;
}

/**
 * @param {THREE.Vector3|{ x: number, y: number, z: number }} world
 * @param {Object} intrinsics
 * @param {number[]} matrixWorld
 * @returns {{ px: number, py: number }|null}
 */
export function worldToPixel(world, intrinsics, matrixWorld) {
    if (!intrinsics || !matrixWorld?.length) return null;

    const worldVec = world instanceof THREE.Vector3
        ? world
        : new THREE.Vector3(world.x, world.y, world.z);

    const cameraMatrix = new THREE.Matrix4().fromArray(matrixWorld);
    const inv = cameraMatrix.clone().invert();
    const pCam = worldVec.clone().applyMatrix4(inv);

    if (pCam.z >= 0) return null;

    const px = Math.round((intrinsics.fx * pCam.x) / -pCam.z + intrinsics.cx);
    const py = Math.round((intrinsics.fy * pCam.y) / -pCam.z + intrinsics.cy);

    if (px < 0 || px >= intrinsics.width || py < 0 || py >= intrinsics.height) {
        return null;
    }

    return { px, py };
}

/**
 * Sample sRGB color from a bottom-left-origin RGBA buffer.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} px
 * @param {number} py
 * @returns {{ r: number, g: number, b: number }|null}
 */
export function sampleColor(rgba, width, height, px, py) {
    if (!rgba || px < 0 || py < 0 || px >= width || py >= height) return null;

    const idx = (py * width + px) * 4;
    if (idx + 2 >= rgba.length) return null;

    return {
        r: rgba[idx] / 255,
        g: rgba[idx + 1] / 255,
        b: rgba[idx + 2] / 255,
    };
}

/**
 * Convert sampled sRGB to linear for Spark splat colors.
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {THREE.Color}
 */
export function srgbToLinearColor(rgb) {
    const color = new THREE.Color(rgb.r, rgb.g, rgb.b);
    color.convertSRGBToLinear();
    return color;
}
