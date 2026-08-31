import { CandidateOutputRuntime } from "../../autonomy/CandidateOutputRuntime.js";
import { ControlRuntime } from "../../autonomy/ControlRuntime.js";
import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";
import { AssertionEngine } from "../AssertionEngine.js";
import { createLocalizationTruthPublisher } from "../LocalizationTruthPublisher.js";
import { TopicContractRouter } from "../TopicContractRouter.js";
import { TopicInputQueue } from "../TopicInputQueue.js";
import { TransformRuntime } from "../TransformRuntime.js";

const DEFAULT_MODULES = Object.freeze({
    inputs: true,
    physics: false,
    vehicles: true,
    sensors: true,
    controls: true,
    rendering: true,
    environment: true,
    scripting: true,
    baking: false,
    assertions: true,
});

function cloneSnapshot(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

/**
 * Authoritative fixed-step simulation state machine. It deliberately owns no
 * RAF, renderer, scene, DOM, viewport controls, or presentation overlays.
 */
export class SimulationKernel {
    constructor(runtimeContext, options = {}) {
        if (!runtimeContext) throw new Error("SimulationKernel requires a runtime context.");
        this.context = runtimeContext;
        this.telemetry = runtimeContext.telemetry ?? null;

        this.stepNs = Math.max(1, Math.floor(options.stepNs ?? ((options.fixedDt ?? (1 / 60)) * 1e9)));
        this.fixedDt = this.stepNs / 1e9;
        this.status = "stopped";
        this.time = 0;
        this.timeNs = 0;
        this.steps = 0;
        this.speed = 1;
        this.maxSteps = null;
        this.realtime = true;
        this.deterministic = true;
        this.modules = { ...DEFAULT_MODULES };

        this.resolvedRun = null;
        this.inputQueue = new TopicInputQueue();
        this.topicRouter = null;
        this.localizationTruthPublisher = null;
        this.assertionEngine = new AssertionEngine([], this.telemetry);
        this.scenarioRuntime = runtimeContext.scenarios ?? null;
        this.candidateOutputRuntime = null;
        this.controlRuntime = null;
        this.transformRuntime = null;
        this.lastStepPhases = [];
        this.resetHandlers = new Set();

        this._defineTelemetrySignals();
    }

    _defineTelemetrySignals() {
        const define = (path, options) => this.telemetry?.defineSignal?.({
            path,
            source: "simulation",
            ...options,
        });
        define("simulation.status", { type: "string", category: "simulation", replayRole: "input", logClass: "core" });
        define("simulation.time", { type: "float64", unit: "s", category: "simulation", replayRole: "state", logClass: "core" });
        define("simulation.step", { type: "uint64", category: "simulation", replayRole: "state", logClass: "core" });
        define("simulation.speed", { type: "float64", category: "simulation", replayRole: "input", logClass: "core" });
        define("simulation.fixedDt", { type: "float64", unit: "s", category: "simulation", replayRole: "input", logClass: "core" });
        define("simulation.timeNs", { type: "uint64", unit: "ns", category: "simulation", replayRole: "state", logClass: "core" });
        define("simulation.clock", { type: "json", category: "simulation", replayRole: "state", logClass: "core" });
        define("simulation.assertions", { type: "json", category: "assertions", replayRole: "state", logClass: "core" });
        define("simulation.modules", { type: "json", category: "simulation", replayRole: "input", logClass: "core" });
        define("simulation.run", { type: "json", category: "simulation", replayRole: "input", logClass: "core" });
    }

    publishRuntimeState() {
        if (!this.telemetry) return;
        const timeUs = Math.round(this.timeNs / 1000);
        const common = { timeUs, cycle: this.steps, source: "simulation" };
        this.telemetry.publishSignal("simulation.status", this.status, common);
        this.telemetry.publishSignal("simulation.time", this.time, common);
        this.telemetry.publishSignal("simulation.timeNs", this.timeNs, { ...common, type: "uint64" });
        this.telemetry.publishSignal("simulation.step", this.steps, common);
        this.telemetry.publishSignal("simulation.speed", this.speed, common);
        this.telemetry.publishSignal("simulation.fixedDt", this.fixedDt, common);
        this.telemetry.publishSignal("simulation.modules", { ...this.modules }, common);
        this.telemetry.publishSignal("simulation.run", this.resolvedRun ? {
            manifestId: this.resolvedRun.manifest.id,
            resolvedHash: this.resolvedRun.resolvedHash,
        } : null, common);
    }

    emitLifecycle(name, payload = {}) {
        this.telemetry?.emitTelemetryEvent?.({
            timeUs: Math.round(this.timeNs / 1000),
            category: "simulation",
            name,
            severity: "info",
            payload: { time: this.time, step: this.steps, ...payload },
        });
    }

    getSnapshot() {
        return cloneSnapshot({
            status: this.status,
            time: this.time,
            timeNs: this.timeNs,
            stepNs: this.stepNs,
            steps: this.steps,
            speed: this.speed,
            realtime: this.realtime,
            deterministic: this.deterministic,
            modules: { ...this.modules },
            maxSteps: this.maxSteps,
            activeRun: this.resolvedRun ? {
                manifestId: this.resolvedRun.manifest.id,
                resolvedHash: this.resolvedRun.resolvedHash,
            } : null,
            assertions: this.assertionEngine.snapshot(),
            scenario: this.scenarioRuntime?.getSnapshot?.() ?? null,
        });
    }

    onReset(handler) {
        this.resetHandlers.add(handler);
        return () => this.resetHandlers.delete(handler);
    }

    play() {
        this.status = "playing";
        this.emitLifecycle("play");
    }

    pause() {
        this.status = "paused";
        this.emitLifecycle("pause");
    }

    stop({ reset = true } = {}) {
        this.status = "stopped";
        if (reset) this.reset();
        this.emitLifecycle("stop", { reset });
    }

    reset() {
        this.time = 0;
        this.timeNs = 0;
        this.steps = 0;
        this.inputQueue.reset();
        this.assertionEngine.reset();
        this.scenarioRuntime?.reset?.();
        this.localizationTruthPublisher?.reset?.();
        this.candidateOutputRuntime?.reset?.();
        this.controlRuntime?.reset?.();

        for (const handler of this.resetHandlers) handler();
        this.emitLifecycle("reset");
        if (this.resolvedRun) {
            this.context.vehicles.applyInitialState(this.resolvedRun.manifest.initialState);
            this.context.physics.resetRun();
            this.context.devices.resetSchedule();
        }
        this.transformRuntime?.publishStaticTransforms?.(0);
    }

    step(count = 1, { afterStep = null } = {}) {
        this.status = "paused";
        let shouldContinue = true;
        for (let index = 0; index < count; index += 1) {
            const previousStep = this.steps;
            shouldContinue = this.advanceStep(this.fixedDt);
            if (this.steps > previousStep) afterStep?.(this.fixedDt, this.getSnapshot());
            if (shouldContinue === false) break;
        }
        this.emitLifecycle("step", { count });
        return shouldContinue;
    }

    setSpeed(speed) {
        this.speed = Math.max(0, Number(speed) || 0);
    }

    setRealtime(realtime) {
        this.realtime = Boolean(realtime);
    }

    setDeterministic(deterministic) {
        this.deterministic = this.resolvedRun ? true : Boolean(deterministic);
    }

    async setPhysicsEnabled(enabled) {
        this.modules.physics = Boolean(enabled);
        if (enabled) await this.context.physics.start();
        else await this.context.physics.stop();
    }

    setModule(name, enabled) {
        if (!(name in this.modules)) return;
        this.modules[name] = Boolean(enabled);
    }

    async configureRun(resolved) {
        if (!resolved?.manifest) throw new Error("Resolved run manifest is required.");

        this.scenarioRuntime?.configure?.(null);
        this.telemetry?.resetRunState?.();
        this.resolvedRun = structuredClone(resolved);
        const manifest = this.resolvedRun.manifest;
        await this.context.environment.applyResolved(this.resolvedRun.environment, this.resolvedRun);

        this.stepNs = Math.max(1, Math.floor(manifest.clock.stepNs));
        this.fixedDt = this.stepNs / 1e9;
        this.realtime = manifest.clock.pacing === "realtime";
        this.deterministic = true;
        this.speed = Math.max(0, Number(manifest.clock.speed) || 0);
        this.maxSteps = manifest.clock.maxSteps;
        for (const [name, enabled] of Object.entries(manifest.clock.modules || {})) {
            if (name in this.modules) this.modules[name] = Boolean(enabled);
        }

        this.inputQueue = new TopicInputQueue(manifest.topics);
        this.topicRouter = new TopicContractRouter(manifest, { telemetry: this.telemetry });
        this.localizationTruthPublisher = createLocalizationTruthPublisher(manifest, this.topicRouter);
        this.localizationTruthPublisher.stepNs = manifest.clock.stepNs;
        this.transformRuntime = this.resolvedRun.calibration
            ? new TransformRuntime(this.resolvedRun.calibration, this.topicRouter, {
                client: this.context.topics.client(),
            })
            : null;
        this.candidateOutputRuntime = new CandidateOutputRuntime({
            telemetry: this.telemetry,
            transformRuntime: this.transformRuntime,
            manifest,
        });
        this.candidateOutputRuntime.setTransformRuntime(this.transformRuntime);
        this.controlRuntime = new ControlRuntime({
            telemetry: this.telemetry,
            manifest,
            controls: manifest.controls,
        });
        this.assertionEngine = new AssertionEngine(manifest.assertions, this.telemetry);
        this.context.scripts.setTopicScheduler((info) => this.queueTopicInput(info));

        await this.context.vehicles.configureFromManifest(manifest.initialState.vehicles, {
            resolvedVehicles: this.resolvedRun.vehicles || [],
        });
        this._configureControlRuntimeLimits(manifest);

        const selectedBindings = this.resolvedRun.bindings?.entries || [];
        await this.context.scripts.setManifest({
            kind: "cev-sim.script-bindings",
            version: 2,
            enabled: manifest.scripts.enabled,
            folders: [],
            bindings: selectedBindings,
        }, { persist: false });
        await this.context.scripts.prepareResolvedScripts(this.resolvedRun.scripts || [], {
            seed: manifest.seed,
            parameterBindings: [
                ...(this.resolvedRun.parameters?.manifest?.bindings || []),
                ...(this.resolvedRun.parameters?.scenario?.bindings || []),
            ],
        });
        this.context.scripts.setTopicScheduler((info) => this.queueTopicInput(info));
        this.context.scripts.setTopicRouter(this.topicRouter, manifest.topics);
        this.context.devices.configureFromManifest(manifest.sensorRig, {
            seed: manifest.seed,
            topics: manifest.topics,
            topicRouter: this.topicRouter,
            transformRuntime: this.transformRuntime,
            calibrationHash: this.resolvedRun.calibration?.hash ?? null,
            stepNs: manifest.clock.stepNs,
        });
        await this.context.physics.configureRun(manifest, this.resolvedRun.environment?.manifest);

        this.reset();
        this.transformRuntime?.publishStaticTransforms?.(0);
        for (const [path, value] of Object.entries(manifest.initialState.signals || {})) {
            this.telemetry?.publishSignal?.(path, value, {
                timeUs: 0,
                cycle: 0,
                source: "manifest",
                replayRole: "input",
                logClass: "core",
            });
        }
        this.scenarioRuntime?.configure?.(this.resolvedRun);
        this.scenarioRuntime?.setControlRuntime?.(this.controlRuntime);
        this.status = "paused";
        this.publishClock();
        this.emitLifecycle("manifest-applied", {
            manifestId: manifest.id,
            resolvedHash: resolved.resolvedHash,
        });
        return this.getSnapshot();
    }

    queueTopicInput(info) {
        if (!this.resolvedRun) {
            this.context.scripts.applyTopicUpdate(info);
            return null;
        }
        const arrivalTimeNs = this.timeNs;
        return this.inputQueue.enqueue(info, this.steps + 1, { arrivalTimeNs });
    }

    advanceStep(dt = this.fixedDt) {
        if (this.maxSteps !== null && this.steps >= this.maxSteps) {
            this.status = "paused";
            this.emitLifecycle("max-steps-reached", { maxSteps: this.maxSteps });
            return false;
        }

        const nextStep = this.steps + 1;
        const nextTimeNs = nextStep * this.stepNs;
        this.lastStepPhases = [];
        let shouldContinue = true;
        const phase = (name, operation) => {
            this.lastStepPhases.push(name);
            return operation?.();
        };

        phase("inputs", () => {
            this.context.inputs.update(dt);
            this._applyQueuedInputs(nextStep);
        });

        phase("scripts", () => {
            if (this.modules.scripting) {
                this.context.scripts.update(dt, { step: nextStep, timeNs: nextTimeNs });
            }
        });

        let scenarioPreTerminal = false;
        if (this.scenarioRuntime?.active) {
            phase("scenario-before-motion", () => {
                const snapshot = this.scenarioRuntime.preMotion({ step: nextStep, timeNs: nextTimeNs, dt });
                scenarioPreTerminal = Boolean(snapshot.terminal);
            });
        }

        phase("controls", () => {
            if (!this.controlRuntime || this.modules.controls === false) return;
            const applied = this.controlRuntime.step({ step: nextStep, timeNs: nextTimeNs, dt });
            this.context.controls.applySetpoints(applied);
        });

        this.context.physics.beginStep();
        phase("vehicles", () => {
            if (!scenarioPreTerminal && this.modules.vehicles) this.context.vehicles.update(dt);
        });

        phase("physics", () => {
            if (!scenarioPreTerminal && this.modules.physics) this.context.physics.step(dt);
        });

        if (this.controlRuntime) {
            phase("controls-achieved", () => {
                this.context.controls.sampleAchieved(this.controlRuntime, {
                    targetVehicleId: this.resolvedRun?.manifest?.controls?.targetVehicleId || "ego",
                    step: this.steps,
                    timeNs: this.timeNs,
                });
            });
        }

        let contacts = null;
        phase("contacts", () => {
            contacts = this.context.physics.syncAndPublishContacts({
                step: nextStep,
                timeNs: nextTimeNs,
            });
            return contacts;
        });

        this.steps = nextStep;
        this.timeNs = nextTimeNs;
        this.time = this.timeNs / 1e9;
        phase("clock", () => this.publishClock());

        phase("transforms", () => {
            if (!this.transformRuntime) return;
            const vehicles = this.context.vehicles.list();
            this.transformRuntime.publishDynamicTransforms(this.timeNs, this.steps, vehicles);
            this.localizationTruthPublisher?.publish(this.timeNs, this.steps, vehicles);
        });

        phase("sensors", () => {
            if (this.modules.sensors) {
                this.context.devices.update(dt, { step: this.steps, timeNs: this.timeNs });
            }
        });

        phase("delivery", () => this.context.devices.deliver({
            step: this.steps,
            timeNs: this.timeNs,
        }));

        // This legacy phase name is part of the PR 1 characterization. Only
        // derived state/telemetry remains here; graphics are updated by the
        // browser adapter after the authoritative transition completes.
        phase("candidate-viz", () => {
            this.candidateOutputRuntime?.refreshOracle?.({
                applyStep: this.steps,
                applyTimeNs: this.timeNs,
            });
        });

        this.publishSimulationEntities();
        this.publishRuntimeState();
        if (this.scenarioRuntime?.active) {
            phase("scenario-after-telemetry", () => {
                const snapshot = this.scenarioRuntime.postTelemetry({
                    step: this.steps,
                    timeNs: this.timeNs,
                    dt,
                    contacts,
                });
                if (snapshot.terminal) {
                    this.status = "paused";
                    shouldContinue = false;
                }
            });
        }

        phase("assertions", () => {
            if (!this.resolvedRun || this.modules.assertions === false) return;
            const evaluated = this.assertionEngine.evaluate(this.steps);
            this.telemetry?.publishSignal?.("simulation.assertions", evaluated.results, {
                timeUs: Math.round(this.timeNs / 1000),
                cycle: this.steps,
                source: "assertions",
                type: "json",
            });
            if (evaluated.shouldStop) {
                this.status = "paused";
                shouldContinue = false;
                this.emitLifecycle("assertion-stop", { results: evaluated.results });
            }
            const scenario = this.scenarioRuntime?.observeAssertions?.(evaluated.results);
            if (scenario?.terminal) {
                this.status = "paused";
                shouldContinue = false;
            }
        });
        return shouldContinue;
    }

    _applyQueuedInputs(step) {
        const applyTimeNs = step * this.stepNs;
        for (const entry of this.inputQueue.drain(step, applyTimeNs)) {
            const routed = this.topicRouter?.routeInbound(entry.info, {
                applyStep: step,
                applyTimeNs,
                arrivalTimeNs: entry.arrivalTimeNs,
            });
            this.candidateOutputRuntime?.ingestRouted?.(routed, { applyStep: step, applyTimeNs });
            if (routed && routed.ok === false && routed.code !== "stale" && routed.code !== "invalid") {
                continue;
            }
            if (routed && routed.ok === false) continue;
            this.context.scripts.applyTopicUpdate(entry.info);
            const handledByScenario = this.scenarioRuntime?.applyExternalTopic?.(entry.info) ?? false;
            const controlTopic = this.resolvedRun?.manifest?.topics?.find((topic) =>
                topic.direction === "input"
                && (topic.contractId === "controls-command"
                    || topic.name === entry.info.name
                    || topic.id === entry.info.name)
            );
            const isControlsCommand = controlTopic?.contractId === "controls-command"
                || entry.info.name === "/controls/command";
            if (!handledByScenario && isControlsCommand && this.controlRuntime) {
                this.controlRuntime.ingestStampedCommand(entry.info, {
                    vehicleId: this.resolvedRun?.manifest?.controls?.targetVehicleId || "ego",
                    producer: controlTopic?.producer || "candidate",
                    applyTimeNs,
                });
            }
            this.telemetry?.emitTelemetryEvent?.({
                timeUs: Math.round(applyTimeNs / 1000),
                category: "topics",
                name: "input-applied",
                payload: {
                    topic: entry.info.name,
                    step,
                    sequence: entry.sequence,
                    routed: routed?.ok ?? null,
                },
            });
        }
    }

    _configureControlRuntimeLimits(manifest) {
        if (!this.controlRuntime) return;
        const vehicleLimits = {};
        const resolvedByActor = new Map((this.resolvedRun?.vehicles || []).map((entry) => [entry.actorId, entry]));
        for (const entry of manifest.initialState?.vehicles || []) {
            const resolved = resolvedByActor.get(entry.id);
            const kinematics = resolved?.manifest?.kinematics
                || getBuiltInVehicleManifest(entry.type)?.kinematics
                || {};
            vehicleLimits[entry.id] = { ...kinematics };
        }
        this.controlRuntime.configure({
            manifest,
            controls: manifest.controls,
            vehicleLimits,
        });
    }

    publishClock() {
        if (!this.telemetry) return;
        const stamp = {
            sec: Math.floor(this.timeNs / 1e9),
            nanosec: this.timeNs % 1e9,
        };
        this.telemetry.publishSignal("simulation.clock", stamp, {
            timeUs: Math.round(this.timeNs / 1000),
            cycle: this.steps,
            source: "simulation",
            type: "json",
        });
        if (this.resolvedRun?.manifest.clock.publishClock) {
            const topic = this.resolvedRun.manifest.topics.find((candidate) => candidate.id === "clock");
            if (topic) {
                this.topicRouter?.routeOutbound?.("clock", {
                    value: { clock: stamp },
                    typeStr: topic.schema?.type || topic.type,
                }, {
                    producer: "simulator",
                    captureTimeNs: this.timeNs,
                    deliveryTimeNs: this.timeNs,
                    cycle: this.steps,
                });
            }
        }
    }

    actorPoses() {
        const poses = {};
        this.context.vehicles.list().forEach((vehicle, index) => {
            const id = vehicle.telemetryId || `vehicle-${index + 1}`;
            poses[id] = {
                x: Number(vehicle.position?.x || 0),
                y: Number(vehicle.position?.y || 0),
                z: Number(vehicle.position?.z || 0),
            };
        });
        return poses;
    }

    targetVehiclePose() {
        const targetId = this.resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
        const vehicles = this.context.vehicles.list();
        const vehicle = vehicles.find((candidate) => candidate.telemetryId === targetId) ?? vehicles[0];
        return vehicle ? {
            position: {
                x: Number(vehicle.position?.x) || 0,
                y: Number(vehicle.position?.y) || 0,
                z: Number(vehicle.position?.z) || 0,
            },
            yaw: Number(vehicle.rotation?.y) || 0,
        } : null;
    }

    publishSimulationEntities() {
        if (!this.telemetry) return;
        const timeUs = Math.round(this.timeNs / 1000);
        this.context.vehicles.list().forEach((vehicle, index) => {
            const id = vehicle.telemetryId || `vehicle-${index + 1}`;
            const prefix = `vehicles.${id}`;
            const pose = {
                position: {
                    x: Number(vehicle.position?.x || 0),
                    y: Number(vehicle.position?.y || 0),
                    z: Number(vehicle.position?.z || 0),
                },
                rotation: {
                    x: Number(vehicle.rotation?.x || 0),
                    y: Number(vehicle.rotation?.y || 0),
                    z: Number(vehicle.rotation?.z || 0),
                    order: vehicle.rotation?.order || "XYZ",
                },
            };
            const common = {
                timeUs,
                cycle: this.steps,
                source: "simulation",
                category: "vehicles",
                replayRole: "state",
                logClass: "core",
            };
            this.telemetry.publishSignal(`${prefix}.pose`, pose, { ...common, type: "pose3" });
            this.telemetry.publishSignal(`${prefix}.velocity`, {
                x: Number(vehicle.velocity?.x || 0),
                y: Number(vehicle.velocity?.y || 0),
                z: Number(vehicle.velocity?.z || 0),
            }, { ...common, type: "vec3", unit: "m/s" });
            if (Number.isFinite(vehicle.steeringAngle)) {
                this.telemetry.publishSignal(`${prefix}.steeringAngle`, vehicle.steeringAngle, {
                    ...common,
                    type: "float64",
                    unit: "rad",
                    replayRole: "input",
                });
            }
        });
    }

    dispose() {
        this.scenarioRuntime?.dispose?.();
        this.resetHandlers.clear();
    }
}
