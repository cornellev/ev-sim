import { assertPhysicsBackendSelection, PHYSICS_BACKEND_CONFIG } from "./PhysicsBackend.js";
import { catchContactFloor, contactBicycleBody } from "../simulation/vehicles/contactBicycle.js";
import { absorbDynamicClamp, dynamicBicycleBody } from "../simulation/vehicles/dynamicBicycle.js";
import { worldSweepMesh } from "../simulation/world/RigidBodyRecords.js";
import { compareUtf8 } from "../simulation/world/WorldDescription.js";
import { boxSupportRadius, obbAsConvex, orientedBoxCenter, sweepAabbConvex, sweepObbConvex, sweepObbConvexHit } from "./SweptConvex.js";

const DYNAMIC_GROUP = 0x0002;
const FLOOR_GROUP = 0x0008;

function collisionGroups(membership, filter) {
    return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

function vector(value = {}) {
    return { x: Number(value.x || 0), y: Number(value.y || 0), z: Number(value.z || 0) };
}

function bounds(center, half) {
    return {
        min: { x: center.x - half.x, y: center.y - half.y, z: center.z - half.z },
        max: { x: center.x + half.x, y: center.y + half.y, z: center.z + half.z },
    };
}

export const SUPPORT_PLANE_EPSILON = 1e-6;

/**
 * Keep a kinematic origin on or above a horizontal support plane. Only Y
 * changes. A start already below the plane is lifted. Motion that would
 * finish below the plane stops on it and keeps its horizontal result.
 */
export function supportPlanePosition(previous, candidate, planeY) {
    const startY = Number(previous?.y) || 0;
    const endY = Number(candidate?.y) || 0;
    const position = {
        x: Number(candidate?.x) || 0,
        y: endY,
        z: Number(candidate?.z) || 0,
    };
    if (startY < planeY - SUPPORT_PLANE_EPSILON || endY < planeY - SUPPORT_PLANE_EPSILON) {
        position.y = planeY;
        return { position, held: true };
    }
    if (Math.abs(endY - planeY) <= SUPPORT_PLANE_EPSILON) {
        position.y = planeY;
        return { position, held: true };
    }
    return { position, held: false };
}

export function aabbIntersects(left, right) {
    return left.min.x <= right.max.x && left.max.x >= right.min.x
        && left.min.y <= right.max.y && left.max.y >= right.min.y
        && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

/** Return the normalized first-impact time for a moving axis-aligned box. */
export function sweepAabb(start, end, half, target) {
    const startBounds = bounds(start, half);
    if (aabbIntersects(startBounds, target)) return 0;
    const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
    let entry = -Infinity;
    let exit = Infinity;
    for (const axis of ["x", "y", "z"]) {
        if (delta[axis] === 0) {
            if (startBounds.max[axis] < target.min[axis] || startBounds.min[axis] > target.max[axis]) return null;
            continue;
        }
        const first = (target.min[axis] - startBounds.max[axis]) / delta[axis];
        const second = (target.max[axis] - startBounds.min[axis]) / delta[axis];
        entry = Math.max(entry, Math.min(first, second));
        exit = Math.min(exit, Math.max(first, second));
    }
    if (entry > exit || exit < 0 || entry > 1) return null;
    return Math.max(0, entry);
}

function projectionInterval(points, axis) {
    const values = points.map((point) => point.x * axis.x + point.z * axis.z);
    return { min: Math.min(...values), max: Math.max(...values) };
}

function movingInterval(start, end, half, axis, target, current, radius = null) {
    const startCenter = start.x * axis.x + start.z * axis.z;
    const endCenter = end.x * axis.x + end.z * axis.z;
    const delta = endCenter - startCenter;
    const extent = radius ?? (Math.abs(axis.x) * half.x + Math.abs(axis.z) * half.z);
    if (Math.abs(delta) <= 1e-15) {
        if (startCenter + extent < target.min || startCenter - extent > target.max) return null;
        return current;
    }
    const first = (target.min - (startCenter + extent)) / delta;
    const second = (target.max - (startCenter - extent)) / delta;
    return {
        entry: Math.max(current.entry, Math.min(first, second)),
        exit: Math.min(current.exit, Math.max(first, second)),
    };
}

function movingYInterval(start, end, half, minY, maxY, current) {
    const delta = end.y - start.y;
    if (Math.abs(delta) <= 1e-15) {
        if (start.y + half.y < minY || start.y - half.y > maxY) return null;
        return current;
    }
    const first = (minY - (start.y + half.y)) / delta;
    const second = (maxY - (start.y - half.y)) / delta;
    return {
        entry: Math.max(current.entry, Math.min(first, second)),
        exit: Math.min(current.exit, Math.max(first, second)),
    };
}

/** Continuous XZ SAT plus a continuous Y-slab test for a yaw-oriented box and a triangle prism. */
export function sweepObbTrianglePrism(start, end, box, points, minY, maxY) {
    const startCenter = orientedBoxCenter(start, box);
    const endCenter = orientedBoxCenter(end, box);
    const axes = [{ x: 1, z: 0 }, { x: 0, z: 1 }];
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const next = points[(index + 1) % points.length];
        const edge = { x: next.x - point.x, z: next.z - point.z };
        if (Math.abs(edge.x) + Math.abs(edge.z) <= 1e-15) continue;
        axes.push({ x: -edge.z, z: edge.x });
    }
    let interval = { entry: -Infinity, exit: Infinity };
    for (const axis of axes) {
        const radius = boxSupportRadius([axis.x, 0, axis.z], box);
        interval = movingInterval(startCenter, endCenter, box.half, axis, projectionInterval(points, axis), interval, radius);
        if (!interval || interval.entry > interval.exit) return null;
    }
    interval = movingYInterval(startCenter, endCenter, box.half, minY, maxY, interval);
    if (!interval || interval.entry > interval.exit || interval.exit < 0 || interval.entry > 1) return null;
    return Math.max(0, interval.entry);
}

/** Yaw-zero, center-zero wrapper around {@link sweepObbTrianglePrism}. */
export function sweepAabbTrianglePrism(start, end, half, points, minY, maxY) {
    return sweepObbTrianglePrism(start, end, { half, center: { x: 0, y: 0, z: 0 }, yaw: 0 }, points, minY, maxY);
}

function axisAlignedRectangle(obstacle) {
    const points = obstacle.footprint;
    if (!Array.isArray(points) || points.length !== 4) return false;
    return points.every((point, index) => {
        const next = points[(index + 1) % points.length];
        return Math.abs(point.x - next.x) <= 1e-12 || Math.abs(point.z - next.z) <= 1e-12;
    });
}

function sweepWorldObstacle(start, end, half, obstacle) {
    if (axisAlignedRectangle(obstacle)) return sweepAabb(start, end, half, obstacle.bounds);
    return sweepObbWorldObstacle(start, end, { half, center: { x: 0, y: 0, z: 0 }, yaw: 0 }, obstacle);
}

function aabbAsConvex(target) {
    const center = {
        x: (target.min.x + target.max.x) / 2,
        y: (target.min.y + target.max.y) / 2,
        z: (target.min.z + target.max.z) / 2,
    };
    const half = {
        x: (target.max.x - target.min.x) / 2,
        y: (target.max.y - target.min.y) / 2,
        z: (target.max.z - target.min.z) / 2,
    };
    return obbAsConvex(center, { half, center: { x: 0, y: 0, z: 0 }, yaw: 0 });
}

function sweepObbWorldObstacle(start, end, box, obstacle) {
    if (axisAlignedRectangle(obstacle)) return sweepObbConvex(start, end, box, aabbAsConvex(obstacle.bounds));
    let firstImpact = null;
    for (const triangle of obstacle.triangles ?? []) {
        const points = triangle.map((index) => obstacle.footprint[index]);
        if (points.some((point) => !point)) continue;
        const impact = sweepObbTrianglePrism(start, end, box, points, obstacle.minY, obstacle.maxY);
        if (impact !== null && (firstImpact === null || impact < firstImpact)) firstImpact = impact;
    }
    return firstImpact;
}

const ALIGNED_BOX_EPSILON = 1e-12;

function isWorldAlignedBox(box) {
    return Math.abs(Math.sin(box.yaw)) <= ALIGNED_BOX_EPSILON
        && Math.abs(box.center.x) <= ALIGNED_BOX_EPSILON
        && Math.abs(box.center.y) <= ALIGNED_BOX_EPSILON
        && Math.abs(box.center.z) <= ALIGNED_BOX_EPSILON;
}

function vehicleBox(vehicle) {
    return {
        half: vehicleHalfExtents(vehicle),
        center: vector(vehicle.collisionCenter),
        yaw: Number(vehicle.rotation?.y) || 0,
    };
}

function yawQuaternion(yaw) {
    const half = (Number(yaw) || 0) / 2;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/** A kinematic plant follows the clamped pose and keeps its commanded speed. */
function absorbKinematicClamp(vehicle, position) {
    const plant = vehicle?.plant;
    if (!plant?.position || plant === dynamicBicycleBody(vehicle)) return;
    plant.position.x = position.x;
    plant.position.y = position.y;
    plant.position.z = position.z;
}

/** Drop the part of the step that points into an already-overlapping body. */
function motionClearOfOverlaps(previous, candidate, overlaps) {
    const delta = {
        x: candidate.x - previous.x,
        y: candidate.y - previous.y,
        z: candidate.z - previous.z,
    };
    for (const hit of overlaps) {
        const normal = hit.normal;
        if (!normal) continue;
        const into = delta.x * normal[0] + delta.y * normal[1] + delta.z * normal[2];
        if (into <= 0) continue;
        delta.x -= into * normal[0];
        delta.y -= into * normal[1];
        delta.z -= into * normal[2];
    }
    return {
        x: previous.x + delta.x,
        y: previous.y + delta.y,
        z: previous.z + delta.z,
    };
}

function horizontalPushAxis(normal, pose, origin) {
    const horizontal = Math.hypot(normal?.[0] ?? 0, normal?.[2] ?? 0);
    if (horizontal > 1e-4) return { x: normal[0] / horizontal, z: normal[2] / horizontal };
    const nx = pose.x - origin.x;
    const nz = pose.z - origin.z;
    const length = Math.hypot(nx, nz);
    if (length <= 1e-8) return null;
    return { x: nx / length, z: nz / length };
}

function sweepVehicleObstacle(start, end, box, obstacle) {
    if (isWorldAlignedBox(box)) {
        if (obstacle.convex) return sweepAabbConvex(start, end, box.half, obstacle.convex);
        if (obstacle.obstacle) return sweepWorldObstacle(start, end, box.half, obstacle);
        return sweepAabb(start, end, box.half, obstacle.bounds);
    }
    if (obstacle.convex) return sweepObbConvex(start, end, box, obstacle.convex);
    if (obstacle.obstacle) return sweepObbWorldObstacle(start, end, box, obstacle);
    return sweepObbConvex(start, end, box, aabbAsConvex(obstacle.bounds));
}

function vehicleHalfExtents(vehicle) {
    const dimensions = vehicle.collisionDimensions || vehicle.dimensions || { x: 1, y: 1, z: 1 };
    return {
        x: Math.max(0.01, Number(dimensions.x || 1) / 2),
        y: Math.max(0.01, Number(dimensions.y || 1) / 2),
        z: Math.max(0.01, Number(dimensions.z || 1) / 2),
    };
}

function rigidBodyOwnsEntry(entry, ids) {
    if (!ids?.size) return false;
    if (ids.has(String(entry.contactId)) || ids.has(String(entry.id))) return true;
    const sourceId = entry.obstacle?.sourceId;
    return sourceId !== undefined && ids.has(String(sourceId));
}

function stableVehicleId(vehicle, index) {
    return String(vehicle.telemetryId || vehicle.manifestId || `vehicle-${String(index + 1).padStart(4, "0")}`);
}

const rapierInitByModule = new WeakMap();

function rapierFromModule(module) {
    return module?.default || module;
}

function initializeRapier(module) {
    const rapier = rapierFromModule(module);
    const init = module?.init ?? rapier?.init;
    if (typeof init !== "function") return Promise.resolve(rapier);
    const key = typeof rapier === "object" && rapier ? rapier : module;
    let pending = rapierInitByModule.get(key);
    if (!pending) {
        pending = Promise.resolve(init.call(rapier ?? module)).then(() => rapier, (error) => {
            rapierInitByModule.delete(key);
            throw error;
        });
        rapierInitByModule.set(key, pending);
    }
    return pending;
}

export class PhysicsEngine {
    constructor(data, { loadPhysics = () => import("@dimforge/rapier3d-compat") } = {}) {
        this.data = data;
        this.RAPIER = null;
        this.world = null;
        this.rigidbodies = [];
        this.staticColliders = [];
        this.vehicleStates = [];
        this.rigidBodyStates = [];
        this.rigidBodyById = new Map();
        this._rigidBodyPoses = [];
        this.forceQueue = [];
        this._pushes = [];
        this.activeContacts = new Set();
        this.pendingContacts = new Set();
        this.episodeObstacles = [];
        this._initialization = loadPhysics().then(async (module) => {
            this.RAPIER = await initializeRapier(module);
            return this.RAPIER;
        });
    }

    _releaseWorld() {
        const world = this.world;
        const bodies = this.rigidbodies;
        this.world = null;
        this.rigidbodies = [];
        this.staticColliders = [];
        this.vehicleStates = [];
        this.rigidBodyStates = [];
        this.rigidBodyById = new Map();
        this._rigidBodyPoses = [];
        if (!world) return;
        if (typeof world.removeRigidBody === "function") {
            for (const body of bodies) {
                try {
                    if (body && body.isValid?.() !== false) world.removeRigidBody(body);
                } catch {
                    // A stale wrapper must not block the rest of teardown.
                }
            }
        }
        try {
            world.free?.();
        } catch {
            // Rapier's wasm-bindgen .free() takes ownership. If a body, collider,
            // or in-flight step still borrows the world, that throw must not
            // prevent environment switches from finishing.
        }
    }

    _createWorld() {
        if (!this.RAPIER) return;
        this._releaseWorld();
        this.world = new this.RAPIER.World(PHYSICS_BACKEND_CONFIG.gravity);
        this.rigidbodies = [];
        this.staticColliders = [];
        this.vehicleStates = [];
    }

    async start() {
        await this._initialization;
        if (!this.world) this._createWorld();
    }

    async configureRun(configuration = null, legacyEnvironmentManifest = null) {
        await this._initialization;
        const legacy = configuration && !Object.hasOwn(configuration, "manifest");
        const manifest = legacy ? configuration : configuration?.manifest ?? null;
        const worldDescription = legacy ? null : configuration?.worldDescription ?? null;
        const backendSelection = legacy ? null : configuration?.backendSelection ?? null;
        if (worldDescription) assertPhysicsBackendSelection(backendSelection, worldDescription);
        this.preparedManifest = manifest;
        this.preparedEnvironmentManifest = legacyEnvironmentManifest;
        this.preparedWorldDescription = worldDescription;
        this.preparedBackendSelection = backendSelection;
        this.resetRun();
    }

    setEpisodeObstacles(obstacles = []) {
        this.episodeObstacles = Array.isArray(obstacles) ? [...obstacles] : [];
    }

    _buildStaticColliders() {
        this._createWorld();
        const worldObstacles = this.preparedWorldDescription?.obstacles;
        const episodeEntries = (this.episodeObstacles ?? []).map((obstacle) => ({
            id: String(obstacle.id),
            contactId: String(obstacle.id),
            bounds: obstacle.bounds,
            footprint: obstacle.footprint,
            triangles: obstacle.triangles,
            minY: obstacle.minY,
            maxY: obstacle.maxY,
            obstacle,
        }));
        const entries = Array.isArray(worldObstacles)
            ? [
                ...worldObstacles.map((obstacle) => ({
                id: String(obstacle.id),
                contactId: String(obstacle.id),
                bounds: obstacle.bounds,
                footprint: obstacle.footprint,
                triangles: obstacle.triangles,
                minY: obstacle.minY,
                maxY: obstacle.maxY,
                obstacle,
                })),
                ...episodeEntries,
                ...(this.preparedWorldDescription?.assetProxies ?? []).flatMap((instance) => (
                    (instance.collision ?? []).map((convex) => ({
                        id: String(convex.id),
                        contactId: String(instance.sourceId),
                        bounds: convex.bounds,
                        convex,
                    }))
                )),
                ...(this.preparedWorldDescription?.primitives ?? []).map((solid) => ({
                    id: String(solid.id),
                    contactId: String(solid.sourceId),
                    bounds: solid.bounds,
                    convex: solid,
                })),
            ]
            : [
                ...[...(this.data.objects?.()?.boxes?.() || [])]
                    .map((box, index) => {
                        const center = vector(box.position);
                        const half = { x: box.scale.x / 2, y: box.scale.y / 2, z: box.scale.z / 2 };
                        return {
                            id: `environment-${String(index + 1).padStart(5, "0")}`,
                            bounds: bounds(center, half),
                            box,
                        };
                    })
                    .sort((left, right) => JSON.stringify(left.bounds).localeCompare(JSON.stringify(right.bounds))),
                ...episodeEntries,
            ];
        const rigidIds = new Set((this.preparedWorldDescription?.rigidBodies ?? []).map((body) => String(body.id)));
        this.staticColliders = entries
            .filter((entry) => !rigidBodyOwnsEntry(entry, rigidIds))
            .sort((left, right) => compareUtf8(left.id, right.id))
            .map((entry) => {
            const center = {
                x: (entry.bounds.min.x + entry.bounds.max.x) / 2,
                y: (entry.bounds.min.y + entry.bounds.max.y) / 2,
                z: (entry.bounds.min.z + entry.bounds.max.z) / 2,
            };
            const half = {
                x: Math.max(0.001, (entry.bounds.max.x - entry.bounds.min.x) / 2),
                y: Math.max(0.001, (entry.bounds.max.y - entry.bounds.min.y) / 2),
                z: Math.max(0.001, (entry.bounds.max.z - entry.bounds.min.z) / 2),
            };
            const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z));
            this.world.createCollider(this.RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), body);
            this.rigidbodies.push(body);
            return { ...entry, center, half, body };
        });
    }

    _buildVehicleStates() {
        const vehicles = [...(this.data.vehicles?.()?.vehicles || [])]
            .map((vehicle, index) => ({ vehicle, id: stableVehicleId(vehicle, index) }))
            .sort((left, right) => compareUtf8(left.id, right.id));
        this.vehicleStates = vehicles.map(({ vehicle, id }) => {
            const half = vehicleHalfExtents(vehicle);
            const position = vector(vehicle.position);
            const descriptor = this.RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position.x, position.y, position.z);
            const body = this.world.createRigidBody(descriptor);
            const center = vector(vehicle.collisionCenter);
            const collider = this.RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z);
            if (center.x || center.y || center.z) collider.setTranslation?.(center.x, center.y, center.z);
            this.world.createCollider(collider, body);
            this.rigidbodies.push(body);
            return { id, vehicle, half, previous: position, body };
        });
    }

    _rigidBodyCollider(part) {
        let descriptor;
        if (part.kind === "cuboid") descriptor = this.RAPIER.ColliderDesc.cuboid(part.half.x, part.half.y, part.half.z);
        else if (part.kind === "ball") descriptor = this.RAPIER.ColliderDesc.ball(part.radius);
        else {
            const points = new Float32Array(part.vertices.length * 3);
            part.vertices.forEach((vertex, index) => {
                points[index * 3] = vertex[0];
                points[index * 3 + 1] = vertex[1];
                points[index * 3 + 2] = vertex[2];
            });
            descriptor = this.RAPIER.ColliderDesc.convexHull(points);
            if (!descriptor) throw new TypeError("Rigid body convex hull failed.");
        }
        descriptor.setDensity(0);
        const offset = part.offset ?? { x: 0, y: 0, z: 0 };
        if (offset.x || offset.y || offset.z) descriptor.setTranslation(offset.x, offset.y, offset.z);
        descriptor.setCollisionGroups(collisionGroups(DYNAMIC_GROUP, 0xffff));
        return descriptor;
    }

    _buildFloorCollider() {
        const plane = this.preparedWorldDescription?.groundPlane;
        if (plane?.collider === false) return;
        const y = Number(plane?.y);
        if (!Number.isFinite(y)) return;
        const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed().setTranslation(0, y - 0.5, 0));
        const descriptor = this.RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000);
        descriptor.setCollisionGroups(collisionGroups(FLOOR_GROUP, DYNAMIC_GROUP));
        this.world.createCollider(descriptor, body);
        this.rigidbodies.push(body);
    }

    _buildRigidBodies() {
        this.rigidBodyStates = [];
        this.rigidBodyById = new Map();
        this._rigidBodyPoses = [];
        const specs = this.preparedWorldDescription?.rigidBodies ?? [];
        if (!this.world || specs.length === 0) return;
        this._buildFloorCollider();
        for (const spec of specs) {
            const dynamic = spec.bodyType !== "kinematic";
            const descriptor = (dynamic ? this.RAPIER.RigidBodyDesc.dynamic() : this.RAPIER.RigidBodyDesc.kinematicPositionBased())
                .setTranslation(spec.position.x, spec.position.y, spec.position.z)
                .setRotation(spec.rotation)
                .setLinearDamping(spec.linearDamping)
                .setAngularDamping(spec.angularDamping)
                .setGravityScale(dynamic && spec.useGravity ? 1 : 0)
                .setCcdEnabled(dynamic);
            const body = this.world.createRigidBody(descriptor);
            for (const part of spec.parts) this.world.createCollider(this._rigidBodyCollider(part), body);
            body.setAdditionalMass(spec.mass, true);
            body.recomputeMassPropertiesFromColliders?.();
            this.rigidbodies.push(body);
            const state = {
                id: spec.id,
                host: spec.host,
                spec,
                body,
                parts: spec.parts,
                spawnPosition: spec.position,
                spawnRotation: spec.rotation,
            };
            this.rigidBodyStates.push(state);
            this.rigidBodyById.set(spec.id, state);
        }
        this._publishRigidBodyPoses();
    }

    _rigidBodyObstacles() {
        return this.rigidBodyStates.flatMap((state) => {
            const mesh = worldSweepMesh(state.parts, state.body.translation(), state.body.rotation());
            if (mesh.vertices.length < 4) return [];
            return [{ id: state.id, contactId: state.id, convex: mesh, bounds: mesh.bounds, rigidBody: true }];
        });
    }

    // shortcut: hull backoff leaves no penetration, so the kinematic car does not push; match its remaining closing speed.
    _queueRigidBodyPush(vehicleState, candidate, deltaTime, hits, impact) {
        if (!this.rigidBodyStates.length || !deltaTime) return;
        const previous = vehicleState.previous;
        const velocity = { x: (candidate.x - previous.x) / deltaTime, z: (candidate.z - previous.z) / deltaTime };
        const origin = vector(vehicleState.vehicle.position);
        for (const hit of hits) {
            if (hit.separate || hit.time > impact + 1e-12) continue;
            const state = this.rigidBodyById.get(hit.id);
            if (!state || state.spec.bodyType !== "dynamic") continue;
            const pose = state.body.translation();
            const axis = horizontalPushAxis(hit.normal, pose, origin);
            if (!axis) continue;
            const into = velocity.x * axis.x + velocity.z * axis.z;
            const linvel = state.body.linvel?.() ?? {};
            const carried = (Number(linvel.x) || 0) * axis.x + (Number(linvel.z) || 0) * axis.z;
            const remaining = into - carried;
            if (!(remaining > 0)) continue;
            const reportedMass = Number(state.body.mass?.());
            const mass = Number.isFinite(reportedMass) && reportedMass > 0 ? reportedMass : state.spec.mass;
            this._pushes.push({
                id: state.id,
                impulse: { x: axis.x * mass * remaining, y: 0, z: axis.z * mass * remaining },
            });
        }
    }

    // shortcut: a second car adds its own depth after the first car already moved the body.
    _separateOverlaps(overlaps) {
        for (const hit of overlaps) {
            if (!(hit.depth > 0) || !hit.normal) continue;
            const state = this.rigidBodyById.get(hit.id);
            const pose = state?.body?.translation?.();
            if (!pose || typeof state.body.setTranslation !== "function") continue;
            state.body.setTranslation({
                x: pose.x + hit.normal[0] * hit.depth,
                y: pose.y + hit.normal[1] * hit.depth,
                z: pose.z + hit.normal[2] * hit.depth,
            }, true);
        }
    }

    _stepRigidBodies() {
        if (!this.rigidBodyStates.length) return;
        for (const state of this.rigidBodyStates) {
            if (state.spec.bodyType === "kinematic") {
                state.body.setNextKinematicTranslation?.(state.spawnPosition);
                state.body.setNextKinematicRotation?.(state.spawnRotation);
                continue;
            }
            state.body.resetForces?.(true);
            const force = state.spec.constantForce;
            if (force && (force.x || force.y || force.z)) state.body.addForce(force, true);
        }
        for (const entry of this.forceQueue.splice(0)) {
            const state = this.rigidBodyById.get(entry.id);
            if (!state || state.spec.bodyType !== "dynamic") continue;
            if (entry.kind === "impulse") state.body.applyImpulse(entry.value, true);
            else state.body.addForce(entry.value, true);
        }
        for (const push of this._pushes.splice(0)) {
            const state = this.rigidBodyById.get(push.id);
            if (!state || state.spec.bodyType !== "dynamic") continue;
            state.body.applyImpulse(push.impulse, true);
        }
    }

    _publishRigidBodyPoses() {
        this._rigidBodyPoses = this.rigidBodyStates.map((state) => {
            const translation = state.body.translation();
            const rotation = state.body.rotation();
            return {
                id: state.id,
                host: state.host,
                position: { x: translation.x, y: translation.y, z: translation.z },
                rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
                spawnPosition: { ...state.spawnPosition },
                spawnRotation: { ...state.spawnRotation },
            };
        }).sort((left, right) => compareUtf8(left.id, right.id));
    }

    applyForce(id, force) {
        this.forceQueue.push({ id: String(id), kind: "force", value: vector(force) });
    }

    applyImpulse(id, impulse) {
        this.forceQueue.push({ id: String(id), kind: "impulse", value: vector(impulse) });
    }

    rigidBodyPoses() {
        return this._rigidBodyPoses ?? [];
    }

    beginStep() {
        for (const state of this.vehicleStates) state.previous = vector(state.vehicle.position);
    }

    step(deltaTime) {
        if (!this.world) return;
        this.pendingContacts = new Set();
        this._pushes = [];
        const obstacles = this.rigidBodyStates.length
            ? [...this.staticColliders, ...this._rigidBodyObstacles()]
            : this.staticColliders;
        for (const state of this.vehicleStates) {
            const candidate = vector(state.vehicle.position);
            const box = vehicleBox(state.vehicle);
            const hits = [];
            for (const obstacle of obstacles) {
                const time = sweepVehicleObstacle(state.previous, candidate, box, obstacle);
                if (time === null) continue;
                const swept = obstacle.rigidBody
                    ? sweepObbConvexHit(state.previous, candidate, box, obstacle.convex)
                    : null;
                const separate = Boolean(obstacle.rigidBody)
                    && time <= 1e-12
                    && this.rigidBodyById.get(obstacle.id)?.spec.bodyType === "dynamic";
                hits.push({
                    id: obstacle.contactId ?? obstacle.id,
                    time,
                    normal: swept?.normal ?? null,
                    depth: swept?.depth ?? 0,
                    separate,
                });
            }
            const collapsed = new Map();
            for (const hit of hits) {
                const previous = collapsed.get(hit.id);
                if (!previous || hit.time < previous.time) collapsed.set(hit.id, hit);
            }
            hits.splice(0, hits.length, ...[...collapsed.values()].sort((left, right) => compareUtf8(left.id, right.id)));
            const overlaps = hits.filter((hit) => hit.separate);
            const impact = hits.reduce((minimum, hit) => (hit.separate ? minimum : Math.min(minimum, hit.time)), 1);
            for (const hit of hits.filter((entry) => entry.time <= impact + 1e-12)) {
                this.pendingContacts.add(`${state.id}|${hit.id}`);
            }
            if (impact < 1) {
                const safeImpact = Math.max(0, impact - 1e-9);
                const clamped = {
                    x: state.previous.x + (candidate.x - state.previous.x) * safeImpact,
                    y: state.previous.y + (candidate.y - state.previous.y) * safeImpact,
                    z: state.previous.z + (candidate.z - state.previous.z) * safeImpact,
                };
                state.vehicle.updatePosition?.(clamped);
                if (!state.vehicle.updatePosition && state.vehicle.position) Object.assign(state.vehicle.position, clamped);
                absorbDynamicClamp(state.vehicle, clamped, state.previous, candidate);
            } else if (overlaps.length) {
                const slid = motionClearOfOverlaps(state.previous, candidate, overlaps);
                state.vehicle.updatePosition?.(slid);
                if (!state.vehicle.updatePosition && state.vehicle.position) Object.assign(state.vehicle.position, slid);
            }
            this._queueRigidBodyPush(state, candidate, deltaTime, hits, impact);
            this._separateOverlaps(overlaps);
            const plane = this.preparedWorldDescription?.groundPlane;
            if (plane && Number.isFinite(Number(plane.y))) {
                const contact = contactBicycleBody(state.vehicle);
                const current = vector(contact?.position ?? state.vehicle.position);
                const supported = supportPlanePosition(state.previous, current, Number(plane.y));
                if (contact) catchContactFloor(contact, Number(plane.y), supported.held);
                if (supported.held) {
                    state.vehicle.updatePosition?.(supported.position);
                    if (!state.vehicle.updatePosition && state.vehicle.position) Object.assign(state.vehicle.position, supported.position);
                    this.pendingContacts.add(`${state.id}|ground:floor`);
                }
            }
        }

        for (let leftIndex = 0; leftIndex < this.vehicleStates.length; leftIndex += 1) {
            const left = this.vehicleStates[leftIndex];
            for (let rightIndex = leftIndex + 1; rightIndex < this.vehicleStates.length; rightIndex += 1) {
                const right = this.vehicleStates[rightIndex];
                const leftCandidate = vector(left.vehicle.position);
                const rightCandidate = vector(right.vehicle.position);
                const leftBox = vehicleBox(left.vehicle);
                const rightBox = vehicleBox(right.vehicle);
                let impact;
                if (isWorldAlignedBox(leftBox) && isWorldAlignedBox(rightBox)) {
                    const relativeStart = {
                        x: left.previous.x - right.previous.x,
                        y: left.previous.y - right.previous.y,
                        z: left.previous.z - right.previous.z,
                    };
                    const relativeEnd = {
                        x: leftCandidate.x - rightCandidate.x,
                        y: leftCandidate.y - rightCandidate.y,
                        z: leftCandidate.z - rightCandidate.z,
                    };
                    impact = sweepAabb(relativeStart, relativeEnd, leftBox.half, bounds({ x: 0, y: 0, z: 0 }, rightBox.half));
                } else {
                    const end = {
                        x: left.previous.x + (leftCandidate.x - left.previous.x) - (rightCandidate.x - right.previous.x),
                        y: left.previous.y + (leftCandidate.y - left.previous.y) - (rightCandidate.y - right.previous.y),
                        z: left.previous.z + (leftCandidate.z - left.previous.z) - (rightCandidate.z - right.previous.z),
                    };
                    impact = sweepObbConvex(left.previous, end, leftBox, obbAsConvex(right.previous, rightBox));
                }
                if (impact === null) continue;
                this.pendingContacts.add(`${left.id}|${right.id}`);
                const safeImpact = Math.max(0, impact - 1e-9);
                const leftClamped = {
                    x: left.previous.x + (leftCandidate.x - left.previous.x) * safeImpact,
                    y: left.previous.y + (leftCandidate.y - left.previous.y) * safeImpact,
                    z: left.previous.z + (leftCandidate.z - left.previous.z) * safeImpact,
                };
                const rightClamped = {
                    x: right.previous.x + (rightCandidate.x - right.previous.x) * safeImpact,
                    y: right.previous.y + (rightCandidate.y - right.previous.y) * safeImpact,
                    z: right.previous.z + (rightCandidate.z - right.previous.z) * safeImpact,
                };
                left.vehicle.updatePosition?.(leftClamped);
                right.vehicle.updatePosition?.(rightClamped);
                absorbDynamicClamp(left.vehicle, leftClamped, left.previous, leftCandidate);
                absorbDynamicClamp(right.vehicle, rightClamped, right.previous, rightCandidate);
            }
        }

        for (const state of this.vehicleStates) {
            const position = vector(state.vehicle.position);
            absorbKinematicClamp(state.vehicle, position);
            state.body.setNextKinematicTranslation(position);
            state.body.setNextKinematicRotation?.(yawQuaternion(state.vehicle.rotation?.y));
        }
        this._stepRigidBodies();
        this.world.timestep = deltaTime;
        this.world.step();
        this._publishRigidBodyPoses();
    }

    syncAndPublishContacts({ step = 0, timeNs = 0 } = {}) {
        const started = [...this.pendingContacts].filter((key) => !this.activeContacts.has(key)).sort(compareUtf8);
        const ended = [...this.activeContacts].filter((key) => !this.pendingContacts.has(key)).sort(compareUtf8);
        const store = this.data.bindings?.()?.signalStore;
        const emit = (name, key) => {
            const [firstId, secondId] = key.split("|");
            store?.emitTelemetryEvent?.({
                timeUs: Math.round(timeNs / 1000),
                category: "contacts",
                name,
                severity: "info",
                payload: { firstId, secondId, step },
            });
        };
        for (const key of started) emit("contact-start", key);
        for (const key of ended) emit("contact-end", key);
        this.activeContacts = new Set(this.pendingContacts);
        return { started, ended, active: [...this.activeContacts].sort(compareUtf8) };
    }

    resetRun() {
        this.forceQueue = [];
        this._pushes = [];
        if (this.RAPIER) {
            this._buildStaticColliders();
            this._buildVehicleStates();
            this._buildRigidBodies();
        }
        this.activeContacts.clear();
        this.pendingContacts.clear();
        for (const state of this.vehicleStates) {
            state.previous = vector(state.vehicle.position);
            state.body?.setNextKinematicTranslation?.(state.previous);
        }
    }

    getDeterministicState() {
        return {
            activeContacts: [...this.activeContacts].sort(compareUtf8),
            pendingContacts: [...this.pendingContacts].sort(compareUtf8),
            vehicles: this.vehicleStates.map((state) => ({
                id: state.id,
                previous: vector(state.previous),
            })),
            ...(this.rigidBodyStates.length > 0 ? { rigidBodies: this._rigidBodyPoses } : {}),
        };
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        this._releaseWorld();
        this.activeContacts.clear();
        this.pendingContacts.clear();
        this.preparedManifest = null;
        this.preparedEnvironmentManifest = null;
        this.preparedWorldDescription = null;
        this.preparedBackendSelection = null;
        this.episodeObstacles = [];
        this.forceQueue = [];
        this._pushes = [];
    }

    async stop() {}
}
