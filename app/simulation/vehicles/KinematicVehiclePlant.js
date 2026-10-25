import { PLUGIN_ERROR_CODES, pluginError } from "../../plugin/PluginErrors.js";
import { PLANT_STATE_LENGTH } from "../../plugin/PlantModule.js";
import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";
import { CONTACT_BICYCLE_MODEL, DYNAMIC_BICYCLE_MODEL, normalizeVehicleManifest } from "../../vehicles/VehicleManifest.js";
import { euler, finiteOr as finite, pose, vec3 } from "../../util/plainGeometry.js";
import { stepContactPlant } from "./contactBicycle.js";
import { deriveAxleDistances, longitudinalCommand, stepDynamicBicycle } from "./dynamicBicycle.js";

export const VEHICLE_PLANT_KIND = "cev-sim.vehicle-plant";
export const VEHICLE_PLANT_VERSION = 1;

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
    const pluginPlantId = manifest.dynamics?.plant || "";
    const dynamicBicycle = manifest.dynamics?.model === DYNAMIC_BICYCLE_MODEL;
    const contactBicycle = manifest.dynamics?.model === CONTACT_BICYCLE_MODEL;
    let motionModel = options.motionModel;
    if (!motionModel) {
        if (pluginPlantId) motionModel = "plugin";
        else if (contactBicycle) motionModel = "contact-bicycle";
        else if (dynamicBicycle) motionModel = "dynamic-bicycle";
        else if (type === "scenario-car") motionModel = "scenario-keyframes";
        else motionModel = "bicycle";
    }
    if (!new Set(["bicycle", "dynamic-bicycle", "contact-bicycle", "scenario-keyframes", "linear", "plugin"]).has(motionModel)) {
        throw new TypeError(`Unknown vehicle motion model "${motionModel}".`);
    }
    if (motionModel === "plugin" && !pluginPlantId) {
        throw new TypeError("Plugin vehicle motion requires manifest.dynamics.plant.");
    }
    if (motionModel === "dynamic-bicycle" && !dynamicBicycle) {
        throw new TypeError("Dynamic bicycle motion requires manifest.dynamics.model \"dynamic-bicycle-v1\".");
    }
    if (motionModel === "contact-bicycle" && !contactBicycle) {
        throw new TypeError("Contact bicycle motion requires manifest.dynamics.model \"contact-bicycle-v1\".");
    }
    return {
        kind: VEHICLE_PLANT_KIND,
        version: VEHICLE_PLANT_VERSION,
        id: String(entry.id || options.id || manifest.id),
        vehicleManifestId: manifest.id,
        motionModel,
        initialPose: pose(entry.pose ?? options.pose),
        initialLinearVelocity: vec3(entry.linearVelocity ?? options.linearVelocity),
        initialLinearAcceleration: vec3(entry.linearAcceleration ?? options.linearAcceleration),
        initialSteeringAngle: finite(entry.steeringAngle ?? options.steeringAngle),
        dimensions: { ...vec3(manifest.boundingBox?.size) },
        boundingBoxCenter: vec3(manifest.boundingBox?.center),
        kinematics: { ...manifest.kinematics },
        keyframes,
        scenario: {
            lift: finite(options.lift ?? entry.pose?.position?.y),
            freezeAtEnd: options.freezeAtEnd !== false,
            playbackRate: finite(options.playbackRate, 1),
            autoplay: options.autoplay !== false,
        },
        ...(motionModel === "plugin" ? {
            plant: {
                id: pluginPlantId,
                pluginId: String(options.plantPluginId || ""),
                runtimeHash: String(options.plantRuntimeHash || ""),
                ...(options.plantModel ? { model: String(options.plantModel) } : {}),
            },
        } : {}),
        ...(motionModel === "dynamic-bicycle" || motionModel === "contact-bicycle" ? {
            dynamics: { ...manifest.dynamics },
            axle: deriveAxleDistances(manifest.wheels, manifest.kinematics?.wheelbase),
        } : {}),
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

function isDynamicPlugin(plant) {
    return plant?.motionModel === "plugin" && plant.definition?.plant?.model === DYNAMIC_BICYCLE_MODEL;
}

function isContactPlugin(plant) {
    return plant?.motionModel === "plugin" && plant.definition?.plant?.model === CONTACT_BICYCLE_MODEL;
}

function isContactMotion(plant) {
    return plant?.motionModel === "contact-bicycle" || isContactPlugin(plant);
}

function packPlantState(plant, target) {
    target[0] = plant.position.x;
    target[1] = plant.position.y;
    target[2] = plant.position.z;
    target[3] = plant.rotation.x;
    target[4] = plant.rotation.y;
    target[5] = plant.rotation.z;
    target[6] = plant.velocity.x;
    target[7] = plant.velocity.y;
    target[8] = plant.velocity.z;
    target[9] = plant.acceleration.x;
    target[10] = plant.acceleration.y;
    target[11] = plant.acceleration.z;
    target[12] = plant.steeringAngle;
    return target;
}

function unpackPlantState(plant, state) {
    plant.position.x = state[0];
    plant.position.y = state[1];
    plant.position.z = state[2];
    plant.rotation.x = state[3];
    plant.rotation.y = state[4];
    plant.rotation.z = state[5];
    plant.velocity.x = state[6];
    plant.velocity.y = state[7];
    plant.velocity.z = state[8];
    plant.acceleration.x = state[9];
    plant.acceleration.y = state[10];
    plant.acceleration.z = state[11];
    plant.steeringAngle = state[12];
}

function packDynamicPlantState(plant, target) {
    target[0] = plant.position.x;
    target[1] = plant.position.y;
    target[2] = plant.position.z;
    target[3] = plant.rotation.x;
    target[4] = plant.rotation.y;
    target[5] = plant.rotation.z;
    target[6] = plant.velocity.x;
    target[7] = plant.lateralVelocity;
    target[8] = plant.yawRate;
    target[9] = plant.axCommand;
    target[10] = 0;
    target[11] = 0;
    target[12] = plant.steeringAngle;
    return target;
}

function unpackDynamicPlantState(plant, state) {
    plant.position.x = state[0];
    plant.position.y = state[1];
    plant.position.z = state[2];
    plant.rotation.x = state[3];
    plant.rotation.y = state[4];
    plant.rotation.z = state[5];
    plant.velocity.x = state[6];
    plant.velocity.y = 0;
    plant.velocity.z = 0;
    plant.lateralVelocity = state[7];
    plant.yawRate = state[8];
    plant.acceleration.x = state[9];
    plant.acceleration.y = state[10];
    plant.acceleration.z = state[11];
    plant.steeringAngle = state[12];
}

export class KinematicVehiclePlant {
    constructor(definition, { stepper = null, unresolved = false } = {}) {
        if (definition?.kind !== VEHICLE_PLANT_KIND || definition?.version !== VEHICLE_PLANT_VERSION) {
            throw new TypeError(`KinematicVehiclePlant requires ${VEHICLE_PLANT_KIND} v${VEHICLE_PLANT_VERSION}.`);
        }
        if (definition.motionModel === "plugin" && !stepper && !unresolved) {
            throw pluginError(
                PLUGIN_ERROR_CODES.UNAVAILABLE,
                `Plant "${definition.plant?.id ?? "unknown"}" is not available in this run.`,
                { pluginId: definition.plant?.pluginId || null, contributionId: definition.plant?.id ?? null },
            );
        }
        this.definition = structuredClone(definition);
        this.stepper = stepper;
        this.unresolvedPluginPlant = unresolved === true;
        this.dynamicsStatus = this.unresolvedPluginPlant ? "Plugin dynamics run only in a resolved run." : "";
        this.stateBuffer = new Float64Array(PLANT_STATE_LENGTH);
        this.id = definition.id;
        this.telemetryId = definition.id;
        this.vehicleManifestId = definition.vehicleManifestId;
        this.manifestId = definition.vehicleManifestId;
        this.motionModel = definition.motionModel;
        this.collisionDimensions = { ...definition.dimensions };
        this.collisionCenter = { ...vec3(definition.boundingBoxCenter) };
        this.dimensions = this.collisionDimensions;
        this.kinematics = { ...definition.kinematics };
        this.keyframes = definition.keyframes.map((frame) => ({ ...frame }));
        this.groundSampler = null;
        this.position = vec3();
        this.rotation = euler();
        this.velocity = vec3();
        this.acceleration = vec3();
        this.steeringAngle = 0;
        this.lateralVelocity = 0;
        this.yawRate = 0;
        this.axCommand = 0;
        this.longitudinal = { mode: "hold" };
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

    setGroundSampler(sampleFn) {
        this.groundSampler = typeof sampleFn === "function" ? sampleFn : null;
        this.drapeToGround();
    }

    drapeToGround() {
        if (isContactMotion(this)) return;
        if (!["bicycle", "plugin", "dynamic-bicycle"].includes(this.motionModel) || typeof this.groundSampler !== "function") return;
        const hit = this.groundSampler(this.position.x, this.position.z, this.rotation.y);
        if (!hit) return;
        this.position.y = finite(hit.y);
        this.rotation.x = 0;
        this.rotation.z = finite(hit.pitch);
        this.rotation.order = this.rotation.order || "XYZ";
    }

    updatePosition(value) {
        Object.assign(this.position, vec3(value));
    }

    updateRotation(value) {
        Object.assign(this.rotation, euler(value));
    }

    resetRunState(entry = {}) {
        const sourcePose = pose(entry.pose ?? this.definition.initialPose);
        Object.assign(this.position, sourcePose.position);
        Object.assign(this.rotation, sourcePose.rotation);
        Object.assign(this.velocity, vec3(entry.linearVelocity ?? this.definition.initialLinearVelocity));
        Object.assign(this.acceleration, vec3(entry.linearAcceleration ?? this.definition.initialLinearAcceleration));
        this.steeringAngle = finite(entry.steeringAngle, this.definition.initialSteeringAngle);
        this.lateralVelocity = 0;
        this.yawRate = 0;
        this.verticalVelocity = 0;
        this.floorSupport = null;
        this.onRoad = false;
        this.axCommand = 0;
        this.longitudinal = { mode: "hold" };
        if (this.motionModel === "dynamic-bicycle" || isDynamicPlugin(this) || isContactMotion(this)) {
            this.velocity.y = 0;
            this.velocity.z = 0;
        }
        this.elapsedTime = 0;
        this.completed = false;
        this.started = true;
        this.isPlaying = this.definition.scenario.autoplay;
        if (this.motionModel === "scenario-keyframes" && this.keyframes.length > 0) {
            this.applyScenarioState(this.keyframes[0]);
        }
        this.stepper?.reset?.();
        this.drapeToGround();
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
        const dynamicPlugin = isDynamicPlugin(this);
        const contactPlugin = isContactPlugin(this);
        if (this.motionModel === "dynamic-bicycle" || dynamicPlugin || this.motionModel === "contact-bicycle" || contactPlugin) {
            this.axCommand = longitudinalCommand({
                mode: this.longitudinal?.mode || "hold",
                speedMps: this.longitudinal?.speedMps,
                accelerationMps2: this.longitudinal?.accelerationMps2,
                vx: this.velocity.x,
                previousAx: this.axCommand,
                dt,
                maxAcceleration: finite(this.kinematics.maxAcceleration, 3),
                maxDeceleration: finite(this.kinematics.maxDeceleration, 5),
                maxJerk: finite(this.kinematics.maxJerk, 10),
            });
        }
        if (this.motionModel === "contact-bicycle" || contactPlugin) {
            stepContactPlant(this, dt);
            return;
        }
        if (this.motionModel === "dynamic-bicycle") {
            const axle = this.definition.axle ?? deriveAxleDistances([], this.kinematics.wheelbase);
            const dynamics = this.definition.dynamics ?? {};
            const maximum = Math.min(finite(this.kinematics.maxSteeringAngle, 0.6), Math.PI * 0.49);
            const steering = Math.max(-maximum, Math.min(maximum, this.steeringAngle));
            // Explicit Euler: forces at the old state, translation at the old yaw.
            const stepped = stepDynamicBicycle({
                vx: this.velocity.x,
                vy: this.lateralVelocity,
                r: this.yawRate,
                x: this.position.x,
                z: this.position.z,
                yaw: this.rotation.y,
            }, {
                axCommand: this.axCommand,
                delta: steering,
                pitch: this.rotation.z,
                dt,
                mass: dynamics.mass,
                yawInertia: dynamics.yawInertia,
                lf: axle.lf,
                lr: axle.lr,
                corneringStiffnessFront: dynamics.corneringStiffnessFront,
                corneringStiffnessRear: dynamics.corneringStiffnessRear,
                frictionMu: dynamics.frictionMu,
                rollingResistance: dynamics.rollingResistance,
            });
            this.velocity.x = stepped.vx;
            this.velocity.y = 0;
            this.velocity.z = 0;
            this.lateralVelocity = stepped.vy;
            this.yawRate = stepped.r;
            this.position.x = stepped.x;
            this.position.z = stepped.z;
            this.rotation.y = stepped.yaw;
            this.acceleration.x = stepped.ax;
            this.acceleration.y = stepped.ay;
            this.acceleration.z = 0;
            this.drapeToGround();
            return;
        }
        if (this.motionModel === "plugin") {
            if (this.unresolvedPluginPlant || !this.stepper) return;
            const next = this.stepper.step(
                dynamicPlugin ? packDynamicPlantState(this, this.stateBuffer) : packPlantState(this, this.stateBuffer),
                dt,
            );
            if (dynamicPlugin) unpackDynamicPlantState(this, next);
            else unpackPlantState(this, next);
            this.drapeToGround();
            return;
        }
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
        this.drapeToGround();
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
            position: vec3(this.position),
            rotation: euler(this.rotation),
            velocity: vec3(this.velocity),
            acceleration: vec3(this.acceleration),
            steeringAngle: finite(this.steeringAngle),
            ...(this.motionModel === "dynamic-bicycle" || isDynamicPlugin(this) || isContactMotion(this) ? {
                lateralVelocity: finite(this.lateralVelocity),
                yawRate: finite(this.yawRate),
            } : {}),
            ...(isContactMotion(this) ? { verticalVelocity: finite(this.verticalVelocity) } : {}),
        };
    }
}
