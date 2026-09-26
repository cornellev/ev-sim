/**
 * Bicycle-model path ribbon geometry shared by live controls overlays and replay.
 * Steering uses Three.js plant convention (positive right).
 * Ribbon vertices are vehicle-local (+X forward, +Y up, +Z left); callers apply
 * {@link applyControlsPathRibbonPose} so elevation, yaw, and pitch follow the plant.
 */

import * as THREE from "three";
import { vehicleForwardTangent } from "../scenarios/route/geometry.js";

const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_PATH_Y = 0.05;

function finiteOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Ackermann centerline in vehicle-local XZ. +X is forward. Steering uses the
 * Three.js plant sign (positive right), matching {@link updateControlsPathRibbon}.
 * This function does not touch Three.js.
 * @param {number} steeringAngleRad
 * @param {{ wheelbase?: number, lookahead?: number, segments?: number }} [options]
 * @returns {{ x: number, z: number }[]}
 */
export function sampleAckermannCenterline(steeringAngleRad, options = {}) {
    const wheelbase = Math.max(0.1, finiteOr(options.wheelbase, 1.5));
    const lookahead = finiteOr(options.lookahead, 8);
    const segments = Math.max(2, Math.floor(finiteOr(options.segments, 24)));
    const curvature = Math.tan(finiteOr(steeringAngleRad, 0)) / wheelbase;
    const ds = lookahead / segments;
    let x = 0;
    let z = 0;
    let headingX = 1;
    let headingZ = 0;
    const points = [];
    for (let index = 0; index <= segments; index += 1) {
        points.push({ x, z });
        x += headingX * ds;
        z += headingZ * ds;
        const turn = curvature * ds;
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const nextX = headingX * cos + headingZ * sin;
        const nextZ = -headingX * sin + headingZ * cos;
        headingX = nextX;
        headingZ = nextZ;
    }
    return points;
}

/**
 * Fill a ribbon BufferGeometry (2 verts per segment) along an Ackermann arc
 * in vehicle-local coordinates. Origin is (0, pathY, 0), heading is +X.
 * @param {THREE.BufferGeometry} geometry
 * @param {{ position?: {x,y,z}, yaw?: number, rotation?: {x,y,z,order} }} [_pose] Plant pose; mesh placement uses {@link applyControlsPathRibbonPose}.
 * @param {number} steeringAngleRad Three.js plant steering
 * @param {{ wheelbase?: number, lookahead?: number, segments?: number, pathWidth?: number, pathY?: number }} options
 */
export function updateControlsPathRibbon(geometry, _pose, steeringAngleRad, options = {}) {
    const wheelbase = Math.max(0.1, finiteOr(options.wheelbase, 1.5));
    const lookahead = finiteOr(options.lookahead, 8);
    const segments = Math.max(2, Math.floor(finiteOr(options.segments, 24)));
    const pathWidth = finiteOr(options.pathWidth, 0.35);
    const pathY = finiteOr(options.pathY, DEFAULT_PATH_Y);
    const curvature = Math.tan(finiteOr(steeringAngleRad, 0)) / wheelbase;

    const pos = new THREE.Vector3(0, pathY, 0);
    const heading = new THREE.Vector3(1, 0, 0);

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

/** Place a local-space control ribbon on the plant pose (position + Euler XYZ). */
export function applyControlsPathRibbonPose(object3d, pose) {
    if (!object3d) return object3d;
    const position = pose?.position || {};
    object3d.position.set(
        Number(position.x) || 0,
        Number(position.y) || 0,
        Number(position.z) || 0,
    );
    const rotation = pose?.rotation || {};
    object3d.rotation.set(
        Number(rotation.x) || 0,
        Number(rotation.y ?? pose?.yaw) || 0,
        Number(rotation.z) || 0,
        rotation.order || "XYZ",
    );
    return object3d;
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

/** Compact arc polyline points for Analysis/Replay 2D summaries (world XZ). */
export function sampleControlsArcPoints(pose, steeringAngleRad, options = {}) {
    const wheelbase = Math.max(0.1, finiteOr(options.wheelbase, 1.5));
    const lookahead = finiteOr(options.lookahead, 8);
    const segments = Math.max(2, Math.floor(finiteOr(options.segments, 16)));
    const curvature = Math.tan(finiteOr(steeringAngleRad, 0)) / wheelbase;
    const yaw = finiteOr(pose?.yaw ?? pose?.rotation?.y, 0);
    const tangent = vehicleForwardTangent(yaw);
    const heading = new THREE.Vector3(tangent.x, 0, tangent.z);
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
