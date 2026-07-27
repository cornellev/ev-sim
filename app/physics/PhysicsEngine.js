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

export class PhysicsEngine {
    constructor(data, { loadPhysics = () => import("@dimforge/rapier3d") } = {}) {
        this.data = data;
        this.RAPIER = null;
        this.world = null;
        this.rigidbodies = [];
        this.staticColliders = [];
        this.vehicleStates = [];
        this.activeContacts = new Set();
        this.pendingContacts = new Set();
        this._initialization = loadPhysics().then((module) => {
            this.RAPIER = module.default || module;
            this._createWorld();
            return this.world;
        });
    }

    _createWorld() {
        this.world?.free?.();
        this.world = new this.RAPIER.World({ x: 0, y: -9.81, z: 0 });
        this.rigidbodies = [];
    }

    async start() {
        await this._initialization;
    }

    async configureRun() {
        await this._initialization;
        this._createWorld();
        const boxes = [...(this.data.objects?.()?.boxes?.() || [])]
            .map((box) => ({ box, key: [box.position.x, box.position.y, box.position.z, box.scale.x, box.scale.y, box.scale.z].join(":" ) }))
            .sort((left, right) => left.key.localeCompare(right.key));
        this.staticColliders = boxes.map(({ box }, index) => {
            const center = vector(box.position);
            const half = { x: box.scale.x / 2, y: box.scale.y / 2, z: box.scale.z / 2 };
            const id = `environment-${String(index + 1).padStart(5, "0")}`;
            const body = this.world.createRigidBody(this.RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z));
            this.world.createCollider(this.RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z), body);
            this.rigidbodies.push(body);
            return { id, center, half, bounds: bounds(center, half), body };
        });
        this._buildVehicleStates();
        this.resetRun();
    }

    _buildVehicleStates() {
        const vehicles = [...(this.data.vehicles?.()?.vehicles || [])]
            .map((vehicle, index) => ({ vehicle, id: stableVehicleId(vehicle, index) }))
            .sort((left, right) => left.id.localeCompare(right.id));
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
            let impact = 1;
            for (const obstacle of this.staticColliders) {
                const time = sweepAabb(state.previous, candidate, state.half, obstacle.bounds);
                if (time === null) continue;
                impact = Math.min(impact, time);
                this.pendingContacts.add(`${state.id}|${obstacle.id}`);
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
        const started = [...this.pendingContacts].filter((key) => !this.activeContacts.has(key)).sort();
        const ended = [...this.activeContacts].filter((key) => !this.pendingContacts.has(key)).sort();
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
        return { started, ended, active: [...this.activeContacts].sort() };
    }

    resetRun() {
        this.activeContacts.clear();
        this.pendingContacts.clear();
        for (const state of this.vehicleStates) {
            state.previous = vector(state.vehicle.position);
            state.body?.setNextKinematicTranslation?.(state.previous);
        }
    }

    async stop() {}
}
