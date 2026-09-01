import assert from "node:assert/strict";
import test from "node:test";

import { lidarDirectionRep103 } from "../app/autonomy/CoordinateFrames.js";
import {
    PERCEPTION_CLASS_IDS,
    perceptionClassId,
} from "../app/autonomy/PerceptionLabelCatalog.js";
import {
    PerceptionTruthIndex,
    stableInstanceIdFromSource,
} from "../app/autonomy/PerceptionTruthIndex.js";
import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import {
    buildCameraInfo,
    buildImageMessage,
    buildPointCloud2,
    buildSemanticPointCloud2,
} from "../app/3d/devices/SensorMessages.js";
import { SensorPublisher } from "../app/3d/devices/SensorPublisher.js";
import { ManifestCamera } from "../app/3d/devices/ManifestCamera.js";
import {
    distortNormalizedPoint,
    undistortNormalizedPoint,
    warpBrownConrady,
} from "../app/3d/perception/CameraRenderProducts.js";
import { SeededRNG } from "../app/util/SeededRNG.js";
import {
    createDefaultRunManifest,
    normalizeRunManifest,
    applyManifestOracleProduct,
} from "../app/simulation/RunManifest.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";

test("perception class catalog mirrors legacy tag ids and extends append-only", () => {
    assert.equal(perceptionClassId("vehicle"), PERCEPTION_CLASS_IDS.vehicle);
    assert.equal(perceptionClassId("traffic-light"), PERCEPTION_CLASS_IDS.traffic_light);
    assert.equal(perceptionClassId("car"), PERCEPTION_CLASS_IDS.vehicle);
    assert.equal(PERCEPTION_CLASS_IDS.lane, 7);
});

test("stable instance ids are deterministic, non-zero, and collision-checked", () => {
    const left = stableInstanceIdFromSource("vehicle:ego");
    const right = stableInstanceIdFromSource("vehicle:ego");
    assert.equal(left, right);
    assert.notEqual(left, 0);
    assert.ok(left <= 0x00ffffff);

    const index = new PerceptionTruthIndex();
    const a = index.register({ sourceId: "alpha", semanticClass: "vehicle" });
    const b = index.register({ sourceId: "beta", semanticClass: "sign" });
    assert.notEqual(a.instanceId, b.instanceId);
    assert.equal(index.getByInstanceId(a.instanceId).sourceId, "alpha");
    const snapshot = index.snapshot();
    assert.deepEqual(snapshot.map((entry) => entry.sourceId).sort(), ["alpha", "beta"]);
});

test("camera info prefers explicit intrinsics and reports plumb_bob distortion", () => {
    const info = buildCameraInfo({
        width: 320,
        height: 180,
        verticalFovDeg: 75,
        timeNs: 1_000_000_000,
        frameId: "front_camera_optical_frame",
        distortion: [0.1, -0.05, 0.001, -0.002, 0.01],
        intrinsics: { fx: 200, fy: 210, cx: 159.5, cy: 89.5 },
    });
    assert.equal(info.distortion_model, "plumb_bob");
    assert.equal(info.k[0], 200);
    assert.equal(info.k[4], 210);
    assert.equal(info.k[2], 159.5);
    assert.equal(info.d.length, 5);
});

test("image builders enforce encoding byte sizes", () => {
    const rgba = buildImageMessage({
        data: new Uint8Array(8),
        width: 2,
        height: 1,
        timeNs: 0,
        frameId: "cam",
        encoding: "rgba8",
    });
    assert.equal(rgba.step, 8);
    const depth = buildImageMessage({
        data: new Float32Array([1, 2, 3, 4]),
        width: 2,
        height: 2,
        timeNs: 0,
        frameId: "cam",
        encoding: "32FC1",
    });
    assert.equal(depth.encoding, "32FC1");
    assert.equal(depth.step, 8);
    assert.throws(() => buildImageMessage({
        data: new Uint8Array(3),
        width: 2,
        height: 1,
        timeNs: 0,
        frameId: "cam",
        encoding: "rgba8",
    }));
});

