import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createPhysicsBackendSelection } from "../../app/physics/PhysicsBackend.js";
import { getHeadlessProfileCapabilities } from "../../app/simulation/headless/ProfileRegistry.js";
import { createStateSensorBackendSelection, STATE_SENSOR_TYPES } from "../../app/simulation/sensors/StateSensorBackend.js";
import { createCpuLidarBackendSelection } from "../../app/simulation/sensors/CpuLidarBackend.js";
import {
    createGpuSensorBackendSelection,
    gpuSensorBackendCapability,
} from "../../app/simulation/sensors/GpuSensorBackend.js";
import { computeEpisodeHash } from "../../app/simulation/kernel/SimulationHashes.js";
import { canonicalStringify } from "../../app/simulation/RunManifest.js";
import { verifyRunBundle } from "./RunBundle.js";
import {
    errorStatus,
    HEADLESS_PROTOCOL,
    infrastructureResult,
    okStatus,
    protocolError,
    supervisorError,
} from "./HeadlessProtocol.js";
import { resolveBatchResourceLimits, resolveSupervisorConfig } from "./SupervisorConfig.js";
import { WorkerHandle } from "./WorkerHandle.js";
import { PooledGpuRenderer } from "./PooledGpuRenderer.js";
import { postProcessGpuObservation } from "./GpuObservationPostProcessing.js";
import { SharedTensorArena } from "./SharedTensorArena.js";
import {
    calculatePerceptionObservationBytes,
    calculateSharedTensorArenaBytes,
    externalizeTensorMap,
    materializeTensorMap,
} from "./SharedTensorTransport.js";

const HEALTH = Object.freeze({ SERVING: 1, DEGRADED: 2, NOT_SERVING: 3 });
const INFRASTRUCTURE_CODES = new Set(["RESOURCE_LIMIT", "STEP_TIMEOUT", "WORKER_CRASHED"]);
const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;

function compareUtf8(left, right) {
    return Buffer.from(String(left)).compare(Buffer.from(String(right)));
}

function normalizedArtifactPolicy(value = {}) {
    const profile = Number(value.profile || 0);
    const fullSflogSampleRate = Number(value.fullSflogSampleRate || 0);
    if (!Number.isSafeInteger(profile) || profile < 0 || profile > 3) {
        throw supervisorError("INVALID_REQUEST", "artifact_policy.profile must be a known ArtifactProfile value.");
    }
    if (!Number.isFinite(fullSflogSampleRate) || fullSflogSampleRate < 0 || fullSflogSampleRate > 1) {
        throw supervisorError("INVALID_REQUEST", "artifact_policy.full_sflog_sample_rate must be within [0, 1].");
    }
    return {
        ...(profile > 0 ? { profile } : {}),
        outputUri: String(value.outputUri || ""),
        fullSflogSampleRate,
        fullSflogOnFailure: Boolean(value.fullSflogOnFailure),
    };
}

function ensureSortedUnique(values, label, { contiguous = false } = {}) {
    for (let index = 0; index < values.length; index += 1) {
        const value = Number(values[index]);
        if (!Number.isSafeInteger(value) || value < 0) throw supervisorError("INVALID_REQUEST", `${label} must contain non-negative integer indexes.`);
        if (index > 0 && value <= Number(values[index - 1])) throw supervisorError("INVALID_REQUEST", `${label} must be sorted and unique.`);
        if (contiguous && value !== index) throw supervisorError("INVALID_REQUEST", `${label} must be zero-based and contiguous.`);
    }
}

function decodeBundles(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw supervisorError("INVALID_REQUEST", "CreateBatch requires at least one run bundle.");
    const bundles = new Map();
    for (const envelope of entries) {
        const bundleId = String(envelope.bundleId || "");
        if (!bundleId || bundles.has(bundleId)) throw supervisorError("INVALID_REQUEST", "run_bundles require unique non-empty bundle_id values.");
        const bytes = Buffer.from(envelope.canonicalJson || []);
        let bundle;
        try {
            bundle = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
            throw supervisorError("BUNDLE_INVALID", `Run bundle ${bundleId} is not valid UTF-8 JSON: ${error.message}`);
        }
        if (!bytes.equals(Buffer.from(canonicalStringify(bundle)))) {
            throw supervisorError("BUNDLE_INVALID", `Run bundle ${bundleId} bytes are not canonical JSON.`);
        }
        const verified = verifyRunBundle(bundle);
        if (String(envelope.resolvedHash || "") !== verified.resolvedHash
            || String(envelope.simulationSemanticHash || "") !== verified.simulationSemanticHash) {
            throw supervisorError("BUNDLE_HASH_MISMATCH", `Run bundle ${bundleId} envelope hashes do not match its canonical bytes.`);
        }
        bundles.set(bundleId, { bundle, verified });
    }
    return bundles;
}

