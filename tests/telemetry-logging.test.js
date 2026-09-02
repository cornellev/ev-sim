import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
    ByteReader,
    ByteWriter,
    RECORD_TAGS,
    SFLogBatchEncoder,
    decodeRecordStream,
    decodeSignalValue,
    encodeSignalValue,
} from "../app/logging/SFLogCodec.js";
import {
    DEFAULT_REPLAY_PROFILE,
    DEFAULT_TELEMETRY_PROFILE,
    SIMULATION_RUN_SENSOR_PROFILE,
    globMatches,
    resolveProfileRule,
    shouldSkipHeavyAlias,
} from "../app/logging/LogProfiles.js";
import { RecordingController } from "../app/logging/RecordingController.js";
import { LogDataset, flattenNumericFields } from "../app/logging/LogDataset.js";
import { SignalStore, summarizeBindingValue } from "../app/scripting/runtime/SignalStore.js";
import { AssertionEngine } from "../app/simulation/AssertionEngine.js";
import { TimelineStore } from "../app/logging/TimelineStore.js";
import { TelemetryTabBridge } from "../app/telemetry/TelemetryRuntime.js";
import { LogService } from "../server/logging/LogService.js";
import { validateDeviceTelemetryId } from "../app/3d/data/DeviceTelemetryId.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";

test("SFLog batch encoder tracks payload size and splits before the transport ceiling", () => {
    const encoder = new SFLogBatchEncoder();
    const huge = new Uint8Array(3 * 1024 * 1024);
    encoder.addUpdate({
        path: "devices.camera.image",
        timeUs: 1_000,
        cycle: 1,
        entry: { type: "bytes", value: huge },
        descriptor: { path: "devices.camera.image", type: "bytes", replayRole: "sample", logClass: "heavy" },
    });
    encoder.addUpdate({
        path: "devices.camera.image",
        timeUs: 2_000,
        cycle: 2,
        entry: { type: "bytes", value: huge },
        descriptor: { path: "devices.camera.image", type: "bytes", replayRole: "sample", logClass: "heavy" },
    });
    encoder.addUpdate({
        path: "devices.camera.image",
        timeUs: 3_000,
        cycle: 3,
        entry: { type: "bytes", value: huge },
        descriptor: { path: "devices.camera.image", type: "bytes", replayRole: "sample", logClass: "heavy" },
    });
    assert.ok(encoder.byteEstimate > 8 * 1024 * 1024);
    const first = encoder.flushUpTo(7.5 * 1024 * 1024);
    assert.ok(first.bytes.byteLength <= 8 * 1024 * 1024);
    assert.ok(encoder.pendingRecordCount > 0);
    const second = encoder.flushUpTo(7.5 * 1024 * 1024);
    assert.ok(second.bytes.byteLength <= 8 * 1024 * 1024);
    while (encoder.pendingRecordCount > 0) {
        const next = encoder.flushUpTo(7.5 * 1024 * 1024);
        assert.ok(next.bytes.byteLength <= 8 * 1024 * 1024);
    }
});

test("SFLog varints, zigzag values, primitives, vectors, arrays, and JSON round-trip", () => {
    const writer = new ByteWriter();
    for (const value of [0, 1, 127, 128, 16384, Number.MAX_SAFE_INTEGER]) writer.varuint(value);
    for (const value of [0, -1, 1, -123456, 123456]) writer.zigzag(value);
    const reader = new ByteReader(writer.finish());
    for (const value of [0, 1, 127, 128, 16384, Number.MAX_SAFE_INTEGER]) assert.equal(reader.varuint(), value);
    for (const value of [0, -1, 1, -123456, 123456]) assert.equal(reader.zigzag(), value);

    const cases = [
        ["boolean", true],
        ["int32", -42],
        ["uint64", 9007199254740991],
        ["float32", 1.25],
        ["float64", Math.PI],
        ["string", "fusion telemetry"],
        ["bytes", new Uint8Array([1, 2, 255])],
        ["vec3", { x: 1, y: -2, z: 3.5 }],
        ["pose3", { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0.1, y: 0.2, z: 0.3 } }],
        ["float64[]", [1, 2.5, -3]],
        ["int32[]", [-1, 0, 8]],
        ["boolean[]", [true, false, true]],
        ["json", { nested: { value: 4 }, values: [1, 2] }],
    ];
    for (const [type, value] of cases) {
        const decoded = decodeSignalValue(type, encodeSignalValue(type, value));
        if (type === "float32") assert.ok(Math.abs(decoded - value) < 1e-6);
        else if (type === "bytes") assert.deepEqual([...decoded], [...value]);
        else if (type === "pose3") assert.deepEqual(decoded.position, value.position);
        else assert.deepEqual(decoded, value);
    }
});

test("SFLog record streams preserve schemas, cycles, events, checkpoints, attachments, and type changes", () => {
    const encoder = new SFLogBatchEncoder();
    const add = (pathName, type, value, timeUs, cycle) => encoder.addUpdate({
        path: pathName,
        timeUs,
        cycle,
        entry: { type, value, timeUs, cycle },
        descriptor: { path: pathName, type, unit: type === "float64" ? "m/s" : null, source: "test", replayRole: "state", logClass: "core" },
    });
    add("vehicle.speed", "float64", 2.5, 1000, 1);
    add("vehicle.enabled", "boolean", true, 1000, 1);
    add("vehicle.speed", "string", "unknown", 2000, 2);
    encoder.addEvent({ timeUs: 1500, category: "simulation", name: "pause", severity: "info", payload: { reason: "test" } });
    encoder.addCheckpoint({ "vehicle.speed": { type: "string", value: "unknown" } }, [{ path: "vehicle.speed", type: "string", replayRole: "state", logClass: "core" }], 2000);
    encoder.addAttachment({ name: "manifest.json", mime: "application/json", bytes: "{}", timeUs: 0 });

    const batch = encoder.flush();
    const decoded = decodeRecordStream(batch.bytes);
    assert.equal(decoded.schemas.size, 3);
    assert.deepEqual(decoded.updates.map((item) => item.value), [2.5, true, "unknown"]);
    assert.deepEqual(decoded.events[0].payload, { reason: "test" });
    assert.equal(decoded.checkpoints[0].values["vehicle.speed"], "unknown");
    assert.equal(new TextDecoder().decode(decoded.attachments[0].bytes), "{}");
});

