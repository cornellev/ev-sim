import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

import { sphereRayDistance, sphereSignedDistance } from "../app/3d/editor/projection/lidarSolidTriangles.js";
import { createAssetMetricsProjector } from "../app/3d/editor/projection/projectors/assetMetricsProjector.js";
import { createSolidsProjector } from "../app/3d/editor/projection/projectors/solidsProjector.js";
import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { compilePrimitiveSolid } from "../app/simulation/world/PrimitiveSolids.js";
import { createWorldDescription } from "../app/simulation/world/WorldDescription.js";
import { Triangle } from "../app/3d/data/objects/Triangle.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

// Vehicle is imported before Database, which lets the Database/Data cycle finish.
await import("../app/3d/data/VehicleDatabase.js");

async function openObjectDatabase() {
    return import("../app/3d/data/ObjectDatabase.js");
}

test("bulk triangle replacement preserves sequential upload identities, ordering, and texture objects", async () => {
    const { ObjectDatabase } = await openObjectDatabase();
    const bulk = new ObjectDatabase({});
    const sequential = new ObjectDatabase({});
    const triangles = Array.from({ length: 160 }, (_, index) => {
        const triangle = new Triangle(new THREE.Vector3(index, 0, 0), new THREE.Vector3(index, 1, 0), new THREE.Vector3(index, 0, 1));
        triangle.environmentSourceId = `source-${index % 4}`;
        return triangle;
    });
    const textures = { ...bulk.textures.textures };
    sequential.addObjects(triangles);
    sequential.rebuildTextureData();
    const copies = triangles.map((triangle) => {
        const copy = new Triangle(triangle.a.clone(), triangle.b.clone(), triangle.c.clone());
        copy.environmentSourceId = triangle.environmentSourceId;
        return copy;
    });
    bulk.replaceTriangles(() => false, [...copies, copies[0]]);
    assert.deepEqual(bulk.textures.data, sequential.textures.data);
    assert.deepEqual(bulk.lidarTwins(), sequential.lidarTwins());
    for (const [key, texture] of Object.entries(textures)) assert.equal(bulk.textures.textures[key], texture);
    bulk.replaceTriangles((triangle) => triangle.environmentSourceId === "source-0", []);
    assert.equal(bulk.triangles().length, 120);
});

const USE_HASH = "a".repeat(64);
const MODEL_GEOMETRY = { 0: { vertices: [[-1, 0, -1], [1, 0, -1], [0, 2, 0]], triangles: [[0, 1, 2]] } };

function compiledFixture() {
    const definition = createEmptyAssetDefinition({ modelUseHash: USE_HASH, name: "Body" });
    definition.collisionProxies.push({
        id: "collision", kind: "box", enabled: true,
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [2, 2, 2],
    });
    definition.lidarProxies.push({
        id: "lidar", kind: "box", enabled: true, semantic: "barrel",
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [2, 2, 2],
    });
    return compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
}

function assetDocument(compiled) {
    return {
        environmentId: "ed07-world",
        snapshot() {
            return {
                environmentId: "ed07-world",
                roads: {
                    nodes: [{ id: "start-node", x: -20, y: 0, z: 0 }, { id: "finish-node", x: 20, y: 0, z: 0 }],
                    edges: [{ id: "road", startNodeId: "start-node", endNodeId: "finish-node", width: 8, laneCount: 2, bidirectional: true }],
                },
                buildings: [],
                features: [],
                objects: [{
                    id: "crate-instance",
                    typeId: "asset-instance",
                    typeVersion: 2,
                    name: "Crate",
                    parentId: null,
                    order: 0,
                    components: {
                        tags: [],
                        locked: false,
                        editorHidden: false,
                        asset: {
                            assetId: "crate",
                            revision: 2,
                            position: { x: 4, y: 0, z: -2 },
                            rotationY: Math.PI / 4,
                            scale: { x: 2, y: 1, z: 0.5 },
                            overrides: {},
                        },
                    },
                }],
                assetMetrics: {
                    version: 1,
                    definitions: [{
                        assetId: "crate",
                        revision: 2,
                        metricHash: compiled.metricHash,
                        collision: compiled.metric.collision,
                        lidar: compiled.metric.lidar,
                    }],
                },
            };
        },
    };
}

