/**
 * Bicycle-model path ribbon geometry shared by live controls overlays and replay.
 * Steering uses Three.js plant convention (positive right).
 */

import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Fill a ribbon BufferGeometry (2 verts per segment) along an Ackermann arc.
 * @param {THREE.BufferGeometry} geometry
 * @param {{ position?: {x,y,z}, yaw?: number, heading?: THREE.Vector3 }} pose
 * @param {number} steeringAngleRad Three.js plant steering
 * @param {{ wheelbase?: number, lookahead?: number, segments?: number, pathWidth?: number, pathY?: number }} options
 */
export function updateControlsPathRibbon(geometry, pose, steeringAngleRad, options = {}) {
    const wheelbase = Math.max(0.1, Number(options.wheelbase) || 1.5);
    const lookahead = Number(options.lookahead) || 8;
    const segments = Math.max(2, Math.floor(Number(options.segments) || 24));
    const pathWidth = Number(options.pathWidth) || 0.35;
    const pathY = Number(options.pathY) || 0.05;
    const curvature = Math.tan(Number(steeringAngleRad) || 0) / wheelbase;

    const pos = new THREE.Vector3(
        Number(pose?.position?.x) || 0,
        pathY,
        Number(pose?.position?.z) || 0,
    );
    const heading = pose?.heading
        ? pose.heading.clone()
        : new THREE.Vector3(Math.cos(Number(pose?.yaw) || 0), 0, -Math.sin(Number(pose?.yaw) || 0));
    heading.y = 0;
    if (heading.lengthSq() < 1e-8) heading.set(1, 0, 0);
    heading.normalize();

    const ds = lookahead / segments;
    const positionAttr = geometry.getAttribute("position");
    const arr = positionAttr.array;
    const tangent = new THREE.Vector3();
    const leftN = new THREE.Vector3();
    const p = new THREE.Vector3().copy(pos);

    for (let i = 0; i <= segments; i += 1) {
        tangent.copy(heading);
        leftN.set(-tangent.z, 0, tangent.x).normalize();
        const halfW = pathWidth * 0.5;
        const leftP = new THREE.Vector3().copy(p).addScaledVector(leftN, +halfW);
        const rightP = new THREE.Vector3().copy(p).addScaledVector(leftN, -halfW);
        const base = i * 2 * 3;
        arr[base + 0] = leftP.x; arr[base + 1] = leftP.y; arr[base + 2] = leftP.z;
        arr[base + 3] = rightP.x; arr[base + 4] = rightP.y; arr[base + 5] = rightP.z;
        p.addScaledVector(heading, ds);
        heading.applyAxisAngle(UP, curvature * ds).normalize();
    }
    positionAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
}

export function createControlsPathRibbonGeometry(segments = 24) {
    const geometry = new THREE.BufferGeometry();
    const count = (segments + 1) * 2;
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const indices = [];
    for (let i = 0; i < segments; i += 1) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(indices);
    return geometry;
}

/** Compact arc polyline points for Analysis/Replay 2D summaries. */
export function sampleControlsArcPoints(pose, steeringAngleRad, options = {}) {
    const wheelbase = Math.max(0.1, Number(options.wheelbase) || 1.5);
    const lookahead = Number(options.lookahead) || 8;
    const segments = Math.max(2, Math.floor(Number(options.segments) || 16));
    const curvature = Math.tan(Number(steeringAngleRad) || 0) / wheelbase;
    const heading = new THREE.Vector3(Math.cos(Number(pose?.yaw) || 0), 0, -Math.sin(Number(pose?.yaw) || 0));
    const p = new THREE.Vector3(Number(pose?.position?.x) || 0, 0, Number(pose?.position?.z) || 0);
    const ds = lookahead / segments;
    const points = [];
    for (let i = 0; i <= segments; i += 1) {
        points.push({ x: p.x, y: p.y, z: p.z });
        p.addScaledVector(heading, ds);
        heading.applyAxisAngle(UP, curvature * ds).normalize();
    }
    return points;
}
