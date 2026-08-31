#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { SOAK_REPORT_KIND, createReport, percentile } from "../server/headless/ReleaseReports.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import {
    actionMessage,
    bundleEnvelope,
    clientCall,
    createGrpcClient,
    createLidarBundle,
    createStateBundle,
    episodeSpec,
    parseOptions,
    processProvenance,
    temporaryRoot,
    waitForProcessExit,
    writeReport,
} from "./lib/headless-release-support.mjs";

const MiB = 1024 * 1024;
const FINISH_TRIGGER = [{
    id: "finish", name: "Finish", enabled: true, once: true,
    condition: { kind: "step", step: 1 }, actions: [{ kind: "finish" }],
}];

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
    return parsed;
}

function environmentCounts(value) {
    return String(value).split(",").map((entry) => positiveInteger(entry.trim(), "environment count"));
}

function workerSnapshot(batch) {
    const health = batch.environments.map((environment) => environment.worker.health || environment.health || {});
    return {
        rssByEnvironment: health.map((entry) => Number(entry.rssBytes || 0)),
        rssBytes: health.reduce((total, entry) => total + Number(entry.rssBytes || 0), 0),
        heapBytes: health.reduce((total, entry) => total + Number(entry.heapBytes || 0), 0),
        queueBytes: health.reduce((total, entry) => total + Number(entry.queueBytes || 0), 0),
        sensorQueueBytes: health.reduce((total, entry) => total + Number(entry.sensorQueueBytes || 0), 0),
        inputQueueBytes: health.reduce((total, entry) => total + Number(entry.inputQueueBytes || 0), 0),
        recordingQueueBytes: health.reduce((total, entry) => total + Number(entry.recordingQueueBytes || 0), 0),
    };
}

async function sha256File(file) {
    const bytes = await fs.readFile(file);
    return createHash("sha256").update(bytes).digest("hex");
}

async function artifactsReadable(results) {
    for (const result of results) {
        for (const artifact of result.artifacts) {
            const stat = await fs.stat(artifact.uri);
            if (!stat.isFile() || stat.size !== Number(artifact.sizeBytes)) return false;
            if (await sha256File(artifact.uri) !== artifact.sha256) return false;
            if (artifact.name.endsWith(".json")) JSON.parse(await fs.readFile(artifact.uri, "utf8"));
        }
    }
    return true;
}

async function residualPaths(root) {
    const found = [];
    async function visit(directory) {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith(".") && entry.name.includes("tmp")) found.push(target);
                await visit(target);
            } else if (entry.name.endsWith(".partial") || entry.name.includes("shared-tensor")) {
                found.push(target);
            }
        }
    }
    await visit(root);
    return found;
}

