#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import {
    BENCHMARK_REPORT_KIND,
    compareBenchmarkReports,
    createReport,
    percentile,
} from "../server/headless/ReleaseReports.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import {
    actionMessage,
    bundleEnvelope,
    clientCall,
    createGrpcClient,
    createStateBundle,
    episodeSpec,
    parseOptions,
    processProvenance,
    temporaryRoot,
    waitForProcessExit,
    writeReport,
} from "./lib/headless-release-support.mjs";

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
    return parsed;
}

function counts(value) {
    const result = String(value).split(",").map((entry) => positiveInteger(entry.trim(), "environment count"));
    if (new Set(result).size !== result.length) throw new Error("Environment counts must be unique.");
    return result;
}

function duration(start) {
    return performance.now() - start;
}

function workerResources(batch) {
    const health = batch.environments.map((environment) => environment.worker.health || environment.health || {});
    return {
        rssBytes: health.reduce((total, entry) => total + Number(entry.rssBytes || 0), 0),
        heapBytes: health.reduce((total, entry) => total + Number(entry.heapBytes || 0), 0),
        cpuMicros: health.reduce((total, entry) => (
            total + Number(entry.cpuUserMicros || 0) + Number(entry.cpuSystemMicros || 0)
        ), 0),
        queueBytes: health.reduce((total, entry) => total + Number(entry.queueBytes || 0), 0),
    };
}

function latencySummary(values) {
    return {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
    };
}

async function benchmarkCount(environmentCount, configuration, running, client, bundle, artifactRoot) {
    const bundleId = bundle.resolvedHash;
    const episodes = Array.from({ length: environmentCount }, (_, index) => (
        episodeSpec(index, bundleId, bundle, { resetSeed: index, actionRepeat: 1 })
    ));
    const created = await clientCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 2 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        artifactPolicy: { profile: 1, outputUri: artifactRoot },
    });
    if (created.error.code !== 0) throw new Error(created.error.message);
    const batchId = created.batch.batchId;
    const batch = running.supervisor.batches.get(batchId);
    const workerPids = batch.environments.map((entry) => entry.worker.pid);
    const actions = episodes.map((entry) => actionMessage(entry.environmentIndex));
    const resetLatencies = [];
    const policyLatencies = [];
    const rssSamples = [];
    const heapSamples = [];
    let measuredWallMs = 0;
    let workerCpuMicros = 0;
    let supervisorCpuMicros = 0;
    let artifactBytes = 0;
    let artifactWallMs = 0;
    let teardownMs = 0;
    let finalQueueBytes = 0;
    try {
        for (let repetition = 0; repetition < configuration.repetitions; repetition += 1) {
            const resetEpisodes = episodes.map((entry, index) => ({
                ...entry,
                resetSeed: String(repetition * environmentCount + index),
            }));
            let started = performance.now();
            const reset = await clientCall(client, "resetBatch", { batchId, episodes: resetEpisodes });
            resetLatencies.push(duration(started));
            if (reset.error.code !== 0 || reset.results.some((entry) => entry.error.code !== 0)) {
                throw new Error(reset.error.message || reset.results.find((entry) => entry.error.code !== 0)?.error.message);
            }
            for (let step = 0; step < configuration.warmupSteps; step += 1) {
                const warmed = await clientCall(client, "stepBatch", { batchId, actions });
                if (warmed.error.code !== 0 || warmed.results.some((entry) => entry.error.code !== 0)) {
                    throw new Error(warmed.error.message || warmed.results.find((entry) => entry.error.code !== 0)?.error.message);
                }
            }
            const beforeWorkers = workerResources(batch);
            const beforeSupervisor = process.cpuUsage();
            const measuredStart = performance.now();
            for (let step = 0; step < configuration.sampleSteps; step += 1) {
                started = performance.now();
                const response = await clientCall(client, "stepBatch", { batchId, actions });
                policyLatencies.push(duration(started));
                if (response.error.code !== 0 || response.results.some((entry) => entry.error.code !== 0)) {
                    throw new Error(response.error.message || response.results.find((entry) => entry.error.code !== 0)?.error.message);
                }
                const resources = workerResources(batch);
                const supervisorMemory = process.memoryUsage();
                rssSamples.push(resources.rssBytes + supervisorMemory.rss);
                heapSamples.push(resources.heapBytes + supervisorMemory.heapUsed);
            }
            measuredWallMs += duration(measuredStart);
            const afterWorkers = workerResources(batch);
            const afterSupervisor = process.cpuUsage();
            workerCpuMicros += Math.max(0, afterWorkers.cpuMicros - beforeWorkers.cpuMicros);
            supervisorCpuMicros += Math.max(0, afterSupervisor.user - beforeSupervisor.user)
                + Math.max(0, afterSupervisor.system - beforeSupervisor.system);
            started = performance.now();
            const finalized = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [] });
            artifactWallMs += duration(started);
            if (finalized.error.code !== 0 || finalized.results.some((entry) => entry.error.code !== 0)) {
                throw new Error(finalized.error.message || finalized.results.find((entry) => entry.error.code !== 0)?.error.message);
            }
            artifactBytes += finalized.results.flatMap((entry) => entry.artifacts)
                .reduce((total, entry) => total + Number(entry.sizeBytes || 0), 0);
            finalQueueBytes = workerResources(batch).queueBytes;
        }
    } finally {
        const closeStart = performance.now();
        await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false });
        teardownMs = duration(closeStart);
    }
    const workersExited = await waitForProcessExit(workerPids);
    const transitions = environmentCount * configuration.sampleSteps * configuration.repetitions;
    const steadyWindow = rssSamples.slice(-Math.max(1, Math.ceil(rssSamples.length / 10)));
    const steadyHeapWindow = heapSamples.slice(-Math.max(1, Math.ceil(heapSamples.length / 10)));
    return {
        environmentCount,
        repetitions: configuration.repetitions,
        warmupSteps: configuration.warmupSteps,
        sampleSteps: configuration.sampleSteps,
        actionRepeat: 1,
        throughput: {
            fixedStepsPerSecond: transitions / (measuredWallMs / 1_000),
            policyTransitionsPerSecond: transitions / (measuredWallMs / 1_000),
        },
        policyLatencyMs: latencySummary(policyLatencies),
        resetLatencyMs: latencySummary(resetLatencies),
        cpu: {
            supervisorMicros: supervisorCpuMicros,
            workersMicros: workerCpuMicros,
            totalMicros: supervisorCpuMicros + workerCpuMicros,
        },
        memory: {
            scope: "supervisor-plus-workers",
            peakRssBytes: Math.max(...rssSamples, 0),
            steadyRssBytes: percentile(steadyWindow, 0.5),
            peakHeapBytes: Math.max(...heapSamples, 0),
            steadyHeapBytes: percentile(steadyHeapWindow, 0.5),
        },
        artifacts: {
            profile: "evaluation",
            bytes: artifactBytes,
            finalizationMs: artifactWallMs,
            bytesPerSecond: artifactWallMs > 0 ? artifactBytes / (artifactWallMs / 1_000) : 0,
        },
        cleanup: {
            teardownMs,
            workersExited,
            queueBytes: finalQueueBytes,
        },
    };
}

