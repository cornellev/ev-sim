import assert from "node:assert/strict";
import express from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CosmosClipJob } from "../server/headless/CosmosClipJob.js";
import { COSMOS_CLIP_MAX_STEPS } from "../server/headless/CosmosClipBundle.js";
import { GpuTurn } from "../server/headless/GpuTurn.js";
import { createHeadlessRouter } from "../server/routes/headlessRouter.js";

async function jobFixture(t, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cosmos-clip-job-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const chromium = path.join(root, "chrome");
    await fs.writeFile(chromium, "");
    const calls = [];
    const gpuTurn = overrides.gpuTurn ?? new GpuTurn();
    const service = new CosmosClipJob({
        artifactRoot: root,
        renderer: { chromiumExecutable: overrides.chromiumExecutable ?? chromium, launchArgs: ["--headless"] },
        gpuTurn,
        managedBusy: overrides.managedBusy ?? (async () => false),
        createBundle: async () => ({ kind: "bundle" }),
        runner: overrides.runner ?? {
            async run(bundle, options) {
                calls.push({ bundle, options });
                return { outputDirectory: path.join(root, "published-run") };
            },
        },
        runProcess: overrides.runProcess ?? (async (args) => {
            if (args[0] === "ffmpeg" || args[0] === "ffprobe") return `${args[0]} version test`;
            if (args.includes("-c")) return "";
            if (args.includes("export")) {
                const outputRoot = args[args.indexOf("--output-root") + 1];
                const destination = path.join(outputRoot, "clip-test");
                await fs.mkdir(destination, { recursive: true });
                await fs.writeFile(path.join(destination, "rgb.mp4"), "rgb");
                await fs.writeFile(path.join(destination, "depth.mp4"), "depth");
                return destination;
            }
            if (args.includes("check")) {
                return JSON.stringify({
                    ok: true,
                    frameCount: 121,
                    frameRate: "30/1",
                    depthRange: [0.65, 67.1],
                });
            }
            throw new Error(`unexpected command ${args.join(" ")}`);
        }),
        ...overrides.service,
    });
    await service.initialize();
    return { root, service, calls, gpuTurn, chromium };
}

test("clip preflight loads a supervisor renderer supplied by the environment", async (t) => {
    const { service, chromium, calls } = await jobFixture(t, { chromiumExecutable: "" });
    service.resolveRenderer = async () => ({ chromiumExecutable: chromium, launchArgs: ["--headless"] });
    const ready = await service.preflight();
    assert.equal(ready.ok, true, ready.issues.join(" "));
    await service.start();
    const finished = await service.whenSettled();
    assert.equal(finished.phase, "ready");
    assert.equal(calls[0].options.config.renderer.chromiumExecutable, chromium);
});

test("clip preflight rejects a server without Chromium before starting a run", async (t) => {
    let ran = false;
    const { service, gpuTurn } = await jobFixture(t, {
        chromiumExecutable: "",
        runner: { async run() { ran = true; } },
    });
    const ready = await service.preflight();
    assert.equal(ready.ok, false);
    assert.match(ready.issues.join(" "), /chromiumExecutable/);
    await assert.rejects(service.start(), /chromiumExecutable/);
    assert.equal(ran, false);
    assert.equal(gpuTurn.holder, null);
});

