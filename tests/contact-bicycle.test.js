import assert from "node:assert/strict";
import test from "node:test";

import { PLANT_CONTACT_BICYCLE_MODEL } from "../app/plugin/PlantModule.js";
import { applyManualDrive } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine, supportPlanePosition } from "../app/physics/PhysicsEngine.js";
import {
    axleContactForces,
    contactAxes,
    groundClearance,
    tangentialGrade,
} from "../app/simulation/vehicles/contactBicycle.js";
import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import {
    CONTACT_BICYCLE_MODEL,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { placeChassis, runChassis, startChassis } from "./helpers/contactChassisRun.js";

const DT = 0.01;
const MERCEVES_AXLE = 0.112991;
const MERCEVES_RADIUS = 0.130091;
const MERCEVES_CLEARANCE = MERCEVES_RADIUS - MERCEVES_AXLE;
const FLUSH_WHEELS = [
    { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true },
    { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true },
    { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } },
    { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } },
];
const HANGING_WHEELS = [
    { id: "front-left", position: { x: 0.33, y: MERCEVES_AXLE, z: 0.26 }, radius: MERCEVES_RADIUS, steerable: true },
    { id: "rear-left", position: { x: -0.33, y: MERCEVES_AXLE, z: 0.26 }, radius: MERCEVES_RADIUS },
];

function manifest(overrides = {}, wheels = FLUSH_WHEELS) {
    return normalizeVehicleManifest({
        id: "contact-car",
        dynamics: { model: CONTACT_BICYCLE_MODEL, ...overrides },
        wheels,
    });
}

function plant(overrides = {}, pose = {}, wheels = FLUSH_WHEELS) {
    const body = new KinematicVehiclePlant(createVehiclePlantDefinition({
        id: pose.id || "ego",
        pose: {
            position: { x: 0, y: 0, z: 0, ...pose.position },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ", ...pose.rotation },
        },
    }, { manifest: manifest(overrides, wheels) }));
    body.telemetryId = pose.id || "ego";
    return body;
}

function fakeRapier() {
    class BodyDescriptor {
        setTranslation() { return this; }
    }
    class Body {
        isValid() { return true; }
        setNextKinematicTranslation() {}
    }
    class World {
        createRigidBody() { return new Body(); }
        createCollider() { return {}; }
        removeRigidBody() {}
        step() {}
        free() {}
    }
    return {
        init: async () => {},
        World,
        RigidBodyDesc: {
            fixed: () => new BodyDescriptor(),
            kinematicPositionBased: () => new BodyDescriptor(),
        },
        ColliderDesc: { cuboid: () => ({}) },
    };
}

const FLOOR = { obstacles: [], groundPlane: { y: 0 } };

function slopeWorld(pitch) {
    return { obstacles: [], groundPlane: { y: -5 }, drivableSurfaces: [rampMesh(pitch)] };
}

function rampMesh(pitch, x0 = -5, length = 60) {
    const rise = Math.tan(pitch) * length;
    const y0 = Math.tan(pitch) * x0;
    return {
        id: "ramp",
        kind: "road-mesh",
        vertices: [
            { x: x0, y: y0, z: -8 },
            { x: x0 + length, y: y0 + rise, z: -8 },
            { x: x0 + length, y: y0 + rise, z: 8 },
            { x: x0, y: y0, z: 8 },
        ],
        indices: [0, 1, 2, 0, 2, 3],
    };
}

async function drive(body, world, fn) {
    const { physics } = await startChassis(world, [body]);
    try {
        return await fn(physics);
    } finally {
        physics.disposeRun();
    }
}

test("ground clearance is the deepest tread below the origin", () => {
    assert.equal(groundClearance([]), 0);
    assert.equal(groundClearance([null]), 0);
    assert.equal(groundClearance([{ position: { y: 0.25 }, radius: 0.25 }]), 0);
    assert.equal(groundClearance([{ position: { y: 0.2 }, radius: 0.1 }]), 0);
    assert.ok(Math.abs(groundClearance(HANGING_WHEELS) - MERCEVES_CLEARANCE) < 1e-12);
    const mixed = groundClearance([
        { position: { y: 0.25 }, radius: 0.25 },
        { position: { y: MERCEVES_AXLE }, radius: MERCEVES_RADIUS },
        { position: { y: 0.1 }, radius: 0.13 },
    ]);
    assert.ok(Math.abs(mixed - 0.03) < 1e-12);
    const flush = plant();
    const hanging = plant({}, {}, HANGING_WHEELS);
    const bare = plant({}, {}, []);
    assert.equal(flush.groundClearance, 0);
    assert.equal(bare.groundClearance, 0);
    assert.ok(Math.abs(hanging.groundClearance - MERCEVES_CLEARANCE) < 1e-12);
    const plugin = createVehiclePlantDefinition({ id: "plug" }, {
        manifest: normalizeVehicleManifest({
            id: "plug",
            dynamics: { plant: "vendor.example.bicycle" },
            wheels: HANGING_WHEELS,
        }),
    });
    assert.equal(plugin.motionModel, "plugin");
    assert.ok(Math.abs(plugin.groundClearance - MERCEVES_CLEARANCE) < 1e-12);
});

