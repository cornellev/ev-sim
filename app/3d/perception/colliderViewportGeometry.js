import { vehicleBox } from "../../physics/PhysicsEngine.js";
import { orientedBoxCenter } from "../../physics/SweptConvex.js";
import { worldSweepMesh } from "../../simulation/world/RigidBodyRecords.js";

const FLOOR_GRID_CELL_M = 10;

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function mesh(vertices, triangles) {
    if (!Array.isArray(vertices) || vertices.length < 3 || !Array.isArray(triangles) || triangles.length === 0) return null;
    const positions = new Float32Array(vertices.length * 3);
    for (let index = 0; index < vertices.length; index += 1) {
        const vertex = vertices[index];
        const x = finite(vertex?.[0] ?? vertex?.x);
        const y = finite(vertex?.[1] ?? vertex?.y);
        const z = finite(vertex?.[2] ?? vertex?.z);
        if (x === null || y === null || z === null) return null;
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
    }
    const indices = [];
    for (const triangle of triangles) {
        const [a, b, c] = triangle ?? [];
        if ([a, b, c].some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) continue;
        indices.push(a, b, c);
    }
    if (indices.length === 0) return null;
    return { kind: "mesh", positions, indices: new Uint32Array(indices) };
}

function extrudeFootprint(obstacle) {
    const footprint = obstacle?.footprint;
    const minY = finite(obstacle?.minY);
    const maxY = finite(obstacle?.maxY);
    if (!Array.isArray(footprint) || footprint.length < 3 || minY === null || maxY === null) return null;
    const vertices = [];
    for (const point of footprint) {
        const x = finite(point?.x);
        const z = finite(point?.z);
        if (x === null || z === null) return null;
        vertices.push([x, minY, z]);
    }
    const count = footprint.length;
    for (let index = 0; index < count; index += 1) {
        vertices.push([vertices[index][0], maxY, vertices[index][2]]);
    }
    const triangles = [];
    for (const triangle of obstacle.triangles ?? []) {
        const [a, b, c] = triangle ?? [];
        if ([a, b, c].some((index) => !Number.isInteger(index) || index < 0 || index >= count)) continue;
        triangles.push([a, b, c], [count + a, count + c, count + b]);
    }
    for (let index = 0; index < count; index += 1) {
        const next = (index + 1) % count;
        triangles.push([index, next, count + next], [index, count + next, count + index]);
    }
    return mesh(vertices, triangles);
}

function boxFromBounds(bounds) {
    const minX = finite(bounds?.min?.x);
    const minY = finite(bounds?.min?.y);
    const minZ = finite(bounds?.min?.z);
    const maxX = finite(bounds?.max?.x);
    const maxY = finite(bounds?.max?.y);
    const maxZ = finite(bounds?.max?.z);
    if ([minX, minY, minZ, maxX, maxY, maxZ].some((value) => value === null)) return null;
    const size = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
    return {
        kind: "box",
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
        yaw: 0,
        size,
    };
}

/** Shape the vehicle sweep tests. The Rapier bounds cuboid on the entry is ignored. */
export function staticContactShape(entry) {
    if (!entry) return null;
    if (entry.convex) return mesh(entry.convex.vertices, entry.convex.triangles);
    if (entry.obstacle) return extrudeFootprint(entry.obstacle);
    return boxFromBounds(entry.bounds);
}

export function vehicleContactBox(vehicle) {
    if (!vehicle) return null;
    const box = vehicleBox(vehicle);
    const origin = vehicle.position ?? {};
    return {
        kind: "box",
        center: orientedBoxCenter({
            x: finite(origin.x) ?? 0,
            y: finite(origin.y) ?? 0,
            z: finite(origin.z) ?? 0,
        }, box),
        yaw: box.yaw,
        size: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
    };
}

export function rigidBodyContactMesh(state) {
    const body = state?.body;
    if (typeof body?.translation !== "function" || typeof body?.rotation !== "function") return null;
    const swept = worldSweepMesh(state.parts, body.translation(), body.rotation());
    return mesh(swept.vertices, swept.triangles);
}

function shapeBounds(shape) {
    if (!shape) return null;
    if (shape.kind === "box") {
        const halfX = shape.size.x / 2;
        const halfY = shape.size.y / 2;
        const halfZ = shape.size.z / 2;
        const yaw = shape.yaw || 0;
        const cosine = Math.abs(Math.cos(yaw));
        const sine = Math.abs(Math.sin(yaw));
        const extentX = cosine * halfX + sine * halfZ;
        const extentZ = sine * halfX + cosine * halfZ;
        return {
            min: { x: shape.center.x - extentX, y: shape.center.y - halfY, z: shape.center.z - extentZ },
            max: { x: shape.center.x + extentX, y: shape.center.y + halfY, z: shape.center.z + extentZ },
        };
    }
    const positions = shape.positions;
    if (!positions?.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
        minX = Math.min(minX, positions[index]);
        minY = Math.min(minY, positions[index + 1]);
        minZ = Math.min(minZ, positions[index + 2]);
        maxX = Math.max(maxX, positions[index]);
        maxY = Math.max(maxY, positions[index + 1]);
        maxZ = Math.max(maxZ, positions[index + 2]);
    }
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function unionBounds(shapes) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const shape of shapes) {
        const bounds = shapeBounds(shape);
        if (!bounds) continue;
        minX = Math.min(minX, bounds.min.x);
        minY = Math.min(minY, bounds.min.y);
        minZ = Math.min(minZ, bounds.min.z);
        maxX = Math.max(maxX, bounds.max.x);
        maxY = Math.max(maxY, bounds.max.y);
        maxZ = Math.max(maxZ, bounds.max.z);
    }
    if (!Number.isFinite(minX)) return null;
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function snappedSpan(min, max) {
    const start = Math.floor((min - FLOOR_GRID_CELL_M) / FLOOR_GRID_CELL_M) * FLOOR_GRID_CELL_M;
    const end = Math.ceil((max + FLOOR_GRID_CELL_M) / FLOOR_GRID_CELL_M) * FLOOR_GRID_CELL_M;
    return [start, end <= start ? start + FLOOR_GRID_CELL_M : end];
}