test("clip job exports and checks after the permissive candidate run", async (t) => {
    const { service, calls, gpuTurn } = await jobFixture(t);
    const started = await service.start();
    assert.equal(started.phase, "running");
    const finished = await service.whenSettled();
    assert.equal(finished.phase, "ready");
    assert.equal(finished.summary.frameCount, 121);
    assert.equal(finished.summary.frameRate, "30/1");
    assert.deepEqual(finished.summary.depthRange, [0.65, 67.1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.config.preset, "permissive");
    assert.equal(calls[0].options.config.renderer.launchArgs[0], "--headless");
    assert.equal(calls[0].options.actions.length, COSMOS_CLIP_MAX_STEPS);
    assert.equal(calls[0].options.artifactPolicy.profile, "evaluation");
    assert.equal(calls[0].options.episodeSpec.maxEpisodeSteps, String(COSMOS_CLIP_MAX_STEPS));
    assert.equal(gpuTurn.holder, null);
    const video = await service.openVideo("rgb.mp4");
    assert.equal(video.name, "rgb.mp4");
    await assert.rejects(service.openVideo("depth.f32"), /rgb\.mp4 and depth\.mp4/);
});

test("export failure deletes the staged clip directory", async (t) => {
    const { service } = await jobFixture(t, {
        runProcess: async (args) => {
            if (args[0] === "ffmpeg" || args[0] === "ffprobe") return `${args[0]} version test`;
            if (args.includes("-c")) return "";
            if (args.includes("export")) {
                const outputRoot = args[args.indexOf("--output-root") + 1];
                const destination = path.join(outputRoot, "clip-partial");
                await fs.mkdir(destination, { recursive: true });
                await fs.writeFile(path.join(destination, "partial.txt"), "x");
                throw new Error("encode failed");
            }
            throw new Error(`unexpected command ${args.join(" ")}`);
        },
    });
    await service.start();
    const finished = await service.whenSettled();
    assert.equal(finished.phase, "failed");
    assert.match(finished.error, /encode failed/);
    const jobDir = path.join(service.root, finished.id);
    await assert.rejects(fs.access(path.join(jobDir, "clips")));
});

test("cancel aborts the run and a second start is rejected while one is active", async (t) => {
    let signal = null;
    const { service } = await jobFixture(t, {
        runner: {
            run(_bundle, options) {
                signal = options.signal;
                return new Promise((resolve, reject) => {
                    if (options.signal.aborted) {
                        reject(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
                        return;
                    }
                    options.signal.addEventListener("abort", () => {
                        reject(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
                    }, { once: true });
                });
            },
        },
    });
    await service.start();
    await assert.rejects(service.start(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /already running/);
        return true;
    });
    const cancelled = await service.cancel();
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(signal.aborted, true);
    assert.equal(service.gpuTurn.holder, null);
});

test("a queued managed run blocks clip start", async (t) => {
    const { service, gpuTurn } = await jobFixture(t, {
        managedBusy: async () => true,
    });
    await assert.rejects(service.start(), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /queued or running/);
        return true;
    });
    assert.equal(gpuTurn.holder, null);
});

test("startup cancels a clip left in the running phase", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cosmos-clip-restart-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "cosmos-clips", "clip-stale");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "status.json"), `${JSON.stringify({
        id: "clip-stale",
        phase: "running",
        error: null,
        clipDirectory: null,
        summary: null,
        startedAt: "2026-09-23T00:00:00.000Z",
        finishedAt: null,
    })}\n`);
    const service = new CosmosClipJob({
        artifactRoot: root,
        renderer: { chromiumExecutable: "" },
        runProcess: async () => "",
    });
    await service.initialize();
    assert.equal(service.currentView().phase, "cancelled");
    assert.match(service.currentView().error, /server stopped/);
});

test("clip video route streams rgb.mp4 and rejects depth.f32", async (t) => {
    const { root, service } = await jobFixture(t);
    await service.start();
    await service.whenSettled();
    const app = express();
    app.use("/api/headless", createHeadlessRouter({ artifactRoot: root }, service));
    const server = app.listen(0);
    t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const { port } = server.address();
    const rgb = await fetch(`http://127.0.0.1:${port}/api/headless/clips/current/files/rgb.mp4`);
    assert.equal(rgb.status, 200);
    assert.equal(await rgb.text(), "rgb");
    const depthFile = await fetch(`http://127.0.0.1:${port}/api/headless/clips/current/files/depth.f32`);
    assert.equal(depthFile.status, 404);
    const traversal = await fetch(`http://127.0.0.1:${port}/api/headless/clips/current/files/${encodeURIComponent("../rgb.mp4")}`);
    assert.equal(traversal.status, 404);
    await assert.rejects(service.openVideo("../rgb.mp4"), (error) => error.status === 404);
    assert.equal(service.gpuTurn.holder, null);
    assert.ok(root);
});

test("clip preflight rejects an invalid body and a stale manifest revision", async (t) => {
    const { root, service } = await jobFixture(t);
    service.resolver = {
        async resolve() {
            const error = new Error("Run manifest \"saved\" revision is 4, not 3.");
            error.status = 409;
            throw error;
        },
    };
    const app = express();
    app.use(express.json());
    app.use("/api/headless", createHeadlessRouter({ artifactRoot: root }, service));
    const server = app.listen(0);
    t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}/api/headless/clips/preflight`;
    const invalid = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "environment" }),
    });
    assert.equal(invalid.status, 400);
    const stale = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            profile: "environment",
            manifestId: "saved",
            expectedManifestRevision: 3,
            camera: { kind: "manifest", cameraId: "front-camera" },
            renderer: "analytic",
        }),
    });
    assert.equal(stale.status, 409);
    const legacy = await fetch(base);
    assert.equal(legacy.status, 200);
});
