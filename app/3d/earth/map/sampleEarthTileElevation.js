import * as THREE from "three";

const RAY_ORIGIN_HEIGHT = 10_000;
const RAY_LENGTH = 20_000;

/**
 * @param {THREE.Object3D|null|undefined} tileRoot
 * @param {Array<{ x: number, z: number }>} samplePoints
 * @returns {{ minY: number, maxY: number, sampled: boolean }}
 */
export function sampleEarthTileElevation(tileRoot, samplePoints) {
    if (!tileRoot || samplePoints.length === 0) {
        return { minY: 0, maxY: 0, sampled: false };
    }

    const meshes = [];
    tileRoot.traverse((child) => {
        if (child.isMesh) {
            meshes.push(child);
        }
    });

    if (meshes.length === 0) {
        return { minY: 0, maxY: 0, sampled: false };
    }

    tileRoot.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    let minY = Infinity;
    let maxY = -Infinity;
    let hitCount = 0;

    for (const point of samplePoints) {
        const origin = new THREE.Vector3(point.x, RAY_ORIGIN_HEIGHT, point.z);
        raycaster.set(origin, down);
        raycaster.near = 0;
        raycaster.far = RAY_LENGTH;
        const hits = raycaster.intersectObjects(meshes, false);
        if (!hits[0]) continue;

        hitCount += 1;
        minY = Math.min(minY, hits[0].point.y);
        maxY = Math.max(maxY, hits[0].point.y);
    }

    if (hitCount === 0) {
        return { minY: 0, maxY: 0, sampled: false };
    }

    return { minY, maxY, sampled: true };
}
