import { createRequire } from "node:module";
import process from "node:process";
import { serialize } from "node:v8";
import { randomUUID } from "node:crypto";
import { HeadlessZenohRuntime } from "./HeadlessZenohRuntime.js";

import { HeadlessEpisode, normalizeEpisodeSpec, TERMINATION_REASON } from "../../app/simulation/headless/HeadlessEpisode.js";
import { createHeadlessArtifactSink, resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { cloneRunBundle, verifyRunBundle } from "./RunBundle.js";
import { HostPacketTransportHub } from "../sensor-transports/HostPacketTransportHub.js";
import {
    hostDescriptorFromConfig,
    resolveSensorTransportHostConfig,
} from "../sensor-transports/SensorTransportConfig.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;

export async function defaultHeadlessProvenance(resolved, { episodeSpec = null, episode = null } = {}) {
    const usesGpu = (episodeSpec?.backendSelections || []).some((entry) => Number(entry.kind) === 4);
    const gpuRenderer = usesGpu ? await episode?.rendererClient?.provenance?.() : null;
    return {
        kind: "cev-sim.headless.provenance",
        version: 1,
        runtimeName: "cev-sim",
        runtimeVersion: PACKAGE_VERSION,
        gitHash: process.env.GIT_HASH || process.env.NEXT_PUBLIC_GIT_HASH || null,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        backendSelections: structuredClone(episodeSpec?.backendSelections || resolved.backendSelections || []),
        createdAt: new Date().toISOString(),
        ...(gpuRenderer ? { gpuRenderer } : {}),
        ...((resolved.plugins || []).length ? {
            plugins: resolved.plugins.map((entry) => ({
                pluginId: entry.pluginId,
                version: entry.version,
                packageHash: entry.packageHash,
                runtimeHash: entry.runtimeHash,
            })),
        } : {}),
    };
}

function errorAssertions(finalization) {
    return (finalization.assertions || []).filter((entry) => entry.status === "failed" && entry.severity === "error");
}

function failureReason({ finalization, lastTransition, interrupted }) {
    const assertion = errorAssertions(finalization)[0];
    if (assertion) return `Assertion "${assertion.name || assertion.id}" failed${assertion.message ? `: ${assertion.message}` : "."}`;
    const outcome = finalization.scenario?.outcomes?.find((entry) => entry.passed !== true);
    if (outcome) return `Expected outcome "${outcome.name || outcome.id}" failed${outcome.detail ? `: ${outcome.detail}` : "."}`;
    if (interrupted) return "The action source ended before the episode reached a terminal transition.";
    if (lastTransition?.terminated || lastTransition?.truncated) {
        return finalization.scenario?.terminationReason || "The episode ended without satisfying its success criteria.";
    }
    return finalization.scenario?.terminationReason || "The episode did not pass.";
}

function expectationMismatches(expect, result) {
    if (!expect || typeof expect !== "object") return [];
    const mismatches = [];
    for (const field of ["episodeHash", "trajectoryHash", "passed"]) {
        if (expect[field] === null || expect[field] === undefined) continue;
        if (expect[field] !== result[field]) mismatches.push({ field, expected: expect[field], actual: result[field] });
    }
    return mismatches;
}

function markPluginFailure(error) {
    if (!String(error?.code ?? "").startsWith("PLUGIN_")) return false;
    error.requiresReset = true;
    error.details = {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        pluginCode: error.code,
        pluginId: error.pluginId ?? null,
        packageHash: error.packageHash ?? null,
        contributionId: error.contributionId ?? null,
        scopeId: error.scopeId ?? null,
        unitId: error.unitId ?? null,
        hook: error.hook ?? null,
        requiresReset: true,
    };
    return true;
}

export function markResetRequiredFailure(error) {
    if (markPluginFailure(error)) return true;
    const infrastructure = error?.infrastructureFailure === true
        || error?.requiresReset === true
        || ["RESOURCE_LIMIT", "ARTIFACT_FAILURE", "WORKER_CRASHED", "STEP_TIMEOUT"].includes(error?.code);
    if (!infrastructure) return false;
    error.requiresReset = true;
    error.infrastructureFailure = true;
    error.details = {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        requiresReset: true,
    };
    return true;
}

export function assertDirectUdpDisabled(hostConfig, packetHub) {
    if (hostConfig?.udp && !packetHub?.udpDelegate) {
        throw new HeadlessRunnerError(
            "UNSUPPORTED_CAPABILITY",
            "Live UDP requires a configured supervisor; browser launch and direct unsupervised CLI remain unsupported.",
        );
    }
}

export function packedTensorMapBytes(map) {
    return (map?.entries || []).reduce((total, entry) => {
        const bytes = entry?.tensor?.payload?.packedData;
        const sharedLength = Number(entry?.tensor?.payload?.sharedMemory?.lengthBytes || 0);
        return total + (ArrayBuffer.isView(bytes)
            ? bytes.byteLength
            : Buffer.isBuffer(bytes)
                ? bytes.length
                : sharedLength);
    }, 0);
}

/** Reusable owner for one prepared environment and its episode/artifact lifecycle. */
export class HeadlessSession {
    constructor({
        episodeFactory = (options = {}) => new HeadlessEpisode(options),
        artifactSinkFactory = createHeadlessArtifactSink,
        provenanceProvider = defaultHeadlessProvenance,
        limits = null,
        hostConfig = null,
        packetHub = null,
        sensorTransportHost = null,
        udpMaxQueueBytes = null,
        zenohTransport = null,
        zenohRuntimeFactory = (options) => new HeadlessZenohRuntime(options),
    } = {}) {
        this.episodeFactory = episodeFactory;
        this.artifactSinkFactory = artifactSinkFactory;
        this.provenanceProvider = provenanceProvider;
        this.limits = limits;
        this.hostConfig = hostConfig
            ? resolveSensorTransportHostConfig(hostConfig)
            : null;
        this.packetHub = packetHub ?? new HostPacketTransportHub();
        assertDirectUdpDisabled(this.hostConfig, this.packetHub);
        this.sensorTransportHost = sensorTransportHost
            ?? hostDescriptorFromConfig(this.hostConfig);
        this.udpMaxQueueBytes = udpMaxQueueBytes;
        this.zenohTransport = zenohTransport;
        this.zenohRuntimeFactory = zenohRuntimeFactory;
        this.zenohRuntime = null;
        this.episode = null;
        this.bundle = null;
        this.verified = null;
        this.descriptor = null;
        this.artifactSink = null;
        this.artifactPolicy = null;
        this.state = "idle";
        this.lastTransition = null;
        this.policyStep = 0;
        this.finalized = null;
    }

    _episodeOptions() {
        return {
            nativePacketSink: this.packetHub,
            sensorTransportHost: this.sensorTransportHost,
            ...this.zenohRuntime?.runtimeOptions(),
        };
    }

    async prepare(bundle, episodeSpec = {}) {
        if (this.state !== "idle" && this.state !== "closed") {
            throw new HeadlessRunnerError("INVALID_REQUEST", "The session is already prepared.");
        }
        this.verified = verifyRunBundle(bundle);
        if (this.verified.resolved.manifest.protobuf?.externalController) throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "External controllers require external-realtime execution, not policy stepping.");
        this.bundle = cloneRunBundle(bundle);
        if (this.verified.resolved.manifest.protobuf?.mode === "zenoh") {
            this.runId = `run-${randomUUID()}`;
            this.zenohRuntime = this.zenohRuntimeFactory({ config: this.zenohTransport, limits: this.limits, queueBytes: () => this.health().queueBytes });
            await this.zenohRuntime.prepare(this.verified.resolved, { runId: this.runId, episodeIdentity: normalizeEpisodeSpec(this.verified.resolved, episodeSpec) });
        }
        this.packetHub.configure({
            bindings: this.verified.resolved.manifest.sensorTransports?.bindings ?? [],
            hostConfig: this.hostConfig,
            stepNs: this.verified.resolved.manifest.clock.stepNs,
            maxQueueBytes: this.limits?.maxQueueBytes ?? 0,
            udpMaxQueueBytes: this.udpMaxQueueBytes,
        });
        this.episode = this.episodeFactory(this._episodeOptions());
        this.descriptor = await this.episode.prepare(this.verified.resolved, episodeSpec, { runId: this.runId });
        this.state = "prepared";
        return this.descriptor;
    }

    async reset(episodeSpec = this.episode?.episodeSpec, {
        artifactPolicy = null,
        outputUri = null,
        provenance = null,
    } = {}) {
        if (!this.episode || !["prepared", "finalized"].includes(this.state)) {
            throw new HeadlessRunnerError("INVALID_REQUEST", "Finalize the current episode before resetting it.");
        }
        this.finalized = null;
        this.lastTransition = null;
        this.policyStep = 0;
        try {
            const reset = this.episode.reset(episodeSpec);
            this.episode.kernel.publishSimulationEntities();
            this.episode.kernel.publishRuntimeState();
            this._enforceObservation(reset.observation);
            this.artifactPolicy = resolveArtifactPolicy(artifactPolicy, this.verified.resolved.manifest, outputUri);
            await this.packetHub.beginEpisode();
            if (this.packetHub.hasPacketBindings() && this.artifactPolicy.profile === "disabled") {
                throw new HeadlessRunnerError(
                    "UNSUPPORTED_CAPABILITY",
                    "Requested packet transport bindings require artifact output.",
                );
            }
            const resolvedProvenance = provenance ?? await this.provenanceProvider(this.verified.resolved, {
                bundle: this.bundle,
                descriptor: this.descriptor,
                episodeSpec: this.episode.episodeSpec,
                episode: this.episode,
            });
            this.artifactSink = await this.artifactSinkFactory({
                bundle: this.bundle,
                episode: this.episode,
                policy: this.artifactPolicy,
                provenance: resolvedProvenance,
                limits: this.limits,
            });
            await this.artifactSink.start();
            if (this.packetHub.hasPacketBindings()) {
                await this.packetHub.attachArtifactRoot(this.artifactSink.stagingDirectory);
            }
            await this.packetHub.activateGeneration();
            if (this.zenohRuntime) {
                await this.zenohRuntime.activate(this.episode.kernel);
                this.episode.kernel.publishClock();
                this.episode.kernel.transformRuntime?.publishStaticTransforms?.(0);
                this.zenohRuntime.routes.deliver({ step: 0, timeNs: 0 });
                this.zenohRuntime.assertHealthy();
            }
            this.state = "ready";
            return reset;
        } catch (error) {
            if (markResetRequiredFailure(error)) {
                this.state = "prepared";
                await this.abort();
            }
            throw error;
        }
    }

    step(action) {
        if (this.state !== "ready") {
            throw new HeadlessRunnerError("ENVIRONMENT_NOT_FOUND", "Reset the environment before stepping it.");
        }
        let transition;
        try {
            this.zenohRuntime?.assertHealthy();
            transition = this.episode.step(action);
            this.zenohRuntime?.assertHealthy();
        } catch (error) {
            if (markResetRequiredFailure(error)) {
                this.state = "prepared";
                this.abort().catch(() => {});
            }
            throw error;
        }
        this._enforceObservation(transition.observation);
        this.policyStep += 1;
        this.lastTransition = transition;
        if (transition.terminated || transition.truncated) this.state = "terminal";
        return transition;
    }

    async stepAsync(action) {
        if (this.state !== "ready") {
            throw new HeadlessRunnerError("ENVIRONMENT_NOT_FOUND", "Reset the environment before stepping it.");
        }
        let transition;
        try {
            this.zenohRuntime?.assertHealthy();
            transition = await this.episode.stepAsync(action);
            this.zenohRuntime?.assertHealthy();
        } catch (error) {
            if (markResetRequiredFailure(error)) {
                this.state = "prepared";
                await this.abort();
            }
            throw error;
        }
        this._enforceObservation(transition.observation);
        this.policyStep += 1;
        this.lastTransition = transition;
        if (transition.terminated || transition.truncated) this.state = "terminal";
        await this.packetHub.drain();
        return transition;
    }

    async finalize({
        status = null,
        interruptedBySignal = false,
        expect = null,
        actionTapeHash = null,
    } = {}) {
        if (this.state === "finalized" && this.finalized) return this.finalized;
        if (!this.episode || !["ready", "terminal"].includes(this.state)) {
            throw new HeadlessRunnerError("ENVIRONMENT_NOT_FOUND", "No active episode is available to finalize.");
        }
        const interrupted = status ? status === "interrupted" : this.state !== "terminal";
        if (this.zenohRuntime) { this.zenohRuntime.active = false; await this.zenohRuntime.drain(); }
        const finalization = this.episode.finalize({ status: interrupted ? "interrupted" : "completed" });
        const assertionsFailed = errorAssertions(finalization).length > 0;
        const scenarioPassed = finalization.scenario
            ? finalization.scenario.passed === true
            : this.lastTransition?.terminated === true
                && this.lastTransition.info?.terminationReason === TERMINATION_REASON.SUCCESS;
        const semanticPassed = !interrupted && scenarioPassed && !assertionsFailed;
        let runResult = {
            kind: "cev-sim.run-result",
            version: 1,
            runId: this.runId ?? `run-${finalization.episodeHash.slice(0, 16)}`,
            manifestId: this.verified.resolved.manifest.id,
            environmentIndex: this.episode.episodeSpec.environmentIndex,
            environmentId: this.episode.episodeSpec.environmentId,
            scenarioId: this.verified.resolved.scenario?.scenario?.id ?? null,
            status: semanticPassed ? "passed" : interrupted ? "interrupted" : "failed",
            completed: !interrupted,
            passed: semanticPassed,
            interrupted,
            interruptedBySignal,
            resolvedHash: this.verified.resolvedHash,
            simulationSemanticHash: finalization.simulationSemanticHash,
            episodeHash: finalization.episodeHash,
            trajectoryHash: finalization.trajectoryHash,
            actionTapeHash,
            step: String(finalization.step),
            policyStep: this.policyStep,
            timeNs: String(finalization.timeNs),
            terminationReason: this.lastTransition?.info?.terminationReason ?? null,
            truncationReason: this.lastTransition?.info?.truncationReason ?? null,
            scenarioTerminationReason: finalization.scenario?.terminationReason ?? null,
            assertions: finalization.assertions,
            outcomes: finalization.scenario?.outcomes ?? [],
            metrics: finalization.scenario?.metrics ?? {},
            failureReason: semanticPassed ? null : failureReason({ finalization, lastTransition: this.lastTransition, interrupted }),
            degraded: false,
            artifactWarnings: [],
            ...(this.artifactSink?.provenance?.gpuRenderer ? {
                diagnostics: {
                    gpuRenderer: structuredClone(this.artifactSink.provenance.gpuRenderer),
                },
            } : {}),
            completedAt: new Date().toISOString(),
        };
        const mismatches = expectationMismatches(expect, runResult);
        if (mismatches.length > 0) {
            runResult = {
                ...runResult,
                status: "failed",
                passed: false,
                expectationMismatches: mismatches,
                failureReason: `Replay expectations did not match: ${mismatches.map((entry) => entry.field).join(", ")}.`,
            };
        }
        await this.packetHub.drain();
        await this.packetHub.finalize();
        const published = await this.artifactSink.finalize(runResult);
        this.artifactSink = null;
        this.finalized = { finalization, runResult: published.runResult, ...published };
        this.state = "finalized";
        return this.finalized;
    }

    health() {
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        const sensorQueueBytes = (this.episode?.runtime?.devices?.devices || []).reduce((total, device) => {
            try {
                if (Number.isFinite(Number(device.contractPublisher?.queuedBytes))) {
                    return total + Number(device.contractPublisher.queuedBytes);
                }
                const queue = device.queue ?? [];
                return total + (queue.length > 0 ? serialize(queue).byteLength : 0) + Number(device.nativeProductBytes || 0);
            } catch {
                return total;
            }
        }, 0);
        const inputQueueBytes = Number(this.episode?.kernel?.inputQueue?.queuedBytes || 0);
        const recordingQueueBytes = Number(this.artifactSink?.recording?.queuedBytes || 0);
        const packetTransportQueueBytes = Number(this.packetHub?.queuedBytes || 0);
        const zenohQueueBytes = Number(this.zenohRuntime?.diagnostics()?.queueBytes || 0);
        return {
            state: this.state,
            rssBytes: memory.rss,
            heapBytes: memory.heapUsed,
            cpuUserMicros: cpu.user,
            cpuSystemMicros: cpu.system,
            lastCompletedStep: this.episode?.kernel?.steps ?? 0,
            queueBytes: sensorQueueBytes + inputQueueBytes + recordingQueueBytes + packetTransportQueueBytes + zenohQueueBytes,
            zenohQueueBytes,
            sensorQueueBytes,
            inputQueueBytes,
            recordingQueueBytes,
            packetTransportQueueBytes,
        };
    }

    async abort() {
        await this.zenohRuntime?.close();
        await this.packetHub?.abort?.();
        await this.artifactSink?.abort?.();
        this.artifactSink = null;
    }

    async close() {
        await this.abort();
        if (this.episode?.disposeAsync) await this.episode.disposeAsync();
        else this.episode?.dispose();
        this.episode = null;
        this.state = "closed";
    }

    _enforceObservation(observation) {
        const maximum = Math.max(0, Number(this.limits?.maxObservationBytes) || 0);
        const bytes = packedTensorMapBytes(observation);
        if (maximum > 0 && bytes > maximum) {
            throw new HeadlessRunnerError(
                "RESOURCE_LIMIT",
                `Packed observation used ${bytes} bytes, exceeding the ${maximum}-byte limit.`,
                { observationBytes: bytes, maxObservationBytes: maximum },
            );
        }
    }
}

export function createHeadlessSession(options) {
    return new HeadlessSession(options);
}