test("airborne axle forces are zero and a grounded force has no yaw moment field", () => {
    const airborne = axleContactForces({ normalLoad: 0, axCommand: 3, vx: 4, inContact: false });
    assert.deepEqual(airborne, { Fxf: 0, Fyf: 0, Fxr: 0, Fyr: 0 });
    const grounded = axleContactForces({
        normalLoad: 1500 * 9.81,
        axCommand: 1,
        vx: 8,
        delta: 0.2,
        gradeX: 0,
    });
    assert.ok(Math.abs(grounded.Fyf) > 1);
    assert.equal(grounded.yawMoment, undefined);
});

test("rolling resistance holds a gentle grade and a steep grade overpowers it", () => {
    const load = 1500 * 9.81;
    const gentle = tangentialGrade({ x: -Math.sin(0.005), y: Math.cos(0.005), z: 0 }, 0, 0.005);
    const held = axleContactForces({ normalLoad: load * Math.cos(0.005), gradeX: gentle.x, vx: 0 });
    assert.ok(Math.abs(held.Fxf + held.Fxr + 1500 * gentle.x) < 1e-6);

    const steep = tangentialGrade({ x: -Math.sin(0.1), y: Math.cos(0.1), z: 0 }, 0, 0.1);
    const loose = axleContactForces({
        normalLoad: load * Math.cos(0.1),
        gradeX: steep.x,
        vx: 0,
        rollingResistance: 0,
    });
    assert.equal(loose.Fxf, 0);
    assert.equal(loose.Fxr, 0);
});

test("a car 10 m above the road falls and then stops on it", async () => {
    const body = plant({}, { position: { y: 10 } });
    await drive(body, FLOOR, (physics) => {
        runChassis(physics, [body], 50);
        assert.ok(body.position.y > 8, `still falling at y=${body.position.y}`);
        runChassis(physics, [body], 400);
        assert.ok(Math.abs(body.position.y) < 0.01, `y ${body.position.y}`);
        assert.ok(Math.abs(body.verticalVelocity) < 1e-3, `vertical ${body.verticalVelocity}`);
        const parked = body.position.y;
        runChassis(physics, [body], 20);
        assert.ok(Math.abs(body.position.y - parked) < 1e-3, `drift y ${body.position.y}`);
        assert.ok(Math.hypot(body.position.x, body.position.z) < 1e-3, "drift");
    });
});

test("an uphill grade slows the car and a flat road does not", async () => {
    const uphill = plant({ rollingResistance: 0 }, { position: { x: 5, y: Math.tan(0.1) * 5 + 0.05 } });
    const flat = plant({ rollingResistance: 0 }, { position: { y: 0.05 } });
    await drive(uphill, slopeWorld(0.1), (physics) => {
        runChassis(physics, [uphill], 50);
    });
    await drive(flat, FLOOR, (physics) => {
        runChassis(physics, [flat], 50);
    });
    assert.ok(uphill.velocity.x < -0.1, `uphill vx ${uphill.velocity.x}`);
    assert.ok(Math.abs(flat.velocity.x) < 1e-3, `flat vx ${flat.velocity.x}`);
    assert.ok(Math.abs(uphill.position.y - uphill.position.x * Math.tan(0.1)) < 0.05, `grade y ${uphill.position.y}`);
});

test("a pose already above the road is not pulled down in one step", async () => {
    const body = plant({}, { position: { y: 2 } });
    body.verticalVelocity = -4;
    await drive(body, FLOOR, (physics) => {
        runChassis(physics, [body], 1);
    });
    assert.ok(body.position.y > 1, `y ${body.position.y}`);
    assert.ok(body.position.y < 2, `y ${body.position.y}`);
});

