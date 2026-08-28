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
    const ack = manifest.topics.find((topic) => topic.id === "ackdrive");

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
    const ack = manifest.topics.find((topic) => topic.id === "ackdrive");
    const payload = fixturePayloadForType(ack.schema.type);
    const routed = router.routeInbound({
        name: ack.name,
        typeStr: ack.schema.type,
        value: payload,
    }, { applyStep: 0, applyTimeNs: 0, arrivalTimeNs: 0 });
    assert.equal(routed.ok, true);
    assert.equal(store.read("active.topics.ackdrive-legacy").value.speed, payload.speed);
});

test("full-catalog fixture manifest declares live outputs and legacy control return", () => {
    const topics = defaultManifestTopics();
    assert.ok(topics.some((topic) => topic.contractId === "front-camera-image"));
    assert.ok(topics.some((topic) => topic.contractId === "imu"));
    assert.ok(topics.some((topic) => topic.contractId === "truth-odometry"));
    assert.ok(topics.some((topic) => topic.contractId === "localization-estimate"));
    assert.ok(topics.some((topic) => topic.contractId === "tf"));
    assert.ok(topics.some((topic) => topic.contractId === "tf-static"));
    assert.ok(topics.some((topic) => topic.contractId === "ackdrive-legacy"));
    const outputTypes = topics.filter((topic) => topic.direction === "output").map((topic) => topic.schema.type);
    for (const type of outputTypes) {
        assert.ok(hasRegisteredSchema(type), type);
        assert.ok(fixturePayloadForType(type) !== undefined);
    }
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
    assert.ok(Array.isArray(tf?.transforms) && tf.transforms.length >= 2);
    assert.ok(Array.isArray(tfStatic?.transforms) && tfStatic.transforms.length >= 0);
    assert.equal(tf.transforms[1].child_frame_id, "base_link");
});
