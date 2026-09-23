import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rep103ToThreeVector } from "../app/autonomy/CoordinateFrames.js";
import { encodeTopicValue, registerMsgDefinition } from "../app/client/TopicCodec.js";
import { measuredStateProfileRef, routeSafetyProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { SFLogBatchEncoder } from "../app/logging/SFLogCodec.js";
import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import { resolveFixedStepSensorSchedule } from "../app/simulation/sensors/FixedStepSensorSchedule.js";
import { createGpuSensorBackendSelection } from "../app/simulation/sensors/GpuSensorBackend.js";
import { HeadlessGpuSensorManager } from "../app/simulation/sensors/HeadlessGpuSensorManager.js";
import { loadHeadlessMessageCodec } from "../app/simulation/sensors/HeadlessMessageCodec.js";
import { loadHeadlessVisualCaptureCodec } from "../app/simulation/sensors/HeadlessVisualCaptureCodec.js";
import { buildCameraInfo, buildImageMessage } from "../app/simulation/sensors/SensorMessages.js";
import { createRunSensor } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { LogService } from "../server/logging/LogService.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { calculateSharedTensorArenaBytes } from "../server/headless/SharedTensorTransport.js";
import { allocateCaptureProducts } from "../server/headless/HeadlessSupervisor.js";
import { PooledGpuRenderer, analyticAxialDepthMeters, analyticGpuCaptureBytes } from "../server/headless/PooledGpuRenderer.js";
import {
    COSMOS_CLIP_CAMERA_ID,
    COSMOS_CLIP_CAPTURE_INTERVAL_NS,
    COSMOS_CLIP_ENVIRONMENT_ID,
    COSMOS_CLIP_FOCAL_PX,
    COSMOS_CLIP_FRAME_COUNT,
    COSMOS_CLIP_HEIGHT,
    COSMOS_CLIP_MAX_STEPS,
    COSMOS_CLIP_SEED,
    COSMOS_CLIP_SPEED_MPS,
    COSMOS_CLIP_STEP_NS,
    COSMOS_CLIP_WIDTH,
    cosmosClipPolicyAction,
    createCosmosClipBundle,
} from "../server/headless/CosmosClipBundle.js";

const SIXTY_HERTZ_STEP_NS = 16_666_667;

test("the 60 Hz step misses the 30 Hz grid and the clip step hits it", () => {
    const missed = resolveFixedStepSensorSchedule(
        { rateHz: 30, phaseNs: 0 },
        {},
        SIXTY_HERTZ_STEP_NS,
    );
    assert.equal(missed.periodNs, COSMOS_CLIP_CAPTURE_INTERVAL_NS);
    assert.equal(missed.periodSteps, 2);
    assert.equal(missed.periodSteps * SIXTY_HERTZ_STEP_NS, 33_333_334);
    assert.notEqual(missed.periodSteps * missed.stepNs, missed.periodNs);

    const selected = resolveFixedStepSensorSchedule(
        { rateHz: 30, phaseNs: 0 },
        {},
        COSMOS_CLIP_STEP_NS,
    );
    assert.equal(selected.periodSteps, 3);
    assert.equal(selected.nextCaptureStep, 3);
    assert.equal(selected.periodSteps * COSMOS_CLIP_STEP_NS, COSMOS_CLIP_CAPTURE_INTERVAL_NS);
    const captures = [];
    for (let step = selected.nextCaptureStep; step <= COSMOS_CLIP_MAX_STEPS; step += selected.periodSteps) {
        captures.push(step);
    }
    assert.equal(captures.length, COSMOS_CLIP_FRAME_COUNT);
    assert.equal(captures[0] * COSMOS_CLIP_STEP_NS, COSMOS_CLIP_CAPTURE_INTERVAL_NS);
    assert.equal(captures.at(-1) * COSMOS_CLIP_STEP_NS, 4_033_333_293);
    assert.deepEqual(captures.slice(1).map((step, index) => step - captures[index]), Array(120).fill(3));
});

test("analytic axial depth is positive in front of the camera and zero otherwise", () => {
    assert.equal(analyticAxialDepthMeters(-4.5), 4.5);
    assert.equal(analyticAxialDepthMeters(2), 0);
    assert.equal(analyticAxialDepthMeters(0), 0);
    assert.equal(analyticAxialDepthMeters(Number.NaN), 0);
});

test("analytic GPU and shared-memory budgets grow only when depth is requested", () => {
    const pixels = 8 * 4;
    assert.equal(analyticGpuCaptureBytes({ type: "camera", width: 8, height: 4 }), pixels * 12);
    assert.equal(analyticGpuCaptureBytes({
        type: "camera",
        width: 8,
        height: 4,
        products: { rgb: true },
    }), pixels * 12);
    assert.equal(analyticGpuCaptureBytes({
        type: "camera",
        width: 8,
        height: 4,
        products: { rgb: true, depth: true },
    }), pixels * 12 + pixels * 36);

    const resolved = (depth) => ({
        manifest: {
            sensorRig: {
                sensors: [{
                    id: "front-camera",
                    type: "camera",
                    enabled: true,
                    calibration: { width: 64, height: 64, products: { rgb: true, depth } },
                    maxQueueFrames: 1,
                }],
            },
        },
    });
    const episode = { backendSelections: [{ kind: 4 }] };
    const withDepth = calculateSharedTensorArenaBytes(resolved(true), episode);
    const rgbOnly = calculateSharedTensorArenaBytes(resolved(false), episode);
    assert.equal(withDepth - rgbOnly, 64 * 64 * 4 * 3);
});

test("capture allocation failure releases every product", async () => {
    const released = [];
    let published = 0;
    const arena = {
        async publishTensor() {
            const reference = { id: published };
            published += 1;
            if (reference.id === 2) throw new Error("arena full");
            return reference;
        },
        async release(reference) {
            released.push(reference.id);
        },
    };
    await assert.rejects(() => allocateCaptureProducts(arena, async (publish) => {
        await publish(new Uint8Array(4), { dtype: 4, shape: [1, 1, 4], byteOrder: 1 }, {});
        await publish(new Uint8Array(4), { dtype: 1, shape: [1, 1, 1], byteOrder: 1 }, {});
        await publish(new Uint8Array(4), { dtype: 4, shape: [1, 1, 4], byteOrder: 1 }, {});
        return "published";
    }), /arena full/);
    assert.deepEqual(released, [0, 1]);
});

test("the cosmos clip bundle is a verified 121-frame analytic camera run", async () => {
    const bundle = await createCosmosClipBundle();
    const manifest = bundle.resolved.manifest;
    assert.equal(manifest.version, 11);
    assert.equal(manifest.seed, COSMOS_CLIP_SEED);
    assert.equal(manifest.environment.id, COSMOS_CLIP_ENVIRONMENT_ID);
    assert.equal(manifest.clock.stepNs, COSMOS_CLIP_STEP_NS);
    assert.equal(manifest.clock.maxSteps, COSMOS_CLIP_MAX_STEPS);
    assert.equal(manifest.clock.pacing, "unbounded");
    assert.equal(manifest.clock.modules.physics, true);
    assert.equal(manifest.clock.modules.sensors, true);
    assert.equal(manifest.clock.modules.vehicles, true);
    assert.equal(manifest.logging.policy, "required");
    assert.equal(manifest.logging.profileId, "simulation-run-full-sensors");
    assert.equal(manifest.controls.authority, "candidate");
    assert.equal(manifest.scripts.enabled, false);
    assert.deepEqual(manifest.sensorRig.sensors.map((sensor) => sensor.type), ["camera", "imu"]);

    const camera = manifest.sensorRig.sensors[0];
    assert.equal(camera.id, COSMOS_CLIP_CAMERA_ID);
    assert.deepEqual(rep103ToThreeVector(camera.pose.position), { x: 1.5, y: 0.5, z: 0 });
    assert.deepEqual(camera.pose.position, { x: 1.5, y: 0, z: 0.5 });
    assert.equal(camera.mountFrameId, "front_camera_link");
    assert.equal(camera.measurementFrameId, "front_camera_optical_frame");
    assert.equal(camera.frameId, "front_camera_optical_frame");
    assert.equal(camera.rateHz, 30);
    assert.equal(camera.phaseNs, 0);
    assert.equal(camera.latency.fixedNs, 0);
    assert.equal(camera.calibration.width, COSMOS_CLIP_WIDTH);
    assert.equal(camera.calibration.height, COSMOS_CLIP_HEIGHT);
    assert.equal(camera.calibration.near, 0.1);
    assert.equal(camera.calibration.far, 200);
    assert.equal(camera.calibration.distortionModel, "none");
    assert.ok(camera.calibration.distortion.every((value) => value === 0));
    assert.equal(camera.calibration.intrinsics.fx, COSMOS_CLIP_FOCAL_PX);
    assert.equal(camera.calibration.intrinsics.fy, COSMOS_CLIP_FOCAL_PX);
    assert.equal(camera.calibration.intrinsics.cx, 639.5);
    assert.equal(camera.calibration.intrinsics.cy, 359.5);
    assert.equal(camera.calibration.products.rgb, true);
    assert.equal(camera.calibration.products.cameraInfo, true);
    assert.equal(camera.calibration.products.depth, true);
    assert.equal(camera.calibration.products.semantic, false);
    assert.equal(camera.calibration.products.instance, false);
    assert.equal(camera.calibration.products.detections2d, false);
    assert.equal(camera.calibration.products.detections3d, false);
    assert.equal(camera.calibration.products.lanes, false);
    assert.equal(camera.calibration.products.trafficControls, false);
    assert.equal(camera.calibration.products.diagnostics, false);
    assert.deepEqual(camera.render, {
        provider: { id: "canonical-analytic", version: 1 },
        productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
    });
    assert.equal(camera.noise.model, "none");
    assert.equal(camera.noise.standardDeviation, 0);
    assert.equal(camera.noise.bias, 0);
    assert.equal(camera.noise.dropoutProbability, 0);
    const topics = new Map(manifest.topics.map((topic) => [topic.id, topic]));
    assert.equal(topics.get("front-camera-image").name, "/sensors/front_camera/image_raw");
    assert.equal(topics.get("front-camera-image").authority, "reference");
    assert.equal(topics.get("front-camera-info").name, "/sensors/front_camera/camera_info");
    assert.equal(topics.get("front-camera-depth").name, "/oracle/front_camera/depth");
    assert.equal(topics.get("front-camera-depth").authority, "oracle");

    const imu = manifest.sensorRig.sensors[1];
    assert.deepEqual(imu.calibration.angularVelocityStdDev, { x: 0, y: 0, z: 0 });
    assert.deepEqual(imu.calibration.linearAccelerationStdDev, { x: 0, y: 0, z: 0 });
    assert.deepEqual(imu.calibration.angularRandomWalk, { x: 0, y: 0, z: 0 });
    assert.deepEqual(imu.calibration.accelerationRandomWalk, { x: 0, y: 0, z: 0 });
    assert.equal(imu.calibration.turnOnBias.randomize, false);

    const vehicles = bundle.resolved.manifest.initialState.vehicles;
    const ego = vehicles.find((vehicle) => vehicle.id === "ego");
    const lead = vehicles.find((vehicle) => vehicle.id === "lead");
    const gap = Math.hypot(lead.pose.position.x - ego.pose.position.x, lead.pose.position.z - ego.pose.position.z);
    assert.ok(gap >= 12 && gap <= 15, `lead gap ${gap}`);
    assert.equal(ego.linearVelocity.x, COSMOS_CLIP_SPEED_MPS);
    assert.equal(lead.linearVelocity.x, COSMOS_CLIP_SPEED_MPS);
    const egoRoute = bundle.resolved.scenario.scenario.routes.find((route) => route.actorId === "ego");
    assert.ok(egoRoute.verification.polyline.length >= 2);
    assert.ok(egoRoute.verification.totalLength > 20);

    const episode = normalizeEpisodeSpec(bundle.resolved, {});
    const gpu = episode.backendSelections.find((entry) => entry.kind === 4);
    const expected = createGpuSensorBackendSelection();
    assert.equal(gpu.capabilityId, expected.capabilityId);
    assert.equal(gpu.version, expected.version);
    assert.equal(gpu.configHash, expected.configHash);
    assert.deepEqual(cosmosClipPolicyAction(), [COSMOS_CLIP_SPEED_MPS / 20, 0]);
});

function analyticCamera() {
    return createRunSensor("camera", {
        id: "front-camera",
        parentId: "ego",
        mountFrameId: "front_camera_link",
        measurementFrameId: "front_camera_optical_frame",
        frameId: "front_camera_optical_frame",
        syncGroupId: "perception-primary",
        rateHz: 30,
        phaseNs: 0,
        noise: { model: "none", standardDeviation: 0, bias: 0, dropoutProbability: 0 },
        outputs: {
            imageTopicId: "front-camera-image",
            cameraInfoTopicId: "front-camera-info",
            depthTopicId: "front-camera-depth",
        },
        calibration: {
            width: 2,
            height: 2,
            verticalFovDeg: 75,
            near: 0.1,
            far: 200,
            distortionModel: "none",
            distortion: [],
            intrinsics: { fx: 2, fy: 2, cx: 0.5, cy: 0.5 },
            products: {
                rgb: true,
                cameraInfo: true,
                depth: true,
                semantic: false,
                instance: false,
                diagnostics: false,
            },
        },
    });
}

async function analyticManager(rendererClient, camera = analyticCamera()) {
    const manager = new HeadlessGpuSensorManager({
        vehicles: [{
            id: "ego",
            telemetryId: "ego",
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        }],
    }, {
        rendererClient,
        messageCodec: await loadHeadlessMessageCodec(),
        visualCapture: await loadHeadlessVisualCaptureCodec(),
    });
    await manager.configureFromManifest({ sensors: [camera] }, {
        backendSelection: createGpuSensorBackendSelection(),
        renderScene: {
            hash: "a".repeat(64),
            description: { provider: { id: "canonical-analytic", version: 1 }, materials: [] },
        },
        stepNs: COSMOS_CLIP_STEP_NS,
        topics: [],
        perceptionObservations: true,
        seed: "42",
    });
    return manager;
}

test("analytic publication pairs RGB, CameraInfo, and depth and keeps observations RGB-only", async () => {
    const calls = [];
    const manager = await analyticManager({
        async captureGroup({ requests }) {
            calls.push(requests);
            return requests.map((request) => ({
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureTimeNs,
                sampleIndex: request.sampleIndex,
                products: {
                    rgb: Uint8Array.from([
                        1, 2, 3, 255, 5, 6, 7, 255,
                        9, 10, 11, 255, 13, 14, 15, 255,
                    ]),
                    depth: Float32Array.from([1, 2, 0, 4]),
                },
            }));
        },
    });
    await manager.updateAsync(0, { step: 3, timeNs: COSMOS_CLIP_CAPTURE_INTERVAL_NS });
    const request = calls[0][0];
    assert.deepEqual(request.provider, { id: "canonical-analytic", version: 1 });
    assert.deepEqual(request.products, { rgb: true, depth: true });
    assert.equal(request.captureTimeNs, COSMOS_CLIP_CAPTURE_INTERVAL_NS);
    assert.equal(request.sampleIndex, 0);
    const queued = manager.devices[0].contractPublisher.queue;
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].messages.map((entry) => entry.signal), ["image", "cameraInfo", "depth"]);
    const [image, info, depth] = queued[0].messages.map((entry) => entry.value);
    assert.equal(image.encoding, "rgba8");
    assert.equal(depth.encoding, "32FC1");
    assert.deepEqual(image.header.stamp, depth.header.stamp);
    assert.deepEqual(image.header.stamp, info.header.stamp);
    assert.deepEqual(Array.from(depth.data), Array.from(new Uint8Array(Float32Array.from([0, 4, 1, 2]).buffer)));
    assert.equal(queued[0].observation.dtype, "uint8");
    assert.deepEqual(queued[0].observation.shape, [2, 2, 4]);
    assert.equal(queued[0].observation.value.length, 16);
    manager.disposeRun();
});

