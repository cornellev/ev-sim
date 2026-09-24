import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { simulationSha256 } from "../../app/simulation/kernel/SimulationHashes.js";
import { measuredStateProfileRef, routeSafetyProfileRef } from "../../app/simulation/headless/ProfileRegistry.js";
import { RUN_BUNDLE_KIND, RUN_BUNDLE_VERSION } from "../../app/simulation/RunManifest.js";
import { ClipBundleResolver, ClipRequestError } from "./ClipBundleResolver.js";
import {
    COSMOS_CLIP_CAMERA_ID,
    COSMOS_CLIP_MAX_STEPS,
    cosmosClipPolicyAction,
    createCosmosClipBundle,
} from "./CosmosClipBundle.js";
import { GpuTurn } from "./GpuTurn.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "./HeadlessProtocol.js";
import { canonicalRunBundleStringify } from "./RunBundle.js";
import { SUPERVISOR_CONFIG_KIND, SUPERVISOR_CONFIG_VERSION } from "./SupervisorConfig.js";
import { SupervisorRunner } from "./SupervisorRunner.js";
import { stageRunPackage } from "./VisualAssetAdmission.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIVE_PHASES = new Set(["preflight", "running", "exporting"]);
const VIDEO_NAMES = new Set(["rgb.mp4", "depth.mp4"]);

export class ClipJobError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "ClipJobError";
        this.status = status;
    }
}

function now() {
    return new Date().toISOString();
}

function isLegacyClipRequest(request) {
    return request == null || (typeof request === "object" && !Array.isArray(request) && Object.keys(request).length === 0);
}

function clipEpisodeSpec() {
    return {
        actionRepeat: 1,
        maxEpisodeSteps: String(COSMOS_CLIP_MAX_STEPS),
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef({
            terminateOnCollision: false,
            terminateOnOffRoad: false,
            terminateOnWrongWay: false,
            smoothness: false,
        }),
    };
}

function clipActions() {
    const action = cosmosClipPolicyAction();
    return Array.from({ length: COSMOS_CLIP_MAX_STEPS }, (_, index) => ({
        policyStep: index + 1,
        action,
    }));
}

function clipSupervisorConfig(renderer = {}) {
    return {
        kind: SUPERVISOR_CONFIG_KIND,
        version: SUPERVISOR_CONFIG_VERSION,
        preset: "permissive",
        renderer: {
            chromiumExecutable: String(renderer.chromiumExecutable || ""),
            contextPoolSize: 1,
            angle: renderer.angle || "",
            disableSandbox: renderer.disableSandbox === true,
            launchArgs: [...(renderer.launchArgs || [])],
        },
    };
}

function requestSummary(request, actionTapeHash) {
    const camera = request.camera || {};
    return {
        profile: request.profile,
        manifestId: request.manifestId,
        expectedManifestRevision: request.expectedManifestRevision ?? null,
        camera: {
            kind: camera.kind,
            ...(camera.cameraId ? { cameraId: camera.cameraId } : {}),
            ...(camera.attachment ? { attachment: camera.attachment } : {}),
            ...(camera.environmentId ? { environmentId: camera.environmentId } : {}),
            ...(camera.parentId ? { parentId: camera.parentId } : {}),
        },
        renderer: request.renderer ?? null,
        durationNs: request.durationNs ?? null,
        width: request.width ?? null,
        height: request.height ?? null,
        actionTapeHash,
    };
}

function publicState(job) {
    if (!job) return null;
    return {
        id: job.id,
        phase: job.phase,
        error: job.error,
        clipDirectory: job.clipDirectory,
        summary: job.summary,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        ...(job.request ? { request: job.request } : {}),
        ...(job.resolution ? { resolution: job.resolution } : {}),
    };
}

