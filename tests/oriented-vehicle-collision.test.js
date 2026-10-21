import assert from "node:assert/strict";
import test from "node:test";

import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine, sweepObbTrianglePrism } from "../app/physics/PhysicsEngine.js";
import { obbAsConvex, sweepAabbConvex, sweepObbConvex } from "../app/physics/SweptConvex.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";

const MERCEVES_HALF = { x: 1.092 / 2, y: 0.584 / 2, z: 0.627 / 2 };
const MERCEVES_CENTER = { x: 0, y: 0.275, z: 0 };
const LOGGED_YAW = 0.8039542804642326;
const LOGGED_POSE = { x: -0.04123380772160125, y: 0.05, z: -9.445648999977287 };
const CONE_HALF = { x: 0.075, y: (0.267909 - 0.090109) / 2, z: 0.075 };
const CONE_CENTER_Y = (0.090109 + 0.267909) / 2;

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

function coneConvex(position, yaw = 0) {
    return obbAsConvex(position, { half: CONE_HALF, center: { x: 0, y: CONE_CENTER_Y, z: 0 }, yaw });
}

test("yaw-zero oriented sweep matches the axis-aligned convex sweep", () => {
    const obstacle = obbAsConvex(
        { x: 5, y: 0.5, z: 0 },
        { half: { x: 0.5, y: 0.5, z: 0.5 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    const half = { x: 1, y: 0.5, z: 0.5 };
    const start = { x: 0, y: 0.5, z: 0 };
    const end = { x: 10, y: 0.5, z: 0 };
    assert.equal(
        sweepObbConvex(start, end, { half, center: { x: 0, y: 0, z: 0 }, yaw: 0 }, obstacle),
        sweepAabbConvex(start, end, half, obstacle),
    );
});

test("yaw of pi/2 swaps vehicle length and width", () => {
    const half = { x: 2, y: 0.5, z: 0.2 };
    const pose = { x: 0, y: 0.5, z: 0 };
    const beside = obbAsConvex(
        { x: 1.5, y: 0.5, z: 0 },
        { half: { x: 0.05, y: 0.5, z: 0.05 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    const ahead = obbAsConvex(
        { x: 0, y: 0.5, z: -1.5 },
        { half: { x: 0.05, y: 0.5, z: 0.05 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    assert.equal(sweepObbConvex(pose, pose, { half, yaw: 0 }, beside), 0);
    assert.equal(sweepObbConvex(pose, pose, { half, yaw: Math.PI / 2 }, beside), null);
    assert.equal(sweepObbConvex(pose, pose, { half, yaw: 0 }, ahead), null);
    assert.equal(sweepObbConvex(pose, pose, { half, yaw: Math.PI / 2 }, ahead), 0);
});

test("bounding-box center moves the contact earlier along the nose", () => {
    const wall = obbAsConvex(
        { x: 3, y: 0.5, z: 0 },
        { half: { x: 0.05, y: 0.5, z: 1 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    const half = { x: 1, y: 0.5, z: 0.5 };
    const start = { x: 0, y: 0.5, z: 0 };
    const end = { x: 10, y: 0.5, z: 0 };
    const centered = sweepObbConvex(start, end, { half, yaw: 0 }, wall);
    const forward = sweepObbConvex(start, end, { half, center: { x: 0.5, y: 0, z: 0 }, yaw: 0 }, wall);
    assert.ok(centered > 0.15 && centered < 0.25);
    assert.ok(forward > 0.1 && forward < centered);
});

test("the logged October 31 graze misses the oriented body and a cone on the nose hits", () => {
    const cone = coneConvex(
        { x: -0.5595938885094962, y: -0.02, z: -9.864579078640245 },
        2.2466351206097928,
    );
    const start = { ...LOGGED_POSE, z: -8.5 };
    const box = { half: MERCEVES_HALF, center: MERCEVES_CENTER, yaw: LOGGED_YAW };
    assert.equal(sweepAabbConvex(LOGGED_POSE, LOGGED_POSE, MERCEVES_HALF, cone), 0);
    assert.equal(sweepObbConvex(start, LOGGED_POSE, box, cone), null);
    assert.equal(sweepObbConvex(LOGGED_POSE, LOGGED_POSE, box, cone), null);

    const nose = MERCEVES_HALF.x - 0.02;
    const onNose = coneConvex({
        x: LOGGED_POSE.x + Math.cos(LOGGED_YAW) * nose,
        y: LOGGED_POSE.y,
        z: LOGGED_POSE.z - Math.sin(LOGGED_YAW) * nose,
    });
    assert.equal(sweepObbConvex(LOGGED_POSE, LOGGED_POSE, box, onNose), 0);
});

test("oriented prism sweep uses vehicle width when the nose is turned", () => {
    const wall = [{ x: 3, z: -2 }, { x: 3.2, z: -2 }, { x: 3.2, z: 2 }, { x: 3, z: 2 }];
    const start = { x: 0, y: 0.5, z: 0 };
    const end = { x: 10, y: 0.5, z: 0 };
    const half = { x: 2, y: 0.5, z: 0.2 };
    const alongLength = sweepObbTrianglePrism(start, end, { half, yaw: 0 }, wall, 0, 2);
    const alongWidth = sweepObbTrianglePrism(start, end, { half, yaw: Math.PI / 2 }, wall, 0, 2);
    assert.ok(alongLength < 0.15);
    assert.ok(alongWidth > alongLength);
});

test("oriented vehicle-vehicle sweep ignores the world-axis box", async () => {
    const world = { obstacles: [] };
    const left = {
        telemetryId: "left",
        collisionDimensions: { x: 4, y: 1, z: 0.4 },
        rotation: { y: Math.PI / 2 },
        position: { x: 0, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const right = {
        telemetryId: "right",
        collisionDimensions: { x: 1, y: 1, z: 1 },
        rotation: { y: 0 },
        position: { x: 1.5, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [left, right] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    physics.beginStep();
    left.position.x = 0.5;
    physics.step(1 / 60);
    const missed = physics.syncAndPublishContacts({ step: 1, timeNs: 1 });
    assert.equal(left.position.x, 0.5);
    assert.deepEqual(missed.started, []);

    left.position.x = 0;
    left.position.z = 0;
    right.position.x = 0;
    right.position.z = -3;
    physics.beginStep();
    left.position.z = -4;
    physics.step(1 / 60);
    const stopped = physics.syncAndPublishContacts({ step: 2, timeNs: 2 });
    assert.ok(left.position.z < -0.4 && left.position.z > -0.8);
    assert.deepEqual(stopped.started, ["left|right"]);
    physics.disposeRun();
});

test("a shortened dynamic bicycle loses into-wall speed and a kinematic plant does not", async () => {
    const wall = obbAsConvex(
        { x: 3, y: 0.5, z: 0 },
        { half: { x: 0.05, y: 1, z: 2 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    function body(motionModel) {
        return {
            telemetryId: "ego",
            motionModel,
            collisionDimensions: { x: 2, y: 1, z: 1 },
            collisionCenter: { x: 0, y: 0, z: 0 },
            rotation: { y: 0 },
            position: { x: 0, y: 0.5, z: 0 },
            velocity: { x: 8, y: 0, z: 0 },
            lateralVelocity: 0.4,
            yawRate: 0.2,
            updatePosition(position) { Object.assign(this.position, position); },
        };
    }
    async function drive(vehicle) {
        const world = {
            obstacles: [],
            assetProxies: [{ id: "wall", sourceId: "wall", collision: [wall] }],
        };
        const physics = new PhysicsEngine({
            vehicles: () => ({ vehicles: [vehicle] }),
            objects: () => ({ boxes: () => [] }),
            bindings: () => ({ signalStore: null }),
        }, { loadPhysics: async () => fakeRapier() });
        await physics.configureRun({
            manifest: {},
            worldDescription: world,
            backendSelection: createPhysicsBackendSelection(world),
        });
        physics.beginStep();
        vehicle.position.x = 5;
        physics.step(1 / 60);
        physics.disposeRun();
        return vehicle;
    }
    const dynamic = await drive(body("dynamic-bicycle"));
    assert.ok(dynamic.position.x > 1.5 && dynamic.position.x < 2.2);
    assert.ok(Math.abs(dynamic.velocity.x) < 1e-9);
    assert.ok(Math.abs(dynamic.lateralVelocity - 0.4) < 1e-9);
    assert.equal(dynamic.yawRate, 0.2);

    const kinematic = await drive(body("bicycle"));
    assert.ok(kinematic.position.x > 1.5 && kinematic.position.x < 2.2);
    assert.equal(kinematic.velocity.x, 8);
    assert.equal(kinematic.lateralVelocity, 0.4);

    const plant = {
        motionModel: "dynamic-bicycle",
        position: { x: 0, y: 0.5, z: 0 },
        velocity: { x: 8, y: 1, z: 2 },
        lateralVelocity: 0.4,
        rotation: { y: 0 },
        yawRate: 0.2,
    };
    const view = body("bicycle");
    view.plant = plant;
    await drive(view);
    assert.ok(plant.position.x > 1.5 && plant.position.x < 2.2);
    assert.ok(Math.abs(plant.velocity.x) < 1e-9);
    assert.ok(Math.abs(view.velocity.x) < 1e-9);
    assert.equal(plant.yawRate, 0.2);
});

test("a nested kinematic plant takes the clamped pose and keeps its speed", async () => {
    const wall = obbAsConvex(
        { x: 3, y: 0.5, z: 0 },
        { half: { x: 0.05, y: 1, z: 2 }, center: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    const plant = {
        motionModel: "bicycle",
        position: { x: 0, y: 0.5, z: 0 },
        velocity: { x: 8, y: 0, z: 0 },
        rotation: { y: 0 },
    };
    const vehicle = {
        telemetryId: "ego",
        motionModel: "bicycle",
        collisionDimensions: { x: 2, y: 1, z: 1 },
        collisionCenter: { x: 0, y: 0, z: 0 },
        rotation: { y: 0 },
        position: { x: 0, y: 0.5, z: 0 },
        velocity: { x: 8, y: 0, z: 0 },
        plant,
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const world = {
        obstacles: [],
        assetProxies: [{ id: "wall", sourceId: "wall", collision: [wall] }],
    };
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [vehicle] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    physics.beginStep();
    vehicle.position.x = 5;
    physics.step(1 / 60);
    assert.ok(plant.position.x > 1.5 && plant.position.x < 2.2, `plant x ${plant.position.x}`);
    assert.equal(plant.position.x, vehicle.position.x);
    assert.equal(plant.position.y, vehicle.position.y);
    assert.equal(plant.position.z, vehicle.position.z);
    assert.equal(plant.velocity.x, 8);
    physics.disposeRun();
});

test("a ground-floor hold does not change dynamic planar speed", async () => {
    const vehicle = {
        telemetryId: "ego",
        motionModel: "dynamic-bicycle",
        collisionDimensions: { x: 2, y: 1, z: 1 },
        collisionCenter: { x: 0, y: 0, z: 0 },
        rotation: { y: 0 },
        position: { x: 0, y: 0.2, z: 0 },
        velocity: { x: 4, y: 0, z: 0 },
        lateralVelocity: 0.25,
        yawRate: 0.1,
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const world = { obstacles: [], groundPlane: { y: 1 } };
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [vehicle] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun({
        manifest: {},
        worldDescription: world,
        backendSelection: createPhysicsBackendSelection(world),
    });
    physics.beginStep();
    vehicle.position.y = 0;
    physics.step(1 / 60);
    assert.equal(vehicle.position.y, 1);
    assert.equal(vehicle.velocity.x, 4);
    assert.equal(vehicle.lateralVelocity, 0.25);
    assert.equal(vehicle.yawRate, 0.1);
    physics.disposeRun();
});

test("the vehicle plant publishes the manifest bounding-box center", () => {
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition({ id: "ego", type: "big-car" }));
    assert.equal(plant.collisionCenter.y, 0.7);
    assert.equal(plant.collisionCenter.x, 0);
    assert.equal(plant.collisionCenter.z, 0);
});

test("an off-centerline cone is a miss and an in-lane cone stops the car", async () => {
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 1.092, y: 0.584, z: 0.627 },
        collisionCenter: MERCEVES_CENTER,
        rotation: { y: Math.PI / 2 },
        position: { x: 0, y: 0.05, z: -8 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    async function drive(coneX) {
        const source = coneX === 0 ? "cone-lane" : "cone-offset";
        const world = {
            obstacles: [],
            assetProxies: [{
                id: source,
                sourceId: source,
                collision: [coneConvex({ x: coneX, y: 0, z: -10 })],
            }],
        };
        const physics = new PhysicsEngine({
            vehicles: () => ({ vehicles: [vehicle] }),
            objects: () => ({ boxes: () => [] }),
            bindings: () => ({ signalStore: null }),
        }, { loadPhysics: async () => fakeRapier() });
        await physics.configureRun({
            manifest: {},
            worldDescription: world,
            backendSelection: createPhysicsBackendSelection(world),
        });
        vehicle.position.x = 0;
        vehicle.position.y = 0.05;
        vehicle.position.z = -8;
        physics.beginStep();
        vehicle.position.z = -12;
        physics.step(1 / 60);
        const contacts = physics.syncAndPublishContacts({ step: 1, timeNs: 16_666_667 });
        physics.disposeRun();
        return { position: { ...vehicle.position }, contacts };
    }

    const missed = await drive(-0.56);
    assert.equal(missed.position.z, -12);
    assert.deepEqual(missed.contacts.started, []);

    const stopped = await drive(0);
    assert.ok(stopped.position.z < -9 && stopped.position.z > -10);
    assert.deepEqual(stopped.contacts.started, ["ego|cone-lane"]);
});
