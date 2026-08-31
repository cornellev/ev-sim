import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../server/headless/Cli.js";
import { createPortableHeadlessBundle, successfulTape } from "./helpers/headlessRunnerBundle.js";

const cliPath = path.resolve("bin/cev-sim.js");

async function temporaryRoot(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-sim-cli-test-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

function runCli(args, { input = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cliPath, args, { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
        if (input !== null) child.stdin.end(input);
        else child.stdin.end();
    });
}

function jsonLines(text) {
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function writeJson(filePath, value) {
    await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
}

test("CLI validate, stdin run, action-file run, and inspect emit machine-readable output", async (t) => {
    const root = await temporaryRoot(t);
    const bundlePath = path.join(root, "bundle.json");
    const actionsPath = path.join(root, "actions.jsonl");
    await writeJson(bundlePath, await createPortableHeadlessBundle());
    await fs.writeFile(actionsPath, `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n`);

    const validation = await runCli(["validate", "--bundle", bundlePath]);
    assert.equal(validation.code, 0, validation.stderr);
    assert.equal(jsonLines(validation.stdout)[0].kind, "cev-sim.headless.validation");

    const stdinOutput = path.join(root, "stdin-run");
    const stdinRun = await runCli([
        "run", "--bundle", bundlePath, "--output", stdinOutput, "--artifact-profile", "disabled", "--episode", await episodeFile(root),
    ], { input: `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n` });
    assert.equal(stdinRun.code, 0, stdinRun.stderr);
    const stdinEvents = jsonLines(stdinRun.stdout);
    assert.deepEqual(stdinEvents.map((entry) => entry.kind), [
        "cev-sim.headless.reset", "cev-sim.headless.transition", "cev-sim.headless.result",
    ]);
    assert.equal(typeof stdinEvents[0].info.simulationTimeNs, "string");
    assert.equal(typeof stdinEvents[1].info.step, "string");
    assert.equal(stdinEvents[0].observation.entries[0].tensor.payload.packedData.encoding, "base64");

    const fileOutput = path.join(root, "file-run");
    const fileRun = await runCli([
        "run", "--bundle", bundlePath, "--output", fileOutput, "--actions", actionsPath,
        "--artifact-profile", "disabled", "--episode", path.join(root, "episode.json"),
    ]);
    assert.equal(fileRun.code, 0, fileRun.stderr);
    const fileResult = jsonLines(fileRun.stdout).at(-1).result;
    assert.equal(fileResult.trajectoryHash, stdinEvents.at(-1).result.trajectoryHash);

    const inspection = await runCli(["inspect", fileOutput]);
    assert.equal(inspection.code, 0, inspection.stderr);
    const inspected = jsonLines(inspection.stdout)[0];
    assert.equal(inspected.kind, "cev-sim.headless.output-inspection");
    assert.equal(inspected.runResult.passed, true);
});

async function episodeFile(root) {
    const filePath = path.join(root, "episode.json");
    try {
        await fs.access(filePath);
    } catch {
        await writeJson(filePath, { actionRepeat: 5 });
    }
    return filePath;
}

test("CLI replay returns semantic failure for a fatal assertion and retains evaluation evidence", async (t) => {
    const root = await temporaryRoot(t);
    const bundlePath = path.join(root, "failing-bundle.json");
    const tapePath = path.join(root, "tape.json");
    const output = path.join(root, "failed-run");
    await writeJson(bundlePath, await createPortableHeadlessBundle({
        assertions: [{
            id: "must-reach-step-99",
            name: "Must reach step 99",
            source: "signal",
            path: "simulation.step",
            selector: null,
            operator: "gte",
            expected: 99,
            tolerance: 0,
            mode: "eventually",
            window: { startStep: 1, endStep: 1 },
            severity: "error",
            onFailure: "stop",
        }],
    }));
    await writeJson(tapePath, successfulTape());
    const replay = await runCli([
        "replay", "--bundle", bundlePath, "--tape", tapePath, "--output", output, "--artifact-profile", "evaluation",
    ]);
    assert.equal(replay.code, 1, replay.stderr);
    assert.equal(jsonLines(replay.stdout).at(-1).result.passed, false);
    assert.equal(await fs.stat(path.join(output, "run-results.json")).then(() => true), true);
    assert.equal(await fs.stat(path.join(output, "run.sflog")).then(() => true), true);
});

test("CLI distinguishes usage, invalid input, and artifact failures", async (t) => {
    const root = await temporaryRoot(t);
    const usageResult = await runCli(["run"]);
    assert.equal(usageResult.code, 2);

    const bundlePath = path.join(root, "bundle.json");
    await writeJson(bundlePath, await createPortableHeadlessBundle());
    const invalidOutput = path.join(root, "invalid");
    const invalid = await runCli([
        "run", "--bundle", bundlePath, "--output", invalidOutput, "--artifact-profile", "disabled",
    ], { input: `${JSON.stringify({ policyStep: 2, action: [0, 0] })}\n` });
    assert.equal(invalid.code, 3, invalid.stderr);
    await assert.rejects(() => fs.access(invalidOutput));

    const existing = path.join(root, "existing");
    await fs.mkdir(existing);
    const artifact = await runCli([
        "run", "--bundle", bundlePath, "--output", existing, "--artifact-profile", "disabled", "--episode", await episodeFile(root),
    ], { input: `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n` });
    assert.equal(artifact.code, 4, artifact.stderr);

    const sink = { write() { return true; } };
    const internal = await main(["validate", "--bundle", bundlePath], {
        runner: { validate: async () => { throw new Error("unexpected runtime failure"); } },
        stdout: sink,
        stderr: sink,
    });
    assert.equal(internal, 5);
});

test("SIGINT finalizes an interrupted result and exits 130", async (t) => {
    const root = await temporaryRoot(t);
    const bundlePath = path.join(root, "bundle.json");
    const output = path.join(root, "interrupted");
    await writeJson(bundlePath, await createPortableHeadlessBundle());
    await episodeFile(root);
    const result = await new Promise((resolve, reject) => {
        const child = spawn(cliPath, [
            "run", "--bundle", bundlePath, "--output", output, "--artifact-profile", "disabled", "--episode", path.join(root, "episode.json"),
        ], { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let interrupted = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (!interrupted && stdout.includes("cev-sim.headless.reset")) {
                interrupted = true;
                child.kill("SIGINT");
            }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 130, result.stderr);
    const final = jsonLines(result.stdout).at(-1);
    assert.equal(final.kind, "cev-sim.headless.result");
    assert.equal(final.result.interruptedBySignal, true);
    assert.equal(await fs.stat(path.join(output, "run-results.json")).then(() => true), true);
});