test("recording profiles use last-match precedence and lock replay-critical signals", () => {
    assert.equal(globMatches("devices.**", "devices.lidar.points"), true);
    assert.equal(globMatches("vehicles.*.pose", "vehicles.ego.pose"), true);
    assert.equal(globMatches("vehicles.*.pose", "vehicles.group.ego.pose"), false);

    const optionalDevice = { path: "devices.lidar.output", replayRole: "derived", logClass: "heavy" };
    assert.equal(resolveProfileRule(DEFAULT_REPLAY_PROFILE, optionalDevice).enabled, false);
    const requiredInput = { path: "devices.lidar.command", replayRole: "input", logClass: "heavy" };
    assert.deepEqual(resolveProfileRule(DEFAULT_REPLAY_PROFILE, requiredInput), {
        enabled: true,
        sampling: "every-update",
        rateHz: null,
        locked: true,
    });
    assert.equal(resolveProfileRule(DEFAULT_TELEMETRY_PROFILE, requiredInput).enabled, false);
});

test("device telemetry IDs are path-safe and unique", () => {
    assert.deepEqual(validateDeviceTelemetryId(" front_lidar-2 ", ["rear-lidar"]), {
        ok: true,
        id: "front_lidar-2",
        error: null,
    });
    assert.equal(validateDeviceTelemetryId("front.lidar", []).ok, false);
    assert.match(validateDeviceTelemetryId("front lidar", []).error, /letters, numbers/i);
    assert.match(validateDeviceTelemetryId("front-lidar", ["front-lidar"]).error, /already in use/i);
});

test("SignalStore publishes typed updates, schema changes, events, and bounded timestamped history", () => {
    const store = new SignalStore({}, { historyDurationSeconds: 1, historySampleLimit: 3, sourceId: "test-source" });
    const messages = [];
    store.subscribeSignals({ includeEvents: true, includeCatalog: true }, (message) => messages.push(message));
    store.publishSignal("imu.accel", 1, { type: "float64", timeUs: 0, cycle: 1, replayRole: "state" });
    store.publishSignal("imu.accel", 2, { type: "float64", timeUs: 500000, cycle: 2 });
    store.publishSignal("imu.accel", 3, { type: "float64", timeUs: 1500000, cycle: 3 });
    store.publishSignal("imu.accel", "invalid", { type: "string", timeUs: 1600000, cycle: 4 });

    assert.deepEqual(store.history("imu.accel").map((sample) => sample.value), [3, "invalid"]);
    assert.ok(messages.some((message) => message.kind === "event" && message.event.name === "signal-type-changed"));
    const last = messages.filter((message) => message.kind === "update").at(-1);
    assert.equal(last.previous.value, 3);
    assert.equal(last.descriptor.type, "string");
    assert.equal(last.cycle, 4);
    assert.equal(store.removeSignal("imu.accel"), true);
    assert.equal(store.descriptor("imu.accel"), null);
    assert.equal(Object.hasOwn(store.snapshot(), "imu.accel"), false);
    assert.ok(messages.some((message) => message.kind === "catalog" && message.action === "removed" && message.path === "imu.accel"));
});

test("SignalStore notify does not invoke listeners added during the same pass", () => {
    const store = new SignalStore({}, { sourceId: "notify-snapshot" });
    let count = 0;
    store.subscribeSignals({ paths: ["imu.accel"], includeEvents: false, includeCatalog: false }, () => {
        count += 1;
        store.subscribeSignals({ paths: ["imu.accel"], includeEvents: false, includeCatalog: false }, () => {
            count += 1;
        });
    });
    store.publishSignal("imu.accel", 1, { type: "float64", timeUs: 0 });
    assert.equal(count, 1);
});

test("SignalStore retains only the latest heavy sample", () => {
    const store = new SignalStore({}, { sourceId: "heavy-source" });
    store.defineSignal({ path: "sensors.camera.frame", type: "bytes", logClass: "heavy" });
    store.publishSignal("sensors.camera.frame", new Uint8Array([1]), { timeUs: 1 });
    store.publishSignal("sensors.camera.frame", new Uint8Array([2]), { timeUs: 2 });
    store.publishSignal("sensors.camera.frame", new Uint8Array([3]), { timeUs: 3 });
    assert.equal(store.descriptor("sensors.camera.frame").retention, "latest");
    assert.equal(store.history("sensors.camera.frame").length, 1);
    assert.deepEqual([...store.history("sensors.camera.frame")[0].value], [3]);
    // Latest retention synthesizes history from `_committed` — no ring allocation.
    assert.equal(store._history.has("sensors.camera.frame"), false);
    const latest = new Uint8Array([5]);
    store.publishSignal("sensors.camera.frame", latest, { timeUs: 5 });
    assert.equal(store.read("sensors.camera.frame").value, latest);
    assert.equal(store.snapshot()["sensors.camera.frame"].value, latest);
    assert.ok(store.revision("sensors.camera.frame") >= 4);
});

