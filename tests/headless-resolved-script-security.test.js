import assert from "node:assert/strict";
import test from "node:test";

import { BindingRuntime } from "../app/scripting/bindings/BindingRuntime.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import {
    createPortableHeadlessBundle,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";

test("headless bindings never resolve a missing script through the loader", async () => {
    let loadCount = 0;
    const runtime = new BindingRuntime({
        autoLoad: false,
        allowWallTimers: false,
        resolvedOnly: true,
        loadScript: async () => {
            loadCount += 1;
            throw new Error("network loader must not run");
        },
    });
    await runtime.ready();
    await runtime.setManifest({
        enabled: true,
        bindings: [{
            id: "url-shaped-script",
            enabled: true,
            scriptId: "https://attacker.invalid/script.json",
            trigger: { kind: "fixed-update", everyN: 1 },
        }],
    }, { persist: false });

    await assert.rejects(
        runtime.prepareResolvedScripts([]),
        /references missing resolved script/,
    );
    assert.equal(loadCount, 0);
    runtime.dispose();
});

test("run-bundle verification enforces a closed and unique script artifact set", async () => {
    const base = await createPortableHeadlessBundle();
    base.resolved.bindings.entries = [{
        id: "missing-script",
        enabled: true,
        scriptId: "missing",
    }];
    assert.throws(
        () => verifyRunBundle(rehashRunBundle(base)),
        /references missing resolved script/,
    );

    base.resolved.bindings.entries = [];
    base.resolved.scripts = [
        { scriptId: "duplicate", artifact: { kind: "test-script", version: 1 } },
        { scriptId: "duplicate", artifact: { kind: "test-script", version: 1 } },
    ];
    assert.throws(
        () => verifyRunBundle(rehashRunBundle(base)),
        /duplicate script artifact/,
    );
});
