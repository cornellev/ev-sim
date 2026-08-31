import { createRequire } from "node:module";
import process from "node:process";
import { serialize } from "node:v8";

import { HeadlessEpisode, TERMINATION_REASON } from "../../app/simulation/headless/HeadlessEpisode.js";
import { createHeadlessArtifactSink, resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { verifyRunBundle } from "./RunBundle.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;

export function defaultHeadlessProvenance(resolved, { episodeSpec = null } = {}) {
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

export function packedTensorMapBytes(map) {
    return (map?.entries || []).reduce((total, entry) => {
        const bytes = entry?.tensor?.payload?.packedData;
        return total + (ArrayBuffer.isView(bytes) ? bytes.byteLength : Buffer.isBuffer(bytes) ? bytes.length : 0);
    }, 0);
}

/** Reusable owner for one prepared environment and its episode/artifact lifecycle. */
export class HeadlessSession {
    constructor({
        episodeFactory = () => new HeadlessEpisode(),
        artifactSinkFactory = createHeadlessArtifactSink,
        provenanceProvider = defaultHeadlessProvenance,
        limits = null,
    } = {}) {
        this.episodeFactory = episodeFactory;
        this.artifactSinkFactory = artifactSinkFactory;
        this.provenanceProvider = provenanceProvider;
        this.limits = limits;
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

    async prepare(bundle, episodeSpec = {}) {
        if (this.state !== "idle" && this.state !== "closed") {
            throw new HeadlessRunnerError("INVALID_REQUEST", "The session is already prepared.");
        }
        this.verified = verifyRunBundle(bundle);
        this.bundle = structuredClone(bundle);
        this.episode = this.episodeFactory();
        this.descriptor = await this.episode.prepare(this.verified.resolved, episodeSpec);
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
        const reset = this.episode.reset(episodeSpec);
        this.episode.kernel.publishSimulationEntities();
        this.episode.kernel.publishRuntimeState();
        this._enforceObservation(reset.observation);
        this.artifactPolicy = resolveArtifactPolicy(artifactPolicy, this.verified.resolved.manifest, outputUri);
        const resolvedProvenance = provenance ?? await this.provenanceProvider(this.verified.resolved, {
            bundle: this.bundle,
            descriptor: this.descriptor,
            episodeSpec: this.episode.episodeSpec,
        });
        this.artifactSink = await this.artifactSinkFactory({
            bundle: this.bundle,
            episode: this.episode,
            policy: this.artifactPolicy,
            provenance: resolvedProvenance,
            limits: this.limits,
        });
        await this.artifactSink.start();
        this.state = "ready";
        return reset;
    }

    step(action) {
        if (this.state !== "ready") {
            throw new HeadlessRunnerError("ENVIRONMENT_NOT_FOUND", "Reset the environment before stepping it.");
        }
        const transition = this.episode.step(action);
        this._enforceObservation(transition.observation);
        this.policyStep += 1;
        this.lastTransition = transition;
        if (transition.terminated || transition.truncated) this.state = "terminal";
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
            runId: `run-${finalization.episodeHash.slice(0, 16)}`,
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
        const published = await this.artifactSink.finalize(runResult);
        this.artifactSink = null;
        this.finalized = { finalization, runResult: published.runResult, ...published };
        this.state = "finalized";
        return this.finalized;
    }

    health() {
        const memory = process.memoryUsage();
        const sensorQueueBytes = (this.episode?.runtime?.devices?.devices || []).reduce((total, device) => {
            try {
                return total + serialize(device.queue ?? device.contractPublisher?.queue ?? []).byteLength;
            } catch {
                return total;
            }
        }, 0);
        let inputQueueBytes = 0;
        try {
            inputQueueBytes = serialize(this.episode?.kernel?.inputQueue?.getDeterministicState?.() ?? null).byteLength;
        } catch {
            inputQueueBytes = 0;
        }
        const recordingQueueBytes = Number(this.artifactSink?.recording?.queuedBytes || 0);
        return {
            state: this.state,
            rssBytes: memory.rss,
            heapBytes: memory.heapUsed,
            lastCompletedStep: this.episode?.kernel?.steps ?? 0,
            queueBytes: sensorQueueBytes + inputQueueBytes + recordingQueueBytes,
            sensorQueueBytes,
            inputQueueBytes,
            recordingQueueBytes,
        };
    }

    async abort() {
        await this.artifactSink?.abort?.();
        this.artifactSink = null;
    }

    async close() {
        await this.abort();
        this.episode?.dispose();
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
