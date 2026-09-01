import { assertPhysicsBackendSelection, PHYSICS_BACKEND_CONFIG } from "./PhysicsBackend.js";
import { compareUtf8 } from "../simulation/world/WorldDescription.js";

function vector(value = {}) {
    return { x: Number(value.x || 0), y: Number(value.y || 0), z: Number(value.z || 0) };
}

function bounds(center, half) {
    return {
        min: { x: center.x - half.x, y: center.y - half.y, z: center.z - half.z },
        max: { x: center.x + half.x, y: center.y + half.y, z: center.z + half.z },
    };
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

function movingInterval(start, end, half, axis, target, current) {
    const startCenter = start.x * axis.x + start.z * axis.z;
    const endCenter = end.x * axis.x + end.z * axis.z;
    const delta = endCenter - startCenter;
    const radius = Math.abs(axis.x) * half.x + Math.abs(axis.z) * half.z;
    if (Math.abs(delta) <= 1e-15) {
        if (startCenter + radius < target.min || startCenter - radius > target.max) return null;
        return current;
    }
    const first = (target.min - (startCenter + radius)) / delta;
    const second = (target.max - (startCenter - radius)) / delta;
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

/** Continuous XZ SAT plus a continuous Y-slab test for an AABB and triangle prism. */
export function sweepAabbTrianglePrism(start, end, half, points, minY, maxY) {
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
        interval = movingInterval(start, end, half, axis, projectionInterval(points, axis), interval);
        if (!interval || interval.entry > interval.exit) return null;
    }
    interval = movingYInterval(start, end, half, minY, maxY, interval);
    if (!interval || interval.entry > interval.exit || interval.exit < 0 || interval.entry > 1) return null;
    return Math.max(0, interval.entry);
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
    let firstImpact = null;
    for (const triangle of obstacle.triangles ?? []) {
        const points = triangle.map((index) => obstacle.footprint[index]);
        if (points.some((point) => !point)) continue;
        const impact = sweepAabbTrianglePrism(start, end, half, points, obstacle.minY, obstacle.maxY);
        if (impact !== null && (firstImpact === null || impact < firstImpact)) firstImpact = impact;
    }
    return firstImpact;
}

function vehicleHalfExtents(vehicle) {
    const dimensions = vehicle.collisionDimensions || vehicle.dimensions || { x: 1, y: 1, z: 1 };
    return {
        x: Math.max(0.01, Number(dimensions.x || 1) / 2),
        y: Math.max(0.01, Number(dimensions.y || 1) / 2),
        z: Math.max(0.01, Number(dimensions.z || 1) / 2),
    };
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
        this.activeContacts = new Set();
        this.pendingContacts = new Set();
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
        if (worldDescription) assertPhysicsBackendSelection(backendSelection);
        this.preparedManifest = manifest;
        this.preparedEnvironmentManifest = legacyEnvironmentManifest;
        this.preparedWorldDescription = worldDescription;
        this.preparedBackendSelection = backendSelection;
        this.resetRun();
    }

    _buildStaticColliders() {
        this._createWorld();
        const worldObstacles = this.preparedWorldDescription?.obstacles;
        const entries = Array.isArray(worldObstacles)
            ? worldObstacles.map((obstacle) => ({
                id: String(obstacle.id),
                bounds: obstacle.bounds,
                footprint: obstacle.footprint,
                triangles: obstacle.triangles,
                minY: obstacle.minY,
                maxY: obstacle.maxY,
                obstacle,
            }))
            : [...(this.data.objects?.()?.boxes?.() || [])]
                .map((box, index) => {
                    const center = vector(box.position);
                    const half = { x: box.scale.x / 2, y: box.scale.y / 2, z: box.scale.z / 2 };
                    return {
                        id: `environment-${String(index + 1).padStart(5, "0")}`,
                        bounds: bounds(center, half),
                        box,
                    };
                })
                .sort((left, right) => JSON.stringify(left.bounds).localeCompare(JSON.stringify(right.bounds)));
        this.staticColliders = entries
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
            this.world.createCollider(this.RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), body);
            this.rigidbodies.push(body);
            return { id, vehicle, half, previous: position, body };
        });
    }

    beginStep() {
        for (const state of this.vehicleStates) state.previous = vector(state.vehicle.position);
    }

    step(deltaTime) {
        if (!this.world) return;
        this.pendingContacts = new Set();
        for (const state of this.vehicleStates) {
            const candidate = vector(state.vehicle.position);
            const hits = [];
            for (const obstacle of this.staticColliders) {
                const time = obstacle.obstacle
                    ? sweepWorldObstacle(state.previous, candidate, state.half, obstacle)
                    : sweepAabb(state.previous, candidate, state.half, obstacle.bounds);
                if (time === null) continue;
                hits.push({ id: obstacle.id, time });
            }
            const impact = hits.reduce((minimum, hit) => Math.min(minimum, hit.time), 1);
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
            }
        }

        for (let leftIndex = 0; leftIndex < this.vehicleStates.length; leftIndex += 1) {
            const left = this.vehicleStates[leftIndex];
            for (let rightIndex = leftIndex + 1; rightIndex < this.vehicleStates.length; rightIndex += 1) {
                const right = this.vehicleStates[rightIndex];
                const leftCandidate = vector(left.vehicle.position);
                const rightCandidate = vector(right.vehicle.position);
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
                const impact = sweepAabb(relativeStart, relativeEnd, left.half, bounds({ x: 0, y: 0, z: 0 }, right.half));
                if (impact === null) continue;
                this.pendingContacts.add(`${left.id}|${right.id}`);
                const safeImpact = Math.max(0, impact - 1e-9);
                left.vehicle.updatePosition?.({
                    x: left.previous.x + (leftCandidate.x - left.previous.x) * safeImpact,
                    y: left.previous.y + (leftCandidate.y - left.previous.y) * safeImpact,
                    z: left.previous.z + (leftCandidate.z - left.previous.z) * safeImpact,
                });
                right.vehicle.updatePosition?.({
                    x: right.previous.x + (rightCandidate.x - right.previous.x) * safeImpact,
                    y: right.previous.y + (rightCandidate.y - right.previous.y) * safeImpact,
                    z: right.previous.z + (rightCandidate.z - right.previous.z) * safeImpact,
                });
            }
        }

        for (const state of this.vehicleStates) {
            const position = vector(state.vehicle.position);
            state.body.setNextKinematicTranslation(position);
        }
        this.world.timestep = deltaTime;
        this.world.step();
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
        if (this.RAPIER) {
            this._buildStaticColliders();
            this._buildVehicleStates();
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
    }

    async stop() {}
}