test("malformed analytic depth rejects the camera frame before publication", async () => {
    const manager = await analyticManager({
        async captureGroup({ requests }) {
            return requests.map((request) => ({
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureTimeNs,
                sampleIndex: request.sampleIndex,
                products: {
                    rgb: new Uint8Array(16),
                    depth: new Float32Array(1),
                },
            }));
        },
    });
    await assert.rejects(
        () => manager.updateAsync(0, { step: 3, timeNs: COSMOS_CLIP_CAPTURE_INTERVAL_NS }),
        /depth product/,
    );
    assert.equal(manager.devices[0].contractPublisher.queue.length, 0);
    manager.disposeRun();
});

test("photometric noise changes analytic RGB and leaves depth unchanged", async () => {
    const camera = analyticCamera();
    camera.noise = { model: "none", standardDeviation: 0, bias: 5, dropoutProbability: 0 };
    const manager = await analyticManager({
        async captureGroup({ requests }) {
            return requests.map((request) => ({
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureTimeNs,
                sampleIndex: request.sampleIndex,
                products: {
                    rgb: new Uint8Array(16).fill(10),
                    depth: Float32Array.from([3, 0, 3, 3]),
                },
            }));
        },
    }, camera);
    await manager.updateAsync(0, { step: 3, timeNs: COSMOS_CLIP_CAPTURE_INTERVAL_NS });
    const [image, , depth] = manager.devices[0].contractPublisher.queue[0].messages.map((entry) => entry.value);
    assert.ok(Array.from(image.data).some((value, index) => index % 4 < 3 && value === 15));
    assert.equal(image.data[3], 10);
    assert.deepEqual(Array.from(depth.data), Array.from(new Uint8Array(Float32Array.from([3, 3, 3, 0]).buffer)));
    manager.disposeRun();
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pythonClip(script, args) {
    return spawnSync("python3", ["-c", script, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "python/src") },
    });
}