function near(vector, point) {
    assert.ok(Math.abs(vector.x - point[0]) < 1e-9);
    assert.ok(Math.abs(vector.y - point[1]) < 1e-9);
    assert.ok(Math.abs(vector.z - point[2]) < 1e-9);
}

test("a ray through a sphere center hits where the signed distance is zero", () => {
    const center = { x: 1, y: 2, z: 3 };
    const radius = 1.5;
    const direction = { x: 0, y: 0.6, z: 0.8 };
    const origin = {
        x: center.x - direction.x * 10,
        y: center.y - direction.y * 10,
        z: center.z - direction.z * 10,
    };
    const distance = sphereRayDistance(origin, direction, center, radius);
    assert.ok(Math.abs(distance - (10 - radius)) < 1e-9);
    const hit = {
        x: origin.x + direction.x * distance,
        y: origin.y + direction.y * distance,
        z: origin.z + direction.z * distance,
    };
    assert.ok(Math.abs(sphereSignedDistance(hit, center, radius)) < 1e-9);
    assert.equal(sphereRayDistance({ x: 0, y: 20, z: 0 }, { x: 1, y: 0, z: 0 }, center, radius), -1);

    const shader = readFileSync(new URL("../app/3d/shaders/Lidar3dShader.js", import.meta.url), "utf8");
    const lidar = readFileSync(new URL("../app/3d/devices/LiDAR3d.js", import.meta.url), "utf8");
    const bake = readFileSync(new URL("../app/3d/environment/visualization/BakeView.js", import.meta.url), "utf8");
    const viewport = readFileSync(new URL("../app/3d/perception/LidarViewportPreview.js", import.meta.url), "utf8");
    assert.match(shader, /float sdSphere\(vec3 p, vec3 center, float radius\)/);
    assert.match(shader, /return length\(p - center\) - radius;/);
    assert.match(lidar, /sphereCount:\s*\{\s*value:\s*0\s*\}/);
    assert.match(bake, /sphereCount:\s*\{\s*value:\s*0\s*\}/);
    assert.match(viewport, /sphereCount:\s*\{\s*value:\s*0\s*\}/);
});

