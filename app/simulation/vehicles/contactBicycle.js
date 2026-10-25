import { PLANT_CONTACT_BICYCLE_MODEL } from "../../plugin/PlantModule.js";
import { CONTACT_BICYCLE_MODEL, DEFAULT_DYNAMIC_BICYCLE } from "../../vehicles/VehicleManifest.js";
import { deriveAxleDistances, GRAVITY } from "./dynamicBicycle.js";

const VX_REST = 1e-3;
const CONTACT_SLACK = 1e-3;

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
    if (vehicle.motionModel === "plugin" && vehicle.definition?.plant?.model === CONTACT_BICYCLE_MODEL) return true;
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

export function normalFromPitch(pitch, yaw) {
    const sine = Math.sin(num(pitch));
    const cosYaw = Math.cos(num(yaw));
    const sinYaw = Math.sin(num(yaw));
    return { x: -sine * cosYaw, y: Math.cos(num(pitch)), z: sine * sinYaw };
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
export function tangentialGrade(normal, yaw, pitch) {
    const n = unitNormal(normal);
    const gy = -GRAVITY;
    const along = gy * n.y;
    const gt = { x: -along * n.x, y: gy - along * n.y, z: -along * n.z };
    const axes = bodyAxes(yaw, pitch);
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
    const Fzf = normalLoad * (lr / length);
    const Fzr = normalLoad * (lf / length);
    let frontLateral = 0;
    let rearLateral = 0;
    if (Math.abs(vx) >= VX_REST) {
        const alphaFront = Math.atan((vy + lf * r) / vx) - delta;
        const alphaRear = Math.atan((vy - lr * r) / vx);
        frontLateral = clip(-cf * alphaFront, mu * Fzf);
        rearLateral = clip(-cr * alphaRear, mu * Fzr);
    }
    const drive = mass * num(input.axCommand);
    const rollingCapacity = crr * normalLoad;
    const net = drive + mass * num(input.gradeX);
    let rolling;
    if (Math.abs(vx) < VX_REST) {
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
    const cosDelta = Math.cos(delta);
    const sinDelta = Math.sin(delta);
    return {
        Fxf: frontLongitudinal * cosDelta - frontLateral * sinDelta,
        Fyf: frontLongitudinal * sinDelta + frontLateral * cosDelta,
        Fxr: rearLongitudinal,
        Fyr: rearLateral,
    };
}

function contactParameters(plant) {
    const plugin = plant.motionModel === "plugin";
    const dynamics = plant.definition?.dynamics ?? {};
    const wheelbase = Math.max(1e-9, finite(plant.kinematics?.wheelbase, 1.5));
    const axle = plugin
        ? { lf: wheelbase / 2, lr: wheelbase / 2 }
        : (plant.definition?.axle ?? deriveAxleDistances([], wheelbase));
    // shortcut: a plugin's mass and yaw inertia stay the crate defaults, upgrade when the host can read those parameters back.
    return {
        mass: Math.max(1e-9, plugin ? DEFAULT_DYNAMIC_BICYCLE.mass : finite(dynamics.mass, DEFAULT_DYNAMIC_BICYCLE.mass)),
        yawInertia: Math.max(1e-9, plugin ? DEFAULT_DYNAMIC_BICYCLE.yawInertia : finite(dynamics.yawInertia, DEFAULT_DYNAMIC_BICYCLE.yawInertia)),
        lf: Math.max(0, finite(axle.lf, wheelbase / 2)),
        lr: Math.max(0, finite(axle.lr, wheelbase / 2)),
        corneringStiffnessFront: finite(dynamics.corneringStiffnessFront, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessFront),
        corneringStiffnessRear: finite(dynamics.corneringStiffnessRear, DEFAULT_DYNAMIC_BICYCLE.corneringStiffnessRear),
        frictionMu: finite(dynamics.frictionMu, DEFAULT_DYNAMIC_BICYCLE.frictionMu),
        rollingResistance: finite(dynamics.rollingResistance, DEFAULT_DYNAMIC_BICYCLE.rollingResistance),
        wheelbase,
    };
}

function steerLimit(plant) {
    return Math.min(finite(plant.kinematics?.maxSteeringAngle, 0.6), Math.PI * 0.49);
}

function worldVelocity(plant, alongRoad) {
    const axes = bodyAxes(plant.rotation.y, alongRoad ? plant.rotation.z : 0);
    const vx = finite(plant.velocity?.x);
    const vy = finite(plant.lateralVelocity);
    return {
        x: axes.forward.x * vx + axes.right.x * vy,
        y: alongRoad ? axes.forward.y * vx + axes.right.y * vy : finite(plant.verticalVelocity),
        z: axes.forward.z * vx + axes.right.z * vy,
    };
}

function readForces(plant, dt, inContact, grade, normalLoad, delta) {
    const params = contactParameters(plant);
    if (plant.motionModel !== "plugin") {
        return axleContactForces({
            ...params,
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

/** The checker floor held this car. The next step drives on it when no road is underneath. */
export function catchContactFloor(plant, planeY, held) {
    if (!plant) return;
    if (!held) {
        plant.floorSupport = null;
        return;
    }
    const y = finite(planeY);
    plant.position.y = y;
    if (finite(plant.verticalVelocity) < 0) plant.verticalVelocity = 0;
    plant.rotation.x = 0;
    plant.rotation.z = 0;
    plant.floorSupport = { y, normal: { x: 0, y: 1, z: 0 } };
}

function floorSample(plant) {
    const support = plant.floorSupport;
    if (!support || plant.position.y > finite(support.y) + CONTACT_SLACK) return null;
    return {
        y: finite(support.y),
        pitch: 0,
        normal: support.normal ?? { x: 0, y: 1, z: 0 },
    };
}

/** Free motion. The road catch runs after the obstacle sweep. */
export function stepContactPlant(plant, dt) {
    const step = Math.max(0, finite(dt));
    const yaw = finite(plant.rotation?.y);
    const sample = (typeof plant.groundSampler === "function"
        ? plant.groundSampler(plant.position.x, plant.position.z, yaw)
        : null) ?? floorSample(plant);
    if (sample) {
        plant.rotation.x = 0;
        plant.rotation.z = finite(sample.pitch);
        plant.rotation.order = plant.rotation.order || "XYZ";
    }
    const pitch = finite(plant.rotation?.z);
    const normal = sample?.normal ?? (sample ? normalFromPitch(pitch, yaw) : null);
    const inContact = Boolean(sample) && plant.position.y <= finite(sample.y) + CONTACT_SLACK;
    const grade = inContact ? tangentialGrade(normal, yaw, pitch) : { x: 0, y: 0, normalY: 0 };
    const params = contactParameters(plant);
    const normalLoad = inContact ? params.mass * GRAVITY * grade.normalY : 0;
    const delta = Math.max(-steerLimit(plant), Math.min(steerLimit(plant), finite(plant.steeringAngle)));
    const forces = readForces(plant, step, inContact, grade, normalLoad, delta);
    if (!forces) return;
    const vx = finite(plant.velocity?.x);
    const vy = finite(plant.lateralVelocity);
    const r = finite(plant.yawRate);
    const sumFx = forces.Fxf + forces.Fxr;
    const sumFy = forces.Fyf + forces.Fyr;
    const yawAccel = (params.lf * forces.Fyf - params.lr * forces.Fyr) / params.yawInertia;
    const gravX = -GRAVITY * Math.sin(pitch);
    const gravZ = -GRAVITY * Math.cos(pitch);
    const ax = sumFx / params.mass + (inContact ? grade.x : 0) + r * vy;
    const ay = sumFy / params.mass + (inContact ? grade.y : 0) - r * vx;
    let nextVx = vx + ax * step;
    const nextVy = vy + ay * step;
    const nextR = r + yawAccel * step;
    const drive = params.mass * finite(plant.axCommand);
    const net = drive + params.mass * grade.x;
    const rollingCapacity = params.rollingResistance * normalLoad;
    if (inContact && Math.abs(vx) < VX_REST && Math.abs(net) <= rollingCapacity) nextVx = 0;
    else if (inContact && finite(plant.axCommand) === 0 && vx !== 0 && vx * nextVx < 0) nextVx = 0;
    const axes = bodyAxes(yaw, inContact ? pitch : 0);
    plant.velocity.x = nextVx;
    plant.velocity.y = 0;
    plant.velocity.z = 0;
    plant.lateralVelocity = nextVy;
    plant.yawRate = nextR;
    plant.position.x += (axes.forward.x * nextVx + axes.right.x * nextVy) * step;
    plant.position.z += (axes.forward.z * nextVx + axes.right.z * nextVy) * step;
    if (inContact) {
        const vertical = axes.forward.y * nextVx + axes.right.y * nextVy;
        plant.position.y += vertical * step;
        plant.verticalVelocity = vertical;
        plant.acceleration.z = 0;
    } else {
        plant.verticalVelocity = finite(plant.verticalVelocity) - GRAVITY * step;
        plant.position.y += plant.verticalVelocity * step;
        plant.acceleration.z = gravZ;
    }
    plant.rotation.y = yaw + nextR * step;
    plant.onRoad = inContact;
    plant.acceleration.x = ax + (inContact ? 0 : gravX);
    plant.acceleration.y = ay;
}

/** Lift only a pose that has gone through the pavement. A crate above the road stays. */
export function settleContactBody(plant) {
    if (!plant) return;
    const sample = typeof plant.groundSampler === "function"
        ? plant.groundSampler(plant.position.x, plant.position.z, plant.rotation.y)
        : null;
    if (sample) {
        plant.rotation.x = 0;
        plant.rotation.z = finite(sample.pitch);
        plant.rotation.order = plant.rotation.order || "XYZ";
    }
    if (!sample || plant.position.y >= finite(sample.y)) return;
    const pitch = finite(sample.pitch);
    const normal = unitNormal(sample.normal ?? normalFromPitch(pitch, plant.rotation.y));
    const vel = worldVelocity(plant, plant.onRoad === true);
    const into = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
    if (into < 0) {
        vel.x -= into * normal.x;
        vel.y -= into * normal.y;
        vel.z -= into * normal.z;
    }
    const axes = bodyAxes(plant.rotation.y, pitch);
    plant.velocity.x = vel.x * axes.forward.x + vel.y * axes.forward.y + vel.z * axes.forward.z;
    plant.lateralVelocity = vel.x * axes.right.x + vel.y * axes.right.y + vel.z * axes.right.z;
    plant.verticalVelocity = axes.forward.y * plant.velocity.x + axes.right.y * plant.lateralVelocity;
    plant.position.y = finite(sample.y);
    plant.onRoad = true;
}

function publishContactPose(vehicle, plant) {
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

export function settleContactVehicles(vehicles = []) {
    for (const vehicle of vehicles) {
        const plant = contactBicycleBody(vehicle);
        if (!plant) continue;
        settleContactBody(plant);
        publishContactPose(vehicle, plant);
    }
}