function validateStaticLimits(resolved, limits, environmentIndex) {
    const actors = Math.max(
        resolved.manifest?.initialState?.vehicles?.length || 0,
        resolved.scenario?.scenario?.actors?.length || 0,
    );
    const sensors = (resolved.manifest?.sensorRig?.sensors || []).filter((entry) => entry.enabled !== false).length;
    if (actors > limits.maxActorsPerEnvironment) {
        throw supervisorError("RESOURCE_LIMIT", `Environment ${environmentIndex} requests ${actors} actors; limit is ${limits.maxActorsPerEnvironment}.`, { actors });
    }
    if (sensors > limits.maxSensorsPerEnvironment) {
        throw supervisorError("RESOURCE_LIMIT", `Environment ${environmentIndex} requests ${sensors} sensors; limit is ${limits.maxSensorsPerEnvironment}.`, { sensors });
    }
}

function episodeArtifactPath(batch, environment, episodeSpec, sequence) {
    const hash = computeEpisodeHash({
        ...episodeSpec,
        protocolMajor: HEADLESS_PROTOCOL.major,
        simulationSemanticHash: environment.bundle.verified.simulationSemanticHash,
    });
    return {
        hash,
        outputUri: path.join(
            batch.outputRoot,
            batch.id,
            `env-${environment.index}`,
            `episode-${sequence}-${hash.slice(0, 12)}`,
        ),
    };
}

function resetResult(environmentIndex, reset) {
    return {
        environmentIndex,
        observation: reset.observation,
        info: {
            episodeHash: reset.info.episodeHash,
            resolvedHash: reset.info.resolvedHash,
            step: String(reset.info.step),
            simulationTimeNs: String(reset.info.simulationTimeNs),
        },
        error: okStatus(),
    };
}

function stepResult(environmentIndex, transition) {
    return {
        environmentIndex,
        observation: transition.observation,
        reward: transition.reward,
        terminated: transition.terminated,
        truncated: transition.truncated,
        info: {
            episodeHash: transition.info.episodeHash,
            trajectoryHash: transition.info.trajectoryHash,
            step: String(transition.info.step),
            simulationTimeNs: String(transition.info.simulationTimeNs),
            rewardTerms: transition.info.rewardTerms,
            terminationReason: transition.info.terminationReason,
            truncationReason: transition.info.truncationReason,
            diagnosticJson: Buffer.from(transition.info.diagnosticJson || []),
        },
        error: okStatus(),
    };
}

function finalizedResult(environmentIndex, finalized) {
    const runResult = finalized.runResult;
    return {
        environmentIndex,
        episodeHash: runResult.episodeHash,
        trajectoryHash: runResult.trajectoryHash,
        passed: runResult.passed,
        canonicalResultJson: Buffer.from(canonicalStringify(runResult)),
        artifacts: (finalized.artifacts || []).map((artifact) => ({
            ...artifact,
            uri: path.join(finalized.outputDirectory, artifact.uri),
            sizeBytes: String(artifact.sizeBytes),
        })),
        error: okStatus(),
    };
}

async function cleanupPartialDirectories(root) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = path.join(root, entry.name);
        if (entry.name.startsWith(".") && entry.name.includes(".tmp-")) {
            await fs.rm(target, { recursive: true, force: true });
        } else {
            await cleanupPartialDirectories(target);
        }
    }
}

export class HeadlessSupervisor {
    constructor(options = {}) {
        this.config = options.kind === "cev-sim.headless-supervisor-config" && options.listener
            ? options
            : resolveSupervisorConfig(options);
        this.workerFactory = options.workerFactory ?? ((workerOptions) => new WorkerHandle(workerOptions));
        this.rendererPool = options.rendererPool ?? new PooledGpuRenderer(this.config.renderer, {
            adapterFactory: options.rendererAdapterFactory,
        });
        this.batches = new Map();
        this.workers = new Set();
        this.reservedWorkers = 0;
        this.startedAt = Date.now();
        this.shuttingDown = false;
        this.closed = false;
    }

    get activeEnvironmentCount() {
        return [...this.batches.values()].reduce((total, batch) => total + batch.environments.length, 0);
    }

