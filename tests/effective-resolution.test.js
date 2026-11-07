import assert from "node:assert/strict";
import test from "node:test";

import { createEffectiveResolver, summaryRows } from "../app/config/effectiveResolution.js";
import { longitudinalSpeed } from "../app/config/simpleRunModel.js";

function clock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeout(fn, ms) {
            const id = nextId;
            nextId += 1;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        run(ms) {
            now += ms;
            const due = [...timers.entries()]
                .filter(([, timer]) => timer.at <= now)
                .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
            for (const [id] of due) timers.delete(id);
            for (const [, timer] of due) timer.fn();
        },
    };
}

function deferredResolve() {
    const calls = [];
    const pending = [];
    return {
        calls,
        pending,
        resolve(body) {
            calls.push(body.id);
            return new Promise((done) => pending.push(done));
        },
    };
}

async function settle() {
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

test("a slow resolve cannot restore an older draft", async () => {
    const time = clock();
    const remote = deferredResolve();
    const resolver = createEffectiveResolver({
        resolve: remote.resolve,
        delayMs: 400,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    resolver.submit({ lane: "draft", key: "a", body: { id: "a" } });
    resolver.submit({ lane: "draft", key: "b", body: { id: "b" } });
    time.run(400);
    await settle();
    assert.deepEqual(remote.calls, ["b"]);

    resolver.submit({ lane: "draft", key: "c", body: { id: "c" } });
    assert.equal(resolver.snapshot().draft.status, "checking");
    assert.equal(resolver.snapshot().draft.result, null);
    remote.pending[0]({ manifest: { id: "b" } });
    await settle();
    assert.equal(resolver.snapshot().draft.result, null);
    assert.deepEqual(remote.calls, ["b"]);

    time.run(400);
    await settle();
    assert.deepEqual(remote.calls, ["b", "c"]);
    remote.pending[1]({ manifest: { id: "c" } });
    await settle();
    assert.equal(resolver.snapshot().draft.status, "ready");
    assert.equal(resolver.snapshot().draft.result.manifest.id, "c");
    resolver.dispose();
});

test("suspending resolution ignores an in-flight response", async () => {
    const time = clock();
    const remote = deferredResolve();
    const resolver = createEffectiveResolver({
        resolve: remote.resolve,
        delayMs: 400,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });
    resolver.submit({ lane: "draft", key: "a", body: { id: "a" } });
    time.run(400);
    await settle();
    resolver.submit({ lane: "draft", key: "suspended", body: null, suspended: true });
    assert.equal(resolver.snapshot().draft.status, "unresolved");
    remote.pending[0]({ manifest: { id: "a" } });
    await settle();
    assert.equal(resolver.snapshot().draft.status, "unresolved");
    assert.equal(resolver.snapshot().draft.result, null);
    resolver.dispose();
});

test("a baseline resolve waits for the in-flight draft and does not repeat its key", async () => {
    const time = clock();
    const remote = deferredResolve();
    const resolver = createEffectiveResolver({
        resolve: remote.resolve,
        delayMs: 400,
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
    });

    resolver.submit({ lane: "draft", key: "draft", body: { id: "draft" } });
    time.run(400);
    await settle();
    resolver.submit({ lane: "baseline", key: "base-1", body: { id: "base" } });
    time.run(400);
    await settle();
    assert.deepEqual(remote.calls, ["draft"]);
    remote.pending[0]({ manifest: { id: "draft" } });
    await settle();
    assert.deepEqual(remote.calls, ["draft", "base"]);
    remote.pending[1]({ manifest: { id: "base" } });
    await settle();
    assert.equal(resolver.snapshot().baseline.status, "ready");

    resolver.submit({ lane: "baseline", key: "base-1", body: { id: "base-again" } });
    time.run(400);
    assert.deepEqual(remote.calls, ["draft", "base"]);
    assert.equal(resolver.snapshot().baseline.result.manifest.id, "base");
    resolver.dispose();
});

test("summary rows read resolved scenario state and sensor types", () => {
    const vehicle = {
        id: "ego",
        type: "scenario-car",
        pose: {
            position: { x: 4, y: 0, z: 1 },
            rotation: { x: 0, y: 0.5, z: 0, order: "XYZ" },
        },
        linearVelocity: { x: 1, y: 0, z: 0 },
    };
    const resolved = {
        scenario: { id: "lane" },
        environment: { id: "yard" },
        controls: { authority: "reference" },
        clock: { pacing: "realtime", speed: 1, stepNs: 1000000, maxSteps: null },
        logging: { policy: "optional" },
        initialState: { vehicles: [vehicle] },
        sensorRig: {
            sensors: [
                { id: "roof-lidar", type: "lidar3d" },
                { id: "mystery", type: "example.unknown" },
            ],
        },
    };
    const rows = Object.fromEntries(summaryRows(resolved, null).map((row) => [row.id, row]));
    assert.equal(rows.scenario.current, "lane");
    assert.equal(rows.scenario.baseline, null);
    assert.equal(rows.environment.current, "yard");
    assert.equal(rows.vehicle.current, "scenario-car");
    assert.equal(rows.authority.current, "reference");
    assert.equal(rows.pacing.current, "realtime");
    assert.equal(rows.speed.current, "1");
    assert.equal(rows.step.current, "1000000");
    assert.equal(rows.maxSteps.current, "Unlimited");
    assert.equal(rows.recording.current, "optional");
    assert.equal(rows.sensors.current, "1 example.unknown, 1 lidar3d");
    assert.equal(rows.position.current, "4, 0, 1");
    assert.equal(rows.heading.current, "0.5");
    assert.equal(rows.longitudinalSpeed.current, String(longitudinalSpeed(vehicle)));

    const empty = summaryRows({
        initialState: { vehicles: [] },
        clock: {},
        logging: {},
        controls: {},
        sensorRig: { sensors: [] },
    }, null);
    assert.equal(empty.find((row) => row.id === "scenario").current, "Manifest only");
    assert.equal(summaryRows(null, null).every((row) => row.current === null && row.baseline === null), true);
});
