#!/usr/bin/env node

import process from "node:process";

import {
    VISUAL_SCALE_PROFILE_IDS,
    getVisualScaleProfile,
} from "../app/simulation/visual/VisualScaleProfile.js";
import { runVisualScaleBenchmark } from "../app/simulation/visual/VisualScaleBenchmark.js";
import { collectVisualScaleTelemetry } from "../server/headless/VisualScaleTelemetry.js";
import { parseOptions, processProvenance, writeReport } from "./lib/headless-release-support.mjs";

async function main() {
    const options = parseOptions(process.argv.slice(2), {
        quick: false,
        requireGpu: false,
        profile: null,
        output: null,
    });
    const profileId = options.quick
        ? VISUAL_SCALE_PROFILE_IDS.hostedQuickV1
        : (options.profile || VISUAL_SCALE_PROFILE_IDS.nvidiaX64ConsumerV1);
    getVisualScaleProfile(profileId);
    const requireGpu = options.requireGpu === true;
    const telemetry = await collectVisualScaleTelemetry({ requireGpu });
    const provenance = processProvenance();
    const report = await runVisualScaleBenchmark({
        profileId,
        requireGpu,
        telemetry,
        gitRevision: provenance.gitHash,
    });
    report.provenance = provenance;
    await writeReport(report, options.output);
    if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
