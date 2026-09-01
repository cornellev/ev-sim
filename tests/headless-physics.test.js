import assert from "node:assert/strict";
import test from "node:test";

import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine, sweepAabbTrianglePrism } from "../app/physics/PhysicsEngine.js";
import { createWorldDescription } from "../app/simulation/world/WorldDescription.js";

function fakeRapier({ throwOnBorrowedFree = true } = {}) {
    class BodyDescriptor {
        setTranslation(x, y, z) { this.translation = { x, y, z }; return this; }
    }
    class Body {
        constructor(world) { this.world = world; }
        isValid() { return Boolean(this.world); }
        setNextKinematicTranslation(position) { this.next = { ...position }; }
    }
    class World {
        constructor(gravity) {
            this.gravity = gravity;
            this.freed = false;
            this.bodies = [];
        }
        createRigidBody() {
            const body = new Body(this);
            this.bodies.push(body);
            return body;
        }
        createCollider() { return {}; }
        removeRigidBody(body) {
            this.bodies = this.bodies.filter((entry) => entry !== body);
            if (body) body.world = null;
        }
        step() {}
        free() {
            if (throwOnBorrowedFree && this.bodies.length) {
                throw new Error("attempted to take ownership of Rust value while it was borrowed");
            }
            this.freed = true;
        }
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

function collisionWorld() {
    return createWorldDescription({
        environmentId: "collision-world",
        templateId: "blank",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        document: {
            roads: { nodes: [], edges: [] },
            buildings: [{
                buildingId: "rotated-building",
                footprint: [{ x: 10, z: 0 }, { x: 12, z: -2 }, { x: 14, z: 0 }, { x: 12, z: 2 }],
                height: 4,
            }],
            features: [{ id: "thin-sign", type: "stop-sign", x: 5, z: 0, rotationY: Math.PI / 4 }],
        },
    });
}

test("continuous prism SAT hits rotated buildings and rejects parallel misses", () => {
    const obstacle = collisionWorld().obstacles.find((entry) => entry.sourceId === "rotated-building");
    const half = { x: 0.5, y: 0.5, z: 0.5 };
    const sweep = (start, end) => Math.min(...obstacle.triangles.map((triangle) => {
        const points = triangle.map((index) => obstacle.footprint[index]);
        return sweepAabbTrianglePrism(start, end, half, points, obstacle.minY, obstacle.maxY) ?? Infinity;
    }));
    assert.ok(Number.isFinite(sweep({ x: 0, y: 0.5, z: 0 }, { x: 20, y: 0.5, z: 0 })));
    assert.equal(sweep({ x: 0, y: 0.5, z: 5 }, { x: 20, y: 0.5, z: 5 }), Infinity);
    assert.equal(sweep({ x: 0, y: 10, z: 0 }, { x: 20, y: 10, z: 0 }), Infinity);
});

test("physics prevents tunneling, collapses triangle hits to stable source contacts, and tears down", async () => {
    const vehicle = {
        telemetryId: "ego",
        collisionDimensions: { x: 1, y: 1, z: 1 },
        position: { x: 0, y: 0.5, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const data = {
        vehicles: () => ({ vehicles: [vehicle] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    };
    const physics = new PhysicsEngine(data, { loadPhysics: async () => fakeRapier() });
    const worldDescription = collisionWorld();
    await physics.configureRun({
        manifest: {},
        worldDescription,
        backendSelection: createPhysicsBackendSelection(),
    });
    physics.beginStep();
    vehicle.position.x = 20;
    physics.step(1);
    const contacts = physics.syncAndPublishContacts({ step: 1, timeNs: 1_000_000_000 });
    assert.ok(vehicle.position.x < 5);
    assert.deepEqual(contacts.started, ["ego|feature:thin-sign"]);
    assert.deepEqual(contacts.active, ["ego|feature:thin-sign"]);
    assert.equal(contacts.active.length, 1);
    physics.disposeRun();
    assert.equal(physics.world, null);
    assert.deepEqual(physics.staticColliders, []);
    assert.deepEqual(physics.vehicleStates, []);
});

test("Rapier load does not create a world until physics starts", async () => {
    const physics = new PhysicsEngine({}, { loadPhysics: async () => fakeRapier() });
    await physics._initialization;
    assert.equal(physics.world, null);
    await physics.start();
    assert.ok(physics.world);
    physics.disposeRun();
    assert.equal(physics.world, null);
});

test("dispose during Rapier load does not create a late world", async () => {
    let resolvePhysics;
    const physics = new PhysicsEngine({}, {
        loadPhysics: () => new Promise((resolve) => { resolvePhysics = resolve; }),
    });
    physics.disposeRun();
    resolvePhysics(fakeRapier());
    await physics._initialization;
    assert.equal(physics.world, null);
});

test("disposeRun drops rigid-body wrappers before freeing Rapier", async () => {
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [] }),
        objects: () => ({ boxes: () => [{ position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier() });
    await physics.configureRun();
    const world = physics.world;
    assert.ok(world);
    assert.ok(physics.rigidbodies.length > 0);
    physics.disposeRun();
    assert.equal(physics.world, null);
    assert.deepEqual(physics.rigidbodies, []);
    assert.equal(world.freed, true);
    assert.equal(world.bodies.length, 0);
});

test("disposeRun finishes even if Rapier still reports a borrow", async () => {
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    }, { loadPhysics: async () => fakeRapier({ throwOnBorrowedFree: false }) });
    await physics.start();
    physics.world.free = () => {
        throw new Error("attempted to take ownership of Rust value while it was borrowed");
    };
    physics.disposeRun();
    assert.equal(physics.world, null);
});

