import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRunManifest, createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { createPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";

test("run-manifest normalization rejects reserved plugin data before dropping fields", () => {
    const manifest = createDefaultRunManifest();
    assert.throws(() => normalizeRunManifest({ ...manifest, plugins: {} }), (error) => error.code === "PLUGIN_EXECUTION_UNAVAILABLE");
    assert.throws(() => normalizeRunManifest({ ...manifest, scripts: { ...manifest.scripts, embeddedBindings: [{ artifact: { pluginRequirements: [] } }] } }), /PLG-02/);
});

test("managed bundle admission rejects plugin resources and profile before integrity execution", async () => {
    const bundle = await createPortableHeadlessBundle();
    const withPackages = structuredClone(bundle);
    withPackages.resolved.pluginPackages = [];
    assert.throws(() => verifyRunBundle(withPackages), (error) => error.code === "UNSUPPORTED_CAPABILITY" && /PLG-02/.test(error.message));
    const withProfile = structuredClone(bundle);
    withProfile.resolved.identityProfile = { id: "world-bound-plugins", version: 1 };
    assert.throws(() => verifyRunBundle(withProfile), /PLG-02/);
});

test("kernel plugin rejection preserves the active resolved run", async () => {
    const kernel = new SimulationKernel({ telemetry: null });
    const active = { marker: "active" };
    kernel.resolvedRun = active;
    await assert.rejects(kernel.prepare({ manifest: {}, plugins: [] }), /PLG-02/);
    assert.equal(kernel.resolvedRun, active);
});
