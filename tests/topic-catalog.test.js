import assert from "node:assert/strict";
import test from "node:test";

import {
    catalogHash,
    catalogMetadata,
    catalogSchemas,
    defaultManifestTopics,
    DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS,
    getAutonomyContract,
    listAutonomyContracts,
    migrateLegacyTopic,
    schemaClosureForManifest,
    topicFromContract,
    validateManifestTopicAuthority,
    validateTopicAgainstCatalog,
} from "../server/interfaces/historical/TopicCatalog.js";
import { createDefaultRunManifest, normalizeRunManifest, validateRunManifest } from "../server/interfaces/historical/RunContracts.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { TopicInputQueue } from "../app/simulation/TopicInputQueue.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { createDefaultRunManifest as createNativeRunManifest } from "../app/simulation/RunManifest.js";
import { requiresControlLease, topicFromNativeContract } from "../app/simulation/NativeTopicCatalog.js";
import { buildNativeOdometry } from "../app/simulation/sensors/NativeSensorProducts.js";
const command = () => ({ runId: "test", mode: "velocity", sequence: "1", captureTimeNs: 0, deadlineNs: 100_000_000, frameId: "base_link", speedMps: 0, steeringRad: 0, accelerationMps2: 0, jerkMps3: 0, steeringRateRadps: 0 });

test("autonomy catalog exposes versioned controls-command and retires ackdrive-legacy", () => {
    const metadata = catalogMetadata();
    assert.equal(metadata.kind, "cev-sim.autonomy-contract-catalog");
    assert.equal(metadata.version, 6);
    assert.equal(metadata.hash, catalogHash());
    assert.ok(listAutonomyContracts().some((contract) => contract.id === "controls-command"));
    assert.ok(!listAutonomyContracts().some((contract) => contract.id === "ackdrive-legacy"));
    assert.equal(getAutonomyContract("controls-command").implementation, "live");
    assert.equal(getAutonomyContract("controls-command").units, "SI");

    const manifest = createDefaultRunManifest({ version: 12 });
    const closure = schemaClosureForManifest(manifest);
    assert.ok(closure["sensor_fusion_msgs/StampedAckermannDrive"]);
    assert.ok(!closure["sensor_fusion_msgs/AckermannDrive"]);
    assert.ok(closure["sensor_msgs/Image"]);
});

test("legacy /ackdrive topics migrate to stamped SI controls-command", () => {
    const migrated = migrateLegacyTopic({
        id: "ackdrive",
        name: "/ackdrive",
        direction: "input",
        type: "sensor_fusion_msgs/AckermannDrive",
        required: true,
    });
    assert.equal(migrated.contractId, "controls-command");
    assert.equal(migrated.name, "/controls/command");
    assert.equal(migrated.schema.type, "sensor_fusion_msgs/StampedAckermannDrive");
    assert.equal(migrated.producer, "candidate");
    assert.equal(migrated.authority, "candidate");
    assert.equal(migrated.fallback, null);
});

test("explicit required false on controls-command survives normalize", () => {
    const omitted = migrateLegacyTopic({
        contractId: "controls-command",
        name: "/controls/command",
        direction: "input",
    });
    assert.equal(omitted.required, true);

    const optional = migrateLegacyTopic({
        contractId: "controls-command",
        name: "/controls/command",
        direction: "input",
        required: false,
    });
    assert.equal(optional.required, false);

    const manifest = createDefaultRunManifest({ version: 12 });
    const controls = manifest.topics.find((topic) => topic.contractId === "controls-command");
    assert.equal(controls.required, true);
    const updated = normalizeRunManifest({
        ...manifest,
        topics: manifest.topics.map((topic) => (
            topic.contractId === "controls-command" ? { ...topic, required: false } : topic
        )),
    });
    assert.equal(updated.topics.find((topic) => topic.contractId === "controls-command").required, false);
});

test("manifest authority validation rejects conflicting authority on the same contract", () => {
    const manifest = createDefaultRunManifest({ version: 12 });
    manifest.topics.push(topicFromContract("controls-command", { id: "controls-alt", authority: "reference" }));
    const issues = validateManifestTopicAuthority(manifest);
    assert.ok(issues.some((issue) => /Conflicting authority/i.test(issue.message)));
});

test("topic contract router writes producer and active namespaces for controls-command", () => {
    const store = new SignalStore({}, { sourceId: "router-test" });
    const manifest = createNativeRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.contractId === "controls-command");
    const payload = command();
    const routed = router.routeInbound({
        name: topic.name,
        valueContract: topic.valueContract,
        value: payload,
        metadata: { captureTimeNs: 0 },
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 10_000_000 });
    assert.equal(routed.ok, true);
    assert.ok(store.read("active.topics.controls-command").value);
    assert.ok(store.read("candidate.topics.controls-command").value);
});

test("observational candidate returns skip active namespace by default", () => {
    const store = new SignalStore({}, { sourceId: "observe-test" });
    const manifest = createNativeRunManifest();
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const topic = manifest.topics.find((entry) => entry.contractId === "localization-estimate");
    assert.equal(topic.routeDownstream, false);
    const routed = router.routeInbound({
        name: topic.name,
        valueContract: topic.valueContract,
        value: buildNativeOdometry(),
    }, { applyStep: 1, applyTimeNs: 16_666_667, arrivalTimeNs: 16_666_667 });
    assert.equal(routed.ok, true);
    assert.ok(store.read("candidate.topics.localization-estimate")?.value);
    assert.equal(store.read("active.topics.localization-estimate")?.exists, false);
    assert.equal(store.read("diagnostics.topics.localization-estimate")?.value?.status, "ok");
});

