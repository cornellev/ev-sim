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
    return { data, environment, persistence };
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

test("an edit during an in-flight save stays dirty even before another flush is queued", async () => {
    let release;
    let calls = 0;
    const { environment, persistence } = createHarness({
        revision: 1,
        put: async (_path, body) => {
            calls += 1;
            await new Promise((resolve) => { release = resolve; });
            return { ...body.manifest, revision: 2, visualLayer: null, evidence: null };
        },
    });
    persistence._dirty = true;
    const pending = persistence.flush();
    environment.name = "Edited while saving";
    persistence._handleChange();
    release();
    await pending;
    assert.equal(calls, 1);
    assert.equal(persistence.isDirty, true);
    assert.equal(environment.visualLayer, null);
    assert.equal(environment.evidence, null);
});

test("suspension blocks flush entry points and resume explicitly drains the pending draft", async () => {
    let calls = 0;
    const { persistence } = createHarness({
        put: async (_path, body) => {
            calls += 1;
            return { ...body.manifest, revision: body.expectedRevision + 1 };
        },
    });
    persistence._dirty = true;
    await persistence.suspendAutosave();
    await persistence.flush({ keepalive: true });
    assert.equal(calls, 0);
    persistence.resumeAutosave();
    await persistence._chain;
    assert.equal(calls, 1);
    assert.equal(persistence.isDirty, false);
});

test("a strict flush joining an autosave observes its failure", async () => {
    let reject;
    const { persistence } = createHarness({
        put: async () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }),
    });
    persistence._dirty = true;
    persistence._saveNow();
    const strict = persistence.flush({ throwOnError: true });
    reject(new Error("disk unavailable"));
    await assert.rejects(strict, /disk unavailable/);
    assert.equal(persistence.isDirty, true);
});

test("explicit null references are applied and stale promotion receipts cannot regress revision", async () => {
    const { environment, persistence } = createHarness({
        revision: 4,
        put: async (_path, body) => ({ ...body.manifest, revision: 5, visualLayer: null, evidence: null }),
    });
    environment.visualLayer = { descriptorHash: "a".repeat(64) };
    environment.evidence = { reportHash: "b".repeat(64) };
    persistence._dirty = true;
    await persistence.flush({ throwOnError: true });
    assert.equal(environment.visualLayer, null);
    assert.equal(environment.evidence, null);
    persistence.adoptPromotedVisualLayer({ revision: 3, visualLayer: { descriptorHash: "c".repeat(64) } });
    assert.equal(persistence.acknowledgedRevision, 5);
    assert.equal(environment.visualLayer, null);
    persistence.adoptPromotedVisualLayer({
        environmentId: "other-yard",
        revision: 6,
        visualLayer: { descriptorHash: "d".repeat(64) },
    });
    assert.equal(persistence.acknowledgedRevision, 5);
    assert.equal(environment.visualLayer, null);
});

test("a save response for another environment cannot advance the local revision", async () => {
    const { persistence } = createHarness({
        revision: 2,
        put: async () => ({ environmentId: "other-yard", revision: 99, visualLayer: null, evidence: null }),
    });
    persistence._dirty = true;
    await persistence.flush({ throwOnError: true });
    assert.equal(persistence.acknowledgedRevision, 2);
    assert.equal(persistence.isDirty, true);
});

test("ED-02 transient gesture frames and cancels never mark dirty; committed changes do", () => {
    let documentNotify = () => {};
    const environment = {
        environmentId: "yard",
        revision: 0,
        toManifest() { return { environmentId: "yard", document: {} }; },
        getDocument() {
            return { subscribe(listener) { documentNotify = listener; return () => {}; } };
        },
        objects() { return { subscribe() { return () => {}; } }; },
        editor() { return { subscribe() { return () => {}; } }; },
        sky() { return { subscribe() { return () => {}; } }; },
    };
    const persistence = new EnvironmentPersistence({ data: { environment: () => environment }, scene: {}, revision: 0, put: async () => ({}) });
    persistence.attach();
    assert.equal(persistence.isDirty, false);
    documentNotify({}, { version: 1, transient: true, source: "gesture", changeSet: {} });
    assert.equal(persistence.isDirty, false, "transient frames stay out of the save queue");
    documentNotify({}, { version: 2, transient: false, source: "cancel", changeSet: {} });
    assert.equal(persistence.isDirty, false, "a cancelled gesture restores the saved state");
    documentNotify({}, { version: 3, transient: false, source: "gesture", changeSet: {} });
    assert.equal(persistence.isDirty, true, "a committed gesture enters the autosave queue");
    persistence._clearTimer();
});

test("ED-02 editor notifications mark dirty only when the persisted editor state changes", () => {
    let editorNotify = () => {};
    let persisted = { layers: { roads: true }, hiddenEntityIds: [], editorMode: "scene", map: { zoom: 1 }, earthImport: null };
    const environment = {
        environmentId: "yard",
        revision: 0,
        toManifest() { return { environmentId: "yard", document: {} }; },
        getDocument() { return { subscribe() { return () => {}; } }; },
        objects() { return { subscribe() { return () => {}; } }; },
        editor() {
            return {
                subscribe(listener) { editorNotify = listener; return () => {}; },
                persistedSnapshot: () => persisted,
            };
        },
        sky() { return { subscribe() { return () => {}; } }; },
    };
    const persistence = new EnvironmentPersistence({ data: { environment: () => environment }, scene: {}, revision: 0, put: async () => ({}) });
    persistence.attach();
    editorNotify({ activeTool: "select" });
    const afterFirst = persistence._editGeneration;
    editorNotify({ activeTool: "translate" });
    editorNotify({ activeTool: "rotate" });
    assert.equal(persistence._editGeneration, afterFirst, "tool and selection changes do not touch the save queue");
    persisted = { ...persisted, layers: { roads: false } };
    editorNotify({ activeTool: "rotate" });
    assert.equal(persistence._editGeneration, afterFirst + 1, "layer visibility is persisted and marks dirty");
    persistence._clearTimer();
});