test("Python decodes retained RGB, depth, and CameraInfo SFLog messages", async (context) => {
    registerMsgDefinition("builtin_interfaces/Time", "int32 sec\nuint32 nanosec\n");
    registerMsgDefinition("std_msgs/Header", "builtin_interfaces/Time stamp\nstring frame_id\n");
    registerMsgDefinition("sensor_msgs/Image", "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n");
    registerMsgDefinition(
        "sensor_msgs/CameraInfo",
        "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\n",
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "cosmos-clip-sflog-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const service = new LogService(directory);
    const session = await service.createSession({ id: "run", name: "clip" });
    const encoder = new SFLogBatchEncoder();
    const stamps = [33_333_333, 66_666_666];
    stamps.forEach((stamp, index) => {
        const rgb = encodeTopicValue("sensor_msgs/Image", buildImageMessage({
            data: new Uint8Array(16).fill(index + 1),
            width: 2,
            height: 2,
            timeNs: stamp,
            frameId: "front_camera_optical_frame",
            encoding: "rgba8",
        }));
        const depth = encodeTopicValue("sensor_msgs/Image", buildImageMessage({
            data: Float32Array.from([1.5 + index, 0, 2, 3]),
            width: 2,
            height: 2,
            timeNs: stamp,
            frameId: "front_camera_optical_frame",
            encoding: "32FC1",
        }));
        const info = encodeTopicValue("sensor_msgs/CameraInfo", buildCameraInfo({
            width: 1280,
            height: 720,
            timeNs: stamp,
            frameId: "front_camera_optical_frame",
            distortionModel: "none",
            distortion: [0, 0, 0, 0, 0],
            intrinsics: { fx: COSMOS_CLIP_FOCAL_PX, fy: COSMOS_CLIP_FOCAL_PX, cx: 639.5, cy: 359.5 },
        }));
        const metadata = {
            captureTimeNs: stamps[0],
            sequenceId: 0,
            captureStep: 3,
        };
        for (const [signal, encoded] of [["image", rgb], ["depth", depth], ["cameraInfo", info]]) {
            encoder.addUpdate({
                path: `devices.front-camera.${signal}`,
                timeUs: Math.round(stamp / 1000),
                cycle: 3 * (index + 1),
                encodedValue: encoded,
                entry: { type: "bytes", value: encoded },
                descriptor: {
                    path: `devices.front-camera.${signal}`,
                    type: "bytes",
                    source: "sensors",
                    category: "devices",
                    replayRole: "derived",
                    logClass: "heavy",
                    metadata,
                },
            });
        }
    });
    const batch = encoder.flush();
    await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 66_667, bytes: batch.bytes });
    await service.finalize(session.id);
    const decoded = pythonClip(`
import json, struct, sys
from cev_sim.cosmos_clip.sflog import read_sflog
updates = read_sflog(sys.argv[1])
print(json.dumps([{
    "path": update.path,
    "timeUs": update.time_us,
    "cycle": update.cycle,
    "captureTimeNs": update.metadata.get("captureTimeNs"),
    "sequenceId": update.metadata.get("sequenceId"),
    "captureStep": update.metadata.get("captureStep"),
    "encoding": None if update.message is None else update.message.get("encoding"),
    "stampNs": None if update.message is None else update.message.get("stampNs"),
    "length": 0 if update.message is None or "data" not in update.message else len(update.message["data"]),
    "fx": None if update.message is None or "k" not in update.message else update.message["k"][0],
    "depth0": None if update.message is None or update.message.get("encoding") != "32FC1" else struct.unpack("<f", update.message["data"][:4])[0],
} for update in updates]))
`, [service.getFilePath(session.id)]);
    assert.equal(decoded.status, 0, decoded.stderr);
    const updates = JSON.parse(decoded.stdout);
    const images = updates.filter((update) => update.path === "devices.front-camera.image");
    const depths = updates.filter((update) => update.path === "devices.front-camera.depth");
    const infos = updates.filter((update) => update.path === "devices.front-camera.cameraInfo");
    assert.deepEqual(images.map((update) => update.stampNs), stamps);
    assert.deepEqual(depths.map((update) => update.stampNs), stamps);
    assert.deepEqual(infos.map((update) => update.stampNs), stamps);
    assert.deepEqual(images.map((update) => update.cycle), [3, 6]);
    assert.ok(images.every((update) => update.encoding === "rgba8" && update.length === 16));
    assert.ok(depths.every((update) => update.encoding === "32FC1" && update.length === 16));
    assert.equal(depths[0].depth0, 1.5);
    assert.equal(depths[1].depth0, 2.5);
    assert.ok(infos.every((update) => update.fx === COSMOS_CLIP_FOCAL_PX));
    assert.ok(updates.every((update) => update.captureTimeNs === stamps[0] && update.sequenceId === 0 && update.captureStep === 3));
});

