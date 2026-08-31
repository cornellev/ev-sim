import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";
import { normalizeVehicleManifest } from "../../vehicles/VehicleManifest.js";

export const VEHICLE_PLANT_KIND = "cev-sim.vehicle-plant";
export const VEHICLE_PLANT_VERSION = 1;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function vector(value = {}) {
    return { x: finite(value?.x), y: finite(value?.y), z: finite(value?.z) };
}

function rotation(value = {}) {
    return { ...vector(value), order: String(value?.order || "XYZ") };
}

function pose(value = {}) {
    return { position: vector(value?.position), rotation: rotation(value?.rotation) };
}

function normalizeKeyframes(keyframes = []) {
    return keyframes
        .filter((frame) => frame && Number.isFinite(Number(frame.x)) && Number.isFinite(Number(frame.y)))
        .map((frame, index) => ({
            t: finite(frame.t, index),
            x: finite(frame.x),
            y: finite(frame.y),
            yaw: finite(frame.yaw),
            velocity: finite(frame.velocity),
        }))
        .sort((left, right) => left.t - right.t || left.x - right.x || left.y - right.y);
}

function normalizeManifest(value, type) {
    const source = value ?? getBuiltInVehicleManifest(type);
    if (!source) throw new Error(`Resolved vehicle manifest "${type}" is required by the headless plant.`);
    return normalizeVehicleManifest(source, { allowMissingKind: true });
}

export function createVehiclePlantDefinition(entry = {}, dependency = null, options = {}) {
    const type = String(entry.type || dependency?.vehicleId || options.type || "big-car");
    const manifest = normalizeManifest(dependency?.manifest ?? options.manifest, type);
    const keyframes = normalizeKeyframes(entry.keyframes ?? options.keyframes ?? []);
    let motionModel = options.motionModel;
    if (!motionModel) motionModel = type === "scenario-car" ? "scenario-keyframes" : "bicycle";
    if (!new Set(["bicycle", "scenario-keyframes", "linear"]).has(motionModel)) {
        throw new TypeError(`Unknown vehicle motion model "${motionModel}".`);
    }
    return {
        kind: VEHICLE_PLANT_KIND,
        version: VEHICLE_PLANT_VERSION,
        id: String(entry.id || options.id || manifest.id),
        vehicleManifestId: manifest.id,
        motionModel,
        initialPose: pose(entry.pose ?? options.pose),
        initialLinearVelocity: vector(entry.linearVelocity ?? options.linearVelocity),
        initialLinearAcceleration: vector(entry.linearAcceleration ?? options.linearAcceleration),
        initialSteeringAngle: finite(entry.steeringAngle ?? options.steeringAngle),
        dimensions: { ...vector(manifest.boundingBox?.size) },
        boundingBoxCenter: vector(manifest.boundingBox?.center),
        kinematics: { ...manifest.kinematics },
        keyframes,
        scenario: {
            lift: finite(options.lift ?? entry.pose?.position?.y),
            freezeAtEnd: options.freezeAtEnd !== false,
            playbackRate: finite(options.playbackRate, 1),
            autoplay: options.autoplay !== false,
        },
    };
}

function lerp(left, right, alpha) {
    return left + (right - left) * alpha;
}

function lerpAngle(left, right, alpha) {
    const tau = Math.PI * 2;
    const delta = ((right - left + Math.PI) % tau + tau) % tau - Math.PI;
    return left + delta * alpha;
}

export class KinematicVehiclePlant {
    constructor(definition) {
        if (definition?.kind !== VEHICLE_PLANT_KIND || definition?.version !== VEHICLE_PLANT_VERSION) {
            throw new TypeError(`KinematicVehiclePlant requires ${VEHICLE_PLANT_KIND} v${VEHICLE_PLANT_VERSION}.`);
        }
        this.definition = structuredClone(definition);
        this.id = definition.id;
        this.telemetryId = definition.id;
        this.vehicleManifestId = definition.vehicleManifestId;
        this.manifestId = definition.vehicleManifestId;
        this.motionModel = definition.motionModel;
        this.collisionDimensions = { ...definition.dimensions };
        this.dimensions = this.collisionDimensions;
        this.kinematics = { ...definition.kinematics };
        this.keyframes = definition.keyframes.map((frame) => ({ ...frame }));
        this.position = vector();
        this.rotation = rotation();
        this.velocity = vector();
        this.acceleration = vector();
        this.steeringAngle = 0;
        this.elapsedTime = 0;
        this.started = false;
        this.completed = false;
        this.currentSpeed = 0;
        this.isPlaying = definition.scenario.autoplay;
        this.resetRunState({
            pose: definition.initialPose,
            linearVelocity: definition.initialLinearVelocity,
            linearAcceleration: definition.initialLinearAcceleration,
            steeringAngle: definition.initialSteeringAngle,
        });
    }