test("primitive solids and asset lidar proxies upload without the floor or collision meshes", async () => {
    const { ObjectDatabase } = await openObjectDatabase();
    const database = new ObjectDatabase({});
    const road = new Triangle(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, 1),
    );
    road.environmentGeometryType = "road";
    road.environmentSourceId = "road-1";
    road.visible = false;
    database.addObject(road);

    const cone = {
        id: "cone-1",
        shape: "cone",
        position: { x: 2, y: 1, z: -3 },
        rotationY: 0.4,
        size: { x: 1.5, y: 2, z: 0.2 },
        tags: ["unknown"],
    };
    const sphere = {
        id: "ball",
        shape: "sphere",
        position: { x: 1, y: 2, z: 3 },
        rotationY: 0,
        size: { x: 4, y: 1, z: 9 },
        tags: ["unknown"],
    };
    const document = {
        environmentId: "yard",
        primitives: [cone, sphere],
        floor: { enabled: true },
        objects: [{ id: "cone-1", components: { tags: ["barrel"] } }],
    };
    const scene = new THREE.Scene();
    const solids = createSolidsProjector();
    const context = {
        scene,
        document,
        changeSet: { domains: { primitives: true } },
        transient: false,
        data: { objects: () => database },
    };
    solids.apply(context);

    const solid = compilePrimitiveSolid(cone, "barrel");
    const primitiveTriangles = database.triangles().filter((triangle) => triangle.environmentGeometryType === "primitive");
    assert.equal(primitiveTriangles.length, solid.triangles.length);
    assert.ok(primitiveTriangles.every((triangle) => triangle.visible === false));
    assert.equal(primitiveTriangles.some((triangle) => triangle.environmentSourceId === "ball"), false);
    for (const [index, face] of solid.triangles.entries()) {
        const triangle = primitiveTriangles.find((entry) => entry.lidarTwinId === `primitive:cone-1:${index}`);
        near(triangle.a, solid.vertices[face[0]]);
        near(triangle.b, solid.vertices[face[1]]);
        near(triangle.c, solid.vertices[face[2]]);
        assert.deepEqual(triangle.tags, ["barrel"]);
    }
    const spheres = database.spheres();
    assert.equal(spheres.length, 1);
    assert.equal(spheres[0].position.x, 1);
    assert.equal(spheres[0].position.y, 2);
    assert.equal(spheres[0].position.z, 3);
    assert.equal(spheres[0].radius, 2);
    assert.equal(spheres[0].visible, false);
    assert.equal(database.t_spheres().count, 1);
    assert.equal(database.textures.data._spherePosData[0], 1);
    assert.equal(database.textures.data._spherePosData[1], 2);
    assert.equal(database.textures.data._spherePosData[2], 3);
    assert.equal(database.textures.data._spherePosData[3], 2);
    assert.equal(scene.getObjectByName("SimulationFloor")?.name, "SimulationFloor");
    assert.equal(database.triangles().some((triangle) => triangle.environmentSourceId === "floor"), false);
    assert.equal(database.triangles().some((triangle) => triangle.environmentGeometryType === "road"), true);

    const compiled = compiledFixture();
    const assetContext = { document: assetDocument(compiled), data: { objects: () => database } };
    const assets = createAssetMetricsProjector();
    assets.sync(assetContext);
    const description = createWorldDescription({
        environmentId: "ed07-world",
        templateId: "blank",
        document: assetContext.document.snapshot(),
    });
    const entry = description.assetProxies[0];
    const lidarFaces = entry.lidar.reduce((count, proxy) => count + proxy.triangles.length, 0);
    const collisionFaces = entry.collision.reduce((count, proxy) => count + proxy.triangles.length, 0);
    const assetTriangles = database.triangles().filter((triangle) => triangle.environmentGeometryType === "asset-lidar");
    assert.ok(collisionFaces > 0);
    assert.equal(assetTriangles.length, lidarFaces);
    assert.notEqual(assetTriangles.length, lidarFaces + collisionFaces);
    const lidarIds = new Set(entry.lidar.map((proxy) => proxy.id));
    const collisionIds = new Set(entry.collision.map((proxy) => proxy.id));
    for (const triangle of assetTriangles) {
        const prefix = triangle.lidarTwinId.slice(0, triangle.lidarTwinId.lastIndexOf(":"));
        assert.equal(lidarIds.has(prefix), true);
        assert.equal(collisionIds.has(prefix), false);
        assert.equal(triangle.visible, false);
    }
    assert.equal(database.triangles().filter((triangle) => triangle.environmentGeometryType === "primitive").length, solid.triangles.length);

    document.primitives = [];
    solids.apply(context);
    assert.equal(database.triangles().filter((triangle) => triangle.environmentGeometryType === "primitive").length, 0);
    assert.equal(database.spheres().length, 0);
    assert.equal(database.t_spheres().count, 0);
    assert.equal(database.textures.data._spherePosData[3], 0);
    assert.equal(database.triangles().filter((triangle) => triangle.environmentGeometryType === "asset-lidar").length, lidarFaces);
    assert.equal(database.triangles().some((triangle) => triangle.environmentGeometryType === "road"), true);
    assert.equal(scene.getObjectByName("SimulationFloor")?.name, "SimulationFloor");

    assets.reset();
    assert.equal(database.triangles().filter((triangle) => triangle.environmentGeometryType === "asset-lidar").length, 0);
    assert.equal(database.triangles().some((triangle) => triangle.environmentGeometryType === "road"), true);
});

function boxRecord(id, x, shape = "box") {
    return {
        id,
        shape,
        position: { x, y: 0.5, z: 0 },
        rotationY: 0,
        size: { x: 1, y: 1, z: 1 },
        color: "#a3a3a3",
        tags: ["unknown"],
    };
}

