import * as THREE from "three";
import { isVisualPreviewObject } from "../../environment/visual/VisualPreviewIsolation.js";

const RAY_ORIGIN_HEIGHT = 10_000;
const RAY_LENGTH = 20_000;
const GLB_KINDS = new Set(["tile", "asset-instance"]);

/**
 * Meshes from projected GLTF tiles and catalog asset instances. Roads,
 * gizmos, Google tiles, and bake-preview roots are excluded.
 */
export function collectGlbMeshes(registry) {
    if (!registry?.listEntities) return [];
    const meshes = [];
    const seen = new Set();
    for (const summary of registry.listEntities()) {
        if (!GLB_KINDS.has(summary?.kind)) continue;
        if (summary.visible === false || summary.hidden === true) continue;
        const root = registry.getEntity?.(summary.id)?.object3D;
        if (!root || root.visible === false) continue;
        root.updateMatrixWorld?.(true);
        root.traverse?.((child) => {
            if (!child?.isMesh || seen.has(child) || child.visible === false) return;
            if (isVisualPreviewObject(child)) return;
            seen.add(child);
            meshes.push(child);
        });
    }
    return meshes;
}

/**
 * Elevation of the GLB surface on a vertical line at `(x, z)` closest to
 * `y`. Casts from both +Y and −Y so FrontSide materials still hit.
 * @returns {number|null}
 */
export function sampleVerticalGlbElevation(meshes, { x = 0, z = 0, y = 0 } = {}) {
    if (!Array.isArray(meshes) || meshes.length === 0) return null;
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return null;

    const raycaster = new THREE.Raycaster();
    const hits = [];
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);

    for (const direction of [down, up]) {
        origin.set(Number(x), direction.y < 0 ? RAY_ORIGIN_HEIGHT : -RAY_ORIGIN_HEIGHT, Number(z));
        raycaster.set(origin, direction);
        raycaster.near = 0;
        raycaster.far = RAY_LENGTH;
        for (const hit of raycaster.intersectObjects(meshes, false)) {
            if (Number.isFinite(hit?.point?.y)) hits.push(hit.point.y);
        }
    }
    if (hits.length === 0) return null;

    const current = Number.isFinite(Number(y)) ? Number(y) : 0;
    let best = hits[0];
    let bestDistance = Math.abs(best - current);
    for (let index = 1; index < hits.length; index += 1) {
        const distance = Math.abs(hits[index] - current);
        if (distance < bestDistance) {
            best = hits[index];
            bestDistance = distance;
        }
    }
    return best;
}

/** Bind a registry snapshot into `(x, z, currentY) => number|null`. */
export function createGlbElevationSampler(registry) {
    const meshes = collectGlbMeshes(registry);
    return (x, z, currentY) => sampleVerticalGlbElevation(meshes, { x, z, y: currentY });
}