    async getCapabilities(request = {}) {
        const mismatch = protocolError(request.clientProtocol);
        if (mismatch) return { protocol: HEADLESS_PROTOCOL, error: errorStatus(mismatch) };
        const profiles = getHeadlessProfileCapabilities();
        const physics = createPhysicsBackendSelection();
        const sensors = createStateSensorBackendSelection();
        const lidar = createCpuLidarBackendSelection();
        const gpu = createGpuSensorBackendSelection();
        const gpuProbe = await this.rendererPool.probe();
        return {
            protocol: HEADLESS_PROTOCOL,
            runtimeName: "cev-sim",
            runtimeVersion: PACKAGE_VERSION,
            platform: process.platform,
            architecture: process.arch,
            backends: [
                { id: physics.capabilityId, version: physics.version, kind: physics.kind, description: "Deterministic swept-prism Rapier backend.", sensorTypes: [], features: ["fixed-step", "continuous-collision"], available: true, unavailableReason: "", determinismScope: "same-runtime-version" },
                { id: sensors.capabilityId, version: sensors.version, kind: sensors.kind, description: "Deterministic measured state sensors.", sensorTypes: [...STATE_SENSOR_TYPES], features: ["packed-protobuf"], available: true, unavailableReason: "", determinismScope: "same-runtime-version" },
                { id: lidar.capabilityId, version: lidar.version, kind: lidar.kind, description: "Deterministic CPU/BVH 3D LiDAR.", sensorTypes: ["lidar3d"], features: ["pointcloud2", "semantic-pointcloud2", "fixed-step"], available: true, unavailableReason: "", determinismScope: "same-build-platform-seed-action-tape" },
                gpuSensorBackendCapability({ available: gpuProbe.available, unavailableReason: gpuProbe.reason, selection: gpu }),
            ],
            observationProfiles: profiles.observationProfiles,
            rewardProfiles: profiles.rewardProfiles,
            transports: ["unix", "tcp-insecure", "grpc+unix+shared-memory-v1"],
            diagnosticJson: Buffer.from(canonicalStringify({
                gpuRenderer: this.rendererPool.diagnostics(),
                gpuProbe,
            })),
            error: okStatus(),
        };
    }

