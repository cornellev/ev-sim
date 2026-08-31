#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { decodeTopicValue } from "../app/client/Client.js";
import { HeadlessEpisode } from "../app/simulation/headless/HeadlessEpisode.js";
import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import {
    PARITY_REPORT_KIND,
    PARITY_TOLERANCES,
    createReport,
    reportSha256,
} from "../server/headless/ReleaseReports.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import {
    REPOSITORY_ROOT,
    actionMessage,
    bundleEnvelope,
    clientCall,
    createGrpcClient,
    createLidarBundle,
    createStateBundle,
    episodeSpec,
    parseOptions,
    processProvenance,
    run,
    temporaryRoot,
    writeReport,
} from "./lib/headless-release-support.mjs";

const DTYPE_NAMES = Object.freeze({
    1: "float32",
    2: "float64",
    3: "int8",
    4: "uint8",
    5: "int16",
    6: "uint16",
    7: "int32",
    8: "uint32",
    9: "int64",
    10: "uint64",
    11: "bool",
});

const DTYPE_BYTES = Object.freeze({
    float32: 4,
    float64: 8,
    int8: 1,
    uint8: 1,
    int16: 2,
    uint16: 2,
    int32: 4,
    uint32: 4,
    int64: 8,
    uint64: 8,
    bool: 1,
});

const ACTIONS = Object.freeze([
    [0, 0],
    [0.25, 0.1],
    [0.5, -0.15],
    [0.1, 0],
]);

const FINISH_TRIGGER = Object.freeze([{
    id: "finish",
    name: "Finish",
    enabled: true,
    once: true,
    condition: { kind: "step", step: ACTIONS.length },
    actions: [{ kind: "finish" }],
}]);

