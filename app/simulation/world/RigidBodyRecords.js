/**
 * Optional rigid-body component and the spawn collider compiled from geometry
 * that already exists. The component is the reset pose's mass and forces.
 * The live pose stays on the physics step.
 */

import { getBuiltinPropAsset } from "../../3d/editor/objects/types/builtinProp.js";
import { assetBindingRevisionVersion, readAssetBinding } from "../../editor-assets/AssetBackedObject.js";
import { localPrimitiveMesh } from "./PrimitiveSolids.js";
import { normalizePrimitiveRecord } from "./PrimitiveRecords.js";

export const RIGID_BODY_HOSTS = new Set(["primitive", "asset-instance", "builtin-prop"]);

const BOX_TRIANGLES = Object.freeze([
    [0, 1, 3], [0, 3, 2],
    [4, 6, 7], [4, 7, 5],
    [0, 4, 5], [0, 5, 1],
    [2, 3, 7], [2, 7, 6],
    [0, 2, 6], [0, 6, 4],
    [1, 5, 7], [1, 7, 3],
]);

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value.values === "function") return [...value.values()];
    return [];
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function defaultRigidBody() {
    return {
        bodyType: "dynamic",
        mass: 1,
        useGravity: true,
        linearDamping: 0,
        angularDamping: 0,
        constantForce: { x: 0, y: 0, z: 0 },
    };
}

/** Structural copy. Invalid numbers stay invalid so validation can reject them. */
export function normalizeRigidBody(value) {
    if (!isPlainObject(value)) return value;
    const defaults = defaultRigidBody();
    const force = isPlainObject(value.constantForce) ? value.constantForce : null;
    return {
        bodyType: value.bodyType === undefined ? defaults.bodyType : value.bodyType,
        mass: value.mass === undefined ? defaults.mass : value.mass,
        useGravity: value.useGravity === undefined ? defaults.useGravity : value.useGravity,
        linearDamping: value.linearDamping === undefined ? defaults.linearDamping : value.linearDamping,
        angularDamping: value.angularDamping === undefined ? defaults.angularDamping : value.angularDamping,
        constantForce: force ? {
            x: force.x === undefined ? 0 : force.x,
            y: force.y === undefined ? 0 : force.y,
            z: force.z === undefined ? 0 : force.z,
        } : value.constantForce === undefined ? { ...defaults.constantForce } : value.constantForce,
    };
}

export function rigidBodyFieldIssues(value) {
    const issues = [];
    if (!isPlainObject(value)) return ["rigidBody must be an object."];
    if (value.bodyType !== "dynamic" && value.bodyType !== "kinematic") issues.push("bodyType must be dynamic or kinematic.");
    if (typeof value.mass !== "number" || !Number.isFinite(value.mass) || value.mass <= 0) issues.push("mass must be a positive number.");
    if (typeof value.useGravity !== "boolean") issues.push("useGravity must be true or false.");
    for (const key of ["linearDamping", "angularDamping"]) {
        if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) issues.push(`${key} must be a non-negative number.`);
    }
    const force = value.constantForce;
    if (!isPlainObject(force) || ["x", "y", "z"].some((axis) => typeof force[axis] !== "number" || !Number.isFinite(force[axis]))) {
        issues.push("constantForce must be a finite xyz vector.");
    }
    return issues;
}

function directionYaw(dir) {
    const normalized = ((Math.floor(Number(dir) || 0) % 4) + 4) % 4;
    return normalized * Math.PI * 0.5;
}