function defaultRunProcess(args, { signal, cwd, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(args[0], args.slice(1), {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        let stdout = "";
        let stderr = "";
        const abort = () => {
            if (child.pid == null) return;
            try {
                process.kill(-child.pid, "SIGTERM");
            } catch {
                child.kill("SIGTERM");
            }
        };
        if (signal?.aborted) {
            abort();
            reject(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
            return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
        });
        child.on("close", (code) => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) {
                reject(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
                return;
            }
            if (code !== 0) {
                reject(new Error((stderr || stdout || `${args[0]} exited ${code}`).trim()));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

export class ClipJob {
    constructor({
        artifactRoot,
        renderer = {},
        resolveRenderer = null,
        gpuTurn = new GpuTurn(),
        managedBusy = async () => false,
        createBundle = createCosmosClipBundle,
        runner = new SupervisorRunner(),
        runProcess = defaultRunProcess,
        idFactory = () => `clip-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        storage = null,
        supervisor = null,
        resolver = null,
    } = {}) {
        if (!artifactRoot) throw new Error("ClipJob requires an artifact root.");
        this.root = path.join(path.resolve(artifactRoot), "cosmos-clips");
        this.renderer = renderer;
        this.resolveRenderer = resolveRenderer;
        this.rendererError = null;
        this.gpuTurn = gpuTurn;
        this.managedBusy = managedBusy;
        this.createBundle = createBundle;
        this.runner = runner;
        this.runProcess = runProcess;
        this.idFactory = idFactory;
        this.storage = storage;
        this.supervisor = supervisor;
        this.resolver = resolver;
        this.current = null;
        this.execution = null;
    }

    _resolver() {
        if (this.resolver) return this.resolver;
        if (!this.storage) throw new ClipJobError("Saved-manifest clips require storage.", 400);
        this.resolver = new ClipBundleResolver({
            storage: this.storage,
            assertRenderer: (renderer, resolved) => this._assertRenderer(renderer, resolved),
        });
        return this.resolver;
    }

    async _assertRenderer(renderer, resolved) {
        if (!this.supervisor) {
            throw new ClipJobError("Headless supervisor is not available.", 400);
        }
        if (renderer === "pbr") {
            const capability = this.supervisor.rendererPool?.pbrCapability?.();
            if (capability && capability.available === false) {
                throw new ClipJobError(capability.reason || "PBR rendering is unavailable.", 400);
            }
        }
        if (typeof this.supervisor.validateManagedRuntime === "function") {
            await this.supervisor.validateManagedRuntime(resolved);
        }
    }

    async initialize() {
        await fs.mkdir(this.root, { recursive: true });
        const names = await fs.readdir(this.root);
        const jobs = [];
        for (const name of names) {
            const directory = path.join(this.root, name);
            try {
                const raw = JSON.parse(await fs.readFile(path.join(directory, "status.json"), "utf8"));
                jobs.push({ ...raw, directory });
            } catch {
                // Ignore directories that are not clip jobs.
            }
        }
        jobs.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
        for (const job of jobs) {
            if (!ACTIVE_PHASES.has(job.phase)) continue;
            job.phase = "cancelled";
            job.error = "The server stopped before the clip finished.";
            job.finishedAt = job.finishedAt || now();
            job.clipDirectory = null;
            await this._write(job);
        }
        this.current = jobs[0] || null;
    }

    currentView() {
        return publicState(this.current);
    }

    whenSettled() {
        return Promise.resolve(this.execution).then(() => this.currentView());
    }

    async _refreshRenderer() {
        if (typeof this.resolveRenderer !== "function") return;
        try {
            const renderer = await this.resolveRenderer();
            this.rendererError = null;
            if (renderer && typeof renderer === "object") this.renderer = renderer;
        } catch (error) {
            this.renderer = {};
            this.rendererError = error.message;
        }
    }

    async _toolPreflight() {
        await this._refreshRenderer();
        const issues = [];
        if (this.rendererError) issues.push(this.rendererError);
        const executable = String(this.renderer?.chromiumExecutable || "").trim();
        if (!this.rendererError && !executable) {
            issues.push("renderer.chromiumExecutable is not set. Set CEV_SIM_HEADLESS_SUPERVISOR_CONFIG to a supervisor JSON path in the server environment or .env.local.");
        } else if (executable) {
            try {
                await fs.access(executable);
            } catch {
                issues.push(`Chromium executable was not found at ${executable}.`);
            }
        }
        for (const tool of ["ffmpeg", "ffprobe"]) {
            try {
                const output = await this.runProcess([tool, "-version"], { cwd: REPOSITORY_ROOT });
                if (!output) issues.push(`${tool} is not usable.`);
            } catch (error) {
                issues.push(error?.code === "ENOENT"
                    ? `${tool} is not on PATH.`
                    : `${tool} is not usable: ${error.message}`);
            }
        }
        try {
            await this.runProcess(["python3", "-c", "import numpy"], {
                cwd: REPOSITORY_ROOT,
                env: this._pythonEnv(),
            });
        } catch (error) {
            issues.push(error?.code === "ENOENT"
                ? "python3 is not on PATH."
                : `Python numpy is not available: ${error.message}`);
        }
        if (await this.managedBusy()) {
            issues.push("A managed headless run is queued or running.");
        }
        return { ok: issues.length === 0, issues };
    }

    async preflight(request) {
        if (isLegacyClipRequest(request)) return this._toolPreflight();
        const tools = await this._toolPreflight();
        let derived = null;
        let requestError = null;
        try {
            derived = await this._resolver().resolve(request);
        } catch (error) {
            requestError = error;
        }
        if (requestError?.status === 409) {
            throw new ClipJobError(requestError.message, 409);
        }
        const issues = [
            ...(requestError ? [requestError.message] : []),
            ...tools.issues,
        ];
        return {
            ok: issues.length === 0,
            issues,
            resolution: derived?.summary ?? null,
            status: requestError ? (requestError.status || 400) : (tools.ok ? 200 : 400),
        };
    }

    async start(request) {
        if (this.current && ACTIVE_PHASES.has(this.current.phase)) {
            throw new ClipJobError("A Cosmos clip is already running.", 409);
        }
        if (isLegacyClipRequest(request)) return this._startLegacy();
        let derived;
        try {
            derived = await this._resolver().resolve(request);
        } catch (error) {
            if (error instanceof ClipJobError || error instanceof ClipRequestError) {
                throw new ClipJobError(error.message, error.status || 400);
            }
            throw new ClipJobError(error.message, error.status || 400);
        }
        const ready = await this._toolPreflight();
        if (!ready.ok) {
            const busy = ready.issues.some((issue) => /queued or running|using the GPU/i.test(issue));
            throw new ClipJobError(ready.issues.join(" "), busy ? 409 : 400);
        }
        if (!this.gpuTurn.tryAcquire("clip")) {
            throw new ClipJobError("A headless run is using the GPU.", 409);
        }
        let started = false;
        try {
            const id = this.idFactory();
            const directory = path.join(this.root, id);
            await fs.mkdir(directory, { recursive: true });
            const actionTapeHash = derived.actionTape ? simulationSha256(derived.actionTape) : null;
            const job = {
                id,
                directory,
                phase: "preflight",
                error: null,
                clipDirectory: null,
                summary: null,
                outputDirectory: null,
                startedAt: now(),
                finishedAt: null,
                abort: new AbortController(),
                request: requestSummary(request, actionTapeHash),
                resolution: derived.summary,
                derived,
            };
            await this._write(job);
            this.current = job;
            started = true;
            this.execution = this._executeResolved(job);
            return this.currentView();
        } finally {
            if (!started) this.gpuTurn.release("clip");
        }
    }

    async _startLegacy() {
        if (!this.gpuTurn.tryAcquire("clip")) {
            throw new ClipJobError("A headless run is using the GPU.", 409);
        }
        let started = false;
        try {
            const ready = await this._toolPreflight();
            if (!ready.ok) {
                const busy = ready.issues.some((issue) => /queued or running|using the GPU/i.test(issue));
                throw new ClipJobError(ready.issues.join(" "), busy ? 409 : 400);
            }
            const id = this.idFactory();
            const directory = path.join(this.root, id);
            await fs.mkdir(directory, { recursive: true });
            const job = {
                id,
                directory,
                phase: "preflight",
                error: null,
                clipDirectory: null,
                summary: null,
                outputDirectory: null,
                startedAt: now(),
                finishedAt: null,
                abort: new AbortController(),
            };
            await this._write(job);
            this.current = job;
            started = true;
            this.execution = this._executeLegacy(job);
            return this.currentView();
        } finally {
            if (!started) this.gpuTurn.release("clip");
        }
    }

    async cancel() {
        if (!this.current || !ACTIVE_PHASES.has(this.current.phase)) {
            throw new ClipJobError("No Cosmos clip is running.", 404);
        }
        this.current.abort?.abort();
        await this.execution;
        return this.currentView();
    }

    async openVideo(name) {
        const requested = String(name || "");
        if (!VIDEO_NAMES.has(requested) || path.basename(requested) !== requested) {
            throw new ClipJobError("Only rgb.mp4 and depth.mp4 can be downloaded.", 404);
        }
        const job = this.current;
        if (!job || job.phase !== "ready" || !job.clipDirectory) {
            throw new ClipJobError("No finished Cosmos clip is available.", 404);
        }
        const root = path.resolve(job.clipDirectory);
        const clipsRoot = path.resolve(this.root);
        const filePath = path.resolve(root, requested);
        if (root !== clipsRoot && !root.startsWith(`${clipsRoot}${path.sep}`)) {
            throw new ClipJobError("Clip directory is outside the artifact root.", 403);
        }
        if (filePath !== path.join(root, requested)) {
            throw new ClipJobError("Clip video path is not inside the clip directory.", 403);
        }
        try {
            await fs.access(filePath);
        } catch {
            throw new ClipJobError("Clip video is missing.", 404);
        }
        return { name: requested, path: filePath, stream: () => createReadStream(filePath) };
    }

    async _executeLegacy(job) {
        const signal = job.abort.signal;
        let released = false;
        const releaseGpu = () => {
            if (released) return;
            released = true;
            this.gpuTurn.release("clip");
        };
        try {
            if (signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
            await this._transition(job, { phase: "running" });
            const bundle = await this.createBundle();
            const event = await this.runner.run(bundle, {
                config: clipSupervisorConfig(this.renderer),
                episodeSpec: clipEpisodeSpec(),
                actions: clipActions(),
                artifactPolicy: { profile: "evaluation" },
                outputUri: path.join(job.directory, "output"),
                signal,
            });
            releaseGpu();
            await this._exportChecked(job, event, signal, {
                moduleArgs: [
                    "python3", "-m", "cev_sim.cosmos_clip", "export",
                    "--run-output", event?.outputDirectory,
                    "--camera-id", COSMOS_CLIP_CAMERA_ID,
                    "--window-index", "0",
                    "--output-root", path.join(job.directory, "clips"),
                ],
                checkModule: "cev_sim.cosmos_clip",
            });
        } catch (error) {
            releaseGpu();
            await this._fail(job, signal, error);
        }
    }

    async _executeResolved(job) {
        const signal = job.abort.signal;
        const derived = job.derived;
        let released = false;
        const releaseGpu = () => {
            if (released) return;
            released = true;
            this.gpuTurn.release("clip");
        };
        let packagePath = null;
        try {
            if (signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
            if (!this.supervisor) throw new ClipJobError("Headless supervisor is not available.", 400);
            await this._transition(job, { phase: "running" });
            const bundle = {
                kind: RUN_BUNDLE_KIND,
                version: RUN_BUNDLE_VERSION,
                exportedAt: now(),
                manifest: derived.resolved.manifest,
                resolved: derived.resolved,
                resolvedHash: derived.resolved.resolvedHash,
                simulationSemanticHash: derived.resolved.simulationSemanticHash,
            };
            const bundleBytes = Buffer.from(canonicalRunBundleStringify(bundle));
            if (derived.renderer === "pbr") {
                packagePath = await this._materializePackage(job, bundleBytes);
            }
            const outputUri = path.join(job.directory, "output");
            const event = derived.authority === "reference"
                ? await this._runReference(bundle, bundleBytes, packagePath, outputUri, signal)
                : await this.runner.replay(bundle, derived.actionTape, {
                    supervisor: this.supervisor,
                    episodeSpec: derived.episodeSpec,
                    artifactPolicy: { profile: "evaluation" },
                    outputUri,
                    signal,
                    packagePath,
                });
            releaseGpu();
            const contract = derived.summary.profile === "cosmos-nano" ? "cosmos-v2" : "camera";
            const checkModule = contract === "cosmos-v2" ? "cev_sim.cosmos_clip" : "cev_sim.clip";
            await this._exportChecked(job, event, signal, {
                moduleArgs: [
                    "python3", "-m", "cev_sim.clip", "export",
                    "--contract", contract,
                    "--run-output", event?.outputDirectory,
                    "--camera-id", derived.summary.cameraId,
                    "--window-index", "0",
                    "--output-root", path.join(job.directory, "clips"),
                    "--requested-duration-ns", String(derived.summary.requestedDurationNs),
                ],
                checkModule,
            });
        } catch (error) {
            releaseGpu();
            await this._fail(job, signal, error);
        } finally {
            if (packagePath) await fs.rm(packagePath, { force: true }).catch(() => {});
        }
    }

    async _runReference(bundle, bundleBytes, packagePath, outputUri, signal) {
        let assetAdmission = null;
        try {
            if (packagePath) assetAdmission = await this._admitPackage(packagePath, signal);
            return await this.runner.runManaged(bundle, {
                supervisor: this.supervisor,
                outputUri,
                signal,
                artifactPolicy: { profile: "evaluation" },
                assetAdmission,
                bundleBytes,
                bundleBytesHash: assetAdmission?.bundleBytesHash ?? null,
            });
        } finally {
            if (assetAdmission?.handle) {
                await this.supervisor.releaseAssetAdmission({ handle: assetAdmission.handle }).catch(() => {});
            }
        }
    }

    async _materializePackage(job, bundleBytes) {
        if (!this.storage?.exportRunPackage) {
            throw new ClipJobError("PBR clips require run-package export.", 400);
        }
        const exported = await this.storage.exportRunPackage({ bundleBytes });
        const packagePath = path.join(job.directory, "clip.run-package");
        const handle = await fs.open(packagePath, "w");
        try {
            for await (const chunk of exported.stream) {
                await handle.write(chunk);
            }
        } finally {
            await handle.close();
        }
        await exported.completion;
        return packagePath;
    }

    async _admitPackage(packagePath, signal) {
        const inbox = this.supervisor.config?.assetAdmission?.inboxDir;
        if (!inbox) throw new ClipJobError("PBR asset admission is not configured.", 400);
        const staged = await stageRunPackage(packagePath, inbox, { signal });
        try {
            const admitted = await this.supervisor.admitRunPackage({
                clientProtocol: HEADLESS_PROTOCOL,
                stagingId: staged.stagingId,
                archiveHash: staged.archiveHash,
            });
            if (Number(admitted?.error?.code) !== ERROR_CODE.OK) {
                throw new ClipJobError(admitted?.error?.message || "Run package admission failed.", 400);
            }
            return admitted.admission;
        } finally {
            await fs.rm(staged.path, { force: true }).catch(() => {});
        }
    }

    async _exportChecked(job, event, signal, { moduleArgs, checkModule }) {
        if (signal.aborted) throw Object.assign(new Error("Cancelled."), { name: "AbortError" });
        const outputDirectory = event?.outputDirectory;
        if (!outputDirectory) throw new Error("The headless run did not publish an output directory.");
        await this._transition(job, { phase: "exporting", outputDirectory });
        const clipsRoot = path.join(job.directory, "clips");
        await fs.mkdir(clipsRoot, { recursive: true });
        const args = moduleArgs.map((entry) => (entry == null ? "" : entry));
        const printed = await this.runProcess(args, { signal, env: this._pythonEnv(), cwd: REPOSITORY_ROOT });
        const clipDirectory = printed.split(/\r?\n/).filter(Boolean).at(-1);
        if (!clipDirectory) throw new Error("The clip exporter did not print a directory.");
        const summary = JSON.parse(await this.runProcess([
            "python3", "-m", checkModule, "check", clipDirectory,
        ], { signal, env: this._pythonEnv(), cwd: REPOSITORY_ROOT }));
        await this._transition(job, {
            phase: "ready",
            clipDirectory,
            summary,
            error: null,
            finishedAt: now(),
        });
    }

    async _fail(job, signal, error) {
        await fs.rm(path.join(job.directory, "clips"), { recursive: true, force: true }).catch(() => {});
        const cancelled = signal.aborted || error?.name === "AbortError";
        await this._transition(job, {
            phase: cancelled ? "cancelled" : "failed",
            error: cancelled ? "Cancelled." : error.message,
            clipDirectory: null,
            summary: null,
            finishedAt: now(),
        });
    }

    _pythonEnv() {
        const source = path.join(REPOSITORY_ROOT, "python/src");
        return {
            ...process.env,
            PYTHONPATH: [source, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        };
    }

    async _transition(job, patch) {
        Object.assign(job, patch);
        await this._write(job);
    }

    async _write(job) {
        const file = path.join(job.directory, "status.json");
        const temporary = path.join(job.directory, `.status-${randomUUID()}.json`);
        await fs.writeFile(temporary, `${JSON.stringify(publicState(job), null, 2)}\n`);
        await fs.rename(temporary, file);
    }
}
