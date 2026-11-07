import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { CHASSIS_GROUP, DYNAMIC_GROUP, PhysicsEngine } from "../app/physics/PhysicsEngine.js";
import { createWorldDescription, hashWorldDescription } from "../app/simulation/world/WorldDescription.js";

function groups(membership, filter = 0xffff) {
    return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

async function start(description) {
    const snapshot = JSON.stringify(description);
    const hash = hashWorldDescription(description);
    const physics = new PhysicsEngine({
        vehicles: () => ({ vehicles: [] }),
        objects: () => ({ boxes: () => [] }),
        bindings: () => ({ signalStore: null }),
    });
    await physics.configureRun({
        manifest: {},
        worldDescription: description,
        backendSelection: createPhysicsBackendSelection(description),
    });
    assert.equal(JSON.stringify(description), snapshot);
    assert.equal(hashWorldDescription(description), hash);
    const surfaceIds = new Set((description.drivableSurfaces ?? []).flatMap((surface) => [String(surface.id), String(surface.sourceId)]));
    for (const contactId of physics.colliderContactIds.values()) assert.equal(surfaceIds.has(contactId), false);
    return physics;
}

function drop(physics, x, y, z, membership) {
    const body = physics.world.createRigidBody(
        physics.RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setCanSleep(false).setCcdEnabled(true),
    );
    body.setEnabledRotations(false, false, false, true);
    const descriptor = physics.RAPIER.ColliderDesc.cuboid(0.25, 0.25, 0.25);
    descriptor.setCollisionGroups(groups(membership));
    physics.world.createCollider(descriptor, body);
    return body;
}

async function restY(description, x, z, membership) {
    const physics = await start(description);
    const body = drop(physics, x, 3, z, membership);
    const dt = 1 / 60;
    for (let step = 0; step < 180; step += 1) physics.step(dt);
    const y = body.translation().y;
    physics.disposeRun();
    return y;
}

function corridorWorld() {
    return createWorldDescription({
        environmentId: "corridor",
        templateId: "blank",
        roadsAuthored: true,
        document: {
            roads: {
                nodes: [
                    { id: "a", x: 0, y: 0, z: 0 },
                    { id: "b", x: 30, y: 2, z: 0 },
                ],
                edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", width: 8 }],
            },
        },
    });
}

function discWorld() {
    return createWorldDescription({
        environmentId: "disc",
        templateId: "blank",
        roadsAuthored: true,
        document: {
            roads: {
                nodes: [
                    { id: "a", x: -20, y: 1, z: 0 },
                    { id: "b", x: 0, y: 1, z: 0 },
                    { id: "c", x: 20, y: 1, z: 0 },
                ],
                edges: [
                    { id: "ab", startNodeId: "a", endNodeId: "b", width: 4 },
                    { id: "bc", startNodeId: "b", endNodeId: "c", width: 4 },
                ],
            },
        },
    });
}

function areaWorld() {
    return createWorldDescription({
        environmentId: "lot",
        templateId: "blank",
        document: {
            roads: { nodes: [], edges: [] },
            driveAreas: [{
                id: "lot",
                y: 2,
                footprint: [
                    { x: 0, z: 0 },
                    { x: 10, z: 0 },
                    { x: 10, z: 10 },
                    { x: 0, z: 10 },
                ],
            }],
        },
    });
}

function meshWorld() {
    const document = new EnvironmentDocument({ environmentId: "mesh", roads: { nodes: [], edges: [] } });
    const service = createEnvironmentCommandService({ document });
    const first = service.run("createRoad", { points: [{ x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }] });
    assert.equal(first.ok, true, JSON.stringify(first.issues ?? first.error));
    const second = service.run("createRoad", {
        points: [{ x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 20 }],
        startNodeId: first.result.endNode.id,
    });
    assert.equal(second.ok, true, JSON.stringify(second.issues ?? second.error));
    return createWorldDescription({
        environmentId: document.environmentId,
        templateId: "blank",
        document: document.snapshot(),
    });
}

test("a chassis rests on a graded corridor and a prop falls through it", async () => {
    const description = corridorWorld();
    assert.ok(description.drivableSurfaces.some((surface) => surface.kind === "road-corridor"));
    const held = await restY(description, 15, 0, CHASSIS_GROUP);
    assert.ok(held > 0.9 && held < 1.7, `corridor y ${held}`);
    const missed = await restY(description, 15, 12, CHASSIS_GROUP);
    assert.ok(missed < 0, `beside corridor y ${missed}`);
    const prop = await restY(description, 15, 0, DYNAMIC_GROUP);
    assert.ok(prop < 0, `prop y ${prop}`);
});

test("a chassis rests on an intersection disc outside the corridors", async () => {
    const description = discWorld();
    assert.ok(description.drivableSurfaces.some((surface) => surface.kind === "intersection-disc"));
    const held = await restY(description, 0, 4, CHASSIS_GROUP);
    assert.ok(held > 0.9 && held < 1.6, `disc y ${held}`);
    const missed = await restY(description, 0, 8, CHASSIS_GROUP);
    assert.ok(missed < 0, `beside disc y ${missed}`);
});

test("a chassis rests on a drive-area polygon", async () => {
    const description = areaWorld();
    assert.ok(description.drivableSurfaces.some((surface) => surface.kind === "area-polygon"));
    const held = await restY(description, 5, 5, CHASSIS_GROUP);
    assert.ok(held > 1.9 && held < 2.6, `area y ${held}`);
    const missed = await restY(description, 20, 5, CHASSIS_GROUP);
    assert.ok(missed < 0, `beside area y ${missed}`);
});

test("a chassis rests on a road mesh and misses the junction's empty side", async () => {
    const description = meshWorld();
    assert.ok(description.drivableSurfaces.some((surface) => surface.kind === "road-mesh"));
    assert.ok(description.drivableSurfaces.some((surface) => surface.kind === "junction-mesh"));
    const held = await restY(description, 15, 0, CHASSIS_GROUP);
    assert.ok(held > 0 && held < 0.7, `mesh y ${held}`);
    const missed = await restY(description, 15, 20, CHASSIS_GROUP);
    assert.ok(missed < 0, `beside mesh y ${missed}`);
});