test("a contact plugin force stepper matches the built-in plant", async () => {
    const wheels = [
        { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, steerable: true },
        { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, steerable: true },
        { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 } },
        { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 } },
    ];
    const entry = {
        id: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 4, y: 0, z: 0 },
        steeringAngle: 0.05,
    };
    const shared = { id: "contact-car", kinematics: { wheelbase: 1.5 }, wheels };
    const plugin = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, {
        manifest: normalizeVehicleManifest({ ...shared, dynamics: { plant: "acme.dynamics.bicycle.bicycle" } }),
    }, { plantModel: PLANT_CONTACT_BICYCLE_MODEL }), {
        stepper: {
            step(state, dt) {
                const forces = axleContactForces({
                    dt,
                    vx: state[6],
                    vy: state[7],
                    r: state[8],
                    delta: state[12],
                    axCommand: state[9],
                    gradeX: state[3],
                    normalLoad: state[11],
                    inContact: state[10] === 1,
                });
                const next = new Float64Array(state);
                next[6] = forces.Fxf;
                next[7] = forces.Fyf;
                next[9] = forces.Fxr;
                next[10] = forces.Fyr;
                return next;
            },
            reset() {},
        },
    });
    const javascript = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, {
        manifest: normalizeVehicleManifest({ ...shared, dynamics: { model: CONTACT_BICYCLE_MODEL } }),
    }));
    plugin.position.y = 0.05;
    javascript.position.y = 0.05;
    applyManualDrive(plugin, { mode: "acceleration", accelerationX: 1.5, steeringRad: 0.1 });
    applyManualDrive(javascript, { mode: "acceleration", accelerationX: 1.5, steeringRad: 0.1 });
    const left = await startChassis(FLOOR, [plugin]);
    const right = await startChassis(FLOOR, [javascript]);
    try {
        runChassis(left.physics, [plugin], 15);
        runChassis(right.physics, [javascript], 15);
    } finally {
        left.physics.disposeRun();
        right.physics.disposeRun();
    }
    for (const field of ["x", "y", "z"]) {
        assert.ok(Math.abs(plugin.position[field] - javascript.position[field]) < 1e-9, `${field} ${plugin.position[field]}`);
    }
    assert.ok(Math.abs(plugin.velocity.x - javascript.velocity.x) < 1e-9);
    assert.ok(Math.abs(plugin.lateralVelocity - javascript.lateralVelocity) < 1e-9);
    assert.ok(Math.abs(plugin.yawRate - javascript.yawRate) < 1e-9);
    assert.ok(Math.abs(plugin.verticalVelocity - javascript.verticalVelocity) < 1e-9);
    assert.ok(plugin.position.x > 0.5, `x ${plugin.position.x}`);
});

test("the checker floor lifts a contact car and the next step can drive", async () => {
    const body = plant({}, { position: { y: -0.2 } });
    body.verticalVelocity = -2;
    await drive(body, FLOOR, (physics) => {
        runChassis(physics, [body], 40);
        assert.ok(body.position.y > -1e-3, `y ${body.position.y}`);
        assert.ok(body.position.y < 0.05, `y ${body.position.y}`);
        runChassis(physics, [body], 20, { mode: "acceleration", accelerationX: 2 });
        assert.ok(body.velocity.x > 0, `vx ${body.velocity.x}`);
    });
});