test("default manifest includes live perception return contracts and controls-command", () => {
    const topics = defaultManifestTopics();
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        const topic = topics.find((entry) => entry.contractId === id);
        assert.ok(topic, id);
        assert.equal(topic.routeDownstream, false);
        assert.equal(topic.implementation, "live");
    }
    const controls = topics.find((entry) => entry.contractId === "controls-command");
    assert.ok(controls);
    assert.equal(controls.name, "/controls/command");
    assert.equal(controls.routeDownstream, true);
    assert.equal(controls.implementation, "live");
    assert.equal(controls.required, true);
});

test("v7 manifests without candidate returns gain them on normalize", () => {
    const source = createDefaultRunManifest({ version: 12 });
    source.version = 7;
    delete source.protobuf;
    source.topics = source.topics.filter((entry) => !DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS.includes(entry.contractId));
    const migrated = normalizeRunManifest(source);
    assert.equal(migrated.version, 12);
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        const topic = migrated.topics.find((entry) => entry.contractId === id);
        assert.ok(topic, id);
        assert.equal(topic.routeDownstream, false);
    }
});

test("v8+ manifests can omit candidate return topics", () => {
    const source = createDefaultRunManifest({ version: 12 });
    source.topics = source.topics.filter((entry) => !DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS.includes(entry.contractId));
    const kept = normalizeRunManifest({ ...source, version: 8, protobuf: undefined });
    for (const id of DEFAULT_CANDIDATE_RETURN_CONTRACT_IDS) {
        assert.ok(!kept.topics.some((entry) => entry.contractId === id), id);
    }
    assert.equal(kept.version, 12);
    assert.ok(kept.controls);
    assert.equal(kept.controls.stalePolicy, "stop");
});

test("topic input queue rejects undeclared topics and preserves arrival ordering", () => {
    const manifest = createDefaultRunManifest({ version: 12 });
    const queue = new TopicInputQueue(manifest.topics);
    const rejected = queue.enqueue({ name: "/unknown", value: 1 }, 1);
    assert.equal(rejected.rejected, true);
    const controls = manifest.topics.find((topic) => topic.contractId === "controls-command");
    queue.enqueue({ name: controls.name, value: { speed: 1 } }, 2, { arrivalTimeNs: 20 });
    queue.enqueue({ name: controls.name, value: { speed: 2 } }, 2, { arrivalTimeNs: 10 });
    const drained = queue.drain(2, 33_333_334);
    assert.equal(drained.length, 2);
    assert.equal(drained[0].info.value.speed, 2);
});

test("v2 manifests normalize to v12 with controls-command migration", () => {
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
    assert.equal(legacy.version, 12);
    assert.equal(legacy.topics[0].contractId, "controls-command");
    assert.equal(legacy.topics[0].name, "/controls/command");
    assert.equal(validateRunManifest(legacy).ok, true);
    for (const topic of legacy.topics) {
        assert.equal(validateTopicAgainstCatalog(topic).length, 0);
    }
    assert.ok(!legacy.topics.some((topic) => topic.name === "/ackdrive"));
});

test("inbound validity windows are enforced separately from transport timeout", () => {
    const store = new SignalStore({}, { sourceId: "validity-test" });
    const manifest = createNativeRunManifest();
    const stamped = topicFromNativeContract("controls-command", {
        id: "controls-validity",
        name: "/controls/command-validity",
        validityNs: 1_000,
        timeoutNs: 10_000_000,
    });
    manifest.topics.push(stamped);
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const payload = command();

    const invalid = router.routeInbound({
        name: stamped.name,
        valueContract: stamped.valueContract,
        value: payload,
        metadata: { captureTimeNs: 0 },
    }, { applyStep: 2, applyTimeNs: 5_000_000, arrivalTimeNs: 4_999_000 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "invalid");
});

test("stale inbound controls without fallback are rejected", () => {
    const store = new SignalStore({}, { sourceId: "stale-test" });
    const manifest = createNativeRunManifest();
    const primary = topicFromNativeContract("controls-command", {
        id: "controls-stale",
        name: "/controls/command-stale",
        timeoutNs: 1_000,
        fallback: null,
    });
    // Replace default controls topic to avoid duplicate name.
    manifest.topics = manifest.topics.filter((topic) => topic.contractId !== "controls-command").concat(primary);
    const router = new TopicContractRouter(manifest, { telemetry: store });
    const stale = router.routeInbound({
        name: primary.name,
        valueContract: primary.valueContract,
        value: command(),
    }, { applyStep: 3, applyTimeNs: 5_000_000, arrivalTimeNs: 1_000_000 });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "stale");
});

test("requiresControlLease is true only for an input control-command version 2 topic", () => {
    const command = topicFromNativeContract("controls-command");
    const leased = { ...command, valueContract: { ...command.valueContract, version: 2 } };
    assert.equal(requiresControlLease({ topics: [leased] }), true);
    assert.equal(requiresControlLease({ topics: [command] }), false);
    assert.equal(requiresControlLease({ topics: [{ ...leased, direction: "output" }] }), false);
    assert.equal(requiresControlLease(null), false);
});
