import assert from "node:assert/strict";
import test from "node:test";

import {
    BINDING_SCOPES,
    BINDING_MANIFEST_KIND,
    BINDING_MANIFEST_VERSION,
    TRIGGER_KINDS,
    createBinding,
    createBindingFolder,
    createBindingManifest,
    normalizeBinding,
    normalizeBindingManifest,
    suggestTriggerFromArtifact,
    summarizeTrigger,
    validateBinding,
} from "../app/scripting/bindings/BindingDocument.js";
import {
    parseBindingManifest,
    serializeBindingManifest,
} from "../app/scripting/bindings/BindingStorage.js";
import { BindingRuntime } from "../app/scripting/bindings/BindingRuntime.js";
import {
    KNOWN_SIGNAL_PATHS,
    SIGNAL_PATHS,
    listSignalPaths,
    topicSignalPath,
} from "../app/scripting/runtime/SignalPaths.js";

function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

function createScriptStub(execute) {
    return {
        runResult(inputs) {
            try {
                return { status: "success", outputs: execute(inputs) };
            } catch (e) {
                return { status: "failure", e };
            }
        }
    };
}

function createRuntime({ scripts = {}, clientManager = null } = {}) {
    const runtime = new BindingRuntime({
        autoLoad: false,
        loadScript: async (scriptId) => {
            const script = scripts[scriptId];
            if (!script) throw new Error(`Local visual script "${scriptId}" was not found.`);
            return script;
        }
    });

    if (clientManager) {
        runtime.attachClient(clientManager);
    }

    return runtime;
}

function createClientManagerStub() {
    const callbacks = [];
    const published = [];

    return {
        published,
        emit(info) {
            callbacks.forEach((callback) => callback(info));
        },
        onUpdate(callback) {
            callbacks.push(callback);
        },
        hasClient() {
            return true;
        },
        get() {
            return {
                publish(topic, typeStr, value) {
                    published.push({ topic, typeStr, value });
                }
            };
        }
    };
}

// ---------------------------------------------------------------- document

test("createBindingManifest produces a normalized versioned document", () => {
    const manifest = createBindingManifest();

    assert.equal(manifest.kind, BINDING_MANIFEST_KIND);
    assert.equal(manifest.version, BINDING_MANIFEST_VERSION);
    assert.equal(manifest.enabled, true);
    assert.deepEqual(manifest.folders, []);
    assert.deepEqual(manifest.bindings, []);
});

test("binding manifest v2 organizes folders and migrates v1 bindings as global", () => {
    const folder = createBindingFolder({ id: "controls", name: "Controls" });
    const current = normalizeBindingManifest({
        kind: BINDING_MANIFEST_KIND,
        version: 2,
        folders: [folder, { ...folder, name: "Duplicate" }],
        bindings: [
            { id: "drive", folderId: "controls", scope: "selected" },
            { id: "orphan", folderId: "missing", scope: "selected" },
        ],
    });
    assert.deepEqual(current.folders, [folder]);
    assert.equal(current.bindings[0].folderId, "controls");
    assert.equal(current.bindings[1].folderId, null);

    const migrated = normalizeBindingManifest({
        kind: BINDING_MANIFEST_KIND,
        version: 1,
        bindings: [{ id: "legacy", folderId: "ignored", scope: "selected" }],
    });
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.folders, []);
    assert.equal(migrated.bindings[0].folderId, null);
    assert.equal(migrated.bindings[0].scope, BINDING_SCOPES.GLOBAL);

    const legacyWithoutScope = normalizeBindingManifest({
        kind: BINDING_MANIFEST_KIND,
        version: 1,
        bindings: [{ id: "legacy-default" }],
    });
    assert.equal(legacyWithoutScope.bindings[0].scope, BINDING_SCOPES.GLOBAL);
    assert.equal(createBinding().scope, BINDING_SCOPES.SELECTED);
});

test("normalizeBindingManifest rejects unknown kinds and repairs bindings", () => {
    assert.throws(() => normalizeBindingManifest({ kind: "other-kind", version: 9 }));

    const manifest = normalizeBindingManifest({
        bindings: [
            { name: "  Drive  ", trigger: { kind: "timer", intervalMs: "-5" }, inputs: [{ input: " x ", source: "constant", value: 3 }] },
            { trigger: { kind: "nonsense" } }
        ]
    });

    assert.equal(manifest.bindings.length, 2);
    assert.equal(manifest.bindings[0].name, "Drive");
    assert.equal(manifest.bindings[0].trigger.intervalMs, 100);
    assert.deepEqual(manifest.bindings[0].inputs, [{ input: "x", source: "constant", value: 3 }]);
    assert.equal(manifest.bindings[1].trigger.kind, TRIGGER_KINDS.TOPIC);
    assert.ok(manifest.bindings[1].id);
});