    updatePosition(value) {
        Object.assign(this.position, vector(value));
    }

    updateRotation(value) {
        Object.assign(this.rotation, rotation(value));
    }

    resetRunState(entry = {}) {
        const sourcePose = pose(entry.pose ?? this.definition.initialPose);
        Object.assign(this.position, sourcePose.position);
        Object.assign(this.rotation, sourcePose.rotation);
        Object.assign(this.velocity, vector(entry.linearVelocity ?? this.definition.initialLinearVelocity));
        Object.assign(this.acceleration, vector(entry.linearAcceleration ?? this.definition.initialLinearAcceleration));
        this.steeringAngle = finite(entry.steeringAngle, this.definition.initialSteeringAngle);
        this.elapsedTime = 0;
        this.completed = false;
        this.started = true;
        this.isPlaying = this.definition.scenario.autoplay;
        if (this.motionModel === "scenario-keyframes" && this.keyframes.length > 0) {
            this.applyScenarioState(this.keyframes[0]);
        }
        return this.getDeterministicState();
    }

    sampleScenarioState(timeSeconds) {
        if (this.keyframes.length === 0) return null;
        if (this.keyframes.length === 1) return this.keyframes[0];
        const first = this.keyframes[0];
        const last = this.keyframes[this.keyframes.length - 1];
        if (timeSeconds <= first.t) return first;
        if (timeSeconds >= last.t) return last;
        for (let index = 1; index < this.keyframes.length; index += 1) {
            const previous = this.keyframes[index - 1];
            const next = this.keyframes[index];
            if (timeSeconds > next.t) continue;
            const span = Math.max(next.t - previous.t, Number.EPSILON);
            const alpha = (timeSeconds - previous.t) / span;
            return {
                t: timeSeconds,
                x: lerp(previous.x, next.x, alpha),
                y: lerp(previous.y, next.y, alpha),
                yaw: lerpAngle(previous.yaw, next.yaw, alpha),
                velocity: lerp(previous.velocity, next.velocity, alpha),
            };
        }
        return last;
    }

    applyScenarioState(state) {
        if (!state) return;
        this.currentSpeed = finite(state.velocity);
        Object.assign(this.velocity, { x: this.currentSpeed, y: 0, z: 0 });
        Object.assign(this.position, { x: state.x, y: this.definition.scenario.lift, z: state.y });
        Object.assign(this.rotation, { x: 0, y: -state.yaw, z: 0, order: "XYZ" });
    }

    update(deltaTime) {
        const dt = finite(deltaTime);
        if (dt < 0) throw new RangeError("Vehicle plant delta time cannot be negative.");
        if (this.motionModel === "linear") {
            this.velocity.x += this.acceleration.x * dt;
            this.velocity.y += this.acceleration.y * dt;
            this.velocity.z += this.acceleration.z * dt;
            this.position.x += this.velocity.x * dt;
            this.position.y += this.velocity.y * dt;
            this.position.z += this.velocity.z * dt;
            return;
        }
        if (this.motionModel === "scenario-keyframes") {
            if (!this.started || this.completed || !this.isPlaying || this.keyframes.length === 0) return;
            this.elapsedTime += dt * this.definition.scenario.playbackRate;
            const last = this.keyframes[this.keyframes.length - 1];
            this.applyScenarioState(this.sampleScenarioState(this.elapsedTime));
            if (this.elapsedTime >= last.t && this.definition.scenario.freezeAtEnd) {
                this.completed = true;
            }
            return;
        }

        // Explicit Euler ordering matches the browser contract: first local
        // acceleration, then translation at the old yaw, then yaw integration.
        this.velocity.x += this.acceleration.x * dt;
        this.velocity.y += this.acceleration.y * dt;
        this.velocity.z += this.acceleration.z * dt;
        const speed = this.velocity.x;
        const maximum = Math.min(finite(this.kinematics.maxSteeringAngle, 0.6), Math.PI * 0.49);
        const steering = Math.max(-maximum, Math.min(maximum, this.steeringAngle));
        const yaw = this.rotation.y;
        this.position.x += Math.cos(yaw) * speed * dt;
        this.position.z += -Math.sin(yaw) * speed * dt;
        const wheelbase = Math.max(1e-9, finite(this.kinematics.wheelbase, 1.5));
        this.rotation.y += (speed / wheelbase) * Math.tan(steering) * dt;
    }

    play({ restart = false } = {}) {
        if (restart || this.completed) this.restart();
        this.isPlaying = true;
    }

    pause() {
        this.isPlaying = false;
    }

    restart() {
        this.resetRunState();
    }

    getDeterministicState() {
        return {
            id: this.telemetryId,
            position: vector(this.position),
            rotation: rotation(this.rotation),
            velocity: vector(this.velocity),
            acceleration: vector(this.acceleration),
            steeringAngle: finite(this.steeringAngle),
        };
    }
}