function ffmpegAvailable() {
    const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
    return result.status === 0 && result.stdout.includes("ffmpeg");
}

function clipCameraRequest(products) {
    return {
        id: "front-camera",
        type: "camera",
        width: 32,
        height: 16,
        products,
        captureTimeNs: 33_333_333,
        sampleIndex: 4,
        clearColor: [0, 0, 0, 1],
        sensor: {
            parentId: "ego",
            pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
            calibration: { verticalFovDeg: 75, near: 0.1, far: 200 },
        },
        vehicles: [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    };
}

test("analytic Chromium capture returns typed RGB and axial depth", {
    skip: !process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
    timeout: 120_000,
}, async () => {
    const pool = new PooledGpuRenderer({
        chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
        contextPoolSize: 1,
    });
    try {
        const empty = await pool.captureGroup({
            environmentKey: "clip-empty",
            scene: { hash: "e".repeat(64), description: { staticPrimitives: [] } },
            requests: [clipCameraRequest({ rgb: true, depth: true })],
            maxGpuBytes: 64 * 1024 * 1024,
        });
        const missed = empty[0];
        assert.ok(missed.products.rgb instanceof Uint8Array);
        assert.ok(missed.products.depth instanceof Float32Array);
        assert.equal(missed.products.rgb.length, 32 * 16 * 4);
        assert.equal(missed.products.depth.length, 32 * 16);
        assert.equal(missed.captureTimeNs, 33_333_333);
        assert.equal(missed.sampleIndex, 4);
        assert.ok(Array.from(missed.products.depth).every((value) => value === 0));
        const hit = await pool.captureGroup({
            environmentKey: "clip-box",
            scene: {
                hash: "f".repeat(64),
                description: {
                    staticPrimitives: [
                        { center: { x: 8, y: 0, z: 0 }, size: { x: 2, y: 8, z: 8 }, semanticId: 1 },
                        { center: { x: 0, y: 8, z: 0 }, size: { x: 8, y: 2, z: 8 }, semanticId: 1 },
                        { center: { x: 0, y: 0, z: 8 }, size: { x: 8, y: 8, z: 2 }, semanticId: 1 },
                    ],
                },
            },
            requests: [clipCameraRequest({ rgb: true, depth: true })],
            maxGpuBytes: 64 * 1024 * 1024,
        });
        const depth = Array.from(hit[0].products.depth);
        const positive = depth.filter((value) => Number.isFinite(value) && value > 0);
        assert.ok(positive.length > 0, "expected a finite positive axial depth");
        assert.ok(depth.some((value) => value === 0), "expected zero depth where the ray misses");
        assert.ok(positive.every((value) => value < 200));
        assert.ok(Array.from(hit[0].products.rgb).some((value, index) => index % 4 < 3 && value > 0));
    } finally {
        await pool.close();
    }
});

function runCli(args, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin/cev-sim.js"), ...args], {
            cwd: REPO_ROOT,
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

test("headless analytic clip run retains 121 aligned RGB and depth frames", {
    skip: !process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
    timeout: 20 * 60 * 1000,
}, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cosmos-clip-run-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const bundle = await createCosmosClipBundle();
    const bundlePath = path.join(root, "bundle.json");
    const configPath = path.join(root, "supervisor.json");
    const actionsPath = path.join(root, "actions.jsonl");
    const episodePath = path.join(root, "episode.json");
    const output = path.join(root, "output");
    const action = cosmosClipPolicyAction();
    await writeFile(bundlePath, canonicalRunBundleStringify(bundle));
    await writeFile(configPath, `${JSON.stringify({
        kind: "cev-sim.headless-supervisor-config",
        version: 1,
        preset: "permissive",
        renderer: {
            chromiumExecutable: process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
            contextPoolSize: 1,
        },
    })}\n`);
    await writeFile(episodePath, `${JSON.stringify({
        actionRepeat: 1,
        maxEpisodeSteps: String(COSMOS_CLIP_MAX_STEPS),
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef({
            terminateOnCollision: false,
            terminateOnOffRoad: false,
            terminateOnWrongWay: false,
            smoothness: false,
        }),
    })}\n`);
    await writeFile(actionsPath, Array.from({ length: COSMOS_CLIP_MAX_STEPS }, (_, index) => (
        JSON.stringify({ policyStep: index + 1, action })
    )).join("\n") + "\n");
    const preflight = await runCli(["gpu-preflight", "--config", configPath], { timeoutMs: 120_000 });
    assert.equal(preflight.code, 0, preflight.stderr);
    assert.match(preflight.stdout, /"available":true/);
    const run = await runCli([
        "run", "--bundle", bundlePath, "--output", output,
        "--actions", actionsPath, "--episode", episodePath,
        "--artifact-profile", "evaluation", "--config", configPath,
    ], { timeoutMs: 18 * 60 * 1000 });
    assert.ok(run.code === 0 || run.code === 1, `${run.stderr}\n${run.stdout}`);
    const events = run.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const resultEvent = events.at(-1);
    assert.equal(resultEvent?.kind, "cev-sim.headless.result", JSON.stringify(resultEvent));
    const published = resultEvent.outputDirectory;
    assert.ok(published, JSON.stringify(resultEvent));
    const decoded = pythonClip(`
import json, sys
from pathlib import Path
import numpy as np
from cev_sim.cosmos_clip.export import load_run, pair_camera_frames
from cev_sim.cosmos_clip.sflog import read_sflog
root = Path(sys.argv[1])
bundle, results, provenance = load_run(root)
frames = pair_camera_frames(read_sflog(root / "run.sflog"), "front-camera")
positive = 0
colored = 0
depth_min = None
depth_max = None
for frame in frames:
    color = np.frombuffer(frame.rgb, dtype=np.uint8).reshape(-1, 4)[:, :3]
    if int(color.max()) > 0:
        colored += 1
    depth = np.frombuffer(frame.depth, dtype="<f4")
    valid = depth[np.isfinite(depth) & (depth > 0)]
    if valid.size:
        positive += 1
        low = float(valid.min())
        high = float(valid.max())
        depth_min = low if depth_min is None else min(depth_min, low)
        depth_max = high if depth_max is None else max(depth_max, high)
print(json.dumps({
    "count": len(frames),
    "first": frames[0].stamp_ns,
    "last": frames[-1].stamp_ns,
    "rgbBytes": len(frames[0].rgb),
    "depthBytes": len(frames[0].depth),
    "coloredFrames": colored,
    "positiveDepthFrames": positive,
    "depthMin": depth_min,
    "depthMax": depth_max,
    "completed": results["completed"],
    "interrupted": results["interrupted"],
    "episodeHash": results["episodeHash"],
}))
`, [published]);
    assert.equal(decoded.status, 0, decoded.stderr);
    console.log(decoded.stdout.trim());
    const summary = JSON.parse(decoded.stdout);
    assert.equal(summary.count, COSMOS_CLIP_FRAME_COUNT);
    assert.equal(summary.first, COSMOS_CLIP_CAPTURE_INTERVAL_NS);
    assert.equal(summary.last, COSMOS_CLIP_MAX_STEPS * COSMOS_CLIP_STEP_NS);
    assert.equal(summary.rgbBytes, COSMOS_CLIP_WIDTH * COSMOS_CLIP_HEIGHT * 4);
    assert.equal(summary.depthBytes, COSMOS_CLIP_WIDTH * COSMOS_CLIP_HEIGHT * 4);
    assert.equal(summary.coloredFrames, COSMOS_CLIP_FRAME_COUNT);
    assert.equal(summary.positiveDepthFrames, COSMOS_CLIP_FRAME_COUNT);
    assert.ok(summary.depthMin < 2, JSON.stringify(summary));
    assert.ok(summary.depthMax > 40, JSON.stringify(summary));
    assert.equal(summary.completed, true);
    assert.equal(summary.interrupted, false);
    if (!ffmpegAvailable()) return;
    const clips = path.join(root, "clips");
    const command = spawnSync("python3", [
        "-m", "cev_sim.cosmos_clip", "export",
        "--run-output", published,
        "--camera-id", "front-camera",
        "--window-index", "0",
        "--output-root", clips,
    ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "python/src") },
    });
    assert.equal(command.status, 0, command.stderr);
    const clip = command.stdout.trim();
    const checked = spawnSync("python3", ["-m", "cev_sim.cosmos_clip", "check", clip], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: path.join(REPO_ROOT, "python/src") },
    });
    assert.equal(checked.status, 0, checked.stderr);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.frameCount, 121);
    assert.equal(report.frameRate, "30/1");
    const depthBytes = (await readFile(path.join(clip, "depth.f32"))).length;
    assert.equal(depthBytes, 446_054_400);
});
