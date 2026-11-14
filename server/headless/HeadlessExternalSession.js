import { randomUUID } from "node:crypto";
import { serialize } from "node:v8";
import { SimulationKernel } from "../../app/simulation/kernel/SimulationKernel.js";
import { ControlOwnershipGuard } from "../../app/autonomy/ControlOwnershipGuard.js";
import { createHeadlessRuntimeContext } from "../../app/simulation/headless/HeadlessRuntimeContext.js";
import { assertProtobufExecutionCapabilities } from "../../app/interfaces/ProtobufRunBinding.js";
import { managedEpisodeIdentity } from "./ManagedHeadlessSession.js";
import { HeadlessZenohRuntime } from "./HeadlessZenohRuntime.js";
import { HeadlessRunnerError } from "./HeadlessRunnerErrors.js";
import { cloneRunBundle, verifyRunBundle } from "./RunBundle.js";
import { createHeadlessArtifactSink, resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { assertDirectUdpDisabled, defaultHeadlessProvenance, markResetRequiredFailure } from "./HeadlessSession.js";
import { HostPacketTransportHub } from "../sensor-transports/HostPacketTransportHub.js";
import { hostDescriptorFromConfig, resolveSensorTransportHostConfig } from "../sensor-transports/SensorTransportConfig.js";
import { SUPERVISOR_PRESETS } from "./SupervisorConfig.js";

export function validateExternalControllerRun(resolved, { controlOwnership } = {}) {
    assertProtobufExecutionCapabilities(resolved, { target: "headless", transport: "zenoh-native", controlOwnership });
    if (resolved.version !== 13 || resolved.manifest.protobuf?.mode !== "zenoh" || !resolved.manifest.protobuf.externalController) {
        throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "external-realtime requires a v13 Zenoh run with explicit external-controller authority.");
    }
    if (!(resolved.manifest.clock.speed > 0) || ["inputs", "controls", "vehicles"].some((key) => resolved.manifest.clock.modules[key] === false)) {
        throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "External control requires positive clock speed and enabled inputs, controls and vehicles.");
    }
    return resolved;
}

/** Paced kernel owner. This session has no policy action, reward or tensor facade. */
export class HeadlessExternalSession {
    constructor({ artifactSinkFactory = createHeadlessArtifactSink, provenanceProvider = defaultHeadlessProvenance,
        zenohRuntimeFactory = (options) => new HeadlessZenohRuntime(options), limits = null, zenohTransport = null,
        hostConfig = null, packetHub = null, sensorTransportHost = null, udpMaxQueueBytes = null,
        rendererClient = null, controlLease = null, scheduler = { now: () => performance.now() } } = {}) {
        this.artifactSinkFactory = artifactSinkFactory;
        this.provenanceProvider = provenanceProvider;
        this.zenohRuntimeFactory = zenohRuntimeFactory;
        this.limits = { ...SUPERVISOR_PRESETS.safety.limits, ...limits };
        this.zenohTransport = zenohTransport;
        this.hostConfig = resolveSensorTransportHostConfig(hostConfig);
        this.packetHub = packetHub ?? new HostPacketTransportHub();
        assertDirectUdpDisabled(this.hostConfig, this.packetHub);
        this.sensorTransportHost = sensorTransportHost ?? hostDescriptorFromConfig(this.hostConfig);
        this.udpMaxQueueBytes = udpMaxQueueBytes;
        this.rendererClient = rendererClient;
        this.scheduler = scheduler;
        this.initialControlLease = controlLease;
        this.ownershipGuard = null;
        this.state = "idle";
        this.kernel = null;
        this.artifactSink = null;
        this.completedStep = 0;
    }