test("brown-conrady distortion round-trips and warps RGB vs labels differently", () => {
    const distortion = [0.2, 0.05, 0.01, -0.01, 0.02];
    const original = { x: 0.15, y: -0.1 };
    const distorted = distortNormalizedPoint(original, distortion);
    const recovered = undistortNormalizedPoint(distorted, distortion);
    assert.ok(Math.abs(recovered.x - original.x) < 1e-6);
    assert.ok(Math.abs(recovered.y - original.y) < 1e-6);

    const width = 4;
    const height = 4;
    const rgb = new Uint8Array(width * height * 4);
    rgb[0] = 255;
    const labels = new Uint16Array(width * height);
    labels[0] = 7;
    const intrinsics = { fx: 2, fy: 2, cx: 1.5, cy: 1.5 };
    const warpedRgb = warpBrownConrady({
        data: rgb, width, height, intrinsics, distortion, channels: 4, interpolation: "linear",
    });
    const warpedLabels = warpBrownConrady({
        data: labels, width, height, intrinsics, distortion, channels: 1, interpolation: "nearest",
    });
    assert.equal(warpedRgb.length, rgb.length);
    assert.equal(warpedLabels.length, labels.length);
});

test("zero distortion warp reuses the source buffer", () => {
    const rgb = new Uint8Array([9, 8, 7, 255]);
    const warped = warpBrownConrady({
        data: rgb,
        width: 1,
        height: 1,
        distortion: [0, 0, 0, 0, 0],
        channels: 4,
    });
    assert.equal(warped, rgb);
});

test("warpBrownConrady can reuse an explicit output buffer", () => {
    const rgb = new Uint8Array(4 * 4 * 4);
    rgb[0] = 255;
    const output = new Uint8Array(rgb.length);
    const warped = warpBrownConrady({
        data: rgb,
        width: 4,
        height: 4,
        intrinsics: { fx: 2, fy: 2, cx: 1.5, cy: 1.5 },
        distortion: [0.1, 0, 0, 0, 0],
        channels: 4,
        interpolation: "nearest",
        output,
    });
    assert.equal(warped, output);
});

test("known LiDAR range maps into REP-103 sensor-frame coordinates", () => {
    const range = 5;
    const calibration = {
        range: 20,
        azimuth: { startDeg: 0, endDeg: 2, stepDeg: 2 },
        elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
    };
    const buffer = new Float32Array([range, 1, PERCEPTION_CLASS_IDS.vehicle, 42]);
    const measured = buildPointCloud2({
        buffer,
        bufferEncoding: "metric-v2",
        calibration,
        timeNs: 2e9,
        frameId: "front_lidar_frame",
    });
    assert.equal(measured.width, 1);
    assert.deepEqual(measured.fields.map((field) => field.name), ["x", "y", "z", "intensity"]);
    const view = new DataView(measured.data.buffer);
    const expected = lidarDirectionRep103(0, 0);
    assert.ok(Math.abs(view.getFloat32(0, true) - expected.x * range) < 1e-5);
    assert.ok(Math.abs(view.getFloat32(4, true) - expected.y * range) < 1e-5);
    assert.ok(Math.abs(view.getFloat32(8, true) - expected.z * range) < 1e-5);

    const semantic = buildSemanticPointCloud2({
        buffer,
        bufferEncoding: "metric-v2",
        calibration,
        timeNs: 2e9,
        frameId: "front_lidar_frame",
    });
    assert.deepEqual(
        semantic.fields.map((field) => field.name),
        ["x", "y", "z", "cos_incidence", "instance_id", "semantic_id", "ray_index"],
    );
    const semanticView = new DataView(semantic.data.buffer);
    assert.equal(semanticView.getUint32(16, true), 42);
    assert.equal(semanticView.getUint16(20, true), PERCEPTION_CLASS_IDS.vehicle);
    assert.equal(semanticView.getUint32(24, true), 0);
    assert.ok(!measured.fields.some((field) => field.name.includes("semantic") || field.name.includes("instance")));
});