async function runArtifactProfileChecks(running, client, bundle, failureBundle, artifactRoot) {
    const cases = [
        {
            id: "evaluation-full",
            artifactPolicy: { profile: 1, fullSflogSampleRate: 0 },
            expectedSflog: true,
        },
        {
            id: "training-sampled",
            artifactPolicy: { profile: 2, fullSflogSampleRate: 1, fullSflogOnFailure: false },
            expectedSflog: true,
        },
        {
            id: "training-unsampled",
            artifactPolicy: { profile: 2, fullSflogSampleRate: 0, fullSflogOnFailure: false },
            expectedSflog: false,
        },
        {
            id: "training-failure-promoted",
            artifactPolicy: { profile: 2, fullSflogSampleRate: 0, fullSflogOnFailure: true },
            expectedSflog: true,
            failure: true,
        },
    ];
    const results = [];
    for (const entry of cases) {
        const outputUri = path.join(artifactRoot, `profile-${entry.id}`);
        const caseBundle = entry.failure ? failureBundle : bundle;
        const spec = episodeSpec(0, caseBundle.resolvedHash, caseBundle);
        const created = await clientCall(client, "createBatch", {
            clientProtocol: { major: 1, minor: 2 },
            runBundles: [bundleEnvelope(caseBundle.resolvedHash, caseBundle)],
            episodes: [spec],
            artifactPolicy: { ...entry.artifactPolicy, outputUri },
        });
        if (created.error.code !== 0) throw new Error(created.error.message);
        const batchId = created.batch.batchId;
        const batch = running.supervisor.batches.get(batchId);
        const pids = batch.environments.map((environment) => environment.worker.pid);
        let closed = false;
        try {
            const reset = await clientCall(client, "resetBatch", { batchId, episodes: [spec] });
            if (reset.error.code !== 0 || reset.results[0].error.code !== 0) {
                throw new Error(reset.error.message || reset.results[0].error.message);
            }
            const stepped = await clientCall(client, "stepBatch", { batchId, actions: [actionMessage(0)] });
            if (stepped.error.code !== 0 || stepped.results[0].error.code !== 0) {
                throw new Error(stepped.error.message || stepped.results[0].error.message);
            }
            const finalized = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [0] });
            if (finalized.error.code !== 0 || finalized.results[0].error.code !== 0) {
                throw new Error(finalized.error.message || finalized.results[0].error.message);
            }
            const result = finalized.results[0];
            const hasSflog = result.artifacts.some((artifact) => artifact.name.endsWith(".sflog"));
            const readable = await artifactsReadable([result]);
            const semanticResultPassed = result.passed === true;
            const semanticStatusCorrect = semanticResultPassed === !entry.failure;
            const close = await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false });
            if (close.error.code !== 0) throw new Error(close.error.message);
            closed = true;
            const workersExited = await waitForProcessExit(pids);
            results.push({
                id: entry.id,
                expectedSflog: entry.expectedSflog,
                hasSflog,
                artifactsReadable: readable,
                workersExited,
                semanticResultPassed,
                semanticStatusCorrect,
                passed: hasSflog === entry.expectedSflog && readable && workersExited && semanticStatusCorrect,
            });
        } finally {
            if (!closed) await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false }).catch(() => {});
        }
    }
    return results;
}

async function runSharedMemoryCleanupCheck(running, client, bundle, artifactRoot) {
    const spec = episodeSpec(0, bundle.resolvedHash, bundle, { perception: true });
    const created = await clientCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 2 },
        runBundles: [bundleEnvelope(bundle.resolvedHash, bundle)],
        episodes: [spec],
        artifactPolicy: { profile: 3, outputUri: path.join(artifactRoot, "shared-memory") },
    });
    if (created.error.code !== 0) throw new Error(created.error.message);
    const batchId = created.batch.batchId;
    const batch = running.supervisor.batches.get(batchId);
    const pids = batch.environments.map((environment) => environment.worker.pid);
    const arenaDirectory = batch.environments[0].sharedArena?.directory;
    const regions = [];
    let finalizedResult = null;
    let zeroQueues = false;
    let closed = false;
    try {
        const reset = await clientCall(client, "resetBatch", { batchId, episodes: [spec] });
        if (reset.error.code !== 0 || reset.results[0].error.code !== 0) {
            throw new Error(reset.error.message || reset.results[0].error.message);
        }
        const stepped = await clientCall(client, "stepBatch", { batchId, actions: [actionMessage(0)] });
        if (stepped.error.code !== 0 || stepped.results[0].error.code !== 0) {
            throw new Error(stepped.error.message || stepped.results[0].error.message);
        }
        for (const result of [reset.results[0], stepped.results[0]]) {
            for (const entry of result.observation.entries) {
                const region = entry.tensor.payload.sharedMemory?.regionName;
                if (region) regions.push(region);
            }
        }
        const finalized = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [0] });
        if (finalized.error.code !== 0 || finalized.results[0].error.code !== 0) {
            throw new Error(finalized.error.message || finalized.results[0].error.message);
        }
        finalizedResult = finalized.results[0];
        zeroQueues = workerSnapshot(batch).queueBytes === 0;
        const close = await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false });
        if (close.error.code !== 0) throw new Error(close.error.message);
        closed = true;
    } finally {
        if (!closed) await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false }).catch(() => {});
    }
    const workersExited = await waitForProcessExit(pids);
    const regionFilesRemoved = regions.length > 0 && (await Promise.all(regions.map(async (region) => (
        fs.access(region).then(() => false, (error) => error.code === "ENOENT")
    )))).every(Boolean);
    const arenaDirectoryRemoved = Boolean(arenaDirectory) && await fs.access(arenaDirectory)
        .then(() => false, (error) => error.code === "ENOENT");
    const artifactsAreReadable = await artifactsReadable([finalizedResult]);
    const checks = {
        observationExternalized: regions.length >= 2,
        regionFilesRemoved,
        arenaDirectoryRemoved,
        zeroQueues,
        artifactsReadable: artifactsAreReadable,
        workersExited,
    };
    return {
        observedRegionReferences: regions.length,
        checks,
        passed: Object.values(checks).every(Boolean),
    };
}

