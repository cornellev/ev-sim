import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
    catalogHash,
    catalogMetadata,
    catalogSchemas,
    defaultManifestTopics,
    DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS,
    fixturePayloadForType,
    getAutonomyContract,
    listAutonomyContracts,
    migrateLegacyTopic,
    msgFilePathsForCatalog,
    schemaClosureForManifest,
    topicFromContract,
    validateManifestTopicAuthority,
    validateTopicAgainstCatalog,
} from "../app/autonomy/AutonomyContractCatalog.js";
import { createDefaultRunManifest, normalizeRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { TopicInputQueue } from "../app/simulation/TopicInputQueue.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { registerMsgDefinition } from "../app/client/Client.js";

test("autonomy catalog exposes versioned contracts and schema closure includes AckermannDrive", () => {
    const metadata = catalogMetadata();
    assert.equal(metadata.kind, "cev-sim.autonomy-contract-catalog");
    assert.equal(metadata.version, 5);
    assert.equal(metadata.hash, catalogHash());
    assert.ok(listAutonomyContracts().some((contract) => contract.id === "ackdrive-legacy"));

    const manifest = createDefaultRunManifest();
    const closure = schemaClosureForManifest(manifest);
    assert.ok(closure["sensor_fusion_msgs/AckermannDrive"]);
    assert.ok(closure["sensor_msgs/Image"]);
});

test("catalog msg file paths exist for every mapped type", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    for (const [type, relativePath] of Object.entries(msgFilePathsForCatalog())) {
        const absolute = path.join(root, "public", relativePath.replace(/^\//, ""));
        await fs.access(absolute);
        assert.ok(type.includes("/"), type);
    }
});

test("legacy topics migrate to v3 contract records", () => {
    const migrated = migrateLegacyTopic({
        id: "ackdrive",
        name: "/ackdrive",
        direction: "input",
        type: "sensor_fusion_msgs/AckermannDrive",
        required: true,
    });
    assert.equal(migrated.contractId, "ackdrive-legacy");
    assert.equal(migrated.schema.type, "sensor_fusion_msgs/AckermannDrive");
    assert.equal(migrated.producer, "candidate");
    assert.equal(migrated.authority, "candidate");
});

test("manifest authority validation rejects conflicting authority on the same contract", () => {
    const manifest = createDefaultRunManifest();
    manifest.topics.push(topicFromContract("ackdrive-legacy", { id: "ackdrive-alt", authority: "reference" }));
    const issues = validateManifestTopicAuthority(manifest);
    assert.ok(issues.some((issue) => /Conflicting authority/i.test(issue.message)));
});

test("topic contract router writes producer and active namespaces deterministically", () => {
    const store = new SignalStore({}, { sourceId: "router-test" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const ackTopic = manifest.topics.find((topic) => topic.id === "ackdrive");
    registerMsgDefinition("sensor_fusion_msgs/AckermannDrive", catalogSchemas()["sensor_fusion_msgs/AckermannDrive"]);
    const payload = fixturePayloadForType("sensor_fusion_msgs/AckermannDrive");
    const routed = router.routeInbound({
        name: ackTopic.name,
        typeStr: ackTopic.schema.type,
        value: payload,
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 10_000_000 });
    assert.equal(routed.ok, true);
    assert.ok(store.read("active.topics.ackdrive-legacy").value);
    assert.ok(store.read("candidate.topics.ackdrive-legacy").value);
});

test("observational candidate returns skip active namespace by default", () => {
    const store = new SignalStore({}, { sourceId: "observe-test" });
    const manifest = createDefaultRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.contractId === "localization-estimate");
    assert.equal(topic.routeDownstream, false);
    const routed = router.routeInbound({
        name: topic.name,
        typeStr: topic.schema.type,
        value: fixturePayloadForType(topic.schema.type),
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 16_666_667 });
    assert.equal(routed.ok, true);
    assert.ok(store.read("candidate.topics.localization-estimate")?.value);
    assert.equal(store.read("active.topics.localization-estimate")?.exists, false);
    assert.equal(store.read("diagnostics.topics.localization-estimate")?.value?.status, "ok");
});

test("default manifest includes live perception return contracts", () => {
    const topics = defaultManifestTopics();
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        const topic = topics.find((entry) => entry.contractId === id);
        assert.ok(topic, id);
        assert.equal(topic.routeDownstream, false);
        assert.equal(topic.implementation, "live");
    }
});

test("v7 manifests without candidate returns gain them on normalize", () => {
    const source = createDefaultRunManifest();
    source.version = 7;
    source.topics = source.topics.filter((entry) => !DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS.includes(entry.contractId));
    const migrated = normalizeRunManifest(source);
    assert.equal(migrated.version, 8);
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        const topic = migrated.topics.find((entry) => entry.contractId === id);
        assert.ok(topic, id);
        assert.equal(topic.routeDownstream, false);
    }
});

test("v8 manifests can omit candidate return topics", () => {
    const source = createDefaultRunManifest();
    source.topics = source.topics.filter((entry) => !DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS.includes(entry.contractId));
    const kept = normalizeRunManifest({ ...source, version: 8 });
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        assert.ok(!kept.topics.some((entry) => entry.contractId === id), id);
    }
});