    async createBatch(request = {}, { signal = null } = {}) {
        const created = [];
        let reservation = 0;
        try {
            const mismatch = protocolError(request.clientProtocol);
            if (mismatch) throw mismatch;
            if (this.shuttingDown) throw supervisorError("INTERNAL", "Supervisor is shutting down.");
            const bundles = decodeBundles(request.runBundles);
            const episodes = request.episodes || [];
            if (episodes.length === 0) throw supervisorError("INVALID_REQUEST", "CreateBatch requires at least one episode.");
            ensureSortedUnique(episodes.map((entry) => entry.environmentIndex), "episodes.environment_index", { contiguous: true });
            if (this.activeEnvironmentCount + this.reservedWorkers + episodes.length > this.config.maxWorkers) {
                throw supervisorError("RESOURCE_LIMIT", `Creating ${episodes.length} environments exceeds supervisor capacity ${this.config.maxWorkers}.`);
            }
            reservation = episodes.length;
            this.reservedWorkers += reservation;
            const limits = resolveBatchResourceLimits(request.resourceLimits, this.config);
            const artifactPolicy = normalizedArtifactPolicy(request.artifactPolicy);
            if (!artifactPolicy.outputUri) throw supervisorError("INVALID_REQUEST", "artifact_policy.output_uri is required.");
            const batch = {
                id: `batch-${randomUUID()}`,
                environments: [],
                limits,
                artifactPolicy,
                outputRoot: path.resolve(artifactPolicy.outputUri),
                protocolMinor: Number(request.clientProtocol?.minor || 0),
                sharedMemory: this.config.listener.kind === "socket"
                    && Number(request.clientProtocol?.minor || 0) >= 2,
            };
            for (const episodeSpec of episodes) {
                const bundle = bundles.get(String(episodeSpec.runBundleId || ""));
                if (!bundle) throw supervisorError("INVALID_REQUEST", `Episode ${episodeSpec.environmentIndex} references unknown run_bundle_id ${episodeSpec.runBundleId}.`);
                validateStaticLimits(bundle.verified.resolved, limits, episodeSpec.environmentIndex);
                const perceptionProfile = String(episodeSpec.observationProfile?.id || "") === "measured-perception";
                if (perceptionProfile && batch.protocolMinor < 2) {
                    throw supervisorError("PROTOCOL_MISMATCH", "measured-perception requires headless protocol 1.2.");
                }
                const arenaBytes = calculateSharedTensorArenaBytes(bundle.verified.resolved, episodeSpec);
                const requestsCamera = bundle.verified.resolved.manifest.sensorRig?.sensors?.some(
                    (sensor) => sensor.enabled !== false && sensor.type === "camera",
                );
                const requestsGpu = requestsCamera
                    || (episodeSpec.backendSelections || []).some((entry) => Number(entry.kind) === 4);
                if (requestsGpu) {
                    const probe = await this.rendererPool.probe();
                    if (!probe.available) throw supervisorError("UNSUPPORTED_CAPABILITY", `GPU backend unavailable: ${probe.reason}`);
                }
                if (arenaBytes > limits.maxSharedMemoryBytesPerEnvironment) {
                    throw supervisorError(
                        "RESOURCE_LIMIT",
                        `Environment ${episodeSpec.environmentIndex} requires ${arenaBytes} shared-memory bytes; limit is ${limits.maxSharedMemoryBytesPerEnvironment}.`,
                        { arenaBytes, limit: limits.maxSharedMemoryBytesPerEnvironment },
                    );
                }
                if (perceptionProfile && !batch.sharedMemory
                    && calculatePerceptionObservationBytes(bundle.verified.resolved, episodeSpec)
                        > Math.min(limits.maxObservationBytes, this.config.maxRpcMessageBytes)) {
                    throw supervisorError(
                        "RESOURCE_LIMIT",
                        `Environment ${episodeSpec.environmentIndex} can exceed the configured inline gRPC response limit.`,
                        {
                            maximumEncodedObservationBytes: calculatePerceptionObservationBytes(
                                bundle.verified.resolved,
                                episodeSpec,
                            ),
                            maxRpcMessageBytes: this.config.maxRpcMessageBytes,
                        },
                    );
                }
                const environment = {
                    batch,
                    index: Number(episodeSpec.environmentIndex),
                    id: String(episodeSpec.environmentId),
                    bundle,
                    episodeSpec: structuredClone(episodeSpec),
                    worker: null,
                    workers: new Set(),
                    state: "preparing",
                    restartCount: 0,
                    requiresReset: true,
                    detail: "",
                    health: null,
                    episodeSequence: 0,
                    episodeDeadline: null,
                    episodeTimer: null,
                    lastFinalizeResult: null,
                    recoveryPromise: null,
                    sharedArena: null,
                    transportSequence: 0n,
                };
                if ((batch.sharedMemory || requestsGpu) && arenaBytes > 0) {
                    environment.sharedArena = await SharedTensorArena.create({
                        environmentToken: `${batch.id}:${environment.index}:${randomUUID()}`,
                        sizeBytes: Math.max(arenaBytes, 3 * 1024),
                    });
                }
                environment.worker = this._newWorker(environment);
                batch.environments.push(environment);
                created.push(environment);
            }
            const initialized = await Promise.all(batch.environments.map(async (environment) => {
                const response = await environment.worker.dispatch("initialize", {
                    bundle: environment.bundle.bundle,
                    episodeSpec: environment.episodeSpec,
                    limits,
                }, { signal });
                environment.health = environment.worker.health;
                const resourceError = this._resourceError(environment, environment.health);
                if (resourceError) throw resourceError;
                environment.state = "prepared";
                return response.descriptor;
            }));
            const actionSpace = initialized[0].actionSpace;
            const observationSpace = initialized[0].observationSpace;
            const actionHash = initialized[0].actionSpaceHash;
            const observationHash = initialized[0].observationSpaceHash;
            if (initialized.some((entry) => entry.actionSpaceHash !== actionHash || entry.observationSpaceHash !== observationHash)) {
                throw supervisorError("INCOMPATIBLE_SPACE", "Every environment in a batch must expose compatible action and observation spaces.");
            }
            if (this.shuttingDown) throw supervisorError("INTERNAL", "Supervisor began shutting down during batch creation.");
            this.batches.set(batch.id, batch);
            return {
                batch: {
                    batchId: batch.id,
                    environments: batch.environments.map((environment, index) => ({
                        environmentIndex: environment.index,
                        environmentId: environment.id,
                        episodeHash: initialized[index].episodeHash,
                    })),
                    actionSpace,
                    observationSpace,
                },
                error: okStatus(),
            };
        } catch (error) {
            await Promise.allSettled(created.flatMap((environment) => [...environment.workers]).map((worker) => worker.close()));
            await Promise.allSettled(created.map((environment) => environment.sharedArena?.close()));
            return { error: errorStatus(error) };
        } finally {
            this.reservedWorkers -= reservation;
        }
    }

    async resetBatch(request = {}, { signal = null } = {}) {
        const batch = this.batches.get(String(request.batchId || ""));
        if (!batch) return { batchId: String(request.batchId || ""), error: errorStatus(supervisorError("BATCH_NOT_FOUND", "Batch was not found.")) };
        try {
            const episodes = request.episodes || [];
            if (episodes.length === 0) throw supervisorError("INVALID_REQUEST", "ResetBatch requires a non-empty episode subset.");
            ensureSortedUnique(episodes.map((entry) => entry.environmentIndex), "episodes.environment_index");
            for (const episode of episodes) {
                const environment = batch.environments[Number(episode.environmentIndex)];
                if (!environment || environment.index !== Number(episode.environmentIndex)) throw supervisorError("INVALID_REQUEST", `Unknown environment_index ${episode.environmentIndex}.`);
                if (String(episode.environmentId) !== environment.id || String(episode.runBundleId) !== String(environment.episodeSpec.runBundleId)) {
                    throw supervisorError("INVALID_REQUEST", `Reset episode ${episode.environmentIndex} may not change environment_id or run_bundle_id.`);
                }
            }
            const results = await Promise.all(episodes.map(async (episode) => {
                const environment = batch.environments[Number(episode.environmentIndex)];
                if (!["prepared", "finalized"].includes(environment.state)) {
                    return infrastructureResult(environment.index, supervisorError("INVALID_REQUEST", "Finalize the active or terminal episode before reset."));
                }
                try {
                    environment.episodeSequence += 1;
                    const artifact = episodeArtifactPath(batch, environment, episode, environment.episodeSequence);
                    const response = await this._dispatch(environment, "reset", {
                        episodeSpec: episode,
                        artifactPolicy: batch.artifactPolicy,
                        outputUri: artifact.outputUri,
                    }, { signal });
                    environment.episodeSpec = structuredClone(episode);
                    environment.requiresReset = false;
                    environment.state = "ready";
                    environment.detail = "";
                    environment.lastFinalizeResult = null;
                    this._startEpisodeWatchdog(environment);
                    await this._externalizeObservation(environment, response.reset.observation);
                    return resetResult(environment.index, response.reset);
                } catch (error) {
                    await this._recoverIfInfrastructure(environment, error);
                    return infrastructureResult(environment.index, error);
                }
            }));
            return { batchId: batch.id, results, error: okStatus() };
        } catch (error) {
            return { batchId: batch.id, error: errorStatus(error) };
        }
    }