async function runCount(count, configuration, running, client, bundle, artifactRoot) {
    const bundleId = bundle.resolvedHash;
    const episodes = Array.from({ length: count }, (_, index) => episodeSpec(index, bundleId, bundle));
    const created = await clientCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 2 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        artifactPolicy: { profile: 3, outputUri: artifactRoot },
    });
    if (created.error.code !== 0) throw new Error(created.error.message);
    const batchId = created.batch.batchId;
    const batch = running.supervisor.batches.get(batchId);
    const pids = batch.environments.map((entry) => entry.worker.pid);
    const actions = episodes.map((entry) => actionMessage(entry.environmentIndex));
    const rss = [];
    const heap = [];
    const rssByEnvironment = [];
    const queues = [];
    const artifacts = [];
    let closed = false;
    try {
        const totalCycles = configuration.warmupCycles + configuration.measuredCycles;
        for (let cycle = 0; cycle < totalCycles; cycle += 1) {
            const resetEpisodes = episodes.map((entry, index) => ({
                ...entry,
                resetSeed: String(cycle * count + index),
            }));
            const reset = await clientCall(client, "resetBatch", { batchId, episodes: resetEpisodes });
            if (reset.error.code !== 0 || reset.results.some((entry) => entry.error.code !== 0)) {
                throw new Error(reset.error.message || reset.results.find((entry) => entry.error.code !== 0)?.error.message);
            }
            const stepped = await clientCall(client, "stepBatch", { batchId, actions });
            if (stepped.error.code !== 0 || stepped.results.some((entry) => entry.error.code !== 0)) {
                throw new Error(stepped.error.message || stepped.results.find((entry) => entry.error.code !== 0)?.error.message);
            }
            const finalized = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [] });
            if (finalized.error.code !== 0 || finalized.results.some((entry) => entry.error.code !== 0)) {
                throw new Error(finalized.error.message || finalized.results.find((entry) => entry.error.code !== 0)?.error.message);
            }
            if (cycle >= configuration.warmupCycles) {
                const snapshot = workerSnapshot(batch);
                rss.push(snapshot.rssBytes);
                heap.push(snapshot.heapBytes);
                rssByEnvironment.push(snapshot.rssByEnvironment);
                queues.push(snapshot);
                artifacts.push(...finalized.results);
            }
        }
        const close = await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false });
        if (close.error.code !== 0) throw new Error(close.error.message);
        closed = true;
    } finally {
        if (!closed) await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false }).catch(() => {});
    }
    const workersExited = await waitForProcessExit(pids);
    const window = Math.max(1, Math.min(5, Math.floor(rss.length / 2)));
    const perEnvironmentMemory = Array.from({ length: count }, (_, environmentIndex) => {
        const samples = rssByEnvironment.map((entry) => entry[environmentIndex]);
        const initialRssBytes = percentile(samples.slice(0, window), 0.5) ?? 0;
        const finalRssBytes = percentile(samples.slice(-window), 0.5) ?? 0;
        const rssAllowanceBytes = Math.max(64 * MiB, initialRssBytes * 0.1);
        return {
            environmentIndex,
            initialRssBytes,
            finalRssBytes,
            rssGrowthBytes: finalRssBytes - initialRssBytes,
            rssAllowanceBytes,
            bounded: finalRssBytes <= initialRssBytes + rssAllowanceBytes,
        };
    });
    const initialRss = perEnvironmentMemory.reduce((total, entry) => total + entry.initialRssBytes, 0);
    const finalRss = perEnvironmentMemory.reduce((total, entry) => total + entry.finalRssBytes, 0);
    const rssAllowance = perEnvironmentMemory.reduce((total, entry) => total + entry.rssAllowanceBytes, 0);
    const residual = await residualPaths(artifactRoot);
    const readable = await artifactsReadable(artifacts);
    const zeroQueues = queues.every((entry) => (
        entry.queueBytes === 0
        && entry.sensorQueueBytes === 0
        && entry.inputQueueBytes === 0
        && entry.recordingQueueBytes === 0
    ));
    const checks = {
        zeroQueues,
        workersExited,
        noResidualSharedMemoryOrStaging: residual.length === 0,
        artifactsReadable: readable,
        boundedRss: perEnvironmentMemory.every((entry) => entry.bounded),
    };
    return {
        environmentCount: count,
        warmupCycles: configuration.warmupCycles,
        measuredCycles: configuration.measuredCycles,
        memory: {
            initialWindowRssBytes: initialRss,
            finalWindowRssBytes: finalRss,
            rssGrowthBytes: finalRss - initialRss,
            rssAllowanceBytes: rssAllowance,
            peakRssBytes: Math.max(...rss, 0),
            peakHeapBytes: Math.max(...heap, 0),
            perEnvironment: perEnvironmentMemory,
        },
        cleanup: {
            residualPaths: residual,
            maximumQueueBytes: Math.max(...queues.map((entry) => entry.queueBytes), 0),
        },
        checks,
        passed: Object.values(checks).every(Boolean),
    };
}