function floorColliderActive(physics) {
    const plane = physics?.preparedWorldDescription?.groundPlane;
    return (physics?.rigidBodyStates?.length ?? 0) > 0
        && plane?.collider !== false
        && finite(plane?.y) !== null;
}

function floorContactGrid(physics, shapes) {
    if (!floorColliderActive(physics)) return null;
    const y = finite(physics.preparedWorldDescription.groundPlane.y);
    const bounds = unionBounds(shapes) ?? { min: { x: 0, z: 0 }, max: { x: 0, z: 0 } };
    const [minX, maxX] = snappedSpan(bounds.min.x, bounds.max.x);
    const [minZ, maxZ] = snappedSpan(bounds.min.z, bounds.max.z);
    // shortcut: grid covers the other colliders, not the full 10 km floor, upgrade if the slab edge must be visible.
    const positions = [];
    for (let x = minX; x <= maxX + 1e-6; x += FLOOR_GRID_CELL_M) {
        positions.push(x, y, minZ, x, y, maxZ);
    }
    for (let z = minZ; z <= maxZ + 1e-6; z += FLOOR_GRID_CELL_M) {
        positions.push(minX, y, z, maxX, y, z);
    }
    return { y, minX, maxX, minZ, maxZ, positions: Float32Array.from(positions) };
}

function listed(value) {
    return Array.isArray(value) ? value : [];
}

function rigidBodyOwns(entry, ids) {
    if (!ids?.size) return false;
    if (ids.has(String(entry.contactId)) || ids.has(String(entry.id))) return true;
    const sourceId = entry.obstacle?.sourceId;
    return sourceId !== undefined && ids.has(String(sourceId));
}

/** Static contact entries from a world description, skipping rigid-body hosts. */
export function descriptionContactEntries(description) {
    if (!Array.isArray(description?.obstacles)) return [];
    const rigidIds = new Set(listed(description.rigidBodies).map((body) => String(body.id)));
    return [
        ...description.obstacles.map((obstacle) => ({
            id: String(obstacle.id),
            contactId: String(obstacle.id),
            obstacle,
            bounds: obstacle.bounds,
        })),
        ...listed(description.assetProxies).flatMap((instance) => listed(instance.collision).map((convex) => ({
            id: String(convex.id),
            contactId: String(instance.sourceId),
            convex,
            bounds: convex.bounds,
        }))),
        ...listed(description.primitives).map((solid) => ({
            id: String(solid.id),
            contactId: String(solid.sourceId),
            convex: solid,
            bounds: solid.bounds,
        })),
    ].filter((entry) => !rigidBodyOwns(entry, rigidIds));
}

function spawnRigidBodies(description) {
    return listed(description?.rigidBodies).map((spec) => ({
        id: spec.id,
        parts: spec.parts,
        body: {
            translation: () => spec.position ?? { x: 0, y: 0, z: 0 },
            rotation: () => spec.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
        },
    }));
}

/**
 * Colliders for a world whose physics world has not been built yet.
 * `staticColliders` is the array passed in, so the caller can keep it stable.
 */
export function unconfiguredColliderSource(description, vehicles, staticColliders = descriptionContactEntries(description)) {
    return {
        staticColliders,
        vehicleStates: listed(vehicles).map((vehicle) => ({ vehicle })),
        rigidBodyStates: spawnRigidBodies(description),
        preparedWorldDescription: description ?? null,
    };
}

/**
 * Contact shapes for the collider viewport. Pass the previous result to keep
 * static meshes when the collider list is the same array.
 */
export function colliderViewportGeometry(physics, previous = null) {
    const staticSource = Array.isArray(physics?.staticColliders) ? physics.staticColliders : null;
    const reuseStatic = previous?.staticSource === staticSource;
    const staticShapes = reuseStatic
        ? previous.staticShapes
        : listed(staticSource).map(staticContactShape).filter(Boolean);
    const vehicles = listed(physics?.vehicleStates).map((state) => vehicleContactBox(state?.vehicle)).filter(Boolean);
    const rigidBodies = listed(physics?.rigidBodyStates).map((state, index) => {
        const shape = rigidBodyContactMesh(state);
        return shape ? { ...shape, id: String(state?.id ?? index) } : null;
    }).filter(Boolean);
    return {
        staticSource,
        staticShapes,
        vehicles,
        rigidBodies,
        floor: floorContactGrid(physics, [...staticShapes, ...vehicles, ...rigidBodies]),
    };
}
