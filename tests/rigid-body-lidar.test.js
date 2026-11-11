import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Vector3 } from "three";

import {
    applyRigidBodyViewportPoses,
    restoreAuthoredRigidBodyPoses,
} from "../app/3d/editor/projection/applyRigidBodyPoses.js";
import { Triangle } from "../app/3d/data/objects/Triangle.js";
import { flushRigidBodyLidarSolids, setRigidBodyLidarPoses } from "../app/3d/editor/projection/rigidBodyLidarSolids.js";
import {
    sphereFromPrimitive,
    trianglesFromSolid,
} from "../app/3d/editor/projection/lidarSolidTriangles.js";
import {
    createBoxLidarTwin,
    createTriangleLidarTwin,
    hashLidarGeometry,
    LIDAR_GEOMETRY_KIND,
    LIDAR_GEOMETRY_VERSION,
} from "../app/simulation/lidar/LidarGeometry.js";
import { prepareAnalyticGpuFrame } from "../app/simulation/sensors/AnalyticGpuScene.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { createCpuLidarBackendSelection } from "../app/simulation/sensors/CpuLidarBackend.js";
import { createGpuSensorBackendSelection } from "../app/simulation/sensors/GpuSensorBackend.js";
import { HeadlessGpuSensorManager } from "../app/simulation/sensors/HeadlessGpuSensorManager.js";
import { loadHeadlessMessageCodec } from "../app/simulation/sensors/HeadlessMessageCodec.js";
import { HeadlessSensorManager } from "../app/simulation/sensors/HeadlessSensorManager.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { compilePrimitiveSolid } from "../app/simulation/world/PrimitiveSolids.js";
import { SeededRNG } from "../app/util/SeededRNG.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const FRAME = { units: "meters", upAxis: "+Y", forwardAxis: "+X" };

function resource(staticPrimitives) {
    const description = {
        kind: LIDAR_GEOMETRY_KIND,
        version: LIDAR_GEOMETRY_VERSION,
        coordinateFrame: FRAME,
        staticPrimitives,
        actors: [],
    };
    return { description, hash: hashLidarGeometry(description) };
}

function crateTriangle() {
    return createTriangleLidarTwin({
        id: "crate:0",
        sourceId: "crate",
        vertices: [
            { x: 5, y: -1, z: -1 },
            { x: 5, y: 1, z: -1 },
            { x: 5, y: 0, z: 1 },
        ],
        semanticId: 1,
        instanceId: 4,
    });
}

function pose(id, x) {
    return {
        id,
        position: { x, y: 0, z: 0 },
        rotation: IDENTITY,
        spawnPosition: { x: 0, y: 0, z: 0 },
        spawnRotation: IDENTITY,
    };
}

function lidarSensor() {
    return createRunSensor("lidar3d", {
        id: "lidar",
        parentId: "ego",
        calibration: {
            range: 20,
            azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
            products: { pointCloud: false, semanticPointCloud: false, diagnostics: false },
        },
    });
}

test("headless CPU and Helios captures follow a moved rigid body and return at spawn", async () => {
    const geometry = resource([crateTriangle()]);
    const vehicles = () => ({
        vehicles: [{ id: "ego", telemetryId: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }],
    });
    const manager = new HeadlessSensorManager(vehicles);
    const pluginScene = new CpuLidarScene(geometry);
    const gpuPoses = [];
    manager.gpu = {
        applyRigidBodyPoses(next) { gpuPoses.push(next); },
        disposeRun() {},
    };
    await manager.configureFromManifest({ sensors: [lidarSensor()] }, {
        backendSelections: [createCpuLidarBackendSelection()],
        lidarGeometry: geometry,
        messageCodec: await loadHeadlessMessageCodec(),
        seed: "0",
    });
    manager.plugin.scene = pluginScene;
    const sensor = manager.lidar.devices[0].config;
    const capture = () => manager.lidar.scene.capture(sensor, manager.lidar.vehicles());
    const pluginCapture = () => pluginScene.capture(sensor, manager.lidar.vehicles());
    const context = { captureTimeNs: 0, sampleIndex: 0, rng: new SeededRNG("0") };

    const spawned = Array.from(capture());
    assert.equal(spawned[0], 5);
    assert.deepEqual(Array.from(pluginCapture()), spawned);
    manager.lidar.devices[0].captureAt(context);

    manager.applyRigidBodyPoses([pose("crate", 3)]);
    const moved = Array.from(capture());
    assert.equal(moved[0], 8);
    assert.deepEqual(Array.from(pluginCapture()), moved);
    assert.deepEqual(gpuPoses.at(-1), [pose("crate", 3)]);

    manager.applyRigidBodyPoses([pose("crate", 0)]);
    assert.deepEqual(Array.from(capture()), spawned);
    assert.deepEqual(Array.from(pluginCapture()), spawned);

    manager.applyRigidBodyPoses([]);
    assert.deepEqual(Array.from(capture()), spawned);
    assert.deepEqual(Array.from(pluginCapture()), spawned);
    manager.disposeRun();
});