test("SignalStore skips heavy updates for default subscribers and promotes logClass", () => {
    const store = new SignalStore({}, { sourceId: "heavy-filter" });
    const defaultMsgs = [];
    const pathMsgs = [];
    const includeMsgs = [];
    store.subscribeSignals({ includeEvents: false, includeCatalog: false }, (message) => defaultMsgs.push(message));
    store.subscribeSignals({ paths: ["topics./sensors/points"], includeEvents: false, includeCatalog: false }, (message) => pathMsgs.push(message));
    store.subscribeSignals({ includeHeavy: true, includeEvents: false, includeCatalog: false }, (message) => includeMsgs.push(message));

    store.publishSignal("topics./sensors/points", {
        header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "lidar" },
        height: 1,
        width: 1,
        fields: [{ name: "x", offset: 0, datatype: 7, count: 1 }],
        is_bigendian: false,
        point_step: 4,
        row_step: 4,
        data: new Uint8Array(4),
        is_dense: true,
    }, { type: "json", logClass: "standard", timeUs: 1 });

    assert.equal(store.descriptor("topics./sensors/points").logClass, "heavy");
    assert.equal(defaultMsgs.length, 0);
    assert.equal(pathMsgs.length, 1);
    assert.equal(includeMsgs.length, 1);
    assert.equal(store._history.has("topics./sensors/points"), false);
    assert.equal(store.history("topics./sensors/points").length, 1);
});

test("SignalStore can skip history rings for latest-only publishes", () => {
    const store = new SignalStore({}, { sourceId: "no-history" });
    store.publishSignal("devices.lidar.captureAttempts", 1, { type: "uint64", history: false, timeUs: 1 });
    store.publishSignal("devices.lidar.captureAttempts", 2, { type: "uint64", history: false, timeUs: 2 });
    assert.equal(store.read("devices.lidar.captureAttempts").value, 2);
    assert.equal(store.history("devices.lidar.captureAttempts").length, 0);
    assert.equal(store._history.has("devices.lidar.captureAttempts"), false);
});

test("optional recording backpressure drops telemetry without pausing the simulation", () => {
    const oversizedBatch = { bytes: new Uint8Array((16 * 1024 * 1024) + 1) };
    const flushWithPolicy = (haltSimulationOnError) => {
        let pauses = 0;
        const controller = new RecordingController({});
        controller.session = { id: "overflow-test" };
        controller.encoder = {
            pendingRecordCount: 1,
            flushUpTo: () => {
                controller.encoder.pendingRecordCount = 0;
                return oversizedBatch;
            },
        };
        controller.status = "recording";
        controller.haltSimulationOnError = haltSimulationOnError;
        controller.attachSimulation({ pause: () => { pauses += 1; } });
        controller._flush();
        return { controller, pauses };
    };

    const optional = flushWithPolicy(false);
    assert.equal(optional.pauses, 0);
    assert.equal(optional.controller.status, "recording");
    assert.equal(optional.controller.droppedSamples, 1);

    const required = flushWithPolicy(true);
    assert.equal(required.pauses, 1);
    assert.equal(required.controller.status, "error");
});

test("dropped optional batches re-emit schemas before later updates", () => {
    const encoder = new SFLogBatchEncoder();
    for (let id = 1; id <= 46; id += 1) {
        encoder.addUpdate({
            path: `signal.${id}`,
            timeUs: 0,
            entry: { type: "float64", value: id },
            descriptor: { path: `signal.${id}`, type: "float64" },
        });
    }
    const initial = decodeRecordStream(encoder.flush().bytes);
    const controller = new RecordingController({});
    controller.encoder = encoder;
    controller.session = { id: "schema-recovery" };
    controller.status = "recording";
    controller.haltSimulationOnError = false;
    controller.queuedBytes = 16 * 1024 * 1024;

    encoder.addUpdate({
        path: "dynamic.signal",
        timeUs: 1,
        entry: { type: "float64", value: 1 },
        descriptor: { path: "dynamic.signal", type: "float64" },
    });
    controller._flush();
    assert.equal(controller.droppedSamples, 1);
    assert.ok(encoder.pendingRecordCount >= 47);

    let recoveredBatch = null;
    controller.queuedBytes = 0;
    controller._enqueueBatch = (batch) => {
        recoveredBatch = batch;
        return true;
    };
    encoder.addUpdate({
        path: "dynamic.signal",
        timeUs: 2,
        entry: { type: "float64", value: 2 },
        descriptor: { path: "dynamic.signal", type: "float64" },
    });
    controller._flush();

    const recovered = decodeRecordStream(recoveredBatch.bytes, initial.schemas);
    assert.equal(recovered.schemas.get(47).path, "dynamic.signal");
    assert.deepEqual(recovered.updates.map((update) => [update.path, update.value]), [["dynamic.signal", 2]]);
});

test("SignalStore uses simulation time as its source clock while paused", () => {
    const store = new SignalStore({}, { sourceId: "simulation-clock-source", sessionStartedAtMs: -1_000_000 });
    assert.equal(store.getSimulationTimeUs(), null);
    store.publishSignal("simulation.time", 4, { type: "float64", timeUs: 4_000_000 });
    store.publishSignal("simulation.timeNs", 4_000_000_000, { type: "uint64", timeUs: 4_000_000 });
    store.publishSignal("simulation.status", "paused", { type: "string", timeUs: 4_000_000 });

    assert.equal(store.getTimeUs(), 4_000_000);
    assert.equal(store.emitTelemetryEvent({ name: "paused-check" }).timeUs, 4_000_000);
});