test("seeded range noise and point dropout are reproducible and measured-only", () => {
    const calibration = {
        range: 20,
        azimuth: { startDeg: 0, endDeg: 4, stepDeg: 2 },
        elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 },
    };
    const buffer = new Float32Array([
        4, 1, 3, 11,
        6, 1, 3, 12,
    ]);
    const build = (seed) => {
        const rng = new SeededRNG(seed);
        return buildPointCloud2({
            buffer,
            bufferEncoding: "metric-v2",
            calibration,
            timeNs: 0,
            frameId: "lidar",
            sampleRange: (range) => range + rng.next() * 0.1,
            shouldDrop: () => rng.next() < 0.5,
        });
    };
    assert.deepEqual(Array.from(build("seed-a").data), Array.from(build("seed-a").data));
    assert.notDeepEqual(Array.from(build("seed-a").data), Array.from(build("seed-b").data));
    const oracle = buildSemanticPointCloud2({
        buffer,
        bufferEncoding: "metric-v2",
        calibration,
        timeNs: 0,
        frameId: "lidar",
    });
    assert.equal(oracle.width, 2);
});

test("coherent camera frame dropout empties the whole publisher capture", () => {
    let now = 0;
    const device = {
        telemetryId: "front-camera",
        captureAt: ({ rng }) => {
            if (rng.next() < 1) return [];
            return [{ topicId: "front-camera-image", signal: "image", value: { header: {} } }];
        },
        getParent: () => null,
    };
    const publisher = new SensorPublisher(device, {
        id: "front-camera",
        rateHz: 30,
        phaseNs: 0,
        maxQueueFrames: 8,
        noise: { dropoutProbability: 1 },
        latency: { fixedNs: 0, jitterNs: 0 },
        outputs: {},
        calibration: { products: { diagnostics: false } },
        health: { deadlineNs: 0 },
    }, {
        seed: "drop-test",
        topics: [],
        nowNs: () => now,
    });
    // Override capture to exercise publisher health without a real camera.
    device.captureAt = () => {
        publisher.recordFrameDrop("camera-frame-dropout", 0);
        return [];
    };
    publisher.update({ step: 2, timeNs: 33_333_334 });
    assert.equal(publisher.health.droppedFrames, 1);
    assert.equal(publisher.queue.length, 0);
    assert.equal(publisher.health.capturedFrames, 0);
});

test("sensor publisher health tracks queue depth and injected clock timings", () => {
    let wall = 1000;
    const device = {
        telemetryId: "front-lidar",
        captureAt: () => {
            wall += 250;
            return [{
                topicId: "front-lidar-points",
                signal: "pointCloud",
                value: { header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "lidar" }, data: new Uint8Array(0) },
            }];
        },
        getParent: () => null,
    };
    const publisher = new SensorPublisher(device, {
        id: "front-lidar",
        rateHz: 10,
        phaseNs: 0,
        maxQueueFrames: 2,
        latency: { fixedNs: 0, jitterNs: 0 },
        outputs: { diagnosticsTopicId: "front-lidar-diagnostics" },
        calibration: { products: { diagnostics: true } },
        health: { deadlineNs: 1 },
        measurementFrameId: "front_lidar_frame",
        frameId: "front_lidar_frame",
        syncGroupId: "perception-primary",
    }, {
        seed: "health",
        topics: [
            { id: "front-lidar-points", name: "/sensors/front_lidar/points", type: "sensor_msgs/PointCloud2", schema: { type: "sensor_msgs/PointCloud2" }, producer: "simulator", authority: "reference", direction: "output" },
            { id: "front-lidar-diagnostics", name: "/diagnostics/front_lidar", type: "diagnostic_msgs/DiagnosticArray", schema: { type: "diagnostic_msgs/DiagnosticArray" }, producer: "simulator", authority: "reference", direction: "output" },
        ],
        nowNs: () => wall,
    });
    publisher.update({ step: 1, timeNs: 100_000_000 });
    assert.equal(publisher.health.capturedFrames, 1);
    assert.equal(publisher.health.queueDepth, 1);
    assert.ok(publisher.health.captureTimeNs >= 250);
    assert.equal(publisher.queue[0].syncGroupKey, "perception-primary:1");
    publisher.recordPointDrops(3);
    assert.equal(publisher.health.pointDrops, 3);
    publisher.recordShaderBusy(0);
    assert.equal(publisher.health.shaderBusyDrops, 1);
});