    async stepBatch(request = {}, { signal = null } = {}) {
        const batch = this.batches.get(String(request.batchId || ""));
        if (!batch) return { batchId: String(request.batchId || ""), error: errorStatus(supervisorError("BATCH_NOT_FOUND", "Batch was not found.")) };
        try {
            const ready = batch.environments.filter((environment) => environment.state === "ready");
            const actions = request.actions || [];
            ensureSortedUnique(actions.map((entry) => entry.environmentIndex), "actions.environment_index");
            if (actions.length !== ready.length || actions.some((entry, index) => Number(entry.environmentIndex) !== ready[index].index)) {
                throw supervisorError("INVALID_REQUEST", "StepBatch requires exactly one sorted action for every ready environment.");
            }
            const results = await Promise.all(actions.map(async (action) => {
                const environment = batch.environments[Number(action.environmentIndex)];
                try {
                    if (environment.episodeDeadline !== null && Date.now() >= environment.episodeDeadline) {
                        throw supervisorError("RESOURCE_LIMIT", `Environment ${environment.index} exceeded its episode wall timeout.`, { episodeWallTimeoutMs: batch.limits.episodeWallTimeoutMs });
                    }
                    const response = await this._dispatch(environment, "step", { action: action.action }, {
                        timeoutMs: batch.limits.stepWallTimeoutMs,
                        signal,
                    });
                    if (response.transition.terminated || response.transition.truncated) {
                        environment.state = "terminal";
                        this._clearEpisodeWatchdog(environment);
                    }
                    await this._externalizeObservation(environment, response.transition.observation);
                    return stepResult(environment.index, response.transition);
                } catch (error) {
                    await this._recoverIfInfrastructure(environment, error);
                    return infrastructureResult(environment.index, error);
                }
            }));
            return { batchId: batch.id, results, error: okStatus() };
        } catch (error) {
            return { batchId: batch.id, error: errorStatus(error) };
        }
    }

    async finalizeBatch(request = {}, { signal = null, finalizeOptions = null } = {}) {
        const batch = this.batches.get(String(request.batchId || ""));
        if (!batch) return { batchId: String(request.batchId || ""), error: errorStatus(supervisorError("BATCH_NOT_FOUND", "Batch was not found.")) };
        try {
            const supplied = request.environmentIndices || [];
            ensureSortedUnique(supplied, "environment_indices");
            const selected = supplied.length === 0
                ? batch.environments
                : supplied.map((index) => batch.environments[Number(index)]);
            if (supplied.length > 0 && selected.some((entry, index) => !entry || entry.index !== Number(supplied[index]))) {
                throw supervisorError("INVALID_REQUEST", "FinalizeBatch references an unknown environment index.");
            }
            const results = await Promise.all(selected.map(
                (environment) => this._finalizeEnvironment(environment, { signal, finalizeOptions }),
            ));
            return { batchId: batch.id, results, error: okStatus() };
        } catch (error) {
            return { batchId: batch.id, error: errorStatus(error) };
        }
    }

    async closeBatch(request = {}, { signal = null } = {}) {
        const batch = this.batches.get(String(request.batchId || ""));
        if (!batch) return { batchId: String(request.batchId || ""), error: errorStatus(supervisorError("BATCH_NOT_FOUND", "Batch was not found.")) };
        const finalized = [];
        try {
            if (request.finalizeActiveEpisodes) {
                const active = batch.environments.filter((environment) => ["ready", "terminal", "finalized"].includes(environment.state));
                finalized.push(...await Promise.all(active.map((environment) => this._finalizeEnvironment(environment, { signal }))));
            }
        } finally {
            this.batches.delete(batch.id);
            for (const environment of batch.environments) {
                this._clearEpisodeWatchdog(environment);
                environment.state = "closing";
            }
            await Promise.allSettled(batch.environments.map(async (environment) => {
                await environment.recoveryPromise?.catch(() => {});
                await Promise.allSettled([...environment.workers].map((worker) => worker.close()));
                await environment.sharedArena?.close();
                this.rendererPool.releaseEnvironment(`${batch.id}:${environment.index}`);
            }));
            await cleanupPartialDirectories(path.join(batch.outputRoot, batch.id));
        }
        return { batchId: batch.id, finalized, error: okStatus() };
    }