async function main() {
    const options = parseOptions(process.argv.slice(2), {
        environmentCounts: "1,8,16,32",
        warmupCycles: "5",
        measuredCycles: "25",
        output: null,
        quick: false,
    });
    const configuration = options.quick ? {
        environmentCounts: [1],
        warmupCycles: 1,
        measuredCycles: 2,
    } : {
        environmentCounts: environmentCounts(options.environmentCounts),
        warmupCycles: positiveInteger(options.warmupCycles, "warmup cycles"),
        measuredCycles: positiveInteger(options.measuredCycles, "measured cycles"),
    };
    const root = await temporaryRoot("cev-headless-soak-");
    const socket = path.join(root, "supervisor.sock");
    const artifactRoot = path.join(root, "artifacts");
    const running = await startHeadlessSupervisor({ socket, preset: "permissive" });
    const client = createGrpcClient(socket, running.config.maxRpcMessageBytes);
    try {
        const bundle = await createStateBundle({ triggers: FINISH_TRIGGER });
        const runs = [];
        for (const count of configuration.environmentCounts) {
            runs.push(await runCount(count, configuration, running, client, bundle, artifactRoot));
        }
        const artifactProfiles = await runArtifactProfileChecks(
            running,
            client,
            bundle,
            await createStateBundle(),
            artifactRoot,
        );
        const sharedMemory = await runSharedMemoryCleanupCheck(
            running,
            client,
            await createLidarBundle({ fullResolution: true }),
            artifactRoot,
        );
        const report = createReport(SOAK_REPORT_KIND, {
            provenance: processProvenance(),
            protocol: { major: 1, minor: 2 },
            configuration,
            runs,
            artifactProfiles,
            sharedMemory,
            passed: runs.every((entry) => entry.passed)
                && artifactProfiles.every((entry) => entry.passed)
                && sharedMemory.passed,
        });
        await writeReport(report, options.output);
        if (!report.passed) process.exitCode = 1;
    } finally {
        client.close();
        await running.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