function packedBytes(value) {
    if (Buffer.isBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value?.encoding === "base64") return Buffer.from(value.data, "base64");
    if (value?.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
    if (typeof value === "string") return Buffer.from(value, "base64");
    throw new Error("Parity observation contains an unsupported packed tensor payload.");
}

function observationProjection(observation) {
    if (Array.isArray(observation)) return observation;
    return (observation?.entries || []).map((entry) => ({
        name: entry.name,
        dtype: DTYPE_NAMES[Number(entry.tensor.spec.dtype)] ?? String(entry.tensor.spec.dtype),
        shape: (entry.tensor.spec.shape || []).map(Number),
        data: packedBytes(entry.tensor.payload.packedData).toString("base64"),
    }));
}

function normalizeTransition(transition) {
    const info = transition.info || {};
    return {
        observation: observationProjection(transition.observation),
        reward: Number(transition.reward),
        terminated: Boolean(transition.terminated),
        truncated: Boolean(transition.truncated),
        episodeHash: info.episodeHash ?? info.episode_hash,
        trajectoryHash: info.trajectoryHash ?? info.trajectory_hash,
        step: Number(info.step),
        simulationTimeNs: Number(info.simulationTimeNs ?? info.simulation_time_ns),
    };
}

function normalizeSource(source) {
    const resetInfo = source.reset.info || {};
    const final = source.final?.result ?? source.final ?? {};
    return {
        id: source.id,
        reset: {
            observation: observationProjection(source.reset.observation),
            episodeHash: resetInfo.episodeHash ?? resetInfo.episode_hash,
            resolvedHash: resetInfo.resolvedHash ?? resetInfo.resolved_hash,
        },
        transitions: source.transitions.map(normalizeTransition),
        final: {
            episodeHash: final.episodeHash ?? final.episode_hash,
            trajectoryHash: final.trajectoryHash ?? final.trajectory_hash,
            passed: Boolean(final.passed),
        },
        cpuLidarEvidence: source.cpuLidarEvidence ?? null,
    };
}

function exactProjection(source) {
    return {
        reset: source.reset,
        transitions: source.transitions,
        final: source.final,
    };
}

function exactComparisons(sources) {
    const baseline = exactProjection(sources[0]);
    return sources.slice(1).map((source) => {
        const expected = canonicalStringify(baseline);
        const actual = canonicalStringify(exactProjection(source));
        return {
            expectedSource: sources[0].id,
            actualSource: source.id,
            ok: expected === actual,
            expectedSha256: reportSha256(expected),
            actualSha256: reportSha256(actual),
        };
    });
}

function decodedValues(tensor) {
    const bytes = Buffer.from(tensor.data, "base64");
    const width = DTYPE_BYTES[tensor.dtype];
    if (!width || bytes.length % width !== 0) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const readers = {
        float32: (offset) => view.getFloat32(offset, true),
        float64: (offset) => view.getFloat64(offset, true),
    };
    const read = readers[tensor.dtype];
    if (!read) return null;
    return Array.from({ length: bytes.length / width }, (_, index) => read(index * width));
}

function semanticProjection(source, bundle) {
    const numeric = [{
        path: "transition.reward",
        kind: "float64",
        values: source.transitions.map((entry) => entry.reward),
    }];
    const discrete = {
        terminal: source.transitions.map((entry) => [entry.terminated, entry.truncated]),
        steps: source.transitions.map((entry) => entry.step),
        tensors: [],
        passed: source.final.passed,
        cpuLidarHits: source.cpuLidarEvidence,
    };
    const snapshots = [source.reset, ...source.transitions];
    for (const [snapshotIndex, snapshot] of snapshots.entries()) {
        for (const tensor of snapshot.observation) {
            const values = decodedValues(tensor);
            const key = `observation.${snapshotIndex}.${tensor.name}`;
            if (!values) {
                discrete.tensors.push({ path: key, dtype: tensor.dtype, shape: tensor.shape, data: tensor.data });
                continue;
            }
            const lower = tensor.name.toLowerCase();
            if (lower.includes("lidar") && tensor.shape.at(-1) === 2) {
                numeric.push({
                    path: `${key}.range`,
                    kind: "lidarRange",
                    values: values.filter((_, index) => index % 2 === 0),
                });
                numeric.push({
                    path: `${key}.incidence`,
                    kind: "lidarIncidence",
                    values: values.filter((_, index) => index % 2 === 1),
                });
                continue;
            }
            const kind = lower === "task/value"
                ? "float64"
                : lower.includes("range")
                ? "lidarRange"
                : lower.includes("incidence")
                    ? "lidarIncidence"
                    : tensor.dtype;
            numeric.push({ path: key, kind, values });
        }
    }
    numeric.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    discrete.tensors.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    return {
        hashes: {
            resolvedHash: bundle.resolvedHash,
            simulationSemanticHash: bundle.simulationSemanticHash,
            episodeHash: source.reset.episodeHash,
        },
        discrete,
        numeric,
    };
}

function cpuLidarHits(episode) {
    const device = episode.runtime.devices?.lidar?.devices?.[0];
    if (!device) return null;
    const published = episode.runtime.signalStore.read(`devices.${device.id}.semanticPointCloud`, { clone: true });
    if (!published.exists) return [];
    const cloud = decodeTopicValue(published.value)?.value;
    if (!cloud || cloud.point_step !== 28) throw new Error("CPU LiDAR semantic evidence is not a metric-v2 PointCloud2 value.");
    const offsets = Object.fromEntries(cloud.fields.map((field) => [field.name, Number(field.offset)]));
    const bytes = Buffer.from(cloud.data.buffer, cloud.data.byteOffset, cloud.data.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: Number(cloud.width) * Number(cloud.height) }, (_, hitIndex) => {
        const offset = hitIndex * Number(cloud.point_step);
        return {
            hitIndex,
            rayIndex: view.getUint32(offset + offsets.ray_index, true),
            semanticId: view.getUint16(offset + offsets.semantic_id, true),
            instanceId: view.getUint32(offset + offsets.instance_id, true),
        };
    });
}

function browserKernelProxy(engine, kernel) {
    return new Proxy(kernel, {
        get(target, property, receiver) {
            if (property === "advanceStep") return (dt) => engine._fixedStep(dt);
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value, receiver) {
            return Reflect.set(target, property, value, receiver);
        },
    });
}