test("DeviceDatabase forwards rigid-body poses to the Helios runtime", async () => {
    await import("../app/3d/data/VehicleDatabase.js");
    const { DeviceDatabase } = await import("../app/3d/data/DeviceDatabase.js");
    const database = new DeviceDatabase({
        vehicles: () => ({ vehicles: [] }),
        bindings: () => null,
        scene: null,
    });
    const seen = [];
    database.pluginSensorScene = { setRigidBodyPoses(poses) { seen.push(poses); } };
    database.applyRigidBodyPoses([pose("crate", 3)]);
    database.applyRigidBodyPoses();
    assert.deepEqual(seen, [[pose("crate", 3)], []]);
    database.pluginSensorScene = null;
    database.applyRigidBodyPoses([pose("crate", 1)]);

    const { ObjectDatabase } = await import("../app/3d/data/ObjectDatabase.js");
    const objects = new ObjectDatabase({});
    const box = {
        id: "box",
        shape: "box",
        position: { x: 4, y: 0.5, z: -2 },
        rotationY: 0,
        size: { x: 1, y: 1, z: 1 },
        tags: ["unknown"],
    };
    const document = {
        objects: [{ id: "box", typeId: "primitive", components: { rigidBody: { mass: 1 }, tags: ["unknown"] } }],
        primitives: [box],
    };
    for (const triangle of trianglesFromSolid(compilePrimitiveSolid(box, "unknown"), {
        geometryType: "primitive",
        sourceId: "box",
    })) objects.addObject(triangle);
    const authoredX = objects.triangles()[0].a.x;
    const scanDatabase = new DeviceDatabase({
        vehicles: () => ({ vehicles: [] }),
        bindings: () => null,
        environment: () => ({ getDocument: () => document }),
        objects: () => objects,
    });
    scanDatabase.applyRigidBodyPoses([pose("box", 2)]);
    assert.equal(objects.triangles()[0].a.x, authoredX);
    flushRigidBodyLidarSolids(scanDatabase.parent);
    const moved = objects.triangles()[0];
    assert.equal(moved.a.x, authoredX + 2);
    assert.equal(objects.textures.data._trianglePosData[objects.triangles().indexOf(moved) * 12], authoredX + 2);
});

function gpuScene() {
    return {
        staticPrimitives: [crateTriangle(), createTriangleLidarTwin({
            id: "wall:0",
            sourceId: "wall",
            vertices: [
                { x: 2, y: -1, z: -1 },
                { x: 2, y: 1, z: -1 },
                { x: 2, y: 0, z: 1 },
            ],
            semanticId: 2,
            instanceId: 5,
        })],
        actors: [],
        planes: [],
    };
}

function gpuJob(type, poses = undefined) {
    return {
        id: type,
        type,
        width: 2,
        height: 1,
        sensor: {
            parentId: "ego",
            pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
            calibration: { verticalFovDeg: 60, near: 0.1, far: 30 },
        },
        vehicles: [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }],
        ...(poses ? { rigidBodyPoses: poses } : {}),
    };
}

function xs(triangles) {
    return triangles.map((triangle) => triangle.vertices.map((vertex) => vertex[0]));
}

test("headless GPU LiDAR moves a rigid body and leaves cameras and spawn poses authored", () => {
    const scene = gpuScene();
    const authoredX = scene.staticPrimitives[0].vertices[0].x;
    const authored = prepareAnalyticGpuFrame({ scene, jobs: [gpuJob("lidar3d")] });
    const spawned = prepareAnalyticGpuFrame({ scene, jobs: [gpuJob("lidar3d", [pose("crate", 0)])] });
    const moved = prepareAnalyticGpuFrame({ scene, jobs: [gpuJob("lidar3d", [pose("crate", 3)])] });
    const camera = prepareAnalyticGpuFrame({
        scene,
        jobs: [gpuJob("camera", [pose("crate", 3)])],
    });
    assert.deepEqual(xs(spawned[0].triangles), xs(authored[0].triangles));
    assert.deepEqual(moved[0].triangles[0].vertices.map((vertex) => vertex[0]), [8, 8, 8]);
    assert.deepEqual(moved[0].triangles[1].vertices.map((vertex) => vertex[0]), [2, 2, 2]);
    assert.deepEqual(xs(camera[0].triangles), xs(authored[0].triangles));
    assert.equal(scene.staticPrimitives[0].vertices[0].x, authoredX);
    const box = createBoxLidarTwin({
        id: "bin",
        sourceId: "bin",
        center: { x: 5, y: 0, z: 0 },
        size: { x: 1, y: 1, z: 1 },
        semanticId: 3,
        instanceId: 6,
    });
    const boxed = prepareAnalyticGpuFrame({
        scene: { staticPrimitives: [box], actors: [], planes: [] },
        jobs: [gpuJob("lidar3d", [pose("bin", 3)])],
    });
    const boxX = boxed[0].triangles.flatMap((triangle) => triangle.vertices.map((vertex) => vertex[0]));
    assert.deepEqual([...new Set(boxX)].sort((left, right) => left - right), [7.5, 8.5]);
    assert.equal(box.center.x, 5);
});