    async health(request = {}) {
        const environments = [...this.batches.values()]
            .sort((left, right) => compareUtf8(left.id, right.id))
            .flatMap((batch) => batch.environments.map((environment) => ({ batch, environment })))
            .sort((left, right) => compareUtf8(left.batch.id, right.batch.id) || left.environment.index - right.environment.index);
        const degraded = environments.some(({ environment }) => ["restarting", "faulted"].includes(environment.state));
        return {
            state: this.shuttingDown ? HEALTH.NOT_SERVING : degraded ? HEALTH.DEGRADED : HEALTH.SERVING,
            runtimeVersion: PACKAGE_VERSION,
            uptimeMs: String(Math.max(0, Date.now() - this.startedAt)),
            activeBatches: this.batches.size,
            activeEnvironments: environments.length,
            environments: request.includeEnvironments ? environments.map(({ batch, environment }) => ({
                environmentIndex: environment.index,
                state: ["restarting", "faulted"].includes(environment.state) ? HEALTH.DEGRADED : HEALTH.SERVING,
                rssBytes: String(environment.health?.rssBytes || 0),
                heapBytes: String(environment.health?.heapBytes || 0),
                lastCompletedStep: String(environment.health?.lastCompletedStep || 0),
                detail: environment.detail || environment.state,
                batchId: batch.id,
                restartCount: environment.restartCount,
                requiresReset: environment.requiresReset,
            })) : [],
            error: okStatus(),
        };
    }

    /**
     * Internal one-shot reference-controlled execution. This intentionally is
     * not part of the public gRPC protocol and shares worker isolation and
     * resource enforcement with policy batches.
     */
    async runManagedExperiment(request = {}, { signal = null, onStarted = null, onHealth = null } = {}) {
        if (this.shuttingDown) throw supervisorError("INTERNAL", "Supervisor is shutting down.");
        if (this.activeEnvironmentCount + this.reservedWorkers + 1 > this.config.maxWorkers) {
            throw supervisorError("RESOURCE_LIMIT", `Creating a managed environment exceeds supervisor capacity ${this.config.maxWorkers}.`);
        }
        const verified = verifyRunBundle(request.bundle);
        const limits = resolveBatchResourceLimits(request.resourceLimits, this.config);
        validateStaticLimits(verified.resolved, limits, 0);
        this.reservedWorkers += 1;
        let worker = null;
        let resourceFailure = null;
        try {
            worker = this.workerFactory({
                limits,
                memoryPollIntervalMs: this.config.memoryPollIntervalMs,
                shutdownGraceMs: this.config.shutdownGraceMs,
                killGraceMs: this.config.killGraceMs,
                onHealth: (health, handle) => {
                    onHealth?.(health);
                    if (Number(health.rssBytes) > limits.maxRssBytesPerEnvironment) {
                        resourceFailure = supervisorError("RESOURCE_LIMIT", "Managed environment exceeded its RSS limit.", { rssBytes: health.rssBytes, limit: limits.maxRssBytesPerEnvironment });
                    } else if (Number(health.heapBytes) > limits.maxHeapBytesPerEnvironment) {
                        resourceFailure = supervisorError("RESOURCE_LIMIT", "Managed environment exceeded its heap limit.", { heapBytes: health.heapBytes, limit: limits.maxHeapBytesPerEnvironment });
                    } else if (Number(health.queueBytes || 0) + Number(handle.pendingBytes || 0) > limits.maxQueueBytes) {
                        resourceFailure = supervisorError("RESOURCE_LIMIT", "Managed environment exceeded its aggregate queue limit.", { queueBytes: health.queueBytes, pendingIpcBytes: handle.pendingBytes || 0, limit: limits.maxQueueBytes });
                    }
                    if (resourceFailure) handle.terminate();
                },
                onExit: (_event, handle) => this.workers.delete(handle),
            });
            this.workers.add(worker);
            onStarted?.({ pid: worker.pid });
            await worker.dispatch("initialize", {
                mode: "managed-experiment",
                bundle: request.bundle,
                metricDefinitions: request.metricDefinitions || [],
                limits,
            }, { signal });
            if (resourceFailure) throw resourceFailure;
            const response = await worker.dispatch("run-managed", {
                artifactPolicy: request.artifactPolicy,
                outputUri: request.outputUri,
                yieldEverySteps: request.yieldEverySteps,
            }, { timeoutMs: limits.episodeWallTimeoutMs, signal });
            if (resourceFailure) throw resourceFailure;
            return response.finalized;
        } catch (error) {
            throw resourceFailure || error;
        } finally {
            this.reservedWorkers -= 1;
            await worker?.close().catch(() => {});
            if (worker) this.workers.delete(worker);
            if (request.outputUri) await cleanupPartialDirectories(path.dirname(path.resolve(request.outputUri)));
        }
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.shuttingDown = true;
        const ids = [...this.batches.keys()];
        await Promise.all(ids.map((batchId) => this.closeBatch({ batchId, finalizeActiveEpisodes: false })));
        await Promise.allSettled([...this.workers].map((worker) => worker.close()));
        await this.rendererPool.close();
    }