test("normalizeBinding clamps trigger fields per kind", () => {
    const fixed = normalizeBinding({ trigger: { kind: "fixed-update", everyN: "0" } });
    assert.equal(fixed.trigger.everyN, 1);

    const topic = normalizeBinding({ trigger: { kind: "topic", topic: "  /controls/command " } });
    assert.equal(topic.trigger.topic, "/controls/command");

    const signal = normalizeBinding({ trigger: { kind: "signal-update", path: " vehicle.ego " } });
    assert.equal(signal.trigger.path, "vehicle.ego");
});

test("validateBinding reports missing script, trigger fields, and mapping issues", () => {
    const binding = normalizeBinding({
        trigger: { kind: "topic", topic: "" },
        inputs: [
            { input: "a", source: "signal", path: "" },
        ],
        outputs: [
            { output: "b", sink: "publish", topic: "", type: "" }
        ]
    });

    const issues = validateBinding(binding);
    assert.ok(issues.some((issue) => issue.includes("No script selected")));
    assert.ok(issues.some((issue) => issue.includes("topic name")));
    assert.ok(issues.some((issue) => issue.includes("\"a\" needs a signal path")));
    assert.ok(issues.some((issue) => issue.includes("\"b\" needs a topic")));
});

test("validateBinding flags message inputs on non-topic triggers", () => {
    const binding = normalizeBinding({
        scriptId: "s1",
        trigger: { kind: "fixed-update" },
        inputs: [{ input: "msg", source: "message" }]
    });

    const issues = validateBinding(binding);
    assert.ok(issues.some((issue) => issue.includes("not a topic")));
});

test("summarizeTrigger renders human-readable summaries", () => {
    assert.equal(summarizeTrigger({ kind: "topic", topic: "/controls/command" }), "on /controls/command");
    assert.equal(summarizeTrigger({ kind: "fixed-update", everyN: 1 }), "every tick");
    assert.equal(summarizeTrigger({ kind: "fixed-update", everyN: 4 }), "every 4 ticks");
    assert.equal(summarizeTrigger({ kind: "signal-update", path: "a.b" }), "when a.b changes");
    assert.equal(summarizeTrigger({ kind: "timer", intervalMs: 250 }), "every 250 ms");
    assert.equal(summarizeTrigger({ kind: "simulation-timer", intervalNs: 250_000_000 }), "every 250000000 ns of simulation time");
});

test("suggestTriggerFromArtifact maps entrypoints and trigger bindings", () => {
    assert.deepEqual(
        suggestTriggerFromArtifact({ entrypoints: [{ kind: "tick", clockPath: "simulation.frame" }] }),
        { kind: TRIGGER_KINDS.FIXED_UPDATE, everyN: 1 }
    );

    assert.deepEqual(
        suggestTriggerFromArtifact({ entrypoints: [{ kind: "signal-update", path: "topics./controls/command" }] }),
        { kind: TRIGGER_KINDS.TOPIC, topic: "/controls/command" }
    );

    assert.deepEqual(
        suggestTriggerFromArtifact({ entrypoints: [{ kind: "timer", intervalMs: 250 }] }),
        { kind: TRIGGER_KINDS.TIMER, intervalMs: 250 }
    );

    assert.deepEqual(
        suggestTriggerFromArtifact({ entrypoints: [], bindings: [{ kind: "trigger", path: "vehicle.ego" }] }),
        { kind: TRIGGER_KINDS.SIGNAL_UPDATE, path: "vehicle.ego" }
    );

    assert.equal(suggestTriggerFromArtifact({ entrypoints: [], bindings: [] }), null);
});

test("manifest serialize/parse round-trips", () => {
    const manifest = createBindingManifest({
        bindings: [createBinding({ name: "Round trip", trigger: { kind: "timer", intervalMs: 42 } })]
    });

    const parsed = parseBindingManifest(serializeBindingManifest(manifest));
    assert.equal(parsed.bindings.length, 1);
    assert.equal(parsed.bindings[0].name, "Round trip");
    assert.equal(parsed.bindings[0].trigger.intervalMs, 42);
});

test("signal paths have one normalized, deduplicated suggestion source", () => {
    const paths = listSignalPaths(
        [" custom.path ", SIGNAL_PATHS.SIMULATION],
        ["custom.path", ""]
    );

    assert.ok(KNOWN_SIGNAL_PATHS.includes(SIGNAL_PATHS.VEHICLE_EGO_POSE));
    assert.equal(paths.filter((path) => path === "custom.path").length, 1);
    assert.equal(topicSignalPath(" /controls/command "), SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC);
});