async function runBrowserAdapter(bundle, spec) {
    const runtime = createHeadlessRuntimeContext();
    const data = {
        ...runtime.data,
        keys: () => null,
        physics: () => runtime.physics,
        client: () => null,
        baking: () => null,
        earthTilesManager: () => null,
        skyManager: () => null,
    };
    const engine = new SimulationEngine(data);
    const kernel = new SimulationKernel(runtime.context);
    engine.kernel = kernel;
    const episode = new HeadlessEpisode({ runtime, kernel: browserKernelProxy(engine, kernel) });
    try {
        await episode.prepare(bundle.resolved, spec);
        const reset = episode.reset(spec);
        kernel.publishSimulationEntities();
        kernel.publishRuntimeState();
        const transitions = [];
        const cpuLidarEvidence = [];
        for (const action of ACTIONS) {
            const transition = episode.step(action);
            transitions.push(transition);
            const hits = cpuLidarHits(episode);
            if (hits) cpuLidarEvidence.push({ step: Number(transition.info.step), hits });
            if (transition.terminated || transition.truncated) break;
        }
        const finalization = episode.finalize();
        return {
            id: "browser-simulation-engine",
            reset,
            transitions,
            final: {
                episodeHash: finalization.episodeHash,
                trajectoryHash: finalization.trajectoryHash,
                passed: finalization.scenario?.passed === true,
            },
            cpuLidarEvidence: cpuLidarEvidence.length > 0 ? cpuLidarEvidence : null,
        };
    } finally {
        episode.dispose();
    }
}

async function runDirect(bundle, spec, root) {
    const events = [];
    await new HeadlessRunner().run(bundle, {
        episodeSpec: spec,
        actions: ACTIONS.map((action, index) => ({ policyStep: index + 1, action })),
        artifactPolicy: { profile: "disabled", outputUri: path.join(root, "direct") },
        outputUri: path.join(root, "direct"),
        onEvent: (event) => events.push(event),
    });
    return {
        id: "direct-headless-session",
        reset: events.find((event) => event.kind.endsWith(".reset")),
        transitions: events.filter((event) => event.kind.endsWith(".transition")),
        final: events.find((event) => event.kind.endsWith(".result")),
    };
}

async function runCli(bundle, spec, root) {
    const bundlePath = path.join(root, "bundle.json");
    const specPath = path.join(root, "episode.json");
    await fs.writeFile(bundlePath, canonicalStringify(bundle));
    await fs.writeFile(specPath, JSON.stringify(spec));
    const input = ACTIONS.map((action, index) => JSON.stringify({ policyStep: index + 1, action })).join("\n") + "\n";
    const result = await run(path.join(REPOSITORY_ROOT, "bin/cev-sim.js"), [
        "run",
        "--bundle", bundlePath,
        "--episode", specPath,
        "--output", path.join(root, "cli"),
        "--artifact-profile", "disabled",
    ], { input });
    if (result.code !== 0) throw new Error(`CLI parity path failed (${result.code}): ${result.stderr}`);
    const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return {
        id: "cli",
        reset: events.find((event) => event.kind.endsWith(".reset")),
        transitions: events.filter((event) => event.kind.endsWith(".transition")),
        final: events.find((event) => event.kind.endsWith(".result")),
    };
}

async function runGrpc(bundle, spec, client, root) {
    const bundleId = spec.runBundleId;
    const created = await clientCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 2 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes: [spec],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "grpc") },
    });
    if (created.error.code !== 0) throw new Error(created.error.message);
    const batchId = created.batch.batchId;
    try {
        const resetResponse = await clientCall(client, "resetBatch", { batchId, episodes: [spec] });
        const transitions = [];
        for (const action of ACTIONS) {
            const response = await clientCall(client, "stepBatch", {
                batchId,
                actions: [actionMessage(0, action)],
            });
            const transition = response.results[0];
            transitions.push(transition);
            if (transition.terminated || transition.truncated) break;
        }
        const finalResponse = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [0] });
        return {
            id: "grpc-uds",
            reset: resetResponse.results[0],
            transitions,
            final: finalResponse.results[0],
        };
    } finally {
        await clientCall(client, "closeBatch", { batchId, finalizeActiveEpisodes: false });
    }
}