test("sensor publisher reset clears queues and reconstructs sample-zero RNG", () => {
    const device = {
        telemetryId: "imu",
        captureAt: ({ sampleIndex, rng }) => [{
            topicId: "imu-data",
            signal: "imu",
            value: { sampleIndex, noise: rng.next() },
        }],
        getParent: () => null,
    };
    const publisher = new SensorPublisher(device, {
        id: "imu",
        rateHz: 100,
        phaseNs: 0,
        maxQueueFrames: 8,
        noise: {},
        latency: { fixedNs: 20_000_000, jitterNs: 5_000_000 },
        outputs: {},
        calibration: { products: { diagnostics: false } },
        health: { deadlineNs: 0 },
    }, { seed: "episode-a", topics: [] });

    publisher.update({ step: 1, timeNs: 10_000_000 });
    const first = publisher.getDeterministicState();
    assert.equal(first.queue.length, 1);
    assert.equal(Object.hasOwn(first.queue[0].messages[0], "value"), false);
    assert.match(first.queue[0].messages[0].digest, /^[0-9a-f]{64}$/);

    publisher.reset({ resetSeed: "episode-a" });
    assert.equal(publisher.getDeterministicState().queue.length, 0);
    publisher.update({ step: 1, timeNs: 10_000_000 });
    assert.deepEqual(publisher.getDeterministicState(), first);

    publisher.reset({ resetSeed: "episode-b" });
    publisher.update({ step: 1, timeNs: 10_000_000 });
    assert.notDeepEqual(publisher.getDeterministicState(), first);
});

test("GPU sensor captures are skipped when the display frame has no remaining budget", () => {
    let captures = 0;
    const simulation = { gpuCaptureEnabled: false };
    const device = {
        telemetryId: "front-camera",
        gpuCapture: true,
        captureAt: () => {
            captures += 1;
            return [{ topicId: "front-camera-image", signal: "image", value: { header: {} } }];
        },
        getParent: () => ({
            getParent: () => ({
                simulation: () => simulation,
            }),
        }),
    };
    const publisher = new SensorPublisher(device, {
        id: "front-camera",
        rateHz: 30,
        phaseNs: 0,
        maxQueueFrames: 8,
        noise: {},
        latency: { fixedNs: 0, jitterNs: 0 },
        outputs: {},
        calibration: { products: { diagnostics: false } },
        health: { deadlineNs: 0 },
    }, { seed: "gpu-budget", topics: [] });
    publisher.update({ step: 2, timeNs: 33_333_334 });
    assert.equal(captures, 0);
    assert.equal(publisher.health.capturedFrames, 0);
    simulation.gpuCaptureEnabled = true;
    publisher.update({ step: 4, timeNs: 66_666_668 });
    assert.equal(captures, 1);
    assert.equal(publisher.health.capturedFrames, 1);
});