test("the checker holds a sweep-driven car that ends a step below it", async () => {
    const kinematic = {
        telemetryId: "box",
        position: { x: 40, y: 1, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const world = { obstacles: [], groundPlane: { y: 0 } };
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [kinematic] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    physics.beginStep();
    kinematic.position.y = -0.2;
    physics.step(DT);
    assert.equal(kinematic.position.y, 0);
    physics.disposeRun();
});

test("a road above the floor pitches the car and a buried road does not", async () => {
    const pitch = 0.1;
    const world = {
        obstacles: [],
        groundPlane: { y: 0 },
        drivableSurfaces: [
            rampMesh(pitch, 2, 20),
            {
                id: "buried",
                kind: "road-mesh",
                vertices: [
                    { x: -8, y: -3, z: -6 }, { x: 1, y: -1, z: -6 },
                    { x: 1, y: -1, z: 6 }, { x: -8, y: -3, z: 6 },
                ],
                indices: [0, 1, 2, 0, 2, 3],
            },
        ],
    };
    const body = plant({}, { position: { x: -2, y: 0.2 } });
    await drive(body, world, (physics) => {
        runChassis(physics, [body], 40);
        assert.equal(body.onRoad, true);
        assert.ok(Math.abs(body.rotation.z) < 0.02, `flat pitch ${body.rotation.z}`);
        runChassis(physics, [body], 20, { mode: "acceleration", accelerationX: 2 });
        assert.ok(body.velocity.x > 0, `vx ${body.velocity.x}`);
        body.position.x = 8;
        body.position.y = Math.tan(pitch) * 6 + 0.1;
        body.position.z = 0;
        body.velocity.x = 0;
        body.lateralVelocity = 0;
        body.yawRate = 0;
        placeChassis(physics, body);
        runChassis(physics, [body], 40);
        assert.ok(Math.abs(body.rotation.z - pitch) < 0.02, `ramp pitch ${body.rotation.z}`);
        assert.equal(body.rotation.x, 0);
    });
});

test("no floor keeps a contact car falling", async () => {
    const body = plant({}, { position: { y: 1 } });
    await drive(body, { obstacles: [] }, (physics) => {
        runChassis(physics, [body], 5);
    });
    assert.ok(body.position.y < 1, `y ${body.position.y}`);
    assert.equal(body.onRoad, false);
});

test("drive force stays off while the car is in the air", async () => {
    const body = plant({}, { position: { y: 4 } });
    await drive(body, FLOOR, (physics) => {
        runChassis(physics, [body], 1, { accelerationX: 3 });
    });
    assert.ok(Math.abs(body.velocity.x) < 1e-6, `vx ${body.velocity.x}`);
    assert.ok(body.verticalVelocity < 0, `vertical ${body.verticalVelocity}`);
    assert.equal(body.axCommand, 0);
    assert.equal(body.contactControlActive, false);
});

test("a floor with its collider off still holds a contact car", async () => {
    const body = plant({}, { position: { y: 1 } }, HANGING_WHEELS);
    await drive(body, { obstacles: [], groundPlane: { y: 0, collider: false } }, (physics) => {
        runChassis(physics, [body], 160);
        assert.ok(Math.abs(body.position.y - MERCEVES_CLEARANCE) < 0.01, `y ${body.position.y}`);
        runChassis(physics, [body], 20, { mode: "acceleration", accelerationX: 2 });
        assert.ok(body.velocity.x > 0, `vx ${body.velocity.x}`);
    });
});

test("cross-slope contact has zero heading pitch", () => {
    const normal = { x: 0, y: Math.cos(0.2), z: Math.sin(0.2) };
    const axes = contactAxes(normal, 0);
    assert.equal(axes.pitch, 0);
    assert.ok(Math.abs(axes.right.y - Math.sin(0.2)) < 1e-12);
});

test("lateral friction dissipates forward, reverse, and zero-forward-speed slip without overshoot", () => {
    for (const vx of [-1, -0.001, 0, 0.001, 1]) {
        for (const vy of [-1, -0.0001, 0.0001, 1]) {
            for (const dt of [0.01, 1 / 60, 0.1]) {
                const forces = axleContactForces({ vx, vy, dt, normalLoad: 1500 * 9.81 });
                const fy = forces.Fyf + forces.Fyr;
                assert.ok(fy * vy < 0, `${vx}, ${vy}: friction must oppose slip`);
                const next = vy + fy / 1500 * dt;
                assert.ok(Math.abs(next) <= Math.abs(vy) + 1e-12);
                assert.ok(next * vy >= -1e-12, "friction must not reverse lateral slip");
            }
        }
    }
});

test("forward and reverse steer generate opposite yaw moments", () => {
    for (const vx of [-2, 2]) {
        const f = axleContactForces({ vx, delta: 0.2, dt: DT, normalLoad: 1500 * 9.81 });
        assert.ok(f.Fyf * vx > 0);
    }
});

test("an unpowered flat contact car dissipates lateral and yaw energy at rest and in reverse", async () => {
    const body = plant({}, { position: { y: 0.05 } });
    await drive(body, FLOOR, (physics) => {
        for (const vx of [-1, 0, 1]) {
            body.position.x = 0;
            body.position.y = 0.05;
            body.position.z = 0;
            body.rotation.y = 0;
            body.rotation.z = 0;
            body.velocity.x = vx;
            body.lateralVelocity = 1;
            body.yawRate = 0.2;
            body.verticalVelocity = 0;
            placeChassis(physics, body);
            runChassis(physics, [body], 600, null, { dt: 1 / 60 });
            assert.ok(Math.hypot(body.velocity.x, body.lateralVelocity) < 0.05, `vx ${body.velocity.x} vy ${body.lateralVelocity}`);
            assert.ok(Math.abs(body.yawRate) < 0.05, `yaw rate ${body.yawRate}`);
        }
    });
});