async function runPython(bundle, root, socket, perception) {
    const bundlePath = path.join(root, "python-bundle.json");
    const actionsPath = path.join(root, "actions.json");
    await fs.writeFile(bundlePath, canonicalStringify(bundle));
    await fs.writeFile(actionsPath, JSON.stringify(ACTIONS));
    const virtualPython = path.join(REPOSITORY_ROOT, "python/.venv/bin/python");
    let python = process.env.PYTHON || "python3";
    if (!process.env.PYTHON) {
        try {
            await fs.access(virtualPython);
            python = virtualPython;
        } catch {
            // Use the configured system Python and surface missing dependencies.
        }
    }
    const result = await run(python, [
        path.join(REPOSITORY_ROOT, "python/scripts/headless_parity_probe.py"),
        "--bundle", bundlePath,
        "--target", `unix:${socket}`,
        "--output", path.join(root, "python"),
        "--actions", actionsPath,
        "--seed", "0",
        ...(perception ? ["--perception"] : []),
    ], { env: { PYTHONPATH: path.join(REPOSITORY_ROOT, "python/src") } });
    if (result.code !== 0) throw new Error(`Python parity path failed (${result.code}): ${result.stderr}`);
    const value = JSON.parse(result.stdout.trim());
    return { id: "python", reset: value.reset, transitions: value.transitions, final: value.final };
}

async function runCase(id, bundle, running, client, options) {
    const root = await temporaryRoot(`cev-parity-${id}-`);
    const spec = episodeSpec(0, bundle.resolvedHash, bundle, { resetSeed: 0, perception: id === "cpu-lidar" });
    try {
        const rawSources = [
            await runBrowserAdapter(bundle, spec),
            await runDirect(bundle, spec, root),
            await runCli(bundle, spec, root),
            await runGrpc(bundle, spec, client, root),
        ];
        if (!options.skipPython) rawSources.push(await runPython(bundle, root, running.address, id === "cpu-lidar"));
        const sources = rawSources.map(normalizeSource);
        const comparisons = exactComparisons(sources);
        return {
            id,
            backend: id === "cpu-lidar" ? "deterministic-cpu-bvh-lidar@1" : "deterministic-state-sensors@1",
            identity: {
                resetSeed: spec.resetSeed,
                actionRepeat: spec.actionRepeat,
                observationProfile: spec.observationProfile,
                rewardProfile: spec.rewardProfile,
                backendSelections: spec.backendSelections,
            },
            actionTape: ACTIONS.map((action, index) => ({ policyStep: index + 1, action })),
            bundle: {
                resolvedHash: bundle.resolvedHash,
                simulationSemanticHash: bundle.simulationSemanticHash,
            },
            sources,
            comparisons,
            semanticProjection: semanticProjection(sources[0], bundle),
            passed: comparisons.every((entry) => entry.ok),
        };
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseOptions(process.argv.slice(2), { output: null, skipPython: false });
    const root = await temporaryRoot("cev-parity-supervisor-");
    const socket = path.join(root, "supervisor.sock");
    const running = await startHeadlessSupervisor({ socket });
    const client = createGrpcClient(socket, running.config.maxRpcMessageBytes);
    try {
        const stateBundle = await createStateBundle({ triggers: FINISH_TRIGGER });
        const lidarBundle = await createLidarBundle({ triggers: FINISH_TRIGGER });
        const cases = [
            await runCase("state-only", stateBundle, running, client, options),
            await runCase("cpu-lidar", lidarBundle, running, client, options),
        ];
        const report = createReport(PARITY_REPORT_KIND, {
            provenance: processProvenance(),
            protocol: { major: 1, minor: 2 },
            tolerances: PARITY_TOLERANCES,
            cases,
            passed: cases.every((entry) => entry.passed),
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