test("a GPU LiDAR request carries rigid-body poses and a camera request does not", async () => {
    const manager = new HeadlessGpuSensorManager(() => ({
        vehicles: [{ id: "ego", telemetryId: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }],
    }), {
        rendererClient: {},
        messageCodec: { encodeTopicValue() { return new Uint8Array(); } },
        visualCapture: {
            createOwnedCaptureScene() { return null; },
            createVisualCameraCalibration() { return null; },
            createVisualCaptureInput() { return null; },
            snapshotRep103CameraPose() { return null; },
            flipRows() { return null; },
            warpBrownConrady() { return null; },
        },
    });
    await manager.configureFromManifest({
        sensors: [createRunSensor("camera", { id: "camera", parentId: "ego" }), lidarSensor()],
    }, {
        backendSelection: createGpuSensorBackendSelection(),
        renderScene: { hash: "a".repeat(64), description: { provider: { id: "canonical-analytic", version: 1 } } },
        lidarGeometry: resource([crateTriangle()]),
    });
    const moved = [pose("crate", 3)];
    manager.applyRigidBodyPoses(moved);
    const context = { captureTimeNs: 1, sampleIndex: 0, rng: { _state: 1, next() { return 0; } } };
    const camera = manager.devices.find((device) => device.type === "camera").request(context);
    const lidar = manager.devices.find((device) => device.type === "lidar3d").request(context);
    assert.equal(camera.rigidBodyPoses, undefined);
    assert.deepEqual(lidar.rigidBodyPoses, moved);
    manager.disposeRun();
    assert.deepEqual(manager.rigidBodyPoses, []);
});

test("browser GPU shader solids follow a rigid body and restore the authored vertices", async () => {
    await import("../app/3d/data/VehicleDatabase.js");
    const { ObjectDatabase } = await import("../app/3d/data/ObjectDatabase.js");
    const database = new ObjectDatabase({});
    const road = new Triangle(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1));
    road.environmentGeometryType = "road";
    road.environmentSourceId = "road-1";
    database.addObject(road);

    const box = {
        id: "box",
        shape: "box",
        position: { x: 4, y: 0.5, z: -2 },
        rotationY: 0,
        size: { x: 1, y: 1, z: 1 },
        tags: ["unknown"],
    };
    const ball = {
        id: "ball",
        shape: "sphere",
        position: { x: 1, y: 2, z: 3 },
        rotationY: 0,
        size: { x: 2, y: 2, z: 2 },
        tags: ["unknown"],
    };
    const document = {
        objects: [
            { id: "box", typeId: "primitive", components: { rigidBody: { mass: 1 }, tags: ["unknown"] } },
            { id: "ball", typeId: "primitive", components: { rigidBody: { mass: 1 }, tags: ["unknown"] } },
        ],
        primitives: [box, ball],
    };
    const solid = compilePrimitiveSolid(box, "unknown");
    for (const triangle of trianglesFromSolid(solid, { geometryType: "primitive", sourceId: "box" })) {
        database.addObject(triangle);
    }
    database.addObject(sphereFromPrimitive(ball, document));
    const authored = database.triangles().filter((triangle) => triangle.environmentSourceId === "box")
        .map((triangle) => [triangle.a.x, triangle.b.x, triangle.c.x]);
    const data = {
        environment: () => ({ getDocument: () => document }),
        objects: () => database,
        scene: { getObjectByName() { return null; } },
    };
    const poses = [pose("box", 2), pose("ball", 2)];
    setRigidBodyLidarPoses(data, poses);
    applyRigidBodyViewportPoses(data, poses);
    assert.equal(database.spheres()[0].position.x, 1);
    flushRigidBodyLidarSolids(data);
    const movedBox = database.triangles().filter((triangle) => triangle.environmentSourceId === "box");
    for (const [index, triangle] of movedBox.entries()) {
        assert.deepEqual([triangle.a.x, triangle.b.x, triangle.c.x], authored[index].map((value) => value + 2));
        const slot = database.triangles().indexOf(triangle) * 12;
        assert.equal(database.textures.data._trianglePosData[slot], triangle.a.x);
    }
    const sphere = database.spheres()[0];
    assert.equal(sphere.position.x, 3);
    assert.equal(sphere.position.y, 2);
    assert.equal(sphere.position.z, 3);
    assert.equal(database.textures.data._spherePosData[0], 3);
    assert.deepEqual([road.a.x, road.b.x, road.c.x], [0, 1, 0]);
    assert.equal(database.textures.data._trianglePosData[0], 0);

    restoreAuthoredRigidBodyPoses(data);
    const restored = database.triangles().filter((triangle) => triangle.environmentSourceId === "box");
    for (const [index, triangle] of restored.entries()) {
        assert.deepEqual([triangle.a.x, triangle.b.x, triangle.c.x], authored[index]);
    }
    assert.equal(database.spheres()[0].position.x, 1);
    assert.equal(database.spheres()[0].position.y, 2);
    assert.equal(database.spheres()[0].position.z, 3);
    assert.equal(database.textures.data._spherePosData[0], 1);
    assert.deepEqual([road.a.x, road.b.x, road.c.x], [0, 1, 0]);
});