function primitiveChange(before, after) {
    return {
        domains: {
            primitives: {
                before: new Map(before.map((record) => [record.id, record])),
                after: new Map(after.map((entry) => Array.isArray(entry) ? entry : [entry.id, entry])),
            },
        },
    };
}

test("a primitive drag keeps LiDAR until commit and then updates that solid only", async () => {
    const { ObjectDatabase } = await openObjectDatabase();
    const database = new ObjectDatabase({});
    const road = new Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1));
    road.environmentGeometryType = "road";
    road.environmentSourceId = "road-1";
    database.addObject(road);

    const kept = boxRecord("b", 10);
    const moved = boxRecord("a", 0);
    const document = { environmentId: "yard", primitives: [moved, kept], floor: { enabled: true }, objects: [] };
    const scene = new THREE.Scene();
    const solids = createSolidsProjector();
    const apply = (changeSet, transient) => solids.apply({
        scene,
        document,
        changeSet,
        transient,
        data: { objects: () => database },
    });
    const of = (id) => database.triangles().filter((triangle) => triangle.environmentSourceId === id);

    apply({ domains: { primitives: true } }, false);
    const keptTriangles = of("b");
    const roadTriangle = database.triangles().find((triangle) => triangle.environmentSourceId === "road-1");
    const startX = of("a")[0].a.x;
    assert.ok(keptTriangles.length > 0);

    const shifted = boxRecord("a", 4);
    document.primitives = [shifted, kept];
    apply(primitiveChange([moved], [shifted]), true);
    assert.equal(of("a")[0].a.x, startX);
    assert.equal(of("b")[0], keptTriangles[0]);
    assert.equal(database.triangles().includes(roadTriangle), true);

    apply(primitiveChange([moved], [shifted]), false);
    assert.notEqual(of("a")[0].a.x, startX);
    assert.equal(of("b")[0], keptTriangles[0]);
    assert.equal(database.triangles().includes(roadTriangle), true);

    const sphere = boxRecord("a", 4, "sphere");
    document.primitives = [sphere, kept];
    apply(primitiveChange([shifted], [sphere]), false);
    assert.equal(of("a").length, 0);
    assert.equal(database.spheres().filter((entry) => entry.environmentSourceId === "a").length, 1);
    assert.equal(of("b")[0], keptTriangles[0]);

    document.primitives = [kept];
    apply(primitiveChange([sphere], [["a", null]]), false);
    assert.equal(of("a").length, 0);
    assert.equal(database.spheres().length, 0);
    assert.equal(of("b")[0], keptTriangles[0]);
    assert.equal(database.triangles().includes(roadTriangle), true);

    apply({
        domains: {
            objects: {
                before: new Map([["prop", { id: "prop" }]]),
                after: new Map([["prop", { id: "prop", name: "renamed" }]]),
            },
        },
    }, false);
    assert.equal(of("b")[0], keptTriangles[0]);
    assert.equal(database.triangles().includes(roadTriangle), true);
});

function assetInstance(id, assetId, x) {
    return {
        id,
        typeId: "asset-instance",
        typeVersion: 2,
        name: id,
        parentId: null,
        order: 0,
        components: {
            tags: [],
            locked: false,
            editorHidden: false,
            asset: {
                assetId,
                revision: 2,
                position: { x, y: 0, z: 0 },
                rotationY: 0,
                scale: { x: 1, y: 1, z: 1 },
                overrides: {},
            },
        },
    };
}

