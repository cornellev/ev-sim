import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
    ByteReader,
    ByteWriter,
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
import { LogDataset, flattenNumericFields } from "../app/logging/LogDataset.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { TimelineStore } from "../app/logging/TimelineStore.js";
import { TelemetryTabBridge } from "../app/telemetry/TelemetryRuntime.js";
import { LogService } from "../server/logging/LogService.js";
import { validateDeviceTelemetryId } from "../app/3d/data/DeviceTelemetryId.js";

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
        sourceA.publishSignal("simulation.time", 2, { type: "float64", timeUs: 200 });
        assert.equal(bridgeB.getSources().find((source) => source.sourceId === "source-a").snapshot["simulation.time"].value, 2);

        bridgeB.requestSource("source-a", ["simulation.time"]);
        assert.equal(bridgeA.remoteSubscriptions.get("simulation.time"), 1);
        sourceA.publishSignal("simulation.time", 3, { type: "float64", timeUs: 300 });
        assert.equal(bridgeB.getSources().find((source) => source.sourceId === "source-a").snapshot["simulation.time"].value, 3);

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
    const session = await service.createSession({ id: "session-safe", name: "Test Log", environmentId: "igvc" });
    const encoder = new SFLogBatchEncoder();
    encoder.addUpdate({ path: "simulation.time", timeUs: 2_000_000, cycle: 120, entry: { type: "float64", value: 2 }, descriptor: { path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" } });
    encoder.addCheckpoint({ "simulation.time": { type: "float64", value: 2 } }, [{ path: "simulation.time", type: "float64", replayRole: "state", logClass: "core" }], 2_000_000);
    const batch = encoder.flush();
    const first = await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 2_000_000, bytes: batch.bytes });
    const duplicate = await service.appendBatch(session.id, { sequence: 0, startUs: 0, endUs: 2_000_000, bytes: batch.bytes });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    const metadata = await service.finalize(session.id);
    assert.equal(metadata.status, "complete");
    const index = await service.getIndex(session.id);
    assert.equal(index.chunks.length, 1);
    assert.equal(index.checkpoints[0].timeUs, 2_000_000);
    assert.equal(index.schemas[0].path, "simulation.time");
    const decoded = decodeRecordStream(await service.readChunks(session.id), new Map(index.schemas.map((schema) => [schema.id, schema])));
    assert.equal(decoded.updates[0].value, 2);

    const file = await readFile(service.getFilePath(session.id));
    const imported = await service.importLog(file, { name: "Imported Copy" });
    assert.equal(imported.name, "Imported Copy");
    assert.equal((await service.listLogs()).length, 2);
    await assert.rejects(service.importLog(new Uint8Array([1, 2, 3])), /SFLog|end/i);
    await assert.rejects(service.getMetadata("../escape"), /Invalid log id/);
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