test("topic input queue rejects undeclared topics and preserves arrival ordering", () => {
    const manifest = createDefaultRunManifest();
    const queue = new TopicInputQueue(manifest.topics);
    const rejected = queue.enqueue({ name: "/unknown", value: 1 }, 1);
    assert.equal(rejected.rejected, true);
    const ack = manifest.topics.find((topic) => topic.id === "ackdrive");
    queue.enqueue({ name: ack.name, value: { speed: 1 } }, 2, { arrivalTimeNs: 20 });
    queue.enqueue({ name: ack.name, value: { speed: 2 } }, 2, { arrivalTimeNs: 10 });
    const drained = queue.drain(2, 33_333_334);
    assert.equal(drained.length, 2);
    assert.equal(drained[0].info.value.speed, 2);
});

test("v2 manifests normalize to v4 with autonomy catalog metadata", () => {
    const legacy = normalizeRunManifest({
        kind: "cev-sim.run-manifest",
        version: 2,
        id: "legacy",
        name: "Legacy",
        topics: [{
            id: "ackdrive",
            name: "/ackdrive",
            direction: "input",
            type: "sensor_fusion_msgs/AckermannDrive",
            required: true,
        }],
    });
    assert.equal(legacy.version, 8);
    assert.equal(legacy.topics[0].contractId, "ackdrive-legacy");
    assert.equal(validateRunManifest(legacy).ok, true);
    for (const topic of legacy.topics) {
        assert.equal(validateTopicAgainstCatalog(topic).length, 0);
    }
});

test("inbound validity windows are enforced separately from transport timeout", () => {
    const store = new SignalStore({}, { sourceId: "validity-test" });
    const manifest = createDefaultRunManifest();
    const stamped = topicFromContract("controls-command", {
        id: "controls-validity",
        validityNs: 1_000,
        timeoutNs: 10_000_000,
    });
    manifest.topics.push(stamped);
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const payload = fixturePayloadForType(stamped.schema.type);
    payload.header.stamp = { sec: 0, nanosec: 0 };
    const invalid = router.routeInbound({
        name: stamped.name,
        typeStr: stamped.schema.type,
        value: payload,
    }, { applyStep: 2, applyTimeNs: 5_000_000, arrivalTimeNs: 4_999_000 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "invalid");
});

test("stale inbound topics honor timeout fallback contracts", () => {
    const store = new SignalStore({}, { sourceId: "stale-test" });
    const manifest = createDefaultRunManifest();
    const primary = topicFromContract("controls-command", {
        id: "controls",
        timeoutNs: 1_000,
        fallback: { contractId: "ackdrive-legacy" },
    });
    manifest.topics.push(primary);
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const stale = router.routeInbound({
        name: primary.name,
        typeStr: primary.schema.type,
        value: fixturePayloadForType(primary.schema.type),
    }, { applyStep: 3, applyTimeNs: 5_000_000, arrivalTimeNs: 1_000_000 });
    assert.equal(stale.ok, true);
    assert.equal(stale.usedFallback, true);
});
