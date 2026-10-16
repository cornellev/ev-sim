import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createSolidsProjector } from "../app/3d/editor/projection/projectors/solidsProjector.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { proxyMeshFailure } from "../app/simulation/world/ConvexMesh.js";
import { supportPlanePosition } from "../app/physics/PhysicsEngine.js";
import { createPhysicsBackendSelection, PHYSICS_CAPABILITY_ID, PHYSICS_CAPABILITY_ID_V2 } from "../app/physics/PhysicsBackend.js";
import { createLidarGeometry, createLidarGeometryResource, hashLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { PRIMITIVE_SHAPES } from "../app/simulation/world/PrimitiveRecords.js";
import { compilePrimitiveSolid } from "../app/simulation/world/PrimitiveSolids.js";
import { assertWorldResource, createWorldDescription, createWorldResource, WORLD_DESCRIPTION_V4 } from "../app/simulation/world/WorldDescription.js";

function blank(document = {}) {
    return createWorldDescription({
        environmentId: "yard",
        templateId: "blank",
        document: { environmentId: "yard", ...document },
    });
}

test("unused primitive and floor fields leave world descriptions unchanged", () => {
    const plain = blank();
    const empty = blank({ primitives: [], floor: { enabled: false } });
    assert.equal(JSON.stringify(plain), JSON.stringify(empty));
    assert.equal(plain.version < WORLD_DESCRIPTION_V4, true);
    assert.equal("primitives" in plain, false);
    assert.equal("groundPlane" in plain, false);
    const lidar = createLidarGeometry(createWorldResource(plain));
    assert.equal("planes" in lidar, false);
    assert.equal(hashLidarGeometry(lidar), hashLidarGeometry(createLidarGeometry(createWorldResource(empty))));
});

test("each primitive compiles to one outward convex solid without its color", () => {
    for (const shape of PRIMITIVE_SHAPES) {
        const solid = compilePrimitiveSolid({ id: shape, shape, tags: ["sign"] }, "sign");
        assert.equal(proxyMeshFailure(solid.vertices, solid.triangles, { convex: true }), null, shape);
        assert.equal(solid.semantic, "sign");
        assert.equal("color" in solid, false);
        const bottom = Math.min(...solid.vertices.map((point) => point[1]));
        assert.ok(Math.abs(bottom) < 1e-6, `${shape} bottom ${bottom}`);
    }
    const sphere = compilePrimitiveSolid({ id: "s", shape: "sphere", size: { x: 2, y: 9, z: 3 } });
    const ys = sphere.vertices.map((point) => point[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) < 2 + 1e-6);
});

test("a box or an enabled floor selects world description v4", () => {
    const boxed = blank({
        primitives: [{ id: "crate", shape: "box", tags: ["sign"] }],
        objects: [{ id: "crate", typeId: "primitive", typeVersion: 1, name: "Box", parentId: null, order: 0, components: { tags: ["barrel"] } }],
    });
    assert.equal(boxed.version, WORLD_DESCRIPTION_V4);
    assert.equal(boxed.primitives[0].semantic, "barrel");
    assert.equal(boxed.primitives.length, 1);
    assert.equal(boxed.primitives[0].sourceId, "crate");
    assert.equal("groundPlane" in boxed, false);
    assert.equal(createPhysicsBackendSelection(boxed).capabilityId, PHYSICS_CAPABILITY_ID_V2);

    const floored = blank({ floor: { enabled: true } });
    assert.equal(floored.version, WORLD_DESCRIPTION_V4);
    assert.deepEqual(floored.primitives, []);
    assert.deepEqual(floored.groundPlane, { id: "floor", y: 0 });
    assert.equal(createPhysicsBackendSelection(floored).capabilityId, PHYSICS_CAPABILITY_ID);
    assert.equal(assertWorldResource(createWorldResource(boxed)).primitives[0].id, "primitive:crate");
    assert.equal(assertWorldResource(createWorldResource(floored)).groundPlane.y, 0);
});

test("the support plane lifts only Y and reports contact on the plane", () => {
    const across = supportPlanePosition({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: -2 }, 0);
    assert.equal(across.held, true);
    assert.deepEqual(across.position, { x: 4, y: 0, z: -2 });
    const descending = supportPlanePosition({ x: 1, y: 2, z: 3 }, { x: 5, y: -1, z: 7 }, 0);
    assert.equal(descending.held, true);
    assert.deepEqual(descending.position, { x: 5, y: 0, z: 7 });
    const above = supportPlanePosition({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }, 0);
    assert.equal(above.held, false);
    assert.equal(above.position.y, 1);
});

test("a downward LiDAR ray hits the floor only when it is enabled", () => {
    const sensor = {
        id: "lidar",
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: -90, endDeg: -89, stepDeg: 1 },
        },
    };
    const ego = { id: "ego", position: { x: 0, y: 2, z: 0 }, rotation: {} };
    const off = new CpuLidarScene(createLidarGeometryResource(createWorldResource(blank())));
    assert.deepEqual(Array.from(off.capture(sensor, [ego])), [0, 0, 0, 0]);
    off.dispose();
    const on = new CpuLidarScene(createLidarGeometryResource(createWorldResource(blank({ floor: { enabled: true } }))));
    const hit = Array.from(on.capture(sensor, [ego]));
    assert.ok(Math.abs(hit[0] - 2) < 1e-4, `distance ${hit[0]}`);
    assert.ok(hit[3] > 0);
    on.dispose();
});