test("nested numeric extraction and dataset interpolation do not duplicate parent payloads", () => {
    assert.deepEqual(flattenNumericFields({ accel: { x: 1, y: 2 }, label: "imu" }), [
        { field: "accel.x", value: 1 },
        { field: "accel.y", value: 2 },
    ]);
    assert.deepEqual(flattenNumericFields({
        detections3d: [{
            box3d: { center: { x: 1, y: 2, z: 3 }, size: { x: 4, y: 5, z: 6 } },
            status: "ok",
        }],
        lanes: [{ points: [{ x: 0, y: 0, z: 0 }] }],
    }), []);
    assert.deepEqual(flattenNumericFields({
        estimate: { position: { x: 1, y: 2, z: 3 }, covarianceEllipse: { sigmaX: 0.5, sigmaY: 0.6 } },
    }), [
        { field: "estimate.position.x", value: 1 },
        { field: "estimate.position.y", value: 2 },
        { field: "estimate.position.z", value: 3 },
        { field: "estimate.covarianceEllipse.sigmaX", value: 0.5 },
        { field: "estimate.covarianceEllipse.sigmaY", value: 0.6 },
    ]);
    const schemas = new Map([[1, { id: 1, path: "vehicles.ego.pose", type: "pose3" }]]);
    const dataset = new LogDataset("log", { metadata: {}, durationUs: 1000 }, {
        schemas,
        updates: [
            { path: "vehicles.ego.pose", timeUs: 0, cycle: 0, value: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } } },
            { path: "vehicles.ego.pose", timeUs: 1000, cycle: 1, value: { position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0 } } },
        ],
        events: [],
        checkpoints: [],
        attachments: [],
    });
    assert.equal(dataset.valueAt("vehicles.ego.pose", 500, { interpolate: true }).position.x, 5);
    assert.equal(dataset.snapshotAt(500)["vehicles.ego.pose"].position.x, 0);
    assert.deepEqual([...dataset.paths()], ["vehicles.ego.pose"]);
    const posePath = [...dataset.paths()].find((path) => path.startsWith("vehicles.") && path.endsWith(".pose"));
    assert.equal(posePath, "vehicles.ego.pose");
});

test("LogDataset exposes calibration artifacts and resolved manifest metadata", () => {
    const encoder = new SFLogBatchEncoder();
    const calibration = { kind: "cev-sim.calibration-bundle", version: 1, hash: "deadbeef".repeat(8) };
    encoder.addAttachment({ name: "run-manifest.json", mime: "application/json", bytes: JSON.stringify({ resolvedHash: "abc", manifest: { id: "golden", name: "Golden Run" }, calibration }) });
    encoder.addAttachment({ name: "calibration.json", mime: "application/json", bytes: JSON.stringify(calibration) });
    encoder.addAttachment({ name: "run-results.json", mime: "application/json", bytes: JSON.stringify({ passed: true, assertions: [{ id: "clear" }] }) });
    const decoded = decodeRecordStream(encoder.flush().bytes);
    const dataset = new LogDataset("run-log", { metadata: { resolvedHash: "abc" }, durationUs: 0 }, decoded);
    assert.equal(dataset.runManifest.id, "golden");
    assert.equal(dataset.calibration.hash, calibration.hash);
    assert.equal(dataset.runResults.passed, true);
    assert.equal(dataset.runResults.assertions[0].id, "clear");
});

test("LogDataset exposes the recorded resolved manifest and assertion report", () => {
    const encoder = new SFLogBatchEncoder();
    encoder.addAttachment({ name: "run-manifest.json", mime: "application/json", bytes: JSON.stringify({ resolvedHash: "abc", manifest: { id: "golden", name: "Golden Run" } }) });
    encoder.addAttachment({ name: "run-results.json", mime: "application/json", bytes: JSON.stringify({ passed: true, assertions: [{ id: "clear" }] }) });
    const decoded = decodeRecordStream(encoder.flush().bytes);
    const dataset = new LogDataset("run-log", { metadata: { resolvedHash: "abc" }, durationUs: 0 }, decoded);
    assert.equal(dataset.runManifest.id, "golden");
    assert.equal(dataset.runResults.passed, true);
    assert.equal(dataset.runResults.assertions[0].id, "clear");
});

test("TimelineStore clamps seeks and preserves shared playback state", () => {
    const timeline = new TimelineStore();
    timeline.setDuration(1000);
    timeline.seek(2000);
    assert.equal(timeline.getSnapshot().timeUs, 1000);
    assert.equal(timeline.getSnapshot().liveLocked, false);
    timeline.set({ speed: 4, playing: true, selection: { startUs: 100, endUs: 900 } });
    assert.deepEqual(timeline.getSnapshot().selection, { startUs: 100, endUs: 900 });
});

test("TimelineStore throttles ui subscribers during playback but keeps seek urgent", () => {
    const timeline = new TimelineStore();
    timeline.setDuration(10_000_000);
    timeline.set({ playing: true, timeUs: 0 });
    let uiUpdates = 0;
    const unsubscribe = timeline.subscribe(() => { uiUpdates += 1; }, { uiIntervalMs: 1000 });
    assert.equal(uiUpdates, 1);
    timeline.set({ timeUs: 1000 });
    timeline.set({ timeUs: 2000 });
    timeline.set({ timeUs: 3000 });
    assert.equal(uiUpdates, 1);
    timeline.seek(4_000_000);
    assert.equal(uiUpdates, 2);
    unsubscribe();
});

test("LogDataset valueAt clone false returns stored samples without copying", () => {
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
    const dataset = new LogDataset("log", { metadata: {}, durationUs: 1000 }, {
        schemas: new Map([[1, { id: 1, path: "vehicles.ego.pose", type: "pose3" }]]),
        updates: [{ path: "vehicles.ego.pose", timeUs: 0, cycle: 0, value: pose }],
        events: [],
        checkpoints: [],
        attachments: [],
    });
    const direct = dataset.valueAt("vehicles.ego.pose", 0, { clone: false });
    assert.equal(direct, pose);
    direct.position.x = 99;
    assert.equal(dataset.series.get("vehicles.ego.pose")[0].value.position.x, 99);
});

