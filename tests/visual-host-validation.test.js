import assert from "node:assert/strict";
import test from "node:test";

import { evaluateVisualHostRole, VISUAL_HOST_ROLES } from "../server/headless/VisualHostValidation.js";
import { hashVisualLodPolicy } from "../app/simulation/visual/VisualLayer.js";
import {
    VISUAL_SCALE_PROFILE_IDS,
    VISUAL_SCALE_REPORT_KIND,
    advertisedVisualScaleProfileIds,
    getVisualScaleProfile,
} from "../app/simulation/visual/VisualScaleProfile.js";
import { runVisualScaleBenchmark } from "../app/simulation/visual/VisualScaleBenchmark.js";

test("AGX host roles reject Orin NX/Nano, software WebGL, and missing telemetry", () => {
    const orinNx = evaluateVisualHostRole({
        role: VISUAL_HOST_ROLES.jetsonAgxOrin,
        architecture: "arm64",
        operatingSystem: { totalMemoryBytes: 32 * 1024 ** 3 },
        jetson: {
            model: "NVIDIA Jetson Orin NX",
            l4tRelease: "R36",
            jetpack: { available: true },
            powerMode: { available: true },
            tegrastats: { available: true },
        },
        graphics: { deviceNodes: [{ readable: true, characterDevice: true }], nvidia: { available: true } },
        runtimes: { chromium: { available: true, output: "Chromium 120" } },
        configuration: { renderer: { chromiumExecutable: "/usr/bin/chromium" } },
        gpuPreflight: { available: true, production: true },
        checks: {},
    }, { requireGpu: true });
    assert.equal(orinNx.passed, false);
    assert.equal(orinNx.checks.jetsonModel, false);

    const software = evaluateVisualHostRole({
        role: VISUAL_HOST_ROLES.jetsonAgxThor,
        architecture: "arm64",
        operatingSystem: { totalMemoryBytes: 64 * 1024 ** 3 },
        jetson: {
            model: "NVIDIA Jetson AGX Thor",
            l4tRelease: "R36",
            jetpack: { available: true },
            powerMode: { available: true },
            tegrastats: { available: true },
        },
        graphics: { deviceNodes: [{ readable: true, characterDevice: true }], nvidia: { available: true } },
        runtimes: { chromium: { available: true, output: "Chromium 120" } },
        configuration: { renderer: { chromiumExecutable: "/usr/bin/chromium" } },
        gpuPreflight: { available: true, production: false },
        checks: {},
    }, { requireGpu: true });
    assert.equal(software.passed, false);
    assert.equal(software.checks.hardwareWebgl2, false);
    assert.equal(software.capabilitySkipDisallowed, true);

    const generic = evaluateVisualHostRole({
        role: VISUAL_HOST_ROLES.jetsonArm64,
        architecture: "arm64",
        checks: { supportedPlatform: true, gpuRequirement: true },
        gpuPreflight: { available: false, production: false },
    });
    assert.equal(generic.passed, true);
    assert.equal(generic.capabilitySkipDisallowed, false);
});

test("quick visual-scale benchmark emits a passing software G-SCALE report", async () => {
    const ids = advertisedVisualScaleProfileIds();
    assert.deepEqual(ids, [
        VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1,
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxOrinV1,
        VISUAL_SCALE_PROFILE_IDS.jetsonAgxThorV1,
    ]);
    const lod = hashVisualLodPolicy(getVisualScaleProfile(ids[0]).lodPolicy);
    assert.equal(lod, hashVisualLodPolicy(getVisualScaleProfile(ids[1]).lodPolicy));

    const report = await runVisualScaleBenchmark({
        profileId: VISUAL_SCALE_PROFILE_IDS.hostedQuickV1,
        requireGpu: false,
        telemetry: { available: false },
    });
    assert.equal(report.kind, VISUAL_SCALE_REPORT_KIND);
    assert.equal(report.passed, true);
    assert.equal(report.gScale.noPerFrameWholeCityTransfer, true);
    assert.equal(report.gScale.noQuadraticLookup, true);
    assert.equal(report.gScale.noSilentLodReduction, true);
    assert.equal(report.failures.length, 0);
    assert.ok(report.skips.includes("hardware-telemetry"));
});
