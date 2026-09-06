import { createRequire } from "node:module";
import process from "node:process";
import { serialize } from "node:v8";

import { assertPhysicsBackendSelection, sortBackendSelections } from "../../app/physics/PhysicsBackend.js";
import { ExperimentMetricCollector } from "../../app/experiments/ExperimentMetricCollector.js";
import { SimulationKernel } from "../../app/simulation/kernel/SimulationKernel.js";
import { defaultEpisodeIdentity } from "../../app/simulation/kernel/SimulationHashes.js";
import { createHeadlessRuntimeContext } from "../../app/simulation/headless/HeadlessRuntimeContext.js";
import {
    assertStateSensorBackendSelection,
    createStateSensorBackendSelection,
    getStateSensorModel,
} from "../../app/simulation/sensors/StateSensorBackend.js";
import {
    assertCpuLidarBackendSelection,
    createCpuLidarBackendSelection,
} from "../../app/simulation/sensors/CpuLidarBackend.js";
import { createHeadlessArtifactSink, resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { cloneRunBundle, verifyRunBundle } from "./RunBundle.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;
const MANAGED_CONTROLLERS = new Set(["route-follower", "script", "script-with-route"]);

function invalid(code, message, details = null) {
    throw new HeadlessRunnerError(code, message, details);
}

function enabledSensors(resolved) {
    return (resolved.manifest?.sensorRig?.sensors || []).filter((sensor) => sensor.enabled !== false);
}

function hasSemanticBound(resolved) {
    const maxSteps = Number(resolved.manifest?.clock?.maxSteps);
    if (Number.isSafeInteger(maxSteps) && maxSteps > 0) return true;
    const scenario = resolved.scenario?.scenario;
    if ((scenario?.completion?.conditions || []).some((condition) => (
        condition.kind === "max-duration" && Number(condition.durationNs) > 0
    ))) return true;
    return (scenario?.triggers || []).some((trigger) => (
        trigger.enabled !== false
        && ["time", "step"].includes(trigger.condition?.kind)
        && Number.isFinite(Number(trigger.condition?.kind === "time"
            ? trigger.condition.timeNs
            : trigger.condition.step))
        && Number(trigger.condition?.kind === "time" ? trigger.condition.timeNs : trigger.condition.step) >= 0
        && (trigger.actions || []).some((action) => action.kind === "finish")
    ));
}

/** Validate the semantic subset supported by server-owned experiment runs. */
export function validateManagedRun(resolved) {
    if (!resolved?.manifest || !resolved?.scenario?.scenario) {
        invalid("BUNDLE_INVALID", "Managed experiments require an immutable resolved manifest and scenario.");
    }
    if (resolved.manifest.controls?.authority !== "reference") {
        invalid("UNSUPPORTED_CAPABILITY", "Managed experiments require reference control authority; candidate control remains a Gym/CLI responsibility.");
    }
    const unsupportedControllers = (resolved.scenario.scenario.routes || [])
        .filter((route) => !MANAGED_CONTROLLERS.has(route.controller?.kind));
    if (unsupportedControllers.length > 0) {
        invalid("UNSUPPORTED_CAPABILITY", `Managed experiments do not support route controller(s): ${unsupportedControllers.map((route) => `${route.id}:${route.controller?.kind || "unknown"}`).sort().join(", ")}.`);
    }
    const sensors = enabledSensors(resolved);
    const unsupportedSensors = sensors.filter((sensor) => !getStateSensorModel(sensor.type) && sensor.type !== "lidar3d");
    if (unsupportedSensors.length > 0) {
        invalid("UNSUPPORTED_CAPABILITY", `Managed experiments do not support sensor(s): ${unsupportedSensors.map((sensor) => `${sensor.id}:${sensor.type}`).sort().join(", ")}.`);
    }
    if (sensors.length > 0 && resolved.manifest.clock?.modules?.sensors === false) {
        invalid("UNSUPPORTED_CAPABILITY", "Managed experiments cannot run enabled sensors while the sensors clock module is disabled.");
    }
    const lidarSensors = sensors.filter((sensor) => sensor.type === "lidar3d");
    if (lidarSensors.length > 0 && !resolved.lidarGeometry) {
        invalid("BUNDLE_INVALID", "LiDAR geometry twins are missing; re-resolve and export the run manifest.");
    }
    const physics = (resolved.backendSelections || []).filter((entry) => Number(entry.kind) === 1);
    const state = (resolved.backendSelections || []).filter((entry) => Number(entry.kind) === 2);
    const lidar = (resolved.backendSelections || []).filter((entry) => Number(entry.kind) === 3);
    const unknown = (resolved.backendSelections || []).filter((entry) => ![1, 2, 3].includes(Number(entry.kind)));
    try {
        if (physics.length !== 1) throw new Error("Exactly one physics backend selection is required.");
        assertPhysicsBackendSelection(physics[0]);
        if (state.length > 1) throw new Error("At most one state-sensor backend selection is supported.");
        if (state.length === 1) assertStateSensorBackendSelection(state[0]);
        if (lidar.length > 1) throw new Error("At most one CPU LiDAR backend selection is supported.");
        if (lidar.length === 1) assertCpuLidarBackendSelection(lidar[0]);
    } catch (error) {
        invalid("UNSUPPORTED_CAPABILITY", error.message);
    }
    if (unknown.length > 0) {
        invalid("UNSUPPORTED_CAPABILITY", `Managed experiments do not support backend kind(s): ${unknown.map((entry) => entry.kind).join(", ")}.`);
    }
    if (lidarSensors.length === 0 && lidar.length > 0) {
        invalid("UNSUPPORTED_CAPABILITY", "A CPU LiDAR backend was selected but the manifest has no enabled lidar3d sensor.");
    }
    if (!hasSemanticBound(resolved)) {
        invalid("INVALID_REQUEST", "Managed experiments require a positive clock.maxSteps, max-duration completion, or finite time/step finish trigger.");
    }
    return resolved;
}

export function managedEpisodeIdentity(resolved) {
    const sensors = enabledSensors(resolved);
    const backends = [...(resolved.backendSelections || [])];
    if (sensors.some((sensor) => getStateSensorModel(sensor.type))
        && !backends.some((entry) => Number(entry.kind) === 2)) {
        backends.push(createStateSensorBackendSelection());
    }
    if (sensors.some((sensor) => sensor.type === "lidar3d")
        && !backends.some((entry) => Number(entry.kind) === 3)) {
        backends.push(createCpuLidarBackendSelection());
    }
    return defaultEpisodeIdentity(resolved, {
        resetSeed: String(resolved.manifest.seed ?? "0"),
        actionRepeat: 1,
        maxEpisodeSteps: String(resolved.manifest.clock?.maxSteps ?? 0),
        backendSelections: sortBackendSelections(backends),
    });
}

function failureReason(finalization) {
    const assertion = (finalization.assertions || [])
        .find((entry) => entry.status === "failed" && entry.severity === "error");
    if (assertion) return `Assertion "${assertion.name || assertion.id}" failed${assertion.message ? `: ${assertion.message}` : "."}`;
    const outcome = finalization.scenario?.outcomes?.find((entry) => entry.passed !== true);
    if (outcome) return `Expected outcome "${outcome.name || outcome.id}" failed${outcome.detail ? `: ${outcome.detail}` : "."}`;
    return finalization.scenario?.terminalEvent?.detail
        || finalization.scenario?.terminationReason
        || "The managed case did not satisfy its success criteria.";
}

function provenance(resolved, episodeIdentity) {
    return {
        kind: "cev-sim.headless.provenance",
        version: 1,
        runtimeName: "cev-sim",
        runtimeVersion: PACKAGE_VERSION,
        gitHash: process.env.GIT_HASH || process.env.NEXT_PUBLIC_GIT_HASH || null,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        backendSelections: structuredClone(episodeIdentity.backendSelections),
        createdAt: new Date().toISOString(),
        execution: "managed-experiment",
        resolvedHash: resolved.resolvedHash,
    };
}

/** One reference-controlled case lifecycle owned entirely by a worker process. */
export class ManagedHeadlessSession {
    constructor({ artifactSinkFactory = createHeadlessArtifactSink, limits = null } = {}) {
        this.artifactSinkFactory = artifactSinkFactory;
        this.limits = limits;
        this.runtime = null;
        this.kernel = null;
        this.bundle = null;
        this.verified = null;
        this.episodeIdentity = null;
        this.metricDefinitions = [];
        this.metricCollector = null;
        this.artifactSink = null;
        this.state = "idle";
    }

    async prepare(bundle, { metricDefinitions = [] } = {}) {
        this.verified = verifyRunBundle(bundle);
        validateManagedRun(this.verified.resolved);
        this.bundle = cloneRunBundle(bundle);
        this.metricDefinitions = structuredClone(metricDefinitions);
        this.episodeIdentity = managedEpisodeIdentity(this.verified.resolved);
        this.runtime = createHeadlessRuntimeContext();
        this.kernel = new SimulationKernel(this.runtime.context);
        await this.kernel.prepare(this.verified.resolved, {
            episode: this.episodeIdentity,
            requireStateSensors: false,
        });
        // Match the browser and candidate-session reset boundary. Fixed-update
        // scripts must see simulation time zero on their first step, never the
        // SignalStore's wall-time fallback.
        this.kernel.publishSimulationEntities();
        this.kernel.publishRuntimeState();
        this.state = "prepared";
        return {
            episodeHash: this.kernel.episodeHash,
            resolvedHash: this.verified.resolvedHash,
            simulationSemanticHash: this.verified.simulationSemanticHash,
        };
    }

    async run({ artifactPolicy = null, outputUri = null, yieldEverySteps = 100 } = {}) {
        if (this.state !== "prepared") invalid("ENVIRONMENT_NOT_FOUND", "Prepare the managed worker before running it.");
        const policy = resolveArtifactPolicy(artifactPolicy, this.verified.resolved.manifest, outputUri);
        this.metricCollector = new ExperimentMetricCollector(this.metricDefinitions, this.runtime.signalStore).start();
        this.artifactSink = await this.artifactSinkFactory({
            bundle: this.bundle,
            episode: this,
            policy,
            provenance: provenance(this.verified.resolved, this.episodeIdentity),
            limits: this.limits,
        });
        await this.artifactSink.start();
        this.kernel.play();
        this.state = "running";
        const interval = Math.max(1, Math.floor(Number(yieldEverySteps) || 100));
        let shouldContinue = true;
        while (shouldContinue) {
            shouldContinue = this.kernel.advanceStep();
            if (shouldContinue && this.kernel.steps % interval === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        const finalization = this.kernel.finalize({ status: "completed" });
        const scenario = finalization.scenario;
        const assertionFailures = (finalization.assertions || [])
            .filter((entry) => entry.status === "failed" && entry.severity === "error");
        const passed = Boolean(scenario?.passed) && assertionFailures.length === 0;
        const runResult = {
            kind: "cev-sim.run-result",
            version: 1,
            runId: `run-${finalization.episodeHash.slice(0, 16)}`,
            manifestId: this.verified.resolved.manifest.id,
            scenarioId: this.verified.resolved.scenario.scenario.id,
            status: passed ? "passed" : "failed",
            completed: true,
            passed,
            resolvedHash: this.verified.resolvedHash,
            simulationSemanticHash: finalization.simulationSemanticHash,
            episodeHash: finalization.episodeHash,
            trajectoryHash: finalization.trajectoryHash,
            step: String(finalization.step),
            timeNs: String(finalization.timeNs),
            terminationReason: scenario?.terminationReason
                || (this.kernel.maxSteps !== null && this.kernel.steps >= this.kernel.maxSteps ? "max-steps" : "completed"),
            latestTrigger: scenario?.latestTrigger ?? null,
            terminalEvent: scenario?.terminalEvent ?? null,
            assertions: finalization.assertions || [],
            outcomes: scenario?.outcomes || [],
            metrics: scenario?.metrics || {},
            failureReason: passed ? null : failureReason(finalization),
            degraded: false,
            artifactWarnings: [],
            completedAt: new Date().toISOString(),
        };
        const experimentMetrics = this.metricCollector.finalize({
            ...runResult,
            status: passed ? "completed" : "failed",
        });
        this.metricCollector.stop();
        const published = await this.artifactSink.finalize({ ...runResult, experimentMetrics });
        this.artifactSink = null;
        this.state = "finalized";
        return { finalization, experimentMetrics, ...published };
    }

    health() {
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        const queueBytes = Number(this.kernel?.inputQueue?.queuedBytes || 0);
        const sensorQueueBytes = (this.runtime?.devices?.devices || []).reduce((total, device) => {
            try {
                if (Number.isFinite(Number(device.contractPublisher?.queuedBytes))) {
                    return total + Number(device.contractPublisher.queuedBytes);
                }
                const deviceQueue = device.queue ?? [];
                return total + (deviceQueue.length > 0 ? serialize(deviceQueue).byteLength : 0);
            }
            catch { return total; }
        }, 0);
        const recordingQueueBytes = Number(this.artifactSink?.recording?.queuedBytes || 0);
        return {
            state: this.state,
            rssBytes: memory.rss,
            heapBytes: memory.heapUsed,
            cpuUserMicros: cpu.user,
            cpuSystemMicros: cpu.system,
            lastCompletedStep: this.kernel?.steps ?? 0,
            queueBytes: queueBytes + sensorQueueBytes + recordingQueueBytes,
            sensorQueueBytes,
            inputQueueBytes: queueBytes,
            recordingQueueBytes,
        };
    }

    async abort() {
        this.metricCollector?.stop();
        await this.artifactSink?.abort?.();
        this.artifactSink = null;
    }

    async close() {
        await this.abort();
        this.kernel?.dispose?.();
        this.kernel = null;
        this.runtime = null;
        this.state = "closed";
    }
}