// ----------------------------------------------------------------- runtime

test("topic updates populate the signal store and dispatch matching bindings", async () => {
    const runs = [];
    const clientManager = createClientManagerStub();
    const runtime = createRuntime({
        clientManager,
        scripts: {
            "script-1": createScriptStub((inputs) => {
                runs.push(inputs);
                return { doubled: inputs.speed * 2 };
            })
        }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            name: "Drive handler",
            scriptId: "script-1",
            trigger: { kind: "topic", topic: "/controls/command" },
            inputs: [{ input: "speed", source: "message", field: "speed" }],
            outputs: [{ output: "doubled", sink: "signal", path: "debug.doubled" }]
        }]
    }, { persist: false });
    await flush();

    clientManager.emit({ name: "/controls/command", typeStr: "pkg/AckermannDrive", value: { speed: 4, steering_angle: 1 } });

    assert.deepEqual(runs, [{ speed: 4 }]);
    assert.deepEqual(runtime.signalStore.read("topics./controls/command").value, { speed: 4, steering_angle: 1 });
    assert.equal(runtime.signalStore.read("debug.doubled").value, 8);

    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.telemetry.b1.lastStatus, "success");
    assert.equal(snapshot.telemetry.b1.runCount, 1);
    assert.deepEqual(snapshot.topics, ["/controls/command"]);
    assert.ok(snapshot.signalPaths.includes(SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC));
    assert.ok(snapshot.signalPaths.includes("debug.doubled"));
});

test("topic updates do not dispatch bindings for other topics", async () => {
    const runs = [];
    const clientManager = createClientManagerStub();
    const runtime = createRuntime({
        clientManager,
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return {}; }) }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "topic", topic: "/controls/command" }
        }]
    }, { persist: false });
    await flush();

    clientManager.emit({ name: "/other", value: 1 });
    assert.equal(runs.length, 0);

    clientManager.emit({ name: "/controls/command", value: 1 });
    assert.equal(runs.length, 1);
});

test("fixed-update bindings honor everyN and receive sim inputs", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: {
            "script-1": createScriptStub((inputs) => {
                runs.push(inputs);
                return {};
            })
        }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "fixed-update", everyN: 3 },
            inputs: [
                { input: "dt", source: "sim", key: "dt" },
                { input: "step", source: "sim", key: "step" }
            ]
        }]
    }, { persist: false });
    await flush();

    for (let i = 0; i < 7; i++) {
        runtime.update(0.016);
    }

    assert.equal(runs.length, 2);
    assert.ok(Math.abs(runs[0].dt - 0.048) < 1e-9);
    assert.equal(runs[0].step, 2);
    assert.equal(runs[1].step, 5);
    assert.equal(runtime.signalStore.read("simulation").value.step, 6);
});

test("simulation-time bindings fire deterministically from integer nanoseconds", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return {}; }) },
    });
    await runtime.ready();
    await runtime.setManifest({
        bindings: [{
            id: "sim-timer",
            scriptId: "script-1",
            trigger: { kind: "simulation-timer", intervalNs: 100_000_000 },
            inputs: [{ input: "time", source: "sim", key: "time" }],
        }],
    }, { persist: false });
    await flush();

    runtime.update(0.05, { timeNs: 50_000_000, step: 1 });
    runtime.update(0.05, { timeNs: 100_000_000, step: 2 });
    runtime.update(0.20, { timeNs: 300_000_000, step: 3 });

    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map((entry) => entry.time), [0.1, 0.2, 0.3]);
});

test("library activation runs only global bindings while manual execution can run selected bindings", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: {
            global: createScriptStub(() => { runs.push("global"); return {}; }),
            selected: createScriptStub(() => { runs.push("selected"); return {}; }),
        },
    });
    await runtime.ready();
    await runtime.setLibraryManifest({
        kind: BINDING_MANIFEST_KIND,
        version: 2,
        bindings: [
            { id: "global", scope: "global", scriptId: "global", trigger: { kind: "fixed-update" } },
            { id: "selected", scope: "selected", scriptId: "selected", trigger: { kind: "fixed-update" } },
        ],
    }, { persist: false });
    await flush();

    runtime.update(0.016);
    assert.deepEqual(runs, ["global"]);
    assert.deepEqual(runtime.getSnapshot().activeManifest.bindings.map((binding) => binding.id), ["global"]);

    const result = await runtime.runBindingNow("selected");
    assert.equal(result.status, "success");
    assert.deepEqual(runs, ["global", "selected"]);
});

