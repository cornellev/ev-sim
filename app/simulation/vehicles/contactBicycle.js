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

function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
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
    const axes = alongRoad && plant.contactNormal
        ? contactAxes(plant.contactNormal, plant.rotation.y)
        : bodyAxes(plant.rotation.y, alongRoad ? plant.rotation.z : 0);
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

/** Support of the zero-roll wheel cylinders against the selected surface plane. */
export function contactClearance(plant, normal, pitch) {
    const wheels = plant.definition?.contactWheels;
    if (!wheels?.length) return Math.max(0, finite(plant.groundClearance));
    const yaw = finite(plant.rotation?.y);
    const { forward, right } = bodyAxes(yaw, pitch);
    const up = { x: -Math.cos(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: Math.sin(yaw) * Math.sin(pitch) };
    const n = unitNormal(normal);
    let clearance = 0;
    for (const wheel of wheels) {
        const center = wheel.position;
        const projectedCenter = center.x * dot(n, forward) + center.y * dot(n, up) - center.z * dot(n, right);
        const steer = wheel.steerable ? finite(plant.steeringAngle) : 0;
        const axle = {
            x: -right.x * Math.cos(steer) + forward.x * Math.sin(steer),
            y: -right.y * Math.cos(steer) + forward.y * Math.sin(steer),
            z: -right.z * Math.cos(steer) + forward.z * Math.sin(steer),
        };
        const axial = Math.min(1, Math.abs(dot(n, axle)));
        const radius = wheel.radius * Math.sqrt(Math.max(0, 1 - axial * axial)) + wheel.width * axial / 2;
        clearance = Math.max(clearance, (radius - projectedCenter) / Math.max(1e-9, n.y));
    }
    return clearance;
}

export function sampleContactSupport(plant) {
    const yaw = finite(plant.rotation.y);
    const road = plant.groundSampler?.(plant.position.x, plant.position.z, yaw);
    const floor = Object.hasOwn(plant, "groundPlane") ? plant.groundPlane : plant.floorSupport;
    const sample = road && (!floor || finite(road.y) >= finite(floor.y))
        ? { ...road, source: "road" }
        : floor ? { y: finite(floor.y), normal: { x: 0, y: 1, z: 0 }, source: "floor" } : null;
    if (!sample) return null;
    const normal = unitNormal(sample.normal ?? normalFromPitch(sample.pitch, yaw));
    const axes = contactAxes(normal, yaw);
    return { ...sample, normal, pitch: axes.pitch, y: finite(sample.y) + contactClearance(plant, normal, axes.pitch) };
}

/** The checker floor held this car. The next step drives on it when no road is underneath. */
export function catchContactFloor(plant, planeY, held) {
    if (!plant) return;
    if (!held) {
        plant.floorSupport = null;
        return;
    }
    const y = finite(planeY);
    plant.position.y = y + contactClearance(plant, { x: 0, y: 1, z: 0 }, 0);
    if (finite(plant.verticalVelocity) < 0) plant.verticalVelocity = 0;
    plant.rotation.x = 0;
    plant.rotation.z = 0;
    plant.floorSupport = { y, normal: { x: 0, y: 1, z: 0 } };
}

/** Free motion. The road catch runs after the obstacle sweep. */
export function stepContactPlant(plant, dt) {
    const step = Math.max(0, finite(dt));
    if (step === 0) return;
    const yaw = finite(plant.rotation?.y);
    const sample = sampleContactSupport(plant);
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
    plant.axCommand = inContact ? contactLongitudinalCommand({
        ...plant.longitudinal,
        vx: plant.velocity.x,
        previousAx: plant.axCommand,
        realizedAx: plant.contactControlActive ? plant.acceleration.x : 0,
        dt: step,
        maxAcceleration: finite(plant.kinematics?.maxAcceleration, 3),
        maxDeceleration: finite(plant.kinematics?.maxDeceleration, 5),
        maxJerk: finite(plant.kinematics?.maxJerk, 10),
    }) : 0;
    plant.contactControlActive = inContact;
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
    const axes = inContact ? contactAxes(normal, yaw) : bodyAxes(yaw, 0);
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
    plant.contactNormal = inContact ? normal : null;
    plant.acceleration.x = ax + (inContact ? 0 : gravX);
    plant.acceleration.y = ay;
}

/** Lift only a pose that has gone through the pavement. A crate above the road stays. */
export function settleContactBody(plant) {
    if (!plant) return null;
    const sample = sampleContactSupport(plant);
    if (sample) {
        plant.rotation.x = 0;
        plant.rotation.z = finite(sample.pitch);
        plant.rotation.order = plant.rotation.order || "XYZ";
    }
    if (!sample || plant.position.y > finite(sample.y) + CONTACT_SLACK) return null;
    const normal = sample.normal;
    const vel = worldVelocity(plant, plant.onRoad === true);
    const into = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
    if (into < 0) {
        vel.x -= into * normal.x;
        vel.y -= into * normal.y;
        vel.z -= into * normal.z;
    }
    const axes = contactAxes(normal, plant.rotation.y);
    plant.velocity.x = vel.x * axes.forward.x + vel.y * axes.forward.y + vel.z * axes.forward.z;
    plant.lateralVelocity = vel.x * axes.right.x + vel.y * axes.right.y + vel.z * axes.right.z;
    plant.verticalVelocity = axes.forward.y * plant.velocity.x + axes.right.y * plant.lateralVelocity;
    plant.position.y = finite(sample.y);
    plant.onRoad = true;
    plant.contactNormal = normal;
    plant.floorSupport = sample.source === "floor" ? { y: finite(plant.groundPlane?.y ?? plant.floorSupport?.y) } : null;
    return sample;
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
