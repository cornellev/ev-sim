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

test("run recording options include immutable manifest attachment and provenance", async () => {
    let options;
    const controller = controllerFor("required", async (value) => { options = value; });
    await controller._ensureRecording();
    assert.equal(options.runId, "run-test");
    assert.equal(options.resolvedHash, "resolved");
    assert.equal(options.timeBase, "simulation");
    assert.equal(options.provenance.orchestratorCatalogHash, "catalog");
    assert.ok(options.attachments.some((attachment) => attachment.name === "run-manifest.json"));
});