test("LogDataset capture-time lookback uses binary search after backward seeks", () => {
    const dataset = new LogDataset("test", { metadata: {}, durationUs: 4_000_000 }, {
        schemas: new Map([
            [1, { id: 1, path: "visualization.perception.candidate", type: "json" }],
        ]),
        updates: [
            { path: "visualization.perception.candidate", timeUs: 1_000_000, cycle: 1, value: { captureTimeNs: 1_000_000_000, detections3d: [{ id: "a" }], detections2d: [], lanes: [] } },
            { path: "visualization.perception.candidate", timeUs: 2_000_000, cycle: 2, value: { captureTimeNs: 2_000_000_000, detections3d: [{ id: "b" }], detections2d: [], lanes: [] } },
            { path: "visualization.perception.candidate", timeUs: 3_000_000, cycle: 3, value: { captureTimeNs: 3_000_000_000, detections3d: [{ id: "c" }], detections2d: [], lanes: [] } },
        ],
        events: [],
        checkpoints: [],
        attachments: [],
    });
    const forward = dataset.valueAtCaptureTime("visualization.perception.candidate", 2_500_000_000);
    assert.equal(forward.matched, true);
    assert.equal(forward.value.detections3d[0].id, "b");
    const backward = dataset.valueAtCaptureTime("visualization.perception.candidate", 1_500_000_000);
    assert.equal(backward.matched, true);
    assert.equal(backward.value.detections3d[0].id, "a");
    const noClone = dataset.valueAtCaptureTime("visualization.perception.candidate", 2_500_000_000, { clone: false });
    assert.equal(noClone.value.detections3d[0].id, "b");
    assert.equal(noClone.value, dataset.series.get("visualization.perception.candidate")[1].value);
});

test("TelemetryTabBridge discovers sources, filters full-rate subscriptions, mirrors previews, and expires stale tabs", () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    class FakeBroadcastChannel {
        static rooms = new Map();
        constructor(name) {
            this.name = name;
            this.listeners = new Set();
            const room = FakeBroadcastChannel.rooms.get(name) || new Set();
            room.add(this);
            FakeBroadcastChannel.rooms.set(name, room);
        }
        addEventListener(type, listener) { if (type === "message") this.listeners.add(listener); }
        postMessage(data) {
            for (const channel of FakeBroadcastChannel.rooms.get(this.name) || []) {
                if (channel === this) continue;
                for (const listener of channel.listeners) listener({ data: structuredClone(data) });
            }
        }
        close() { FakeBroadcastChannel.rooms.get(this.name)?.delete(this); }
    }
    globalThis.BroadcastChannel = FakeBroadcastChannel;

    const sourceA = new SignalStore({}, { sourceId: "source-a" });
    const sourceB = new SignalStore({}, { sourceId: "source-b" });
    sourceA.publishSignal("simulation.time", 1, { type: "float64", timeUs: 100, replayRole: "state", logClass: "core" });
    const bridgeA = new TelemetryTabBridge(sourceA, { channelName: "test-telemetry" }).start();
    const bridgeB = new TelemetryTabBridge(sourceB, { channelName: "test-telemetry" }).start();
    try {
        assert.ok(bridgeA.getSources().some((source) => source.sourceId === "source-b"));
        assert.ok(bridgeB.getSources().some((source) => source.sourceId === "source-a"));
        assert.equal(bridgeA.getSources().find((source) => source.sourceId === "source-b").timeUs, 0);
        assert.equal(bridgeB.getSources().find((source) => source.sourceId === "source-a").timeUs, 1_000_000);
        sourceA.publishSignal("simulation.time", 2, { type: "float64", timeUs: 200 });
        const updatedSource = bridgeB.getSources().find((source) => source.sourceId === "source-a");
        assert.equal(updatedSource.snapshot["simulation.time"].value, 2);
        assert.equal(updatedSource.timeUs, 2_000_000);

        bridgeB.requestSource("source-a", ["simulation.time"]);
        assert.equal(bridgeA.remoteSubscriptions.get("simulation.time"), 1);
        assert.deepEqual(bridgeB.getSeries("source-a", "simulation.time").map((sample) => sample.value), [1, 2]);
        sourceA.publishSignal("simulation.time", 3, { type: "float64", timeUs: 300 });
        assert.equal(bridgeB.getSources().find((source) => source.sourceId === "source-a").snapshot["simulation.time"].value, 3);
        assert.equal(bridgeB.getSeries("source-a", "simulation.time").at(-1).value, 3);
        bridgeB.requestSource("source-a", []);
        assert.equal(bridgeA.remoteSubscriptions.has("simulation.time"), false);

        sourceA.removeSignal("simulation.time");
        const mirrored = bridgeB.getSources().find((source) => source.sourceId === "source-a");
        assert.equal(mirrored.descriptors.some((descriptor) => descriptor.path === "simulation.time"), false);
        assert.equal(Object.hasOwn(mirrored.snapshot, "simulation.time"), false);

        bridgeB.remoteSources.get("source-a").lastSeenAt = 0;
        bridgeB._expireSources();
        assert.equal(bridgeB.getSources().some((source) => source.sourceId === "source-a"), false);
    } finally {
        bridgeA.stop();
        bridgeB.stop();
        globalThis.BroadcastChannel = originalBroadcastChannel;
    }
});