test("an asset drag keeps LiDAR until commit and then updates that instance only", async () => {
    const { ObjectDatabase } = await openObjectDatabase();
    const database = new ObjectDatabase({});
    const compiled = compiledFixture();
    const definitionFor = (assetId) => ({
        assetId,
        revision: 2,
        metricHash: compiled.metricHash,
        collision: compiled.metric.collision,
        lidar: compiled.metric.lidar,
    });
    const crate = assetInstance("crate-a", "crate", 0);
    const other = assetInstance("crate-b", "other", 8);
    const document = {
        environmentId: "ed07-world",
        roads: {
            nodes: [{ id: "start-node", x: -20, y: 0, z: 0 }, { id: "finish-node", x: 20, y: 0, z: 0 }],
            edges: [{ id: "road", startNodeId: "start-node", endNodeId: "finish-node", width: 8, laneCount: 2, bidirectional: true }],
        },
        buildings: [],
        features: [],
        objects: [crate, other],
        primitives: [],
        assetMetrics: { version: 1, definitions: [definitionFor("crate"), definitionFor("other")] },
        snapshot() { return this; },
    };
    const assets = createAssetMetricsProjector();
    const context = { document, data: { objects: () => database } };
    assets.sync(context);
    const of = (id) => database.triangles().filter((triangle) => triangle.environmentGeometryType === "asset-lidar" && triangle.environmentSourceId === id);
    const kept = of("crate-b");
    const startX = of("crate-a")[0].a.x;
    assert.ok(kept.length > 0);

    const shifted = assetInstance("crate-a", "crate", 3);
    document.objects = [shifted, other];
    const objects = {
        before: new Map([["crate-a", crate]]),
        after: new Map([["crate-a", shifted]]),
    };
    assets.apply({ ...context, transient: true, changeSet: { domains: { objects } } });
    assert.equal(of("crate-a")[0].a.x, startX);
    assert.equal(of("crate-b")[0], kept[0]);

    assets.apply({ ...context, transient: false, changeSet: { domains: { objects } } });
    assert.notEqual(of("crate-a")[0].a.x, startX);
    assert.equal(of("crate-b")[0], kept[0]);

    const movedTriangle = of("crate-a")[0];
    const lidar = structuredClone(document.assetMetrics.definitions[0].lidar);
    lidar[0].vertices[0][0] += 1;
    document.assetMetrics.definitions[0] = { ...document.assetMetrics.definitions[0], lidar };
    assets.apply({
        ...context,
        transient: false,
        changeSet: {
            domains: {
                "assetMetrics.definitions": {
                    before: new Map([["crate@2", definitionFor("crate")]]),
                    after: new Map([["crate@2", document.assetMetrics.definitions[0]]]),
                },
            },
        },
    });
    assert.notEqual(of("crate-a")[0], movedTriangle);
    assert.equal(of("crate-b")[0], kept[0]);
});

test("triangle and sphere uploads stop at the texture capacity", async () => {
    const { MAX_SPHERES, MAX_TRIANGLES, ObjectDatabase } = await openObjectDatabase();
    const { Sphere } = await import("../app/3d/data/objects/Sphere.js");
    const database = new ObjectDatabase({});
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        const triangles = [];
        for (let index = 0; index < MAX_TRIANGLES + 1; index += 1) {
            const triangle = new Triangle(
                new THREE.Vector3(index === MAX_TRIANGLES ? 12345 : 0, 0, 0),
                new THREE.Vector3(1, 0, 0),
                new THREE.Vector3(0, 0, 1),
            );
            triangle.environmentGeometryType = "primitive";
            triangle.visible = false;
            triangles.push(triangle);
        }
        database.replaceTriangles(() => false, triangles);
        assert.equal(database.t_triangles().count, MAX_TRIANGLES);
        assert.equal(database.textures.data._trianglePosData.includes(12345), false);

        const spheres = [];
        for (let index = 0; index < MAX_SPHERES + 1; index += 1) {
            const sphere = new Sphere(
                { x: index === MAX_SPHERES ? 54321 : index, y: 0, z: 0 },
                1,
            );
            sphere.environmentGeometryType = "primitive";
            spheres.push(sphere);
        }
        database.replaceSpheres(() => false, spheres);
        assert.equal(database.t_spheres().count, MAX_SPHERES);
        assert.equal(database.textures.data._spherePosData.includes(54321), false);
        assert.equal(warnings.length, 2);
    } finally {
        console.warn = original;
    }
});
