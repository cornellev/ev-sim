import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentPersistence } from "../app/3d/environment/EnvironmentPersistence.js";

function createHarness({ revision = 0, put } = {}) {
    let documentNotify = () => {};
    const environment = {
        environmentId: "yard",
        revision,
        visualLayer: null,
        evidence: null,
        persistence: null,
        toManifest() {
            return {
                environmentId: "yard",
                name: this.name,
                schemaVersion: 3,
                revision: this.revision,
                visualLayer: this.visualLayer,
                evidence: this.evidence,
                document: { roads: { nodes: [], edges: [] } },
            };
        },
        getDocument() {
            return {
                subscribe(listener) {
                    documentNotify = listener;
                    return () => {};
                },
            };
        },
        objects() { return { subscribe() { return () => {}; } }; },
        editor() { return { subscribe() { return () => {}; } }; },
        sky() { return { subscribe() { return () => {}; } }; },
        name: "Yard",
        notify() { documentNotify(); },
    };
    const data = { environment: () => environment };
    const persistence = new EnvironmentPersistence({ data, scene: {}, revision, put });
    persistence.attach();
    return { environment, persistence };
}

test("edits arriving during a save produce a second guarded save from the latest draft", async () => {
    const puts = [];
    let releaseFirst;
    const put = async (_path, body) => {
        const call = { body, revision: body.expectedRevision + 1 };
        puts.push(call);
        if (puts.length === 1) {
            await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { ...body.manifest, revision: call.revision, schemaVersion: 3, visualLayer: null, evidence: null };
    };
    const { environment, persistence } = createHarness({ revision: 1, put });
    environment.name = "First";
    persistence._dirty = true;
    const first = persistence.flush();
    environment.name = "Second";
    persistence._handleChange();
    persistence._saveNow();
    releaseFirst();
    await first;
    assert.equal(puts.length, 2);
    assert.equal(puts[0].body.expectedRevision, 1);
    assert.equal(puts[0].body.manifest.name, "First");
    assert.equal(puts[1].body.expectedRevision, 2);
    assert.equal(puts[1].body.manifest.name, "Second");
    assert.equal(puts[0].body.detachStaleVisual, true);
    assert.equal(persistence.acknowledgedRevision, 3);
    assert.equal(persistence.conflict, null);
});

test("hide and unload flushes join the in-flight queue instead of writing in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const put = async (_path, body) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { ...body.manifest, revision: body.expectedRevision + 1, schemaVersion: 3 };
    };
    const { environment, persistence } = createHarness({ revision: 0, put });
    environment.name = "Draft";
    persistence._dirty = true;
    const first = persistence.flush();
    const hidden = persistence.flush({ keepalive: true });
    await Promise.all([first, hidden]);
    assert.equal(maxInFlight, 1);
    assert.equal(persistence.acknowledgedRevision >= 1, true);
});

test("suspend invalidates queued saves and conflicts never adopt an unacknowledged revision", async () => {
    const puts = [];
    let releaseFirst;
    const put = async (_path, body) => {
        puts.push(body);
        if (puts.length === 1) {
            await new Promise((resolve) => { releaseFirst = resolve; });
            const error = new Error("revision conflict");
            error.status = 409;
            error.code = "ENVIRONMENT_REVISION_CONFLICT";
            error.currentRevision = 5;
            throw error;
        }
        return { ...body.manifest, revision: body.expectedRevision + 1, schemaVersion: 3 };
    };
    const { environment, persistence } = createHarness({ revision: 1, put });
    environment.name = "Local";
    persistence._dirty = true;
    const pending = persistence.flush();
    environment.name = "Queued";
    persistence._handleChange();
    persistence._saveNow();
    const suspended = persistence.suspendAutosave();
    releaseFirst();
    await suspended;
    await pending;
    assert.equal(puts.length, 1);
    assert.equal(persistence.acknowledgedRevision, 1);
    assert.equal(persistence.conflict.code, "ENVIRONMENT_REVISION_CONFLICT");
    assert.equal(persistence.isDirty, true);
    persistence.resumeAutosave();
    const decision = await persistence.prepareExternalApply({ revision: 5, name: "Remote" });
    assert.equal(decision.apply, false);
    assert.equal(persistence.acknowledgedRevision, 1);
});

test("clean external updates adopt the acknowledged server revision", async () => {
    const { persistence } = createHarness({ revision: 2, put: async () => ({ revision: 3 }) });
    const decision = await persistence.prepareExternalApply({ revision: 4 });
    assert.equal(decision.apply, true);
    persistence.adoptRevision(4);
    persistence.resumeAutosave();
    assert.equal(persistence.acknowledgedRevision, 4);
    assert.equal(persistence.conflict, null);
});

test("promoted visual references adopt the committed revision without clearing local metric dirtiness", () => {
    const { environment, persistence } = createHarness({ revision: 2 });
    environment.visualLayer = { descriptorHash: "a".repeat(64), accessHash: "b".repeat(64) };
    persistence._dirty = true;
    persistence.adoptPromotedVisualLayer({
        revision: 3,
        visualLayer: { descriptorHash: "c".repeat(64), accessHash: "d".repeat(64) },
        manifest: { evidence: null, visualLayer: { descriptorHash: "c".repeat(64), accessHash: "d".repeat(64) } },
    });
    assert.equal(persistence.acknowledgedRevision, 3);
    assert.equal(environment.revision, 3);
    assert.equal(environment.visualLayer.descriptorHash, "c".repeat(64));
    assert.equal(environment.evidence, null);
    assert.equal(persistence.isDirty, true);
    assert.equal(persistence.conflict, null);
});
