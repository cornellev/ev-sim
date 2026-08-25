import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";

function controllerFor(policy, start) {
    const controller = new RunSessionController();
    const manifest = createDefaultRunManifest({ logging: { policy, profileId: "simulation-run-full-sensors" } });
    controller.snapshot.activeRunId = "run-test";
    controller.snapshot.activeResolved = {
        manifest,
        definitionHash: "definition",
        resolvedHash: "resolved",
        environment: { manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { entries: [] },
    };
    controller.data = {
        renderer: null,
        bindings: () => ({ manifest: null, _scripts: new Map() }),
        environment: () => ({ environmentId: "igvc" }),
        simulation: () => ({ getSnapshot: () => ({ status: "paused" }) }),
        client: () => ({ catalogHash: "catalog" }),
    };
    controller.recording = { start, attachSimulation() {} };
    return controller;
}

test("required logging rejects the run before the first step when storage cannot open", async () => {
    const controller = controllerFor("required", async () => { throw new Error("storage offline"); });
    await assert.rejects(controller._ensureRecording(), /storage offline/);
    assert.equal(controller._recordingRunId, null);
});

test("optional logging marks a run degraded while disabled logging does not open a session", async () => {
    let optionalAttempts = 0;
    const optional = controllerFor("optional", async () => { optionalAttempts += 1; throw new Error("storage offline"); });
    await optional._ensureRecording();
    assert.equal(optionalAttempts, 1);
    assert.equal(optional.snapshot.degraded, true);
    assert.equal(optional._recordingRunId, "run-test");

    let disabledAttempts = 0;
    const disabled = controllerFor("disabled", async () => { disabledAttempts += 1; });
    await disabled._ensureRecording();
    assert.equal(disabledAttempts, 0);
});

test("optional log finalization failures degrade rather than fail a completed run", async () => {
    const controller = controllerFor("optional", async () => {});
    controller._recordingRunId = "run-test";
    controller.recording = {
        session: { id: "log-pending" },
        addAttachment() {},
        async stop() { throw new Error("schema validation failed"); },
    };
    controller.data = {
        ...controller.data,
        simulation: () => ({
            steps: 10,
            timeNs: 1_000_000_000,
            assertionEngine: { finalize: () => ({ results: [] }) },
            stop() {},
        }),
    };

    const result = await controller.stop({ status: "completed" });
    assert.equal(result.completed, true);
    assert.equal(result.passed, true);
    assert.equal(result.logId, null);
    assert.equal(controller.snapshot.degraded, true);
    assert.match(controller.snapshot.error, /Optional log finalization failed/);
});

test("run recording options include immutable manifest attachment and provenance", async () => {
    let options;
    const controller = controllerFor("required", async (value) => { options = value; });
    await controller._ensureRecording();
    assert.equal(options.runId, "run-test");
    assert.equal(options.resolvedHash, "resolved");
    assert.equal(options.timeBase, "simulation");
    assert.equal(options.provenance.orchestratorCatalogHash, "catalog");
    assert.equal(options.haltSimulationOnError, true);
    assert.ok(options.attachments.some((attachment) => attachment.name === "run-manifest.json"));

    let optionalOptions;
    const optional = controllerFor("optional", async (value) => { optionalOptions = value; });
    await optional._ensureRecording();
    assert.equal(optionalOptions.haltSimulationOnError, false);
});

test("prepare waits for a switched environment to mount and apply the resolved run", async () => {
    const controller = new RunSessionController();
    const applied = [];
    const makeData = (environmentId) => {
        const simulation = {
            subscribe(listener) { listener({ status: "paused", assertions: [] }); return () => {}; },
            async applyRunManifest(value) { applied.push(value.resolvedHash); },
        };
        return {
            environment: () => ({ environmentId }),
            simulation: () => simulation,
        };
    };
    controller.attachData(makeData("yard"));
    let requestedEnvironment = null;
    controller.setEnvironmentHandler((environmentId) => { requestedEnvironment = environmentId; });
    const manifest = createDefaultRunManifest({ environment: { id: "igvc" }, logging: { policy: "disabled" } });
    const resolved = {
        manifest,
        resolvedHash: "resolved-environment-switch",
        environment: { manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { entries: [] },
    };
    let settled = false;
    const readiness = controller.prepare(resolved, { autoplay: false }).then((value) => {
        settled = true;
        return value;
    });

    await Promise.resolve();
    assert.equal(requestedEnvironment, "igvc");
    assert.equal(settled, false);
    assert.deepEqual(applied, []);

    controller.attachData(makeData("igvc"));
    const snapshot = await readiness;
    assert.equal(snapshot.status, "ready");
    assert.deepEqual(applied, ["resolved-environment-switch"]);
    assert.equal(controller.getSnapshot().activeResolved.resolvedHash, "resolved-environment-switch");
});

test("scenario diagnostics preference is reapplied when a new simulation attaches", () => {
    const controller = new RunSessionController();
    controller.recording = { attachSimulation() {} };
    const firstValues = [];
    const secondValues = [];
    const dataFor = (values) => ({
        simulation: () => ({
            setScenarioDiagnosticsEnabled(value) { values.push(value); },
            subscribe() { return () => {}; },
        }),
    });

    controller.attachData(dataFor(firstValues));
    assert.deepEqual(firstValues, [false]);
    assert.equal(controller.setScenarioDiagnosticsEnabled(true), true);
    assert.deepEqual(firstValues, [false, true]);

    controller.attachData(dataFor(secondValues));
    assert.deepEqual(secondValues, [true]);
    controller.setScenarioDiagnosticsEnabled(false);
    assert.deepEqual(secondValues, [true, false]);
});

test("transient logging override skips recording and speed override applies immediately", async () => {
    let startCount = 0;
    const speeds = [];
    const controller = controllerFor("required", async () => { startCount += 1; });
    controller.data = {
        ...controller.data,
        simulation: () => ({
            getSnapshot: () => ({ status: "paused" }),
            setSpeed(value) { speeds.push(value); },
            play() {},
        }),
    };

    controller.setLoggingPolicyOverride("disabled");
    controller.setSpeedOverride(4);
    await controller.play();
    assert.equal(startCount, 0);
    assert.equal(controller._recordingRunId, "run-test");
    assert.ok(speeds.includes(4));

    controller.clear();
    assert.equal(controller._loggingPolicyOverride, null);
    assert.equal(controller._speedOverride, null);
});

test("external-ros realtime cases force 1x regardless of speed override", () => {
    const speeds = [];
    const controller = controllerFor("disabled", async () => {});
    controller.data = {
        ...controller.data,
        simulation: () => ({
            getSnapshot: () => ({ status: "paused" }),
            setSpeed(value) { speeds.push(value); },
        }),
    };
    controller.snapshot.activeResolved = {
        ...controller.snapshot.activeResolved,
        manifest: {
            ...controller.snapshot.activeResolved.manifest,
            clock: { pacing: "realtime", speed: 1 },
            logging: { policy: "disabled", profileId: "simulation-run-full-sensors" },
        },
        scenario: {
            scenario: {
                routes: [{ controller: { kind: "external-ros", topicId: "/ackdrive" } }],
            },
        },
    };
    controller.setSpeedOverride(4);
    speeds.length = 0;
    controller.applyRuntimeOverrides();
    assert.deepEqual(speeds, [1]);
});
