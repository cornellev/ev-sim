import assert from "node:assert/strict";
import test from "node:test";

import {
    Client,
    hasRegisteredSchema,
    registerMsgDefinition,
} from "../app/client/Client.js";
import {
    catalogSchemas,
    defaultManifestTopics,
    fixturePayloadForType,
    schemaClosureForManifest,
} from "../app/autonomy/AutonomyContractCatalog.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { buildCalibrationBundle } from "../app/autonomy/CalibrationBundle.js";
import { TransformRuntime } from "../app/simulation/TransformRuntime.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createOrchestratorLoopback } from "./helpers/orchestratorLoopback.js";

function registerCatalogSchemas() {
    for (const [type, definition] of Object.entries(catalogSchemas())) {
        registerMsgDefinition(type, definition);
    }
}

test("orchestrator loopback preflight rejects wrong return types and accepts valid fixtures", async () => {
    registerCatalogSchemas();
    const manifest = createDefaultRunManifest({ sensorRig: { sensors: [] } });
    const resolved = {
        manifest,
        schemas: schemaClosureForManifest(manifest),
        autonomyCatalog: manifest.autonomyCatalog,
    };
    const ack = manifest.topics.find((topic) => topic.contractId === "controls-command");

    const loopback = createOrchestratorLoopback({
        topics: [{ name: ack.name, typeStr: "std_msgs/String" }],
    });

    const client = new Client({
        url: loopback.url,
        reconnect: false,
        autoSubscribe: false,
    });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Client connect timeout")), 5000);
        client.onOpen = () => {
            clearTimeout(timeout);
            resolve();
        };
        client.start().catch(reject);
    });
    const catalog = await client.fetchTopicCatalog();
    assert.ok(catalog.some((entry) => entry.name === ack.name));

    const issues = [];
    if (!client.isOpen()) issues.push("transport");
    for (const type of Object.keys(resolved.schemas)) {
        if (!hasRegisteredSchema(type)) issues.push(type);
    }
    const known = catalog.find((entry) => entry.name === ack.name);
    if (known && known.typeStr !== ack.schema.type) {
        issues.push(`type mismatch ${known.typeStr} != ${ack.schema.type}`);
    }
    assert.ok(issues.some((issue) => /type mismatch/i.test(String(issue))));

    await client.stop();
    await loopback.close();
});

