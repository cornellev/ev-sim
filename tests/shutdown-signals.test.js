import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { bindShutdownSignals, createShutdownHandler, unbindShutdownSignals } from "../server/headless/shutdownSignals.js";

test("shutdown signals stay installed and a second interrupt repeats the handler", () => {
    const emitter = new EventEmitter();
    const seen = [];
    const handler = bindShutdownSignals(emitter, () => seen.push("stop"));
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(emitter.listenerCount(name), 1);
    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    assert.deepEqual(seen, ["stop", "stop"]);
    unbindShutdownSignals(emitter, handler);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(emitter.listenerCount(name), 0);
    emitter.emit("SIGINT");
    assert.deepEqual(seen, ["stop", "stop"]);
});

test("shutdown binding rejects a missing handler", () => {
    assert.throws(() => bindShutdownSignals(new EventEmitter(), null), TypeError);
});

test("startup SIGINT shuts down, force-exits, and a second interrupt exits immediately", () => {
    const emitter = new EventEmitter();
    const abort = new AbortController();
    const calls = [];
    const timers = [];
    bindShutdownSignals(emitter, createShutdownHandler({
        abort,
        isStarting: () => true,
        shutdown: () => calls.push("shutdown"),
        exit: (code) => calls.push(code),
        schedule: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    }));
    emitter.emit("SIGINT", "SIGINT");
    assert.equal(abort.signal.aborted, true);
    assert.deepEqual(calls, ["shutdown"]);
    assert.equal(timers[0].ms, 1500);
    timers[0].fn();
    emitter.emit("SIGINT", "SIGINT");
    assert.deepEqual(calls, ["shutdown", 130, 130]);
    unbindShutdownSignals(emitter, emitter.listeners("SIGINT")[0]);
});

test("a ready SIGTERM shuts down without arming a force-exit", () => {
    const abort = new AbortController();
    const calls = [];
    const onSignal = createShutdownHandler({
        abort,
        isStarting: () => false,
        shutdown: () => calls.push("shutdown"),
        exit: (code) => calls.push(code),
        schedule: () => { throw new Error("SIGTERM must not force-exit."); },
    });
    onSignal("SIGTERM");
    assert.deepEqual(calls, ["shutdown"]);
});
