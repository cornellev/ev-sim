import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRunManifest, createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { createPortableHeadlessBundle, createPluginPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

test("run-manifest v11 admits exact plugin locks and legacy versions reject them", () => {
    const manifest = createDefaultRunManifest();
    const normalized = normalizeRunManifest({
        ...manifest,
        plugins: {
            enabled: true,
            artifacts: [{
                pluginId: "acme.example",
                expectedHash: "a".repeat(64),
                capabilities: ["signals.read.vehicles"],
            }],
        },
    });
    assert.deepEqual(normalized.plugins, {
        enabled: true,
        artifacts: [{
            pluginId: "acme.example",
            expectedHash: "a".repeat(64),
            capabilities: ["signals.read.vehicles"],
        }],
    });
    assert.throws(() => normalizeRunManifest({ ...manifest, version: 10, plugins: normalized.plugins }), /version 11/);
    assert.throws(() => normalizeRunManifest({
        ...manifest,
        plugins: { enabled: true, artifacts: [{ pluginId: "cev.reserved", expectedHash: "a".repeat(64) }] },
    }), /reserved cev namespace/);
});

test("plugin-free bundles reject the plugin identity profile", async () => {
    const bundle = await createPortableHeadlessBundle();
    const tampered = structuredClone(bundle);
    tampered.resolved.identityProfile = { id: "world-bound-plugins", version: 1 };
    assert.throws(() => verifyRunBundle(tampered), /requires an effective plugin selection/);
});

test("portable plugin bundles include package closure and plugin identity", async () => {
    const resource = await pluginFixtureResource();
    const bundle = await createPluginPortableHeadlessBundle(resource, {
        triggers: [{
            id: "finish",
            name: "Finish",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 1 },
            actions: [{ kind: "finish" }],
        }],
    });
    assert.equal(bundle.resolved.pluginPackages.length, 1);
    assert.equal(bundle.resolved.pluginPackages[0].packageHash, resource.packageHash);
    assert.equal(bundle.resolved.plugins[0].runtimeHash, resource.runtimeHash);
    assert.equal(bundle.resolved.plugins[0].uiHash, undefined);
    assert.equal(bundle.resolved.scenario?.scenario?.id, "headless-runner-test");
    verifyRunBundle(bundle);
});

test("failed plugin preparation preserves the active resolved run", async () => {
    const expected = Object.assign(new Error("plugin import failed"), { code: "PLUGIN_IMPORT_INVALID" });
    const kernel = new SimulationKernel({
        telemetry: null,
        plugins: { prepare: async () => { throw expected; } },
    });
    const active = { marker: "active" };
    kernel.resolvedRun = active;
    await assert.rejects(kernel.prepare({
        manifest: {
            plugins: {
                enabled: true,
                artifacts: [{ pluginId: "acme.example", expectedHash: "a".repeat(64), capabilities: [] }],
            },
        },
        plugins: [{ pluginId: "acme.example" }],
    }), expected);
    assert.equal(kernel.resolvedRun, active);
});