    async prepare(bundle) {
        if (!["idle", "closed"].includes(this.state)) throw new HeadlessRunnerError("INVALID_REQUEST", "Close the external session before preparing another run.");
        this.state = "preparing";
        this.failure = null;
        this.interruptedBySignal = false;
        this.pump = null;
        this.finalized = null;
        this.completedStep = 0;
        this.pacing = { lagMs: 0, maxLagMs: 0 };
        this.completion = new Promise((resolve) => { this._complete = resolve; });
        try {
            this.verified = verifyRunBundle(bundle);
            const resolved = validateExternalControllerRun(this.verified.resolved, { controlOwnership: Boolean(this.initialControlLease) });
            const needsLease = resolved.manifest.topics.some((topic) => topic.direction === "input" && topic.valueContract?.id === "cev.control-command" && topic.valueContract.version === 2);
            if (needsLease && !this.initialControlLease) throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "Control-command@2 requires onboarding ownership.");
            if (this.initialControlLease) {
                if (!needsLease || this.initialControlLease.target?.vehicleId !== resolved.manifest.controls?.targetVehicleId || resolved.manifest.controls.authority !== "candidate") throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "Owned headless runs require candidate control-command@2 on the leased vehicle.");
            }
            this.bundle = cloneRunBundle(bundle);
            this.runId = `run-${randomUUID()}`;
            this.episodeIdentity = managedEpisodeIdentity(resolved);
            this.zenohRuntime = this.zenohRuntimeFactory({ config: this.zenohTransport, limits: this.limits, queueBytes: () => this.health().queueBytes });
            await this.zenohRuntime.prepare(resolved, { runId: this.runId, episodeIdentity: this.episodeIdentity });
            this.packetHub.configure({ bindings: resolved.manifest.sensorTransports?.bindings ?? [], hostConfig: this.hostConfig,
                stepNs: resolved.manifest.clock.stepNs, maxQueueBytes: this.limits.maxQueueBytes, udpMaxQueueBytes: this.udpMaxQueueBytes });
            this.runtime = createHeadlessRuntimeContext({ rendererClient: this.rendererClient, nativePacketSink: this.packetHub, controlOwnership: Boolean(this.initialControlLease),
                sensorTransportHost: this.sensorTransportHost, ...this.zenohRuntime.runtimeOptions() });
            this.kernel = new SimulationKernel(this.runtime.context);
            await this.kernel.prepare(resolved, { episode: this.episodeIdentity, runId: this.runId });
            if (this.initialControlLease) {
                this.ownershipGuard = new ControlOwnershipGuard({ now: () => this.scheduler.now(), onLoss: () => this._ownershipStop() });
                this.ownershipGuard.begin(this.initialControlLease);
                this.kernel.controlRuntime.ownershipGuard = this.ownershipGuard;
                this.kernel.inputQueue.validateInput = (info) => info.valueContract?.id === "cev.control-command" ? this.ownershipGuard.validate(info.value, { applyTimeNs: this.kernel.timeNs }) : { ok: true };
            }
            this.kernel.publishSimulationEntities();
            this.kernel.publishRuntimeState();
            this.state = "prepared";
            return this.descriptor();
        } catch (error) { await this.close().catch(() => {}); throw error; }
    }

    descriptor() {
        return { runId: this.runId, controllerMode: "external-realtime", state: this.state, step: this.kernel.steps, stepNs: String(this.kernel.stepNs), timeNs: String(this.kernel.timeNs), episodeHash: this.kernel.episodeHash,
            resolvedHash: this.verified.resolvedHash, simulationSemanticHash: this.verified.simulationSemanticHash,
            routes: [...this.zenohRuntime.admission.routesById].map(([routeId, route]) => ({ routeId, direction: route.direction, key: route.key })) };
    }

    async start({ artifactPolicy = null, outputUri = null, paused = false } = {}) {
        if (this.state !== "prepared") throw new HeadlessRunnerError("INVALID_REQUEST", "Prepare the external session before starting it.");
        try {
            const policy = resolveArtifactPolicy(artifactPolicy, this.verified.resolved.manifest, outputUri);
            if (this.packetHub.hasPacketBindings() && policy.profile === "disabled") throw new HeadlessRunnerError("UNSUPPORTED_CAPABILITY", "Packet transports require artifact output.");
            await this.packetHub.beginEpisode();
            this.artifactSink = await this.artifactSinkFactory({ bundle: this.bundle, episode: this, policy, limits: this.limits,
                provenance: await this.provenanceProvider(this.verified.resolved, { episodeSpec: this.episodeIdentity, episode: this }) });
            await this.artifactSink.start();
            if (this.packetHub.hasPacketBindings()) await this.packetHub.attachArtifactRoot(this.artifactSink.stagingDirectory);
            await this.packetHub.activateGeneration();
            await this.zenohRuntime.activate(this.kernel);
            this.kernel.publishClock();
            this.kernel.transformRuntime?.publishStaticTransforms?.(0);
            this.zenohRuntime.routes.deliver({ step: 0, timeNs: 0 });
            this.zenohRuntime.assertHealthy();
            this.episodeStartedAt = this.scheduler.now();
            if (paused) { this.state = "paused"; this.kernel.pause(); }
            else this._startPump();
            return this.descriptor();
        } catch (error) { this._fail(error); await this.abort(); throw error; }
    }

    _startPump() {
        if (this.ownershipGuard && !this.ownershipGuard.check()) throw new HeadlessRunnerError("INVALID_REQUEST", "A live run-bound control lease is required before resuming.");
        this.state = "running";
        this.kernel.play();
        this.deadline = this.scheduler.now();
        this.pump = this._pump().catch((error) => this._fail(error));
    }

    async _wait(ms) {
        if (this.scheduler.wait) return this.scheduler.wait(ms);
        await new Promise((resolve) => {
            const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
            this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
        });
    }

    async _pump() {
        const periodMs = this.kernel.stepNs / 1e6 / this.verified.resolved.manifest.clock.speed;
        while (this.state === "running") {
            this.zenohRuntime.assertHealthy();
            if (this.scheduler.now() - this.episodeStartedAt > this.limits.episodeWallTimeoutMs) throw new HeadlessRunnerError("RESOURCE_LIMIT", "External episode exceeded its wall timeout.");
            this.deadline += periodMs;
            while (this.state === "running" && this.scheduler.now() < this.deadline) {
                await this._wait(Math.min(100, this.deadline - this.scheduler.now()));
                this.zenohRuntime.assertHealthy();
            }
            if (this.state !== "running") break;
            const continued = await this._advanceOnce();
            this.pacing.lagMs = Math.max(0, this.scheduler.now() - this.deadline);
            this.pacing.maxLagMs = Math.max(this.pacing.maxLagMs, this.pacing.lagMs);
            this.deadline = Math.max(this.deadline, this.scheduler.now());
            if (!continued || (this.kernel.maxSteps !== null && this.kernel.steps >= this.kernel.maxSteps)) {
                this.state = "terminal";
                this.kernel.pause();
                this._complete({ state: this.state });
            }
        }
    }

    async _advanceOnce() {
        this.zenohRuntime.assertHealthy();
        this.stepStartedAt = this.scheduler.now();
        let timer;
        this.inFlight = this.kernel.advanceStepAsync();
        try {
            const continued = await Promise.race([this.inFlight, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new HeadlessRunnerError("STEP_TIMEOUT", "External fixed step exceeded its wall timeout.")), this.limits.stepWallTimeoutMs);
            })]);
            await this.packetHub.drain();
            this.zenohRuntime.assertHealthy();
            const health = this.health();
            if (health.queueBytes > this.limits.maxQueueBytes || health.rssBytes > this.limits.maxRssBytesPerEnvironment || health.heapBytes > this.limits.maxHeapBytesPerEnvironment) {
                throw new HeadlessRunnerError("RESOURCE_LIMIT", "External environment exceeded its memory or queue limit.");
            }
            this.completedStep = this.kernel.steps;
            return continued;
        } finally { clearTimeout(timer); this.inFlight = null; }
    }

    _fail(error) {
        this.failure = error;
        error.infrastructureFailure = true;
        markResetRequiredFailure(error);
        this.state = "failed";
        if (this.zenohRuntime) this.zenohRuntime.active = false;
        this.kernel?.pause();
        this._complete?.({ state: "failed", error });
    }

    waitForCompletion() { return this.completion; }

    _ownershipStop() {
        if (!this.kernel) return;
        this.kernel.pause();
        if (this.state === "running") this.pause().catch((error) => this._fail(error));
        const vehicleId = this.ownershipGuard.lease.vehicleId;
        this.kernel.inputQueue.reset();
        const stopped = this.kernel.controlRuntime.revokeOwnership(vehicleId, { timeNs: this.kernel.timeNs });
        this.runtime.context.controls.applySetpoints(new Map([[vehicleId, stopped]]));
    }

    updateOwnership({ snapshot, runId, sentAtMonotonicNs, attach = false } = {}) {
        if (!this.ownershipGuard || runId !== this.runId || snapshot?.runId !== this.runId) throw new HeadlessRunnerError("INVALID_REQUEST", "Ownership update belongs to another run.");
        if (typeof sentAtMonotonicNs !== "string" || !/^(0|[1-9][0-9]*)$/.test(sentAtMonotonicNs)) throw new HeadlessRunnerError("INVALID_REQUEST", "Ownership update requires a monotonic send time.");
        const elapsedNs = process.hrtime.bigint() - BigInt(sentAtMonotonicNs);
        if (elapsedNs < 0n || elapsedNs > 750_000_000n) { this.ownershipGuard.update({ ...snapshot, status: "lost", remainingMs: 0 }); throw new HeadlessRunnerError("INVALID_REQUEST", "Ownership update expired in transit."); }
        const options = { requestedAt: this.scheduler.now() - Number(elapsedNs) / 1e6 };
        const guard = this.ownershipGuard;
        if (attach && snapshot.leaseId !== guard.lease.leaseId) {
            if (this.state !== "paused") throw new HeadlessRunnerError("INVALID_REQUEST", "Pause the run before changing its control owner.");
            guard.attach(snapshot, { ...options, startTimeNs: this.kernel.timeNs });
            this.kernel.inputQueue.reset();
            this.zenohRuntime?.routes.resetControlSequences();
            this.kernel.controlRuntime.revokeOwnership(guard.lease.vehicleId, { timeNs: this.kernel.timeNs });
            this.kernel.controlRuntime._state(guard.lease.vehicleId).lastSequence = -1;
        } else if (!guard.lease.runId) {
            if (!guard.update(snapshot, options)) throw new HeadlessRunnerError("INVALID_REQUEST", "Ownership ended before run binding.");
            guard.attach(snapshot, { ...options, startTimeNs: this.kernel.timeNs });
        } else if (!guard.update(snapshot, options) && snapshot.status === "active") throw new HeadlessRunnerError("INVALID_REQUEST", "Ownership update does not match a live local lease.");
        return this.descriptor();
    }

    async pause() {
        if (this.state === "paused") return this.descriptor();
        if (this.state !== "running") throw new HeadlessRunnerError("INVALID_REQUEST", "Only a running external session can pause.");
        this.state = "paused";
        this.wake?.();
        await this.pump;
        if (this.failure) throw this.failure;
        this.kernel.pause();
        try { await this.zenohRuntime.suspend(); } catch (error) { this._fail(error); throw error; }
        return this.descriptor();
    }

    async resume() {
        if (this.state !== "paused") throw new HeadlessRunnerError("INVALID_REQUEST", "Only a paused external session can resume.");
        if (this.ownershipGuard && !this.ownershipGuard.check()) throw new HeadlessRunnerError("INVALID_REQUEST", "Control ownership has ended.");
        try { await this.zenohRuntime.activate(this.kernel); this._startPump(); } catch (error) { this._fail(error); throw error; }
        return this.descriptor();
    }

    async stop({ interruptedBySignal = false } = {}) {
        this.interruptedBySignal ||= interruptedBySignal;
        if (this.state === "running" || this.state === "paused") this.state = "stopped";
        this.wake?.();
        await this.pump;
        this.kernel?.pause();
        if (this.zenohRuntime) this.zenohRuntime.active = false;
        this.kernel?.inputQueue.reset();
        this._complete?.({ state: this.state, ...(this.failure ? { error: this.failure } : {}) });
        return this.kernel ? this.descriptor() : null;
    }

    async reset() {
        if (this.ownershipGuard) throw new HeadlessRunnerError("INVALID_REQUEST", "Owned runs require a new lease and a new prepared run after reset.");
        if (!this.bundle) throw new HeadlessRunnerError("ENVIRONMENT_NOT_FOUND", "No external run is prepared.");
        const bundle = this.bundle;
        await this.stop();
        if (this.artifactSink && !this.failure) await this.finalize();
        await this.close();
        this.packetHub = new HostPacketTransportHub({ udpDelegate: this.packetHub.udpDelegate });
        return this.prepare(bundle);
    }

    async finalize() {
        if (this.finalized) return this.finalized;
        if (this.failure) throw this.failure;
        if (!this.artifactSink || !["terminal", "stopped"].includes(this.state)) throw new HeadlessRunnerError("INVALID_REQUEST", "Stop the external session before finalizing it.");
        this.zenohRuntime.active = false;
        await this.zenohRuntime.drain();
        await this.zenohRuntime.close();
        const completed = this.state === "terminal";
        const finalization = this.kernel.finalize({ status: completed ? "completed" : "interrupted" });
        const failed = finalization.assertions.find((entry) => entry.status === "failed" && entry.severity === "error");
        const passed = completed && !failed;
        const runResult = { kind: "cev-sim.run-result", version: 1, runId: this.runId, controllerMode: "external-realtime",
            manifestId: this.verified.resolved.manifest.id, scenarioId: null, status: passed ? "passed" : completed ? "failed" : "interrupted",
            completed, passed, interrupted: !completed, interruptedBySignal: Boolean(this.interruptedBySignal),
            resolvedHash: this.verified.resolvedHash, simulationSemanticHash: finalization.simulationSemanticHash,
            episodeHash: finalization.episodeHash, trajectoryHash: finalization.trajectoryHash, step: String(finalization.step), timeNs: String(finalization.timeNs),
            assertions: finalization.assertions, outcomes: [], metrics: {}, terminationReason: failed ? "assertion-failed" : completed ? "max-steps" : "interrupted",
            failureReason: failed?.message ?? (completed ? null : "External run was interrupted."), degraded: false, artifactWarnings: [],
            diagnostics: { zenohTransport: this.zenohRuntime.diagnostics(), pacing: this.pacing }, completedAt: new Date().toISOString() };
        await this.packetHub.drain();
        await this.packetHub.finalize();
        const published = await this.artifactSink.finalize(runResult);
        this.artifactSink = null;
        this.state = "finalized";
        this.finalized = { finalization, ...published };
        return this.finalized;
    }

    health() {
        const memory = process.memoryUsage();
        const sensorQueueBytes = (this.runtime?.devices.devices ?? []).reduce((sum, device) => sum + Number(device.contractPublisher?.queuedBytes ?? (device.queue?.length ? serialize(device.queue).byteLength : 0)) + Number(device.nativeProductBytes || 0), 0);
        const inputQueueBytes = Number(this.kernel?.inputQueue.queuedBytes || 0);
        const recordingQueueBytes = Number(this.artifactSink?.recording?.queuedBytes || 0);
        const packetTransportQueueBytes = Number(this.packetHub.queuedBytes || 0);
        const zenohQueueBytes = Number(this.zenohRuntime?.diagnostics().queueBytes || 0);
        return { state: this.state, rssBytes: memory.rss, heapBytes: memory.heapUsed, lastCompletedStep: this.completedStep,
            queueBytes: sensorQueueBytes + inputQueueBytes + recordingQueueBytes + packetTransportQueueBytes + zenohQueueBytes,
            sensorQueueBytes, inputQueueBytes, recordingQueueBytes, packetTransportQueueBytes, zenohQueueBytes,
            stepInFlight: Boolean(this.inFlight), stepWallElapsedMs: this.inFlight ? this.scheduler.now() - this.stepStartedAt : 0 };
    }

    async abort() {
        await this.zenohRuntime?.close();
        await this.packetHub.abort();
        await this.artifactSink?.abort();
        this.artifactSink = null;
    }

    async close() {
        this.ownershipGuard?.close();
        await this.stop();
        try { await this.abort(); } finally { await this.kernel?.disposeAsync(); this.kernel = null; this.state = "closed"; }
    }
}
