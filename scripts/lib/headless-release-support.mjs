import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
    measuredPerceptionProfileRef,
    measuredStateProfileRef,
    routeSafetyProfileRef,
} from "../../app/simulation/headless/ProfileRegistry.js";
import { namedTensor, tensorMap } from "../../app/simulation/headless/TensorProtocol.js";
import { createCpuLidarBackendSelection } from "../../app/simulation/sensors/CpuLidarBackend.js";
import { createStateSensorBackendSelection } from "../../app/simulation/sensors/StateSensorBackend.js";
import { canonicalStringify } from "../../app/simulation/RunManifest.js";
import { loadHeadlessGrpcSchema } from "../../server/headless/GrpcSchema.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { createHeadlessImu, createPortableHeadlessBundle } from "../../tests/helpers/headlessRunnerBundle.js";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function parseOptions(argv, defaults = {}) {
    const options = { ...defaults };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (!value.startsWith("--")) throw new Error(`Unexpected argument ${value}.`);
        const [rawKey, inline] = value.slice(2).split("=", 2);
        const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        if (["quick", "promoteBaseline", "skipPython", "requireGpu", "verifyOnly"].includes(key)) {
            options[key] = true;
            continue;
        }
        const next = inline ?? argv[++index];
        if (next === undefined || next.startsWith("--")) throw new Error(`Option --${rawKey} requires a value.`);
        options[key] = next;
    }
    return options;
}

export async function temporaryRoot(prefix) {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? REPOSITORY_ROOT,
            env: { ...process.env, ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.stdin.end(options.input ?? "");
    });
}

export function clientCall(client, method, request) {
    return new Promise((resolve, reject) => client[method](request, (error, response) => error ? reject(error) : resolve(response)));
}

export function createGrpcClient(socket, maxMessageBytes = 64 * 1024 * 1024) {
    const { grpc, service } = loadHeadlessGrpcSchema();
    return new service(`unix:${socket}`, grpc.credentials.createInsecure(), {
        "grpc.max_receive_message_length": maxMessageBytes,
        "grpc.max_send_message_length": maxMessageBytes,
    });
}

export function episodeSpec(environmentIndex, bundleId, bundle, overrides = {}) {
    const sensors = bundle.resolved.manifest.sensorRig.sensors.filter((sensor) => sensor.enabled !== false);
    const requestsLidar = sensors.some((sensor) => sensor.type === "lidar3d");
    return {
        environmentIndex,
        environmentId: `environment-${environmentIndex}`,
        runBundleId: bundleId,
        resetSeed: String(overrides.resetSeed ?? environmentIndex),
        actionRepeat: Number(overrides.actionRepeat ?? 1),
        maxEpisodeSteps: String(overrides.maxEpisodeSteps ?? 0),
        observationProfile: overrides.perception === true || requestsLidar
            ? measuredPerceptionProfileRef()
            : measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef(),
        backendSelections: [
            ...bundle.resolved.backendSelections,
            createStateSensorBackendSelection(),
            ...(requestsLidar ? [createCpuLidarBackendSelection()] : []),
        ],
    };
}

export function bundleEnvelope(bundleId, bundle) {
    return {
        bundleId,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        canonicalJson: Buffer.from(canonicalStringify(bundle)),
    };
}

export function actionMessage(environmentIndex, action = [0, 0]) {
    return {
        environmentIndex,
        action: tensorMap([namedTensor("action", "float32", [2], action)]),
    };
}

export async function createStateBundle(options = {}) {
    return createPortableHeadlessBundle({
        sensors: [createHeadlessImu()],
        triggers: options.triggers ?? [],
        completion: options.completion ?? { conditions: [] },
    });
}

export async function createLidarBundle(options = {}) {
    const resolvedDefault = await new StorageService().resolveRunManifest("igvc-default");
    const lidar = structuredClone(resolvedDefault.manifest.sensorRig.sensors.find((sensor) => sensor.type === "lidar3d"));
    lidar.rateHz = 60;
    lidar.phaseNs = 0;
    lidar.calibration.azimuth = options.fullResolution
        ? { startDeg: -180, endDeg: 180, stepDeg: 1 }
        : { startDeg: -45, endDeg: 46, stepDeg: 45 };
    lidar.calibration.elevation = options.fullResolution
        ? { startDeg: -20, endDeg: 20, stepDeg: 1 }
        : { startDeg: 0, endDeg: 1, stepDeg: 1 };
    lidar.calibration.products.pointCloud = true;
    lidar.calibration.products.semanticPointCloud = true;
    lidar.noise = {
        ...lidar.noise,
        dropoutProbability: 0,
        pointDropoutProbability: 0,
        bias: 0,
        standardDeviation: 0,
    };
    return createPortableHeadlessBundle({
        sensors: [createHeadlessImu(), lidar],
        triggers: options.triggers ?? [],
        completion: options.completion ?? { conditions: [] },
    });
}

export function processProvenance(extra = {}) {
    return {
        runtime: "cev-sim",
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        ci: Boolean(process.env.CI),
        runner: process.env.RUNNER_NAME || null,
        gitHash: process.env.GITHUB_SHA || process.env.GIT_HASH || null,
        ...extra,
    };
}

export async function writeReport(report, output) {
    const serialized = `${canonicalStringify(report)}\n`;
    if (output) {
        await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
        await fs.writeFile(path.resolve(output), serialized);
    }
    process.stdout.write(serialized);
}

export async function waitForProcessExit(pids, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const live = pids.filter((pid) => {
            try { process.kill(pid, 0); return true; } catch { return false; }
        });
        if (live.length === 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
}