test("oracle 3D detections stamp map and only include in-view objects", () => {
    const camera = new ManifestCamera({
        id: "front-camera",
        type: "camera",
        measurementFrameId: "front_camera_optical_frame",
        frameId: "front_camera_optical_frame",
        pose: { position: { x: 1.5, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        noise: {},
        outputs: {
            detections2dTopicId: "oracle-detections-2d",
            detections3dTopicId: "oracle-detections-3d",
            lanesTopicId: "oracle-lanes",
        },
        calibration: {
            width: 8,
            height: 8,
            products: { detections2d: true, detections3d: true, lanes: true },
        },
    }, { transformRuntime: { frames: { map: "map" } } });

    const inView = {
        instanceId: 11,
        semanticId: 2,
        semanticClass: "vehicle",
        visible: true,
        worldBounds: { center: { x: 8, y: 1, z: 0.6 }, size: { x: 4, y: 2, z: 1.4 } },
    };
    const outOfView = {
        instanceId: 12,
        semanticId: 2,
        semanticClass: "vehicle",
        visible: true,
        worldBounds: { center: { x: 80, y: 0, z: 0.6 }, size: { x: 4, y: 2, z: 1.4 } },
    };
    const messages = camera._buildMessages({
        captureTimeNs: 1e9,
        sampleIndex: 0,
        rng: { next: () => 0.5 },
        truth: [inView, outOfView, { lane: { points: [{ x: 1, y: 2, z: 0 }] } }],
        imageDetections: [inView],
    }, {});

    const det3d = messages.find((entry) => entry.signal === "detections3d");
    assert.equal(det3d.frameId, "map");
    assert.equal(det3d.value.header.frame_id, "map");
    assert.equal(det3d.value.detections.length, 1);
    assert.equal(det3d.value.detections[0].bbox.center.position.x, 8);
    const lanes = messages.find((entry) => entry.signal === "lanes");
    assert.equal(lanes.value.header.frame_id, "map");
    const det2d = messages.find((entry) => entry.signal === "detections2d");
    assert.equal(det2d.frameId, "front_camera_optical_frame");
});

test("oracle topics stay under oracle.* and do not populate active.*", () => {
    const store = new SignalStore({}, { sourceId: "perception-router" });
    const published = [];
    store.publishSignal = (path, value, options) => {
        published.push({ path, value, options });
    };
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.id === "front-camera-depth");
    assert.equal(topic.producer, "oracle");
    router.routeOutbound(topic.id, { value: { encoding: "32FC1" }, typeStr: topic.schema.type }, {
        producer: "oracle",
        observationalOracle: true,
        captureTimeNs: 1e9,
        deliveryTimeNs: 1e9,
        cycle: 1,
    });
    assert.ok(published.some((entry) => entry.path.startsWith("oracle.topics.")));
    assert.ok(!published.some((entry) => entry.path.startsWith("active.topics.")));
});

test("default v6 manifests declare perception sync group; v5 migration keeps oracle products off", () => {
    const defaults = createDefaultRunManifest();
    assert.equal(defaults.version, 9);
    const camera = defaults.sensorRig.sensors.find((sensor) => sensor.id === "front-camera");
    assert.equal(camera.calibration.products.depth, true);
    assert.equal(camera.outputs.depthTopicId, "front-camera-depth");
    assert.ok(defaults.topics.some((topic) => topic.id === "front-lidar-semantic"));
    const sync = defaults.sensorRig.syncGroups.find((group) => group.id === "perception-primary");
    assert.ok(sync.topicIds.includes("front-camera-image"));
    assert.ok(sync.topicIds.includes("front-camera-depth"));

    const migrated = normalizeRunManifest({
        ...createDefaultRunManifest({
            sensorRig: {
                sensors: [
                    {
                        id: "front-camera",
                        type: "camera",
                        frameId: "front_camera_optical_frame",
                        mountFrameId: "front_camera_link",
                        measurementFrameId: "front_camera_optical_frame",
                        outputs: { imageTopicId: "front-camera-image", cameraInfoTopicId: "front-camera-info" },
                    },
                    {
                        id: "front-lidar",
                        type: "lidar3d",
                        frameId: "front_lidar_frame",
                        mountFrameId: "front_lidar_frame",
                        measurementFrameId: "front_lidar_frame",
                        outputs: { pointCloudTopicId: "front-lidar-points" },
                    },
                ],
            },
            topics: [
                { id: "front-camera-image", contractId: "front-camera-image", name: "/sensors/front_camera/image_raw", direction: "output", type: "sensor_msgs/Image", schema: { type: "sensor_msgs/Image", version: 1 }, producer: "simulator", authority: "reference" },
                { id: "front-camera-info", contractId: "front-camera-info", name: "/sensors/front_camera/camera_info", direction: "output", type: "sensor_msgs/CameraInfo", schema: { type: "sensor_msgs/CameraInfo", version: 1 }, producer: "simulator", authority: "reference" },
                { id: "front-lidar-points", contractId: "front-lidar-points", name: "/sensors/front_lidar/points", direction: "output", type: "sensor_msgs/PointCloud2", schema: { type: "sensor_msgs/PointCloud2", version: 1 }, producer: "simulator", authority: "reference" },
            ],
        }),
        version: 5,
    });
    const migratedCamera = migrated.sensorRig.sensors.find((sensor) => sensor.id === "front-camera");
    assert.equal(migratedCamera.calibration.products.depth, false);
    assert.equal(migratedCamera.outputs.depthTopicId, undefined);
    const migratedLidar = migrated.sensorRig.sensors.find((sensor) => sensor.id === "front-lidar");
    assert.equal(migratedLidar.calibration.products.semanticPointCloud, false);

    const bundle = buildCalibrationBundle(defaults);
    assert.equal(bundle.version, 2);
    assert.ok(bundle.labelCatalogVersion >= 1);
    assert.ok(bundle.hash);
    assert.ok(bundle.sensors[0].calibration.products);
    assert.ok(bundle.sensors[0].health);
});

test("enabling an oracle product restores output topic ids and catalog topics", () => {
    const migrated = normalizeRunManifest({
        ...createDefaultRunManifest({
            sensorRig: {
                sensors: [
                    {
                        id: "front-camera",
                        type: "camera",
                        frameId: "front_camera_optical_frame",
                        mountFrameId: "front_camera_link",
                        measurementFrameId: "front_camera_optical_frame",
                        syncGroupId: "perception-primary",
                        outputs: { imageTopicId: "front-camera-image", cameraInfoTopicId: "front-camera-info" },
                    },
                    {
                        id: "front-lidar",
                        type: "lidar3d",
                        frameId: "front_lidar_frame",
                        mountFrameId: "front_lidar_frame",
                        measurementFrameId: "front_lidar_frame",
                        syncGroupId: "perception-primary",
                        outputs: { pointCloudTopicId: "front-lidar-points" },
                    },
                ],
            },
            topics: [
                { id: "front-camera-image", contractId: "front-camera-image", name: "/sensors/front_camera/image_raw", direction: "output", type: "sensor_msgs/Image", schema: { type: "sensor_msgs/Image", version: 1 }, producer: "simulator", authority: "reference" },
                { id: "front-camera-info", contractId: "front-camera-info", name: "/sensors/front_camera/camera_info", direction: "output", type: "sensor_msgs/CameraInfo", schema: { type: "sensor_msgs/CameraInfo", version: 1 }, producer: "simulator", authority: "reference" },
                { id: "front-lidar-points", contractId: "front-lidar-points", name: "/sensors/front_lidar/points", direction: "output", type: "sensor_msgs/PointCloud2", schema: { type: "sensor_msgs/PointCloud2", version: 1 }, producer: "simulator", authority: "reference" },
            ],
        }),
        version: 5,
    });
    const cameraIndex = migrated.sensorRig.sensors.findIndex((sensor) => sensor.id === "front-camera");
    const lidarIndex = migrated.sensorRig.sensors.findIndex((sensor) => sensor.id === "front-lidar");
    assert.equal(migrated.sensorRig.sensors[cameraIndex].calibration.products.depth, false);
    assert.equal(migrated.sensorRig.sensors[cameraIndex].outputs.depthTopicId, undefined);

    const withDepth = normalizeRunManifest(applyManifestOracleProduct(migrated, cameraIndex, "depth", true));
    const camera = withDepth.sensorRig.sensors[cameraIndex];
    assert.equal(camera.calibration.products.depth, true);
    assert.equal(camera.outputs.depthTopicId, "front-camera-depth");
    assert.ok(withDepth.topics.some((topic) => topic.id === "front-camera-depth"));
    const perception = withDepth.sensorRig.syncGroups.find((group) => group.id === "perception-primary");
    assert.ok(perception.topicIds.includes("front-camera-depth"));

    const withLidar = normalizeRunManifest(applyManifestOracleProduct(withDepth, lidarIndex, "semanticPointCloud", true));
    assert.equal(withLidar.sensorRig.sensors[lidarIndex].calibration.products.semanticPointCloud, true);
    assert.equal(withLidar.sensorRig.sensors[lidarIndex].outputs.semanticPointCloudTopicId, "front-lidar-semantic");
    assert.ok(withLidar.topics.some((topic) => topic.id === "front-lidar-semantic"));
});