test("LogService finalizes indexed chunks, retries batches idempotently, imports, and rejects invalid files", async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-sflog-test-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const service = new LogService(directory);
    const session = await service.createSession({ id: "session-safe", name: "Test Log", environmentId: "igvc", runId: "run-1", manifestId: "golden", manifestRevision: 3, definitionHash: "def", resolvedHash: "resolved", provenance: { gpu: "test" } });
    assert.equal(session.metadata.runId, "run-1");
    assert.equal(session.metadata.resolvedHash, "resolved");
    const encoder = new SFLogBatchEncoder();
    encoder.addUpdate({ path: "simulation.time", timeUs: 2_000_000, cycle: 120, entry: { type: "float64", value: 2 }, descriptor: { path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" } });
    encoder.addCheckpoint({ "simulation.time": { type: "float64", value: 2 } }, [{ path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" }], 2_000_000);
    const batch = encoder.flush();
    const first = await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 2_000_000, bytes: batch.bytes });
    const duplicate = await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 2_000_000, bytes: batch.bytes });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    encoder.addUpdate({ path: "simulation.time", timeUs: 3_000_000, cycle: 180, entry: { type: "float64", value: 3 }, descriptor: { path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" } });
    encoder.addUpdate({
        path: "devices.camera.image",
        timeUs: 3_000_000,
        cycle: 180,
        entry: { type: "bytes", value: new Uint8Array([1, 2, 3]) },
        descriptor: { path: "devices.camera.image", type: "bytes", replayRole: "sample", logClass: "heavy" },
    });
    encoder.addCheckpoint(
        { "simulation.time": { type: "float64", value: 3 } },
        [{ path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" }],
        3_000_000,
    );
    const secondBatch = encoder.flush();
    await service.appendBatch(session.id, { sequence: 1, startUs: 0, endUs: 3_000_000, bytes: secondBatch.bytes });
    const metadata = await service.finalize(session.id);
    assert.equal(metadata.status, "complete");
    const index = await service.getIndex(session.id);
    assert.equal(index.chunks.length, 2);
    assert.equal(index.checkpoints[0].timeUs, 2_000_000);
    assert.equal(index.schemas[0].path, "simulation.time");
    const decoded = decodeRecordStream(await service.readChunks(session.id), new Map(index.schemas.map((schema) => [schema.id, schema])));
    assert.equal(decoded.updates[0].value, 2);
    assert.equal(decoded.updates[1].value, 3);
    const exactChunk = decodeRecordStream(await service.readChunk(session.id, 1), new Map(index.schemas.map((schema) => [schema.id, schema])));
    assert.deepEqual(exactChunk.updates.map((update) => [update.path, update.value]), [
        ["simulation.time", 3],
        ["devices.camera.image", new Uint8Array([1, 2, 3])],
    ]);
    const iterated = [];
    for await (const chunk of service.iterateChunks(session.id, { fromUs: 2_500_000 })) iterated.push(chunk.index);
    assert.deepEqual(iterated, [0, 1]);
    const series = await service.readSeries(session.id, { path: "simulation.time", maxPoints: 10 });
    assert.deepEqual(series.samples.map((sample) => sample.value), [2, 3]);
    const snapshot = await service.readSnapshot(session.id, 3_000_000);
    assert.equal(snapshot.snapshot["simulation.time"], 3);
    assert.deepEqual(snapshot.snapshot["devices.camera.image"], new Uint8Array([1, 2, 3]));
    const lightSnapshot = await service.readSnapshot(session.id, 3_000_000, { includeHeavy: false });
    assert.equal(Object.hasOwn(lightSnapshot.snapshot, "devices.camera.image"), false);

    const file = await readFile(service.getFilePath(session.id));
    const imported = await service.importLog(file, { name: "Imported Copy" });
    assert.equal(imported.name, "Imported Copy");
    assert.equal((await service.listLogs()).length, 2);
    await assert.rejects(service.importLog(new Uint8Array([1, 2, 3])), /SFLog|end/i);
    await assert.rejects(service.getMetadata("../escape"), /Invalid log id/);
});

test("LogService validates a batch before accepting its sequence number", async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-sflog-validation-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const service = new LogService(directory);
    const session = await service.createSession({ id: "schema-validation" });
    const invalid = new ByteWriter();
    invalid.uint8(RECORD_TAGS.CYCLE);
    invalid.varuint(1);
    invalid.varuint(0);
    invalid.varuint(1);
    invalid.varuint(47);
    invalid.sizedBytes(encodeSignalValue("float64", 1));
    const input = { sequence: 0, startUs: 0, endUs: 0, bytes: invalid.finish() };

    await assert.rejects(service.appendBatch(session.id, input), /unknown schema 47/);
    await assert.rejects(service.appendBatch(session.id, input), /unknown schema 47/);
    assert.equal(service.active.get(session.id).lastSequence, -1);
    assert.equal(service.active.get(session.id).pending.length, 0);

    const encoder = new SFLogBatchEncoder();
    encoder.addUpdate({
        path: "simulation.time",
        timeUs: 0,
        entry: { type: "float64", value: 0 },
        descriptor: { path: "simulation.time", type: "float64" },
    });
    const valid = encoder.flush();
    const appended = await service.appendBatch(session.id, { sequence: 0, ...valid });
    assert.equal(appended.duplicate, false);
    assert.equal((await service.finalize(session.id)).status, "complete");
});

test("LogService recovers valid chunks from interrupted partial recordings", async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-sflog-recovery-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const writer = new LogService(directory);
    const session = await writer.createSession({ id: "interrupted", name: "Interrupted" });
    const encoder = new SFLogBatchEncoder();
    encoder.addUpdate({ path: "simulation.step", timeUs: 2_000_000, cycle: 1, entry: { type: "uint64", value: 1 }, descriptor: { path: "simulation.step", type: "uint64", replayRole: "state", logClass: "core" } });
    const batch = encoder.flush();
    await writer.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 2_000_000, bytes: batch.bytes });

    const restarted = new LogService(directory);
    const catalog = await restarted.listLogs();
    assert.equal(catalog[0].id, "interrupted");
    assert.equal(catalog[0].status, "incomplete");
    assert.equal((await restarted.getIndex("interrupted")).chunks.length, 1);
});

test("route status records stay constant-depth with flat lastGood scalars", () => {
    const store = new SignalStore({}, { sourceId: "route-status" });
    const manifest = createDefaultRunManifest();
    const topic = manifest.topics.find((entry) => entry.direction === "input") || manifest.topics[0];
    const router = new TopicContractRouter(manifest, { telemetry: store });
    for (let index = 0; index < 40; index += 1) {
        router._publishStatus(topic, {
            code: index % 5 === 0 ? "stale" : "ok",
            status: index % 5 === 0 ? "stale" : "ok",
            captureTimeNs: index * 1e6,
            arrivalTimeNs: index * 1e6,
            applyTimeNs: index * 1e6 + 1000,
            applyStep: index,
            sequence: index,
            routeDownstream: false,
            lastGoodSequence: index,
        });
    }
    const status = router.lastStatus.get(topic.contractId || topic.id);
    assert.equal(typeof status.lastGoodSequence === "number" || status.lastGoodSequence === null, true);
    assert.equal(Object.prototype.hasOwnProperty.call(status, "lastGood"), false);
    let depth = 0;
    let cursor = status;
    while (cursor && typeof cursor === "object" && depth < 8) {
        if (cursor.lastGood) depth += 1;
        cursor = cursor.lastGood;
    }
    assert.equal(depth, 0);
    assert.equal(store.descriptor(`diagnostics.topics.${topic.contractId || topic.id}`)?.retention || "none", "none");
});

test("full-sensor profile skips heavy aliases when canonical device path is enabled", () => {
    assert.equal(shouldSkipHeavyAlias(SIMULATION_RUN_SENSOR_PROFILE, {
        path: "oracle.topics.front-camera-depth",
        type: "json",
        logClass: "heavy",
        metadata: { canonicalSignalPath: "devices.front-camera.depth" },
    }, { isHeavy: true }), true);
    assert.equal(shouldSkipHeavyAlias(SIMULATION_RUN_SENSOR_PROFILE, {
        path: "devices.front-camera.depth",
        type: "bytes",
        logClass: "heavy",
    }, { isHeavy: true }), false);
    assert.equal(shouldSkipHeavyAlias(DEFAULT_REPLAY_PROFILE, {
        path: "oracle.topics.front-camera-depth",
        type: "json",
        logClass: "heavy",
        metadata: { canonicalSignalPath: "devices.front-camera.depth" },
    }, { isHeavy: true }), false);
});

test("binding value summaries never retain Image buffers", () => {
    const image = {
        width: 2,
        height: 2,
        encoding: "rgba8",
        data: new Uint8Array(16),
    };
    const summary = summarizeBindingValue({ frame: image, ok: true });
    assert.equal(summary.ok, true);
    assert.equal(summary.frame.type, "image");
    assert.equal(summary.frame.byteLength, 16);
    assert.equal(summary.frame.data, undefined);
});

test("TelemetryTabBridge keeps remote heavy series latest-only and prunes on unsubscribe", async () => {
    const originalBroadcastChannel = globalThis.BroadcastChannel;
    class FakeBroadcastChannel {
        static rooms = new Map();
        constructor(name) {
            this.name = name;
            this.listeners = new Set();
            const room = FakeBroadcastChannel.rooms.get(name) || new Set();
            room.add(this);
            FakeBroadcastChannel.rooms.set(name, room);
        }
        addEventListener(type, listener) { if (type === "message") this.listeners.add(listener); }
        postMessage(data) {
            for (const channel of FakeBroadcastChannel.rooms.get(this.name) || []) {
                if (channel === this) continue;
                for (const listener of channel.listeners) listener({ data });
            }
        }
        close() { FakeBroadcastChannel.rooms.get(this.name)?.delete(this); }
    }
    globalThis.BroadcastChannel = FakeBroadcastChannel;

    const sourceA = new SignalStore({}, { sourceId: "heavy-a" });
    const sourceB = new SignalStore({}, { sourceId: "heavy-b" });
    sourceA.defineSignal({ path: "devices.cam.image", type: "bytes", logClass: "heavy" });
    const bridgeA = new TelemetryTabBridge(sourceA, { channelName: "heavy-telemetry" }).start();
    const bridgeB = new TelemetryTabBridge(sourceB, { channelName: "heavy-telemetry" }).start();
    try {
        bridgeB.requestSource("heavy-a", ["devices.cam.image"]);
        for (let index = 0; index < 12; index += 1) {
            sourceA.publishSignal("devices.cam.image", new Uint8Array([index]), {
                type: "bytes",
                logClass: "heavy",
                timeUs: index + 1,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        const series = bridgeB.getSeries("heavy-a", "devices.cam.image");
        assert.ok(series.length <= 1);
        bridgeB.requestSource("heavy-a", []);
        assert.equal(bridgeA.remoteSubscriptions.has("devices.cam.image"), false);
        assert.equal(bridgeA.remoteSeries.get("heavy-b")?.has("devices.cam.image") || false, false);
    } finally {
        bridgeA.stop();
        bridgeB.stop();
        globalThis.BroadcastChannel = originalBroadcastChannel;
    }
});

test("SFLogCodec does not expand typed arrays into JSON number lists", () => {
    const encoder = new SFLogBatchEncoder();
    const huge = new Uint8Array(64 * 1024);
    huge.fill(7);
    encoder.addUpdate({
        path: "topics./sensors/image",
        timeUs: 1,
        cycle: 1,
        entry: {
            type: "json",
            value: {
                width: 128,
                height: 128,
                encoding: "rgba8",
                data: huge,
            },
        },
        descriptor: { path: "topics./sensors/image", type: "json", logClass: "heavy" },
    });
    assert.ok(encoder.byteEstimate < huge.byteLength);
    const batch = encoder.flush();
    assert.ok(batch.bytes.byteLength < huge.byteLength);
});

test("LogService reads attachments, pose series, and autonomy snapshots from indexed logs", async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-sflog-spatial-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const service = new LogService(directory);
    const session = await service.createSession({ id: "spatial-queries" });
    const encoder = new SFLogBatchEncoder();
    encoder.addAttachment({
        name: "environment.json",
        mime: "application/json",
        bytes: JSON.stringify({ roads: { nodes: [{ id: "n1", x: 0, z: 0 }, { id: "n2", x: 20, z: 0 }], edges: [] }, buildings: [], features: [] }),
    });
    encoder.addAttachment({
        name: "run-manifest.json",
        mime: "application/json",
        bytes: JSON.stringify({ resolvedHash: "abc123", manifest: { id: "run-a" } }),
    });
    for (let index = 0; index < 120; index += 1) {
        encoder.addUpdate({
            path: "vehicles.ego.pose",
            timeUs: index * 100_000,
            cycle: index,
            entry: {
                type: "pose3",
                value: {
                    position: { x: index, y: 0, z: Math.sin(index / 8) },
                    rotation: { x: 0, y: index / 40, z: 0, order: "XYZ" },
                },
            },
            descriptor: { path: "vehicles.ego.pose", type: "pose3", replayRole: "state", logClass: "core" },
        });
        encoder.addUpdate({
            path: "visualization.perception.candidate",
            timeUs: index * 100_000,
            cycle: index,
            entry: {
                type: "json",
                value: {
                    captureTimeNs: index * 100_000_000,
                    detections3d: [{ center: { x: index, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, yaw: 0 }],
                    lanes: [],
                },
            },
            descriptor: { path: "visualization.perception.candidate", type: "json", replayRole: "sample", logClass: "core" },
        });
    }
    const batch = encoder.flush();
    await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 11_900_000, bytes: batch.bytes });
    await service.finalize(session.id);

    const attachments = await service.readAttachments(session.id, { names: ["environment.json", "run-manifest.json"] });
    assert.equal(attachments.attachments.length, 2);
    const environmentAttachment = attachments.attachments.find((entry) => entry.name === "environment.json");
    assert.ok(environmentAttachment);
    assert.equal(JSON.parse(Buffer.from(environmentAttachment.bytes, "base64").toString()).roads.nodes.length, 2);

    const poseSeries = await service.readPoseSeries(session.id, { path: "vehicles.ego.pose", maxPoints: 30 });
    assert.equal(poseSeries.path, "vehicles.ego.pose");
    assert.ok(poseSeries.samples.length <= 30);
    assert.equal(poseSeries.samples[0].timeUs, 0);
    assert.equal(poseSeries.samples.at(-1).timeUs, 11_900_000);

    const autonomy = await service.readAutonomySnapshot(session.id, 5_000_000);
    assert.equal(autonomy.timeUs, 5_000_000);
    assert.equal(autonomy.snapshot.perception.detections3d.length, 1);

    const missingPose = await service.readPoseSeries(session.id, { path: "vehicles.missing.pose", maxPoints: 10 });
    assert.equal(missingPose.path, "vehicles.missing.pose");
    assert.deepEqual(missingPose.samples, []);

    const missingSeries = await service.readSeries(session.id, { path: "vehicles.missing.pose", maxPoints: 10 });
    assert.equal(missingSeries.path, "vehicles.missing.pose");
    assert.deepEqual(missingSeries.samples, []);
});

test("SignalStore events() returns defensive copies", () => {
    const store = new SignalStore({}, { sourceId: "events-clone" });
    store.emitTelemetryEvent({ name: "evt", category: "test", payload: { x: 1 } });
    const events = store.events();
    events[0].payload.x = 99;
    assert.equal(store.events()[0].payload.x, 1);
});

test("SignalStore eventsFromIndex cursor survives ring trim", () => {
    const store = new SignalStore({}, { eventLimit: 3, sourceId: "events-ring" });
    store.emitTelemetryEvent({ name: "e0", category: "c", payload: {} });
    store.emitTelemetryEvent({ name: "e1", category: "c", payload: {} });
    store.emitTelemetryEvent({ name: "e2", category: "c", payload: {} });
    const baseline = store.eventsFromIndex(0);
    assert.equal(baseline.events.length, 3);
    assert.equal(baseline.nextIndex, 3);

    store.emitTelemetryEvent({ name: "e3", category: "c", payload: {} });
    const tail = store.eventsFromIndex(3);
    assert.equal(tail.events.length, 1);
    assert.equal(tail.events[0].name, "e3");

    const resumed = store.eventsFromIndex(2);
    assert.deepEqual(resumed.events.map((event) => event.name), ["e2", "e3"]);
    assert.equal(resumed.nextIndex, 4);
});

test("SignalStore publishSignal skips cloning primitive return values", () => {
    const store = new SignalStore({}, { sourceId: "primitive-return" });
    const returned = store.publishSignal("simulation.step", 7, {
        type: "int32",
        history: false,
        retention: "none",
    });
    assert.equal(returned, null);
    assert.equal(store.read("simulation.step").value, 7);
});

test("SignalStore notify clones object updates once for all subscribers", () => {
    const store = new SignalStore({}, { sourceId: "notify-once" });
    const seen = [];
    store.subscribeSignals({ includeEvents: false, includeCatalog: false }, (message) => {
        seen.push(message);
    });
    store.subscribeSignals({ includeEvents: false, includeCatalog: false }, (message) => {
        seen.push(message);
    });
    store.publishSignal("vehicles.ego.speed", { x: 1 }, { type: "json", history: false, retention: "none" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].entry, seen[1].entry);
    seen[0].entry.value.x = 99;
    assert.equal(store.read("vehicles.ego.speed").value.x, 1);
});

test("AssertionEngine collects telemetry events via eventsFromIndex cursor", () => {
    const store = new SignalStore({}, { eventLimit: 100, sourceId: "assert-events" });
    store.emitTelemetryEvent({ category: "controls", name: "input-applied", payload: { step: 1 } });
    const engine = new AssertionEngine([{
        id: "evt-count",
        name: "input",
        source: "event",
        category: "controls",
        event: "input-applied",
        mode: "eventually",
        window: { startStep: 0, endStep: null },
        expected: { min: 1, max: 1 },
        severity: "error",
        onFailure: "stop",
    }], store);
    const result = engine.evaluate(1);
    assert.equal(result.results[0].status, "passed");
});