    _newWorker(environment) {
        let worker = null;
        worker = this.workerFactory({
            limits: environment.batch.limits,
            memoryPollIntervalMs: this.config.memoryPollIntervalMs,
            shutdownGraceMs: this.config.shutdownGraceMs,
            killGraceMs: this.config.killGraceMs,
            onHealth: (health) => this._observeHealth(environment, health),
            onExit: ({ error }, handle) => {
                const exitedWorker = handle ?? worker;
                environment.workers.delete(exitedWorker);
                this.workers.delete(exitedWorker);
                this._observeExit(environment, error);
            },
            rendererHandler: (operation, payload) => this._rendererRequest(environment, operation, payload),
        });
        environment.workers.add(worker);
        this.workers.add(worker);
        return worker;
    }

    _observeExit(environment, error) {
        if (this.shuttingDown || ["closing", "restarting", "faulted"].includes(environment.state)) return;
        this._recover(environment, error).catch(() => {});
    }

    _observeHealth(environment, health) {
        environment.health = health;
        const error = this._resourceError(environment, health);
        if (error && !environment.worker?.pending && !environment.recoveryPromise
            && !["preparing", "restarting", "faulted", "closing"].includes(environment.state)) {
            this._recover(environment, error).catch(() => {});
        }
    }

    _resourceError(environment, health = {}) {
        const limits = environment.batch.limits;
        if (Number(health.rssBytes) > limits.maxRssBytesPerEnvironment) {
            return supervisorError("RESOURCE_LIMIT", `Environment ${environment.index} exceeded its RSS limit.`, { rssBytes: health.rssBytes, limit: limits.maxRssBytesPerEnvironment });
        }
        if (Number(health.heapBytes) > limits.maxHeapBytesPerEnvironment) {
            return supervisorError("RESOURCE_LIMIT", `Environment ${environment.index} exceeded its heap limit.`, { heapBytes: health.heapBytes, limit: limits.maxHeapBytesPerEnvironment });
        }
        if (Number(health.queueBytes || 0) + Number(environment.worker?.pendingBytes || 0) > limits.maxQueueBytes) {
            return supervisorError("RESOURCE_LIMIT", `Environment ${environment.index} exceeded its aggregate queue limit.`, { queueBytes: health.queueBytes, pendingIpcBytes: environment.worker?.pendingBytes || 0, limit: limits.maxQueueBytes });
        }
        return null;
    }

    async _dispatch(environment, command, payload, options) {
        if (environment.recoveryPromise) await environment.recoveryPromise;
        if (!environment.worker || environment.state === "faulted") throw supervisorError("WORKER_CRASHED", `Environment ${environment.index} is permanently faulted.`);
        const result = await environment.worker.dispatch(command, payload, options);
        environment.health = environment.worker.health || environment.health;
        const resourceError = this._resourceError(environment, environment.health);
        if (resourceError) {
            await this._recover(environment, resourceError);
            throw resourceError;
        }
        return result;
    }

    async _recoverIfInfrastructure(environment, error) {
        if (!INFRASTRUCTURE_CODES.has(error?.code)) return;
        await this._recover(environment, error);
    }

    async _recover(environment, error) {
        if (environment.recoveryPromise) return environment.recoveryPromise;
        environment.recoveryPromise = (async () => {
            this._clearEpisodeWatchdog(environment);
            await environment.sharedArena?.invalidate();
            this.rendererPool.releaseEnvironment(`${environment.batch.id}:${environment.index}`);
            environment.requiresReset = true;
            environment.detail = error.message;
            environment.state = "restarting";
            const failedWorker = environment.worker;
            failedWorker?.terminate();
            await failedWorker?.close().catch(() => {});
            if (environment.restartCount >= environment.batch.limits.restartBudget || this.shuttingDown) {
                environment.state = "faulted";
                environment.worker = null;
                return;
            }
            environment.restartCount += 1;
            try {
                environment.worker = this._newWorker(environment);
                await environment.worker.dispatch("initialize", {
                    bundle: environment.bundle.bundle,
                    episodeSpec: environment.episodeSpec,
                    limits: environment.batch.limits,
                });
                environment.health = environment.worker.health;
                const resourceError = this._resourceError(environment, environment.health);
                if (resourceError) throw resourceError;
                environment.state = "prepared";
                environment.detail = `${error.message} Replacement prepared; reset required.`;
            } catch (replacementError) {
                environment.detail = `Replacement failed: ${replacementError.message}`;
                environment.state = "faulted";
                await environment.worker?.close().catch(() => {});
                environment.worker = null;
            }
        })();
        try {
            await environment.recoveryPromise;
        } finally {
            environment.recoveryPromise = null;
        }
    }

