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
    globMatches,
    resolveProfileRule,
} from "../app/logging/LogProfiles.js";
import { RecordingController } from "../app/logging/RecordingController.js";
import { LogDataset, flattenNumericFields } from "../app/logging/LogDataset.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { TimelineStore } from "../app/logging/TimelineStore.js";
import { TelemetryTabBridge } from "../app/telemetry/TelemetryRuntime.js";
import { LogService } from "../server/logging/LogService.js";
import { validateDeviceTelemetryId } from "../app/3d/data/DeviceTelemetryId.js";

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

test("SignalStore retains only the latest heavy sample", () => {
    const store = new SignalStore({}, { sourceId: "heavy-source" });
    store.defineSignal({ path: "sensors.camera.frame", type: "bytes", logClass: "heavy" });
    store.publishSignal("sensors.camera.frame", new Uint8Array([1]), { timeUs: 1 });
    store.publishSignal("sensors.camera.frame", new Uint8Array([2]), { timeUs: 2 });
    store.publishSignal("sensors.camera.frame", new Uint8Array([3]), { timeUs: 3 });
    assert.equal(store.history("sensors.camera.frame").length, 1);
    assert.deepEqual([...store.history("sensors.camera.frame")[0].value], [3]);
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