async function main() {
    const options = parseOptions(process.argv.slice(2), {
        environmentCounts: "1,8,16,32",
        warmupSteps: "32",
        sampleSteps: "256",
        repetitions: "5",
        output: null,
        baseline: null,
        promoteBaseline: false,
        quick: false,
    });
    if (options.promoteBaseline && !options.baseline) throw new Error("--promote-baseline requires --baseline.");
    const configuration = options.quick ? {
        environmentCounts: [1],
        warmupSteps: 1,
        sampleSteps: 2,
        repetitions: 1,
    } : {
        environmentCounts: counts(options.environmentCounts),
        warmupSteps: positiveInteger(options.warmupSteps, "warmup steps"),
        sampleSteps: positiveInteger(options.sampleSteps, "sample steps"),
        repetitions: positiveInteger(options.repetitions, "repetitions"),
    };
    const root = await temporaryRoot("cev-headless-benchmark-");
    const socket = path.join(root, "supervisor.sock");
    const artifactRoot = path.join(root, "artifacts");
    const running = await startHeadlessSupervisor({ socket, preset: "permissive" });
    const client = createGrpcClient(socket, running.config.maxRpcMessageBytes);
    try {
        const bundle = await createStateBundle();
        const runs = [];
        for (const environmentCount of configuration.environmentCounts) {
            runs.push(await benchmarkCount(environmentCount, configuration, running, client, bundle, artifactRoot));
        }
        let report = createReport(BENCHMARK_REPORT_KIND, {
            provenance: processProvenance(),
            protocol: { major: 1, minor: 2 },
            configuration,
            runs,
            passed: runs.every((entry) => entry.cleanup.workersExited && entry.cleanup.queueBytes === 0),
        });
        if (options.baseline) {
            try {
                const baseline = JSON.parse(await fs.readFile(path.resolve(options.baseline), "utf8"));
                const regression = compareBenchmarkReports(baseline, report);
                report = { ...report, regression, passed: report.passed && regression.ok };
            } catch (error) {
                if (error.code !== "ENOENT" || !options.promoteBaseline) throw error;
                report = { ...report, regression: { ok: true, promotedInitialBaseline: true, comparisons: [] } };
            }
        }
        await writeReport(report, options.output);
        if (options.promoteBaseline && report.passed) {
            await fs.mkdir(path.dirname(path.resolve(options.baseline)), { recursive: true });
            await fs.writeFile(path.resolve(options.baseline), `${JSON.stringify(report)}\n`);
        }
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
