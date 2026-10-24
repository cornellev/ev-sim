import { PLANT_CONTACT_BICYCLE_MODEL } from "../../plugin/PlantModule.js";
import { DEFAULT_DYNAMIC_BICYCLE, DYNAMIC_BICYCLE_MODEL } from "../../vehicles/VehicleManifest.js";

export const GRAVITY = 9.81;

/** Below this forward speed the slip-angle denominator is treated as rest. */
const VX_REST = 1e-3;

function num(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clip(value, limit) {
    const bound = Math.abs(limit);
    if (value > bound) return bound;
    if (value < -bound) return -bound;
    return value;
}

/**
 * Distances from the body origin to the front and rear axles.
 * Wheel `position.x` is used only when the origin sits strictly between the
 * two axle means. Otherwise the wheelbase is split in half.
 */
export function deriveAxleDistances(wheels = [], wheelbase = 1.5) {
    const half = Math.max(1e-9, num(wheelbase, 1.5)) / 2;
    const front = [];
    const rear = [];
    for (const wheel of Array.isArray(wheels) ? wheels : []) {
        if (wheel?.axle === "front") front.push(wheel);
        else if (wheel?.axle === "rear") rear.push(wheel);
        else if (wheel?.axle) continue;
        else if (wheel?.steerable === true) front.push(wheel);
        else rear.push(wheel);
    }
    if (front.length === 0 || rear.length === 0) return { lf: half, lr: half };
    const meanX = (entries) => entries.reduce((sum, entry) => sum + num(entry.position?.x), 0) / entries.length;
    const xf = meanX(front);
    const xr = meanX(rear);
    if (xr < 0 && xf > 0) return { lf: xf, lr: -xr };
    return { lf: half, lr: half };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Longitudinal acceleration command for one step.
 * Acceleration mode is already jerk-limited by ControlRuntime.
 * Velocity and stop close that same limiter on plant `vx`.
 */
export function longitudinalCommand({
    mode = "hold",
    speedMps = 0,
    accelerationMps2 = 0,
    vx = 0,
    previousAx = 0,
    dt = 0.01,
    maxAcceleration = 3,
    maxDeceleration = 5,
    maxJerk = 10,
} = {}) {
    if (mode === "hold") return 0;
    const accelLimit = Math.max(0, num(maxAcceleration, 3));
    const brakeLimit = Math.max(0, num(maxDeceleration, 5));
    if (mode === "acceleration") return clamp(num(accelerationMps2), -brakeLimit, accelLimit);
    const dtSafe = Math.max(1e-6, num(dt, 0.01));
    const target = mode === "stop" ? 0 : num(speedMps);
    const limited = clamp((target - num(vx)) / dtSafe, -brakeLimit, accelLimit);
    const jerk = Math.max(0, num(maxJerk, 10)) * dtSafe;
    return clamp(limited, num(previousAx) - jerk, num(previousAx) + jerk);
}

function scaleLongitudinal(fx, fy, fz, mu) {
    const limit = Math.abs(mu * fz);
    const lateral = Math.min(Math.abs(fy), limit);
    const room = Math.sqrt(Math.max(0, limit * limit - lateral * lateral));
    if (Math.abs(fx) <= room) return fx;
    return Math.sign(fx) * room;
}

/**
 * One explicit-Euler step of the dynamic bicycle.
 * Forces use the start-of-step state. Translation uses the updated body
 * velocity and the old yaw. `+vy` is to the right (world −Z at yaw 0).
 */
export function stepDynamicBicycle(state = {}, input = {}) {
    const mass = Math.max(1e-9, num(input.mass, DEFAULT_DYNAMIC_BICYCLE.mass));
    const yawInertia = Math.max(1e-9, num(input.yawInertia, DEFAULT_DYNAMIC_BICYCLE.yawInertia));
    const lf = Math.max(0, num(input.lf, 0.75));
    const lr = Math.max(0, num(input.lr, 0.75));
    const length = Math.max(1e-9, lf + lr);
    const cf = Math.max(0, num(input.corneringStiffnessFront, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessFront));
    const cr = Math.max(0, num(input.corneringStiffnessRear, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessRear));
    const mu = Math.max(0, num(input.frictionMu, DEFAULT_DYNAMIC_BICYCLE.frictionMu));
    const crr = Math.max(0, num(input.rollingResistance, DEFAULT_DYNAMIC_BICYCLE.rollingResistance));
    const vx = num(state.vx);
    const vy = num(state.vy);
    const r = num(state.r);
    const yaw = num(state.yaw);
    const delta = num(input.delta);
    const pitch = num(input.pitch);
    const dt = Math.max(0, num(input.dt));
    const axCommand = num(input.axCommand);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const mgCos = mass * GRAVITY * cosPitch;
    const Fzf = mgCos * (lr / length);
    const Fzr = mgCos * (lf / length);

    // shortcut: rest kills lateral force, revisit if crawl steering matters.
    let Fyf = 0;
    let Fyr = 0;
    if (Math.abs(vx) >= VX_REST) {
        const alphaFront = Math.atan((vy + lf * r) / vx) - delta;
        const alphaRear = Math.atan((vy - lr * r) / vx);
        Fyf = clip(-cf * alphaFront, mu * Fzf);
        Fyr = clip(-cr * alphaRear, mu * Fzr);
    }

    const drive = mass * axCommand;
    const rollingCapacity = crr * mass * GRAVITY * Math.max(0, cosPitch);
    const net = drive - mass * GRAVITY * sinPitch;
    let rolling;
    if (Math.abs(vx) < VX_REST) {
        rolling = Math.abs(net) <= rollingCapacity ? -net : -Math.sign(net || 1) * rollingCapacity;
    } else {
        rolling = -Math.sign(vx) * rollingCapacity;
    }
    const fxTotal = drive + rolling;
    const weight = Fzf + Fzr;
    let Fxf = 0;
    let Fxr = 0;
    if (Math.abs(weight) > 1e-12) {
        Fxf = scaleLongitudinal(fxTotal * (Fzf / weight), Fyf, Fzf, mu);
        Fxr = scaleLongitudinal(fxTotal * (Fzr / weight), Fyr, Fzr, mu);
    }
    const cosDelta = Math.cos(delta);
    const sinDelta = Math.sin(delta);
    const sumFx = Fxf * cosDelta - Fyf * sinDelta + Fxr;
    const sumFy = Fxf * sinDelta + Fyf * cosDelta + Fyr;
    const ax = sumFx / mass - GRAVITY * sinPitch + r * vy;
    const ay = sumFy / mass - r * vx;
    const yawAccel = (lf * (Fxf * sinDelta + Fyf * cosDelta) - lr * Fyr) / yawInertia;
    let nextVx = vx + ax * dt;
    const nextVy = vy + ay * dt;
    const nextR = r + yawAccel * dt;
    if (Math.abs(vx) < VX_REST && Math.abs(net) <= rollingCapacity) nextVx = 0;
    else if (axCommand === 0 && vx !== 0 && vx * nextVx < 0) nextVx = 0;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    return {
        vx: nextVx,
        vy: nextVy,
        r: nextR,
        x: num(state.x) + (nextVx * cosYaw - nextVy * sinYaw) * dt,
        z: num(state.z) + (-nextVx * sinYaw - nextVy * cosYaw) * dt,
        yaw: yaw + nextR * dt,
        ax,
        ay,
        Fyf,
        Fyr,
        Fxf,
        Fxr,
        Fzf,
        Fzr,
    };
}

/** Drop the component of body velocity aimed along the attempted world displacement. */
export function projectPlanarVelocity(vx, vy, yaw, from = {}, to = {}) {
    const dx = num(to.x) - num(from.x);
    const dz = num(to.z) - num(from.z);
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) return { vx: 0, vy: 0 };
    const dirX = dx / length;
    const dirZ = dz / length;
    const cosYaw = Math.cos(num(yaw));
    const sinYaw = Math.sin(num(yaw));
    const worldX = num(vx) * cosYaw - num(vy) * sinYaw;
    const worldZ = -num(vx) * sinYaw - num(vy) * cosYaw;
    const into = worldX * dirX + worldZ * dirZ;
    if (into <= 0) return { vx: num(vx), vy: num(vy) };
    const remainingX = worldX - into * dirX;
    const remainingZ = worldZ - into * dirZ;
    return {
        vx: remainingX * cosYaw - remainingZ * sinYaw,
        vy: -remainingX * sinYaw - remainingZ * cosYaw,
    };
}

/** The dynamic body, either the built-in plant or a plugin that copies it. */
function isPlantModel(vehicle, model) {
    return vehicle?.motionModel === "plugin" && vehicle.definition?.plant?.model === model;
}

export function dynamicBicycleBody(vehicle) {
    if (vehicle?.motionModel === "dynamic-bicycle" || vehicle?.motionModel === "contact-bicycle") return vehicle;
    if (vehicle?.plant?.motionModel === "dynamic-bicycle" || vehicle?.plant?.motionModel === "contact-bicycle") return vehicle.plant;
    if (isPlantModel(vehicle, DYNAMIC_BICYCLE_MODEL) || isPlantModel(vehicle, PLANT_CONTACT_BICYCLE_MODEL)) return vehicle;
    if (isPlantModel(vehicle?.plant, DYNAMIC_BICYCLE_MODEL) || isPlantModel(vehicle?.plant, PLANT_CONTACT_BICYCLE_MODEL)) {
        return vehicle.plant;
    }
    return null;
}

/** Write a shortened pose back onto a dynamic bicycle and strip into-wall speed. */
export function absorbDynamicClamp(vehicle, clamped, from, attempted) {
    const plant = dynamicBicycleBody(vehicle);
    if (!plant || !clamped) return;
    plant.position.x = num(clamped.x);
    plant.position.y = num(clamped.y);
    plant.position.z = num(clamped.z);
    const projected = projectPlanarVelocity(
        plant.velocity?.x,
        plant.lateralVelocity,
        plant.rotation?.y,
        from,
        attempted,
    );
    if (plant.velocity) {
        plant.velocity.x = projected.vx;
        plant.velocity.y = 0;
        plant.velocity.z = 0;
    }
    plant.lateralVelocity = projected.vy;
    if ((plant.motionModel === "contact-bicycle" || plant.definition?.plant?.model === PLANT_CONTACT_BICYCLE_MODEL)
        && num(clamped.y) > num(attempted.y) + 1e-9
        && plant.verticalVelocity < 0) {
        plant.verticalVelocity = 0;
    }
    if (vehicle !== plant && vehicle.velocity) {
        if (typeof vehicle.velocity.set === "function") vehicle.velocity.set(projected.vx, 0, 0);
        else {
            vehicle.velocity.x = projected.vx;
            vehicle.velocity.y = 0;
            vehicle.velocity.z = 0;
        }
    }
}