test("signal-update bindings fire only when the watched value changes", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return {}; }) }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "signal-update", path: "vehicle.ego" },
            inputs: [{ input: "pose", source: "signal", path: "vehicle.ego" }]
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);
    assert.equal(runs.length, 0, "path does not exist yet");

    runtime.signalStore.set("vehicle.ego", { x: 1 });
    runtime.update(0.016);
    assert.equal(runs.length, 0, "first observation is the baseline");

    runtime.signalStore.set("vehicle.ego", { x: 2 });
    runtime.update(0.016);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].pose, { x: 2 });

    runtime.update(0.016);
    assert.equal(runs.length, 1, "no re-fire without a new write");
});

test("input resolution covers signal paths with fields and constants", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return {}; }) }
    });
    await runtime.ready();

    runtime.signalStore.set("topics./imu", { accel: { x: 9.81 } });

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "fixed-update", everyN: 1 },
            inputs: [
                { input: "ax", source: "signal", path: "topics./imu", field: "accel.x" },
                { input: "gain", source: "constant", value: 1.5 },
                { input: "missing", source: "signal", path: "does.not.exist" }
            ]
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].ax, 9.81);
    assert.equal(runs[0].gain, 1.5);
    assert.equal(runs[0].missing, null);
});

test("publish sinks route outputs through the client", async () => {
    const clientManager = createClientManagerStub();
    const runtime = createRuntime({
        clientManager,
        scripts: { "script-1": createScriptStub(() => ({ cmd: { speed: 2 } })) }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "fixed-update", everyN: 1 },
            outputs: [{ output: "cmd", sink: "publish", topic: "/cmd_out", type: "pkg/AckermannDrive" }]
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);

    assert.deepEqual(clientManager.published, [
        { topic: "/cmd_out", typeStr: "pkg/AckermannDrive", value: { speed: 2 } }
    ]);
});

test("script failures are isolated and recorded in telemetry", async () => {
    const runtime = createRuntime({
        scripts: {
            "script-1": createScriptStub(() => {
                throw new Error("boom");
            })
        }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "fixed-update", everyN: 1 }
        }]
    }, { persist: false });
    await flush();

    assert.doesNotThrow(() => runtime.update(0.016));

    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.telemetry.b1.lastStatus, "failure");
    assert.equal(snapshot.telemetry.b1.lastError, "boom");
});

test("invalid bindings are skipped with an invalid status", async () => {
    const runtime = createRuntime({ scripts: {} });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: null,
            trigger: { kind: "fixed-update", everyN: 1 }
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);

    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.telemetry.b1.lastStatus, "invalid");
});

test("missing scripts surface a load failure without breaking the loop", async () => {
    const runtime = createRuntime({ scripts: {} });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "ghost-script",
            trigger: { kind: "fixed-update", everyN: 1 }
        }]
    }, { persist: false });
    await flush();

    assert.doesNotThrow(() => runtime.update(0.016));
    await flush();

    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.telemetry.b1.lastStatus, "failure");
    assert.match(snapshot.telemetry.b1.lastError, /not found/);
});

test("disabled bindings and a disabled runtime never dispatch", async () => {
    const runs = [];
    const runtime = createRuntime({
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return {}; }) }
    });
    await runtime.ready();

    await runtime.setManifest({
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            enabled: false,
            trigger: { kind: "fixed-update", everyN: 1 }
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);
    assert.equal(runs.length, 0);

    await runtime.setManifest({
        enabled: false,
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            enabled: true,
            trigger: { kind: "fixed-update", everyN: 1 }
        }]
    }, { persist: false });
    await flush();

    runtime.update(0.016);
    assert.equal(runs.length, 0);
});

test("runBindingNow executes manually with the last topic message as context", async () => {
    const runs = [];
    const clientManager = createClientManagerStub();
    const runtime = createRuntime({
        clientManager,
        scripts: { "script-1": createScriptStub((inputs) => { runs.push(inputs); return { echoed: inputs.msg }; }) }
    });
    await runtime.ready();

    await runtime.setManifest({
        enabled: false,
        bindings: [{
            id: "b1",
            scriptId: "script-1",
            trigger: { kind: "topic", topic: "/controls/command" },
            inputs: [{ input: "msg", source: "message" }]
        }]
    }, { persist: false });
    await flush();

    runtime.signalStore.set("topics./controls/command", { speed: 7 });

    const result = await runtime.runBindingNow("b1");
    assert.equal(result.status, "success");
    assert.deepEqual(runs, [{ msg: { speed: 7 } }]);
    assert.deepEqual(result.outputs.echoed, { speed: 7 });
});