test("adding a primitive and enabling the floor are undoable and stay out of empty snapshots", () => {
    resetDocumentIdCounter();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const before = JSON.stringify(document.snapshot());
    const service = createEnvironmentCommandService({ document });
    const added = service.run("addPrimitive", { shape: "box", x: 3, z: 4 });
    assert.equal(added.ok, true);
    assert.equal(document.primitives.length, 1);
    assert.equal(document.primitives[0].position.y, 0.5);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.primitives.length, 0);
    assert.equal(JSON.stringify(document.snapshot()), before);

    const floor = service.run("setFloor", { enabled: true });
    assert.equal(floor.ok, true);
    assert.equal(document.floor.enabled, true);
    assert.equal(document.objects.some((record) => record.typeId === "floor"), true);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.floor, null);
    assert.equal(document.objects.some((record) => record.typeId === "floor"), false);
    assert.equal(JSON.stringify(document.snapshot()), before);
});

function primitiveMeshes(scene) {
    const meshes = [];
    scene.traverse((object) => {
        if (typeof object.name === "string" && object.name.startsWith("primitive:")) meshes.push(object);
    });
    return meshes;
}

/** Reparents meshes into a chunk group, the same way ChunkManager.assignEntity does. */
function chunkRegistry(scene) {
    const entities = new Map();
    const chunk = new THREE.Group();
    chunk.name = "EnvironmentChunk:0,0";
    scene.add(chunk);
    const reparent = (mesh) => {
        if (mesh && mesh.parent !== chunk) chunk.attach(mesh);
    };
    return {
        chunk,
        getEntity(id) {
            return entities.get(id) ?? null;
        },
        registerEntity(entity) {
            entities.set(entity.id, entity);
            reparent(entity.object3D);
            return entity;
        },
        updateEntityTransform(id, object3D = null, options = {}) {
            const entity = entities.get(id);
            if (!entity) return null;
            if (object3D) entity.object3D = object3D;
            entity.lastAffectsPersistence = options.affectsPersistence;
            reparent(entity.object3D);
            return entity;
        },
        unregisterEntity(id) {
            return entities.delete(id);
        },
    };
}

function boxRecord(position) {
    return {
        id: "box-1",
        shape: "box",
        position: { ...position },
        rotationY: 0,
        size: { x: 1, y: 1, z: 1 },
        color: "#a3a3a3",
        tags: ["unknown"],
    };
}

test("a reparented primitive mesh moves in place", () => {
    const scene = new THREE.Scene();
    const registry = chunkRegistry(scene);
    const record = boxRecord({ x: 0, y: 0.5, z: 0 });
    const document = { environmentId: "yard", primitives: [record], floor: null };
    const projector = createSolidsProjector();
    const changeSet = { domains: { primitives: true } };
    projector.apply({ scene, document, registry, changeSet, transient: true });
    record.position = { x: 4, y: 0.5, z: 1 };
    projector.apply({ scene, document, registry, changeSet, transient: true });

    const meshes = primitiveMeshes(scene);
    assert.equal(meshes.length, 1);
    assert.equal(meshes[0].position.x, 4);
    assert.equal(meshes[0].position.z, 1);
    assert.equal(meshes[0].parent, registry.chunk);
    assert.equal(registry.getEntity("primitive:box-1").lastAffectsPersistence, false);
});

test("removing a primitive disposes meshes left in chunk groups", () => {
    const scene = new THREE.Scene();
    const registry = chunkRegistry(scene);
    const record = boxRecord({ x: 1, y: 0.5, z: 2 });
    const document = { environmentId: "yard", primitives: [record], floor: null };
    const projector = createSolidsProjector();
    const changeSet = { domains: { primitives: true } };
    projector.apply({ scene, document, registry, changeSet, transient: false });
    const trail = primitiveMeshes(scene)[0].clone();
    trail.name = "primitive:box-1";
    registry.chunk.add(trail);
    assert.equal(primitiveMeshes(scene).length, 2);

    document.primitives = [];
    projector.apply({ scene, document, registry, changeSet, transient: false });
    assert.equal(primitiveMeshes(scene).length, 0);
    assert.equal(registry.getEntity("primitive:box-1"), null);
});
