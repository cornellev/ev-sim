import { PLANT_CONTACT_BICYCLE_MODEL } from "../../plugin/PlantModule.js";
import { DEFAULT_DYNAMIC_BICYCLE } from "../../vehicles/VehicleManifest.js";
import { GRAVITY } from "./dynamicBicycle.js";

export const VX_REST = 1e-3;

function num(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clip(value, limit) {
    const bound = Math.abs(limit);
    if (value > bound) return bound;
    if (value < -bound) return -bound;
    return value;
}

export function contactLongitudinalCommand({
    mode = "hold", speedMps = 0, accelerationMps2 = 0, vx = 0,
    previousAx = 0, realizedAx = 0, dt = 0.01,
    maxAcceleration = 3, maxDeceleration = 5, maxJerk = 10,
} = {}) {
    const acceleration = Math.max(0, num(maxAcceleration, 3));
    const deceleration = Math.max(0, num(maxDeceleration, 5));
    const clampAx = (value) => Math.max(-deceleration, Math.min(acceleration, num(value)));
    if (mode === "hold") return 0;
    if (mode === "acceleration") return clampAx(accelerationMps2);
    const step = Math.max(0, num(dt));
    if (step === 0) return clampAx(previousAx);
    const maxJ = Math.max(0, num(maxJerk, 10));
    const omega = Math.min(4, 2 * maxJ / Math.max(acceleration, deceleration, 1e-9), 0.5 / step);
    const error = (mode === "stop" ? 0 : num(speedMps)) - num(vx);
    // Damping on realized acceleration releases braking before the speed error crosses zero.
    const jerk = clip(omega * omega * error - 2 * omega * num(realizedAx), maxJ);
    return clampAx(num(previousAx) + jerk * step);
}

export function brakeLongitudinalCommand({ vx, previousAx, dt, maxAcceleration, maxDeceleration, maxJerk, gradeX = 0, rollingAcceleration = 0, state }) {
    const step = Math.max(0, num(dt));
    if (!step) return previousAx;
    const direction = Math.sign(vx) || state.direction || 1;
    const speed = Math.abs(vx);
    const jerk = maxJerk;
    const feedforward = direction * rollingAcceleration - gradeX;
    let acceleration = direction * ((state.direction === direction ? state.endAx : undefined) ?? previousAx) - direction * feedforward;
    acceleration = Math.max(-maxDeceleration, Math.min(maxAcceleration, acceleration));
    let remaining = step;
    let integral = 0;
    const peak = Math.min(maxDeceleration, Math.sqrt(jerk * speed + acceleration * acceleration / 2));
    const downTime = Math.max(0, (acceleration + peak) / jerk);
    const plateauTime = peak > 0 ? Math.max(0, (speed + (acceleration * acceleration - 2 * peak * peak) / (2 * jerk)) / peak) : 0;
    for (const [duration, slope] of [[downTime, -jerk], [plateauTime, 0], [Math.max(0, -Math.min(acceleration, -peak) / jerk), jerk]]) {
        const elapsed = Math.min(remaining, duration);
        integral += acceleration * elapsed + slope * elapsed * elapsed / 2;
        acceleration += slope * elapsed;
        remaining -= elapsed;
        if (remaining <= 0) break;
    }
    if (remaining > 0) acceleration = 0;
    const desired = speed <= VX_REST ? -gradeX : direction * integral / step + feedforward;
    const bounded = direction * Math.max(-maxDeceleration, Math.min(maxAcceleration, direction * desired));
    const command = Math.max(previousAx - jerk * step, Math.min(previousAx + jerk * step, bounded));
    state.direction = direction;
    state.endAx = speed <= VX_REST ? command : direction * acceleration + feedforward;
    return command;
}

function scaleLongitudinal(fx, fy, fz, mu) {
    const limit = Math.abs(mu * fz);
    const lateral = Math.min(Math.abs(fy), limit);
    const room = Math.sqrt(Math.max(0, limit * limit - lateral * lateral));
    if (Math.abs(fx) <= room) return fx;
    return Math.sign(fx) * room;
}

export function isContactBicycle(vehicle) {
    if (!vehicle) return false;
    if (vehicle.motionModel === "contact-bicycle") return true;
    if (vehicle.plant?.motionModel === "contact-bicycle") return true;
    if (vehicle.motionModel === "plugin" && vehicle.definition?.plant?.model === PLANT_CONTACT_BICYCLE_MODEL) return true;
    if (vehicle.plant?.motionModel === "plugin" && vehicle.plant.definition?.plant?.model === PLANT_CONTACT_BICYCLE_MODEL) return true;
    return false;
}

export function contactBicycleBody(vehicle) {
    if (!isContactBicycle(vehicle)) return null;
    if (vehicle.motionModel === "contact-bicycle" || vehicle.motionModel === "plugin") return vehicle;
    return vehicle.plant ?? null;
}

/** Body axes. +x is forward, +y is right (world −Z at yaw 0), roll is 0. */
export function bodyAxes(yaw, pitch) {
    const cosYaw = Math.cos(num(yaw));
    const sinYaw = Math.sin(num(yaw));
    const cosPitch = Math.cos(num(pitch));
    const sinPitch = Math.sin(num(pitch));
    return {
        forward: { x: cosYaw * cosPitch, y: sinPitch, z: -sinYaw * cosPitch },
        right: { x: -sinYaw, y: 0, z: -cosYaw },
    };
}

/** Orthonormal motion frame, including the vertical component of cross-slope travel. */
export function contactAxes(normal, yaw) {
    const n = unitNormal(normal);
    const hx = Math.cos(num(yaw));
    const hz = -Math.sin(num(yaw));
    const rise = -(n.x * hx + n.z * hz) / Math.max(1e-9, n.y);
    const pitch = Math.atan(rise) || 0;
    const forward = { x: hx * Math.cos(pitch), y: Math.sin(pitch), z: hz * Math.cos(pitch) };
    return {
        forward,
        right: {
            x: n.y * forward.z - n.z * forward.y,
            y: n.z * forward.x - n.x * forward.z,
            z: n.x * forward.y - n.y * forward.x,
        },
        pitch,
    };
}

function unitNormal(normal) {
    const x = num(normal?.x);
    const y = num(normal?.y, 1);
    const z = num(normal?.z);
    const length = Math.hypot(x, y, z);
    if (length <= 1e-12) return { x: 0, y: 1, z: 0 };
    return { x: x / length, y: y / length, z: z / length };
}

/** Tangential gravity in the car frame, m/s². +x pulls forward, +y pulls right. */
export function tangentialGrade(normal, yaw) {
    const n = unitNormal(normal);
    const gy = -GRAVITY;
    const along = gy * n.y;
    const gt = { x: -along * n.x, y: gy - along * n.y, z: -along * n.z };
    const axes = contactAxes(n, yaw);
    return {
        x: gt.x * axes.forward.x + gt.y * axes.forward.y + gt.z * axes.forward.z,
        y: gt.x * axes.right.x + gt.y * axes.right.y + gt.z * axes.right.z,
        normalY: Math.max(0, n.y),
    };
}

/**
 * Tire forces in the car frame. Gravity is not included.
 * `gradeX` is only the direction rolling resistance braces against at rest.
 * `frictionCircle: false` keeps the cornering plugin's uncoupled drive force.
 */
export function axleContactForces(input = {}) {
    const mass = Math.max(1e-9, num(input.mass, DEFAULT_DYNAMIC_BICYCLE.mass));
    const lf = Math.max(0, num(input.lf, 0.75));
    const lr = Math.max(0, num(input.lr, 0.75));
    const length = Math.max(1e-9, lf + lr);
    const cf = Math.max(0, num(input.corneringStiffnessFront, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessFront));
    const cr = Math.max(0, num(input.corneringStiffnessRear, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessRear));
    const mu = Math.max(0, num(input.frictionMu, DEFAULT_DYNAMIC_BICYCLE.frictionMu));
    const crr = Math.max(0, num(input.rollingResistance, DEFAULT_DYNAMIC_BICYCLE.rollingResistance));
    const normalLoad = Math.max(0, num(input.normalLoad));
    const zeros = { Fxf: 0, Fyf: 0, Fxr: 0, Fyr: 0 };
    if (input.inContact === false || normalLoad <= 1e-12) return zeros;
    const vx = num(input.vx);
    const vy = num(input.vy);
    const r = num(input.r);
    const delta = num(input.delta);
    const dt = Math.max(0, num(input.dt));
    const inertia = Math.max(1e-9, num(input.yawInertia, DEFAULT_DYNAMIC_BICYCLE.yawInertia));
    const cosDelta = Math.cos(delta);
    const sinDelta = Math.sin(delta);
    const Fzf = normalLoad * (lr / length);
    const Fzr = normalLoad * (lf / length);
    const frontSpeed = vy + lf * r;
    const frontSlip = frontSpeed * cosDelta - vx * sinDelta;
    const rearSlip = vy - lr * r;
    const alphaFront = Math.atan2(frontSlip, Math.max(Math.abs(vx * cosDelta + frontSpeed * sinDelta), VX_REST));
    const alphaRear = Math.atan2(rearSlip, Math.max(Math.abs(vx), VX_REST));
    // Row sums of J M^-1 J^T keep the coupled tire impulses dissipative at low speed.
    const coupling = Math.abs(cosDelta / mass - lf * lr * cosDelta / inertia);
    const frontInverseMass = 1 / mass + (lf * cosDelta) ** 2 / inertia + coupling;
    const rearInverseMass = 1 / mass + lr * lr / inertia + coupling;
    const frontLimit = dt > 0 ? Math.min(mu * Fzf, Math.abs(frontSlip) / (dt * frontInverseMass)) : mu * Fzf;
    const rearLimit = dt > 0 ? Math.min(mu * Fzr, Math.abs(rearSlip) / (dt * rearInverseMass)) : mu * Fzr;
    const frontLateral = clip(-cf * alphaFront, frontLimit);
    const rearLateral = clip(-cr * alphaRear, rearLimit);
    const drive = mass * num(input.axCommand);
    const rollingCapacity = crr * normalLoad;
    const net = drive + mass * num(input.gradeX);
    let rolling;
    if (dt > 0) {
        rolling = clip(-net - mass * vx / dt, rollingCapacity);
    } else if (Math.abs(vx) < VX_REST) {
        rolling = Math.abs(net) <= rollingCapacity ? -net : -Math.sign(net || 1) * rollingCapacity;
    } else {
        rolling = -Math.sign(vx) * rollingCapacity;
    }
    const fxTotal = drive + rolling;
    const weight = Fzf + Fzr;
    let frontLongitudinal = 0;
    let rearLongitudinal = 0;
    if (Math.abs(weight) > 1e-12) {
        const frontShare = fxTotal * (Fzf / weight);
        const rearShare = fxTotal * (Fzr / weight);
        if (input.frictionCircle === false) {
            frontLongitudinal = frontShare;
            rearLongitudinal = rearShare;
        } else {
            frontLongitudinal = scaleLongitudinal(frontShare, frontLateral, Fzf, mu);
            rearLongitudinal = scaleLongitudinal(rearShare, rearLateral, Fzr, mu);
        }
    }
    return {
        Fxf: frontLongitudinal * cosDelta - frontLateral * sinDelta,
        Fyf: frontLongitudinal * sinDelta + frontLateral * cosDelta,
        Fxr: rearLongitudinal,
        Fyr: rearLateral,
    };
}

export function contactParameters(plant) {
    if (!plant.physicsConfig) throw new Error("Contact vehicle has no resolved physics configuration.");
    return plant.physicsConfig;
}

function steerLimit(plant) {
    return Math.min(finite(plant.kinematics?.maxSteeringAngle, 0.6), Math.PI * 0.49);
}

function readForces(plant, dt, inContact, grade, normalLoad, delta) {
    const params = contactParameters(plant);
    if (plant.motionModel !== "plugin") {
        return axleContactForces({
            ...params,
            dt,
            vx: plant.velocity.x,
            vy: plant.lateralVelocity,
            r: plant.yawRate,
            delta,
            axCommand: plant.axCommand,
            gradeX: grade.x,
            normalLoad,
            inContact,
        });
    }
    if (plant.unresolvedPluginPlant || !plant.stepper) return null;
    const buffer = plant.stateBuffer;
    buffer[0] = plant.position.x;
    buffer[1] = plant.position.y;
    buffer[2] = plant.position.z;
    buffer[3] = grade.x;
    buffer[4] = plant.rotation.y;
    buffer[5] = grade.y;
    buffer[6] = plant.velocity.x;
    buffer[7] = plant.lateralVelocity;
    buffer[8] = plant.yawRate;
    buffer[9] = plant.axCommand;
    buffer[10] = inContact ? 1 : 0;
    buffer[11] = normalLoad;
    buffer[12] = delta;
    const next = plant.stepper.step(buffer, dt);
    return { Fxf: next[6], Fyf: next[7], Fxr: next[9], Fyr: next[10] };
}

/** How far the origin sits above the surface so the deepest tread is on it. */
export function groundClearance(wheels = []) {
    let clearance = 0;
    if (!Array.isArray(wheels)) return 0;
    for (const wheel of wheels) {
        if (!wheel || typeof wheel !== "object") continue;
        const drop = num(wheel.radius) - num(wheel.position?.y);
        if (drop > clearance) clearance = drop;
    }
    return clearance;
}

/** Command and tire forces for one step on the given support. Gravity is not included. */
export function contactTireStep(plant, inContact, normal, dt) {
    const yaw = finite(plant.rotation?.y);
    const grade = inContact ? tangentialGrade(normal, yaw) : { x: 0, y: 0, normalY: 0 };
    const params = contactParameters(plant);
    const normalLoad = inContact ? params.mass * GRAVITY * grade.normalY : 0;
    const delta = Math.max(-steerLimit(plant), Math.min(steerLimit(plant), finite(plant.steeringAngle)));
    const braking = plant.longitudinal?.zeroSpeedResponse === "brake-v1"
        && (plant.longitudinal.mode === "stop" || (plant.longitudinal.mode === "velocity" && plant.longitudinal.speedMps === 0));
    if (!inContact || !braking) delete plant.brakeState;
    if (inContact && braking) plant.brakeState ??= {};
    const effectiveLimits = braking ? plant.longitudinal.actuatorLimits ?? plant.kinematics : plant.kinematics;
    const commandOptions = {
        ...plant.longitudinal,
        vx: plant.velocity.x,
        previousAx: plant.axCommand,
        realizedAx: plant.contactControlActive ? plant.acceleration.x : 0,
        dt,
        maxAcceleration: finite(effectiveLimits?.maxAcceleration, 3),
        maxDeceleration: finite(effectiveLimits?.maxDeceleration, 5),
        maxJerk: finite(effectiveLimits?.maxJerk, 10),
    };
    plant.axCommand = !inContact ? 0 : braking ? brakeLongitudinalCommand({
        ...commandOptions, gradeX: grade.x,
        rollingAcceleration: params.rollingResistance * GRAVITY * grade.normalY,
        state: plant.brakeState,
    }) : contactLongitudinalCommand(commandOptions);
    plant.contactControlActive = inContact;
    const forces = readForces(plant, dt, inContact, grade, normalLoad, delta);
    return { params, grade, normalLoad, forces };
}

/**
 * World force and yaw torque for a Rapier chassis on `normal`. Also returns the
 * rest-rule inputs that stop a parked car from creeping.
 */
export function contactChassisPush(plant, inContact, normal, dt) {
    const { params, grade, normalLoad, forces } = contactTireStep(plant, inContact, normal, dt);
    const rest = {
        net: params.mass * finite(plant.axCommand) + params.mass * grade.x,
        rollingCapacity: params.rollingResistance * normalLoad,
    };
    if (!inContact || !forces) return { force: null, torque: null, ...rest };
    const { forward, right } = contactAxes(normal, plant.rotation.y);
    const n = unitNormal(normal);
    const fx = forces.Fxf + forces.Fxr;
    const fy = forces.Fyf + forces.Fyr;
    const moment = params.lf * forces.Fyf - params.lr * forces.Fyr;
    return {
        force: {
            x: forward.x * fx + right.x * fy,
            y: forward.y * fx + right.y * fy,
            z: forward.z * fx + right.z * fy,
        },
        torque: { x: n.x * moment, y: n.y * moment, z: n.z * moment },
        ...rest,
    };
}

export function publishContactPose(vehicle, plant) {
    if (!vehicle || vehicle === plant) return;
    if (vehicle.position) {
        vehicle.position.x = plant.position.x;
        vehicle.position.y = plant.position.y;
        vehicle.position.z = plant.position.z;
    }
    if (vehicle.rotation) {
        vehicle.rotation.x = plant.rotation.x;
        vehicle.rotation.y = plant.rotation.y;
        vehicle.rotation.z = plant.rotation.z;
    }
    vehicle.updatePosition?.(vehicle.position);
    vehicle.updateRotation?.(vehicle.rotation);
    if (vehicle.velocity) {
        if (typeof vehicle.velocity.set === "function") vehicle.velocity.set(plant.velocity.x, 0, 0);
        else {
            vehicle.velocity.x = plant.velocity.x;
            vehicle.velocity.y = 0;
            vehicle.velocity.z = 0;
        }
    }
}