export function yawQuaternion(yaw) {
    const half = finite(yaw, 0) / 2;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

function assetMetric(document, record) {
    const asset = readAssetBinding(record);
    if (!asset || assetBindingRevisionVersion(record) !== 2) return null;
    return list(document?.assetMetrics?.definitions).find((entry) => (
        entry.assetId === asset.assetId && entry.revision === asset.revision
    )) ?? null;
}

/** Why this record cannot wear a rigid body, or null when the collider source exists. */
export function rigidBodyShapeIssue(document, record) {
    const typeId = record?.typeId;
    if (!RIGID_BODY_HOSTS.has(typeId)) return `A ${typeId || "object"} cannot have a rigid body.`;
    if (typeId === "primitive") {
        const solid = list(document?.primitives).find((entry) => String(entry.id) === String(record.id));
        return solid ? null : "This primitive has no solid.";
    }
    if (typeId === "builtin-prop") {
        const feature = list(document?.features).find((entry) => String(entry.id) === String(record.id));
        return feature && getBuiltinPropAsset(feature.type) ? null : "This prop has no collision size.";
    }
    const metric = assetMetric(document, record);
    return metric && (metric.collision?.length ?? 0) > 0 ? null : "This asset instance has no collision proxy.";
}

function cuboidPart(half, offset = { x: 0, y: 0, z: 0 }) {
    return {
        kind: "cuboid",
        half: { x: half.x, y: half.y, z: half.z },
        offset: { x: offset.x, y: offset.y, z: offset.z },
    };
}

function convexPart(vertices, triangles) {
    return {
        kind: "convex",
        offset: { x: 0, y: 0, z: 0 },
        vertices: vertices.map((vertex) => [vertex[0], vertex[1], vertex[2]]),
        triangles: triangles.map((triangle) => [...triangle]),
    };
}

function compileParts(document, record) {
    if (record.typeId === "primitive") {
        const primitive = normalizePrimitiveRecord(list(document.primitives).find((entry) => String(entry.id) === String(record.id)));
        const frame = {
            position: { ...primitive.position },
            rotation: yawQuaternion(primitive.rotationY),
        };
        if (primitive.shape === "box") {
            return { frame, parts: [cuboidPart({ x: primitive.size.x / 2, y: primitive.size.y / 2, z: primitive.size.z / 2 })] };
        }
        if (primitive.shape === "sphere") {
            return { frame, parts: [{ kind: "ball", radius: primitive.size.x / 2, offset: { x: 0, y: 0, z: 0 } }] };
        }
        const mesh = localPrimitiveMesh(primitive);
        return { frame, parts: [convexPart(mesh.vertices, mesh.triangles)] };
    }
    if (record.typeId === "builtin-prop") {
        const feature = list(document.features).find((entry) => String(entry.id) === String(record.id));
        const asset = getBuiltinPropAsset(feature.type);
        const yaw = finite(feature.rotationY, 0) + (asset.metric.directional ? directionYaw(feature.dir) : 0);
        return {
            frame: {
                position: { x: finite(feature.x, 0), y: 0, z: finite(feature.z, 0) },
                rotation: yawQuaternion(yaw),
            },
            parts: [cuboidPart(
                { x: asset.metric.size.x / 2, y: asset.metric.size.y / 2, z: asset.metric.size.z / 2 },
                { x: 0, y: asset.metric.centerY, z: 0 },
            )],
        };
    }
    const asset = readAssetBinding(record);
    const metric = assetMetric(document, record);
    const scale = asset.scale ?? { x: 1, y: 1, z: 1 };
    const parts = metric.collision.map((proxy) => convexPart(
        proxy.vertices.map((vertex) => [vertex[0] * scale.x, vertex[1] * scale.y, vertex[2] * scale.z]),
        proxy.triangles,
    ));
    return {
        frame: {
            position: { x: finite(asset.position?.x, 0), y: finite(asset.position?.y, 0), z: finite(asset.position?.z, 0) },
            rotation: yawQuaternion(asset.rotationY),
        },
        parts,
    };
}

export function compileRigidBodies(document) {
    const records = (document?.objects ?? []).filter((record) => record?.components?.rigidBody !== undefined);
    if (records.length === 0) return [];
    return records.map((record) => {
        const spec = normalizeRigidBody(record.components.rigidBody);
        const fieldIssue = rigidBodyFieldIssues(spec)[0];
        if (fieldIssue) throw new TypeError(`Rigid body "${record.id}" ${fieldIssue}`);
        const shapeIssue = rigidBodyShapeIssue(document, record);
        if (shapeIssue) throw new TypeError(`Rigid body "${record.id}": ${shapeIssue}`);
        const compiled = compileParts(document, record);
        return {
            id: String(record.id),
            host: record.typeId,
            bodyType: spec.bodyType,
            mass: spec.mass,
            useGravity: spec.useGravity,
            linearDamping: spec.linearDamping,
            angularDamping: spec.angularDamping,
            constantForce: { ...spec.constantForce },
            position: compiled.frame.position,
            rotation: compiled.frame.rotation,
            parts: compiled.parts,
        };
    }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function rotateQuaternion(rotation, vector) {
    const { x: qx, y: qy, z: qz, w: qw } = rotation;
    const { x: vx, y: vy, z: vz } = vector;
    const dot = qx * vx + qy * vy + qz * vz;
    const cross = { x: qy * vz - qz * vy, y: qz * vx - qx * vz, z: qx * vy - qy * vx };
    const scale = qw * qw - (qx * qx + qy * qy + qz * qz);
    return {
        x: 2 * dot * qx + scale * vx + 2 * qw * cross.x,
        y: 2 * dot * qy + scale * vy + 2 * qw * cross.y,
        z: 2 * dot * qz + scale * vz + 2 * qw * cross.z,
    };
}

function conjugate(rotation) {
    return { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w };
}

/** Move an authored world point from the spawn frame into the live frame. */
export function transformRigidBodyPoint(point, pose) {
    const origin = pose.spawnPosition ?? { x: 0, y: 0, z: 0 };
    const local = rotateQuaternion(conjugate(pose.spawnRotation ?? { x: 0, y: 0, z: 0, w: 1 }), {
        x: point.x - origin.x,
        y: point.y - origin.y,
        z: point.z - origin.z,
    });
    const world = rotateQuaternion(pose.rotation ?? pose.spawnRotation ?? { x: 0, y: 0, z: 0, w: 1 }, local);
    return {
        x: pose.position.x + world.x,
        y: pose.position.y + world.y,
        z: pose.position.z + world.z,
    };
}

function cuboidVertices(half, offset) {
    const vertices = [];
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                vertices.push([
                    offset.x + sx * half.x,
                    offset.y + sy * half.y,
                    offset.z + sz * half.z,
                ]);
            }
        }
    }
    return { vertices, triangles: BOX_TRIANGLES.map((triangle) => [...triangle]) };
}

