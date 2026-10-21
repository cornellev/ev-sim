import { stepDynamicBicycle } from "../../app/simulation/vehicles/dynamicBicycle.js";
import { DEFAULT_DYNAMIC_BICYCLE } from "../../app/vehicles/VehicleManifest.js";

const SHARED = {
    x: 10,
    z: -4,
    yaw: 0.3,
    wheelbase: 1.5,
    maxSteeringAngle: 0.6,
    dt: 0.02,
    ...DEFAULT_DYNAMIC_BICYCLE,
};

const INPUT_KEYS = [
    "x", "z", "yaw", "vx", "vy", "r", "pitch", "delta", "axCommand", "dt",
    "wheelbase", "maxSteeringAngle", "mass", "yawInertia",
    "corneringStiffnessFront", "corneringStiffnessRear", "frictionMu", "rollingResistance",
];

const CASES = [
    { id: "stick-on-grade", match: ["longitudinal", "cornering", "bicycle"], vx: 0, vy: 0, r: 0, pitch: 0.01, delta: 0, axCommand: 0 },
    { id: "slide-on-grade", match: ["longitudinal", "cornering", "bicycle"], vx: 0, vy: 0, r: 0, pitch: 0.2, delta: 0, axCommand: 0 },
    { id: "drive-flat", match: ["longitudinal", "cornering", "bicycle"], vx: 5, vy: 0, r: 0, pitch: 0, delta: 0, axCommand: 1.5 },
    { id: "coast-uphill", match: ["longitudinal", "cornering", "bicycle"], vx: 8, vy: 0, r: 0, pitch: 0.02, delta: 0, axCommand: 0 },
    { id: "reverse-roll", match: ["longitudinal", "cornering", "bicycle"], vx: -3, vy: 0, r: 0, pitch: 0, delta: 0, axCommand: 0 },
    { id: "stop-before-reverse", match: ["longitudinal", "cornering", "bicycle"], vx: 0.002, vy: 0, r: 0, pitch: 0, delta: 0, axCommand: 0, dt: 0.05 },
    { id: "gentle-turn", match: ["cornering", "bicycle"], vx: 8, vy: 0.05, r: 0.02, pitch: 0.02, delta: 0.04, axCommand: 0.4 },
    { id: "rest-kills-lateral", match: ["cornering", "bicycle"], vx: 1e-4, vy: 0.4, r: 0.3, pitch: 0, delta: 0.2, axCommand: 0 },
    { id: "hard-turn", match: ["bicycle"], vx: 12, vy: 1.2, r: 0.6, pitch: 0.01, delta: 0.5, axCommand: 4 },
    { id: "friction-limit", match: ["bicycle"], vx: 5, vy: 0, r: 0, pitch: 0, delta: 0, axCommand: 12 },
];

function canonical(value) {
    const number = Number(value);
    return Object.is(number, -0) ? 0 : number;
}

export function buildDynamicBicycleStepOracle() {
    return {
        rows: CASES.map((entry) => {
            const source = { ...SHARED, ...entry };
            const half = Math.max(1e-9, source.wheelbase) / 2;
            const input = Object.fromEntries(INPUT_KEYS.map((key) => [key, canonical(source[key])]));
            const stepped = stepDynamicBicycle({
                x: input.x,
                z: input.z,
                yaw: input.yaw,
                vx: input.vx,
                vy: input.vy,
                r: input.r,
            }, {
                axCommand: input.axCommand,
                delta: input.delta,
                pitch: input.pitch,
                dt: input.dt,
                mass: input.mass,
                yawInertia: input.yawInertia,
                lf: half,
                lr: half,
                corneringStiffnessFront: input.corneringStiffnessFront,
                corneringStiffnessRear: input.corneringStiffnessRear,
                frictionMu: input.frictionMu,
                rollingResistance: input.rollingResistance,
            });
            return {
                id: entry.id,
                match: entry.match,
                input,
                expect: {
                    x: canonical(stepped.x),
                    z: canonical(stepped.z),
                    yaw: canonical(stepped.yaw),
                    vx: canonical(stepped.vx),
                    vy: canonical(stepped.vy),
                    r: canonical(stepped.r),
                    ax: canonical(stepped.ax),
                    ay: canonical(stepped.ay),
                },
            };
        }),
    };
}
