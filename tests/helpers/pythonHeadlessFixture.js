import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { measuredStateProfileRef, routeSafetyProfileRef } from "../../app/simulation/headless/ProfileRegistry.js";
import { createStateSensorBackendSelection } from "../../app/simulation/sensors/StateSensorBackend.js";
import { HeadlessRunner } from "../../server/headless/HeadlessRunner.js";
import { createPortableHeadlessBundle } from "./headlessRunnerBundle.js";

function runCli(args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(path.resolve("bin/cev-sim.js"), args, {
            cwd: path.resolve("."),
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 1
            ? resolve({ stdout, stderr })
            : code === 0
                ? resolve({ stdout, stderr })
                : reject(new Error(`CLI exited ${code}: ${stderr}`)));
        child.stdin.end(input);
    });
}

function observationFixture(observation) {
    return observation.entries.map((entry) => ({
        name: entry.name,
        dtype: entry.tensor.spec.dtype,
        shape: entry.tensor.spec.shape,
        data: Buffer.from(entry.tensor.payload.packedData).toString("base64"),
    }));
}

async function main() {
    const outputRoot = path.resolve(process.argv[2]);
    await fs.mkdir(outputRoot, { recursive: true });
    const bundle = await createPortableHeadlessBundle();
    const bundlePath = path.join(outputRoot, "bundle.json");
    const episodePath = path.join(outputRoot, "episode.json");
    const spec = {
        environmentIndex: 0,
        environmentId: "environment-0",
        runBundleId: bundle.resolvedHash,
        resetSeed: "123",
        actionRepeat: 1,
        maxEpisodeSteps: "0",
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef(),
        backendSelections: [...bundle.resolved.backendSelections, createStateSensorBackendSelection()],
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle));
    await fs.writeFile(episodePath, JSON.stringify(spec));

    const directEvents = [];
    const direct = await new HeadlessRunner().run(bundle, {
        episodeSpec: spec,
        actions: [{ policyStep: 1, action: [0, 0] }],
        outputUri: path.join(outputRoot, "direct"),
        artifactPolicy: { profile: "disabled", outputUri: path.join(outputRoot, "direct") },
        onEvent: (event) => directEvents.push(event),
    });
    const cli = await runCli([
        "run",
        "--bundle", bundlePath,
        "--episode", episodePath,
        "--output", path.join(outputRoot, "cli"),
        "--artifact-profile", "disabled",
    ], `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n`);
    const cliEvents = cli.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const directReset = directEvents.find((event) => event.kind === "cev-sim.headless.reset");
    const directStep = directEvents.find((event) => event.kind === "cev-sim.headless.transition");
    const cliStep = cliEvents.find((event) => event.kind === "cev-sim.headless.transition");
    const fixture = {
        bundlePath,
        episodeHash: directReset.info.episodeHash,
        trajectoryHash: directStep.info.trajectoryHash,
        cliTrajectoryHash: cliStep.info.trajectoryHash,
        resetObservation: observationFixture(directReset.observation),
        stepObservation: observationFixture(directStep.observation),
        finalTrajectoryHash: direct.result.trajectoryHash,
    };
    await fs.writeFile(path.join(outputRoot, "expected.json"), JSON.stringify(fixture));
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