test("topic router routes valid team returns through producer and active paths", () => {
    registerCatalogSchemas();
    const store = new SignalStore({}, { sourceId: "loopback-router" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const ack = manifest.topics.find((topic) => topic.contractId === "controls-command");
    const payload = fixturePayloadForType(ack.schema.type);
    const routed = router.routeInbound({
        name: ack.name,
        typeStr: ack.schema.type,
        value: payload,
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 16_666_667 });
    assert.equal(routed.ok, true);
    assert.ok(store.read("candidate.topics.controls-command")?.value);
    assert.ok(store.read("active.topics.controls-command")?.value);
});

test("perception returns preserve capture stamps without writing active paths", () => {
    registerCatalogSchemas();
    const store = new SignalStore({}, { sourceId: "perception-return" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.contractId === "perception-detections-2d");
    const payload = fixturePayloadForType(topic.schema.type);
    payload.header.stamp = { sec: 2, nanosec: 0 };
    const routed = router.routeInbound({
        name: topic.name,
        typeStr: topic.schema.type,
        value: payload,
    }, { applyStep: 3, applyTimeNs: 50_000_000, arrivalTimeNs: 49_000_000 });
    assert.equal(routed.ok, true);
    assert.equal(routed.envelope.captureTimeNs, 2_000_000_000);
    assert.equal(routed.envelope.arrivalTimeNs, 49_000_000);
    assert.equal(routed.envelope.applyTimeNs, 50_000_000);
    assert.ok(store.read("candidate.topics.perception-detections-2d")?.value);
    assert.equal(store.read("active.topics.perception-detections-2d")?.exists, false);
    assert.equal(store.read("diagnostics.topics.perception-detections-2d")?.value?.status, "ok");
});

test("full-catalog fixture manifest declares live outputs and stamped controls return", () => {
    const topics = defaultManifestTopics();
    assert.ok(topics.some((topic) => topic.contractId === "front-camera-image"));
    assert.ok(topics.some((topic) => topic.contractId === "front-camera-depth"));
    assert.ok(topics.some((topic) => topic.contractId === "front-lidar-semantic"));
    assert.ok(topics.some((topic) => topic.contractId === "oracle-detections-2d"));
    assert.ok(topics.some((topic) => topic.contractId === "imu"));
    assert.ok(topics.some((topic) => topic.contractId === "truth-odometry"));
    assert.ok(topics.some((topic) => topic.contractId === "localization-estimate"));
    assert.ok(topics.some((topic) => topic.contractId === "perception-detections-3d"));
    assert.ok(topics.some((topic) => topic.contractId === "perception-lanes"));
    assert.ok(topics.some((topic) => topic.contractId === "tf"));
    assert.ok(topics.some((topic) => topic.contractId === "tf-static"));
    assert.ok(topics.some((topic) => topic.contractId === "controls-command"));
    assert.ok(!topics.some((topic) => topic.contractId === "ackdrive-legacy"));
    const depth = topics.find((topic) => topic.contractId === "front-camera-depth");
    assert.equal(depth.producer, "oracle");
    assert.equal(depth.authority, "oracle");
    const outputTypes = topics.filter((topic) => topic.direction === "output").map((topic) => topic.schema.type);
    for (const type of outputTypes) {
        assert.ok(hasRegisteredSchema(type), type);
        assert.ok(fixturePayloadForType(type) !== undefined);
    }
});

test("perception sync-group topics share calibration hash and encode through loopback fixtures", () => {
    registerCatalogSchemas();
    const store = new SignalStore({}, { sourceId: "perception-loopback" });
    const published = [];
    const original = store.publishSignal.bind(store);
    store.publishSignal = (path, value, options) => {
        published.push({ path, value, options });
        return original(path, value, options);
    };
    const manifest = createDefaultRunManifest();
    const bundle = buildCalibrationBundle(manifest);
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const stamp = 1_000_000_000;
    const syncGroupKey = "perception-primary:60";
    for (const topicId of ["front-camera-image", "front-camera-info", "front-lidar-points", "front-camera-depth"]) {
        const topic = manifest.topics.find((entry) => entry.id === topicId);
        const payload = fixturePayloadForType(topic.schema.type);
        router.routeOutbound(topic.id, { value: payload, typeStr: topic.schema.type }, {
            producer: topic.producer,
            observationalOracle: topic.producer === "oracle",
            captureTimeNs: stamp,
            deliveryTimeNs: stamp,
            syncGroupKey,
            calibrationHash: bundle.hash,
            sequenceId: 0,
            cycle: 60,
        });
    }
    const imageRoute = published.find((entry) => entry.path.includes("front-camera-image") || entry.options?.descriptorMetadata?.topic === "/sensors/front_camera/image_raw");
    const depthRoute = published.find((entry) => entry.path.startsWith("oracle.topics."));
    assert.ok(imageRoute);
    assert.ok(depthRoute);
    assert.ok(!published.some((entry) => entry.path.startsWith("active.topics.front-camera-depth") || entry.path === "active.topics.front-camera-depth"));
    const metadataEntries = published.filter((entry) => entry.options?.descriptorMetadata?.syncGroupKey);
    assert.ok(metadataEntries.every((entry) => entry.options.descriptorMetadata.syncGroupKey === syncGroupKey));
    assert.ok(metadataEntries.every((entry) => entry.options.descriptorMetadata.calibrationHash === bundle.hash));
    assert.ok(metadataEntries.every((entry) => entry.options.descriptorMetadata.captureTimeNs === stamp));
});

test("transform runtime publishes live TF fixtures through the contract router", () => {
    registerCatalogSchemas();
    const store = new SignalStore({}, { sourceId: "tf-loopback" });
    const manifest = createDefaultRunManifest({ sensorRig: { sensors: [] } });
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const runtime = new TransformRuntime(buildCalibrationBundle(manifest), router);
    runtime.publishStaticTransforms(0);
    runtime.publishDynamicTransforms(16_666_667, 1, [{ telemetryId: "ego", position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } }]);
    const tf = store.read("topics./tf")?.value;
    const tfStatic = store.read("topics./tf_static")?.value;
    const tfEntry = store.read("topics./tf");
    const tfStaticEntry = store.read("topics./tf_static");
    assert.ok(Array.isArray(tf?.transforms) && tf.transforms.length >= 2);
    assert.ok(Array.isArray(tfStatic?.transforms) && tfStatic.transforms.length >= 0);
    assert.equal(tf.transforms[1].child_frame_id, "base_link");
    assert.equal(tfEntry.timeUs, 16_667);
    assert.equal(tfEntry.cycle, 1);
    assert.equal(tfStaticEntry.timeUs, 0);
    assert.equal(tfStaticEntry.cycle, 0);
});
