import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { createPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";

function fakeAdmission() {
    const events = [];
    return {
        events,
        async bind() {
            events.push("bind");
        },
        async acquireBatch() {
            events.push("pin");
        },
        createDigestReader() {
            events.push("reader");
            return { close: async () => { events.push("close"); } };
        },
        async releaseBatch() {
            events.push("unpin");
        },
        async release() {
            events.push("release");
        },
        async close() {},
    };
}

async function supervisorFor(t, admission, workerFactory) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-clip-admission-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const supervisor = new HeadlessSupervisor({
        socket: path.join(root, "supervisor.sock"),
        inlineObservations: true,
        workerFactory,
    });
    supervisor.rendererPool = {
        probe: async () => ({ available: true }),
        pbrCapability: () => ({ available: true }),
        releaseEnvironment: async () => {},
        close: async () => {},
    };
    supervisor.admissionManager = admission;
    t.after(() => supervisor.close());
    return supervisor;
}

test("managed clip admission closes the reader and releases the pin on success, failure, cancellation, and stale rights", async (t) => {
    const bundle = await createPortableHeadlessBundle();
    const bundleBytes = Buffer.from(canonicalRunBundleStringify(bundle));
    const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-clip-admission-out-"));
    t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
    const request = {
        bundle,
        bundleBytes,
        outputUri: path.join(outputRoot, "episode"),
        assetAdmission: { handle: "a".repeat(64) },
        artifactPolicy: { profile: "evaluation" },
    };

    const success = fakeAdmission();
    const succeeded = await supervisorFor(t, success, () => ({
        pid: 1,
        async dispatch(op) {
            if (op === "run-managed") return { finalized: { outputDirectory: "/tmp/out", runResult: { completed: true }, artifacts: [] } };
            return { descriptor: {} };
        },
        async close() {},
    }));
    await succeeded.runManagedExperiment(request);
    assert.deepEqual(success.events, ["bind", "pin", "reader", "close", "unpin", "release"]);

    const failed = fakeAdmission();
    const failing = await supervisorFor(t, failed, () => ({
        pid: 1,
        async dispatch(op) {
            if (op === "run-managed") throw new Error("renderer failed");
            return { descriptor: {} };
        },
        async close() {},
    }));
    await assert.rejects(failing.runManagedExperiment(request), /renderer failed/);
    assert.deepEqual(failed.events, ["bind", "pin", "reader", "close", "unpin", "release"]);

    const cancelled = fakeAdmission();
    const controller = new AbortController();
    controller.abort();
    const cancelling = await supervisorFor(t, cancelled, () => ({
        pid: 1,
        async dispatch(_op, _payload, options) {
            options?.signal?.throwIfAborted();
            return { descriptor: {} };
        },
        async close() {},
    }));
    await assert.rejects(cancelling.runManagedExperiment(request, { signal: controller.signal }));
    assert.deepEqual(cancelled.events, ["bind", "pin", "reader", "close", "unpin", "release"]);

    const stale = fakeAdmission();
    stale.bind = async () => {
        stale.events.push("bind");
        throw new Error("Asset admission is stale, released, or unknown.");
    };
    const staleSupervisor = await supervisorFor(t, stale, () => ({ pid: 1, async dispatch() { return {}; }, async close() {} }));
    await assert.rejects(staleSupervisor.runManagedExperiment(request), /stale/);
    assert.deepEqual(stale.events, ["bind", "release"]);
});
