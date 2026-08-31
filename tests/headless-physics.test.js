import assert from "node:assert/strict";
import test from "node:test";

import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { PhysicsEngine, sweepAabbTrianglePrism } from "../app/physics/PhysicsEngine.js";
import { createWorldDescription } from "../app/simulation/world/WorldDescription.js";

function fakeRapier() {
    class BodyDescriptor {
        setTranslation(x, y, z) { this.translation = { x, y, z }; return this; }
    }
    class Body {
        setNextKinematicTranslation(position) { this.next = { ...position }; }
    }
    class World {
        constructor(gravity) { this.gravity = gravity; this.freed = false; }
        createRigidBody() { return new Body(); }
        createCollider() { return {}; }
        step() {}
        free() { this.freed = true; }
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