function ballVertices(radius, offset) {
    const r = radius;
    return {
        vertices: [
            [offset.x + r, offset.y, offset.z], [offset.x - r, offset.y, offset.z],
            [offset.x, offset.y + r, offset.z], [offset.x, offset.y - r, offset.z],
            [offset.x, offset.y, offset.z + r], [offset.x, offset.y, offset.z - r],
        ],
        triangles: [
            [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
            [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
        ],
    };
}

function localSweepMesh(part) {
    const offset = part.offset ?? { x: 0, y: 0, z: 0 };
    if (part.kind === "cuboid") return cuboidVertices(part.half, offset);
    if (part.kind === "ball") return ballVertices(part.radius, offset);
    return {
        vertices: part.vertices.map((vertex) => [vertex[0] + offset.x, vertex[1] + offset.y, vertex[2] + offset.z]),
        triangles: part.triangles.map((triangle) => [...triangle]),
    };
}

export function worldSweepMesh(parts, translation, rotation) {
    const vertices = [];
    const triangles = [];
    for (const part of parts ?? []) {
        const local = localSweepMesh(part);
        const base = vertices.length;
        for (const vertex of local.vertices) {
            const rotated = rotateQuaternion(rotation, { x: vertex[0], y: vertex[1], z: vertex[2] });
            vertices.push([translation.x + rotated.x, translation.y + rotated.y, translation.z + rotated.z]);
        }
        for (const triangle of local.triangles) triangles.push(triangle.map((index) => index + base));
    }
    const bounds = vertices.length === 0 ? null : {
        min: {
            x: Math.min(...vertices.map((vertex) => vertex[0])),
            y: Math.min(...vertices.map((vertex) => vertex[1])),
            z: Math.min(...vertices.map((vertex) => vertex[2])),
        },
        max: {
            x: Math.max(...vertices.map((vertex) => vertex[0])),
            y: Math.max(...vertices.map((vertex) => vertex[1])),
            z: Math.max(...vertices.map((vertex) => vertex[2])),
        },
    };
    return { vertices, triangles, bounds };
}
