import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ensureOrchestrator } = require("../server/ensureOrchestrator.js");

function fakeChild(pid) {
    return { pid, exitCode: null, signalCode: null, on() {}, unref() {} };
}

async function run(overrides = {}) {
    const warnings = [];
    const logs = [];
    const signals = [];
    const spawns = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (...args) => warnings.push(args.join(" "));
    console.log = (...args) => logs.push(args.join(" "));
    const exitsBefore = process.listenerCount("exit");
    try {
        const handle = ensureOrchestrator({
            lookup: async () => true,
            listening: async () => false,
            spawnOrch: (...args) => {
                spawns.push(args);
                return fakeChild(4242);
            },
            kill: (pid, signal) => signals.push([pid, signal]),
            wait: async () => {},
            ...overrides,
        });
        await handle.stop();
        await handle.stop();
        return { warnings, logs, signals, spawns, exitsBefore };
    } finally {
        console.warn = originalWarn;
        console.log = originalLog;
    }
}

test("missing orch warns and does not spawn or signal", async () => {
    let probed = false;
    const result = await run({
        lookup: async () => false,
        listening: async () => {
            probed = true;
            return false;
        },
        spawnOrch: () => {
            throw new Error("spawned");
        },
    });
    assert.equal(probed, false);
    assert.deepEqual(result.spawns, []);
    assert.deepEqual(result.signals, []);
    assert.deepEqual(result.warnings, ["[WARNING] Orchestrator doesn't exist."]);
    assert.equal(process.listenerCount("exit"), result.exitsBefore);
});

test("open orchestrator port does not spawn or signal", async () => {
    const result = await run({ listening: async () => true });
    assert.deepEqual(result.spawns, []);
    assert.deepEqual(result.signals, []);
    assert.deepEqual(result.logs, []);
    assert.equal(process.listenerCount("exit"), result.exitsBefore);
});

test("closed port spawns detached orch and stop signals only that process group", async () => {
    const child = fakeChild(4242);
    const signals = [];
    let args = null;
    const result = await run({
        spawnOrch: (...spawnArgs) => {
            args = spawnArgs;
            return child;
        },
        kill: (pid, signal) => {
            signals.push([pid, signal]);
            if (signal === "SIGTERM") child.exitCode = 0;
        },
    });
    assert.deepEqual(args, ["orch", [], { detached: true, stdio: "inherit" }]);
    assert.deepEqual(signals, [[-4242, "SIGTERM"]]);
    assert.deepEqual(result.logs, ["Started orchestrator (orch)."]);
    assert.equal(process.listenerCount("exit"), result.exitsBefore);
});

test("stop sends SIGKILL when the spawned orch is still alive", async () => {
    const child = fakeChild(5150);
    const signals = [];
    const result = await run({
        spawnOrch: () => child,
        kill: (pid, signal) => signals.push([pid, signal]),
    });
    assert.deepEqual(signals, [[-5150, "SIGTERM"], [-5150, "SIGKILL"]]);
    assert.equal(process.listenerCount("exit"), result.exitsBefore);
});

test("stop during startup still kills the orch this process spawned", async () => {
    const child = fakeChild(7);
    let releaseLookup;
    const signals = [];
    const originalLog = console.log;
    console.log = () => {};
    const exitsBefore = process.listenerCount("exit");
    try {
        const handle = ensureOrchestrator({
            lookup: () => new Promise((resolve) => {
                releaseLookup = resolve;
            }),
            listening: async () => false,
            spawnOrch: () => child,
            kill: (pid, signal) => {
                signals.push([pid, signal]);
                if (signal === "SIGTERM") child.exitCode = 0;
            },
            wait: async () => {},
        });
        const stopped = handle.stop();
        releaseLookup(true);
        await stopped;
        assert.deepEqual(signals, [[-7, "SIGTERM"]]);
        assert.equal(process.listenerCount("exit"), exitsBefore);
    } finally {
        console.log = originalLog;
    }
});