    _startEpisodeWatchdog(environment) {
        this._clearEpisodeWatchdog(environment);
        const timeoutMs = environment.batch.limits.episodeWallTimeoutMs;
        environment.episodeDeadline = Date.now() + timeoutMs;
        environment.episodeTimer = setTimeout(() => {
            const error = supervisorError("RESOURCE_LIMIT", `Environment ${environment.index} exceeded its ${timeoutMs}-ms episode wall timeout.`, { episodeWallTimeoutMs: timeoutMs });
            this._recover(environment, error).catch(() => {});
        }, timeoutMs);
        environment.episodeTimer.unref?.();
    }

    _clearEpisodeWatchdog(environment) {
        clearTimeout(environment.episodeTimer);
        environment.episodeTimer = null;
        environment.episodeDeadline = null;
    }

    async _finalizeEnvironment(environment, { signal = null, finalizeOptions = null } = {}) {
        if (environment.lastFinalizeResult) return environment.lastFinalizeResult;
        if (!["ready", "terminal"].includes(environment.state)) {
            return infrastructureResult(environment.index, supervisorError("ENVIRONMENT_NOT_FOUND", "Environment has no active episode to finalize."));
        }
        this._clearEpisodeWatchdog(environment);
        try {
            const response = await this._dispatch(environment, "finalize", {
                options: {
                    ...(finalizeOptions || {}),
                    status: environment.state === "terminal" ? "completed" : "interrupted",
                },
            }, { signal });
            const result = finalizedResult(environment.index, response.finalized);
            environment.lastFinalizeResult = result;
            environment.state = "finalized";
            environment.requiresReset = true;
            return result;
        } catch (error) {
            await this._recoverIfInfrastructure(environment, error);
            return infrastructureResult(environment.index, error);
        }
    }

    async _externalizeObservation(environment, observation) {
        if (!environment.sharedArena) return observation;
        if (!environment.batch.sharedMemory) {
            return materializeTensorMap(observation, environment.sharedArena);
        }
        const sequence = environment.transportSequence + 1n;
        await externalizeTensorMap(observation, environment.sharedArena, {
            generation: sequence,
            sequence,
        });
        environment.transportSequence = sequence;
        return observation;
    }

    async _rendererRequest(environment, operation, payload) {
        if (operation === "provenance") return this.rendererPool.diagnostics();
        if (operation === "release-shared") {
            return { released: await environment.sharedArena?.release(payload.reference) === true };
        }
        if (operation !== "capture-group") throw supervisorError("INVALID_REQUEST", `Unknown renderer operation ${operation}.`);
        const captured = await this.rendererPool.captureGroup({
            ...payload,
            environmentKey: `${environment.batch.id}:${environment.index}`,
            maxGpuBytes: environment.batch.limits.maxGpuBytesPerEnvironment,
            timeoutMs: environment.batch.limits.stepWallTimeoutMs,
        });
        if (!environment.sharedArena) return captured;
        const sequence = environment.transportSequence + 1n;
        const requests = new Map(payload.requests.map((entry) => [entry.id, entry]));
        return Promise.all(captured.map(async (entry) => {
            const request = requests.get(entry.id);
            const rawSpec = {
                dtype: entry.type === "camera" ? 4 : 1,
                shape: [request.height, request.width, 4],
                byteOrder: 1,
            };
            const rawBytes = new Uint8Array(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
            const rawSharedMemory = await environment.sharedArena.publishTensor(rawBytes, rawSpec, {
                generation: sequence,
                sequence,
            });
            const observation = request.includeObservation
                ? postProcessGpuObservation(entry.data, request)
                : null;
            const sharedMemory = observation ? await environment.sharedArena.publishTensor(new Uint8Array(
                observation.values.buffer,
                observation.values.byteOffset,
                observation.values.byteLength,
            ), {
                dtype: observation.scalarType,
                shape: observation.shape,
                byteOrder: 1,
            }, { generation: sequence, sequence, retained: true }) : null;
            return {
                id: entry.id,
                type: entry.type,
                rawSharedMemory,
                ...(observation ? { observation: {
                    dtype: observation.dtype,
                    shape: observation.shape,
                    sharedMemory,
                    digest: observation.digest,
                } } : {}),
            };
        }));
    }
}
