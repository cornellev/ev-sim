import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { bindShutdownSignals, unbindShutdownSignals } from "../server/headless/shutdownSignals.js";

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
