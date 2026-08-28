import { clamp } from "three/src/math/MathUtils.js";
import { AssertionEngine } from "./AssertionEngine.js";
import { TopicInputQueue } from "./TopicInputQueue.js";
import { TopicContractRouter } from "./TopicContractRouter.js";
import { TransformRuntime } from "./TransformRuntime.js";
import { createLocalizationTruthPublisher } from "./LocalizationTruthPublisher.js";
import { ScenarioRuntime } from "../scenarios/ScenarioRuntime.js";
import { ScenarioDiagnostics } from "../scenarios/ScenarioDiagnostics.js";

export class SimulationEngine {
    /**
     * @param {Data} data 
     */
    constructor(data, options={}) {
        this.data = data;

        this.stepNs = Math.max(1, Math.floor(options.stepNs ?? ((options.fixedDt ?? (1 / 60)) * 1e9)));
        this.fixedDt = this.stepNs / 1e9;
        this.maxFrameDt = options.maxFrameDt ?? 0.1; // cap delta time to avoid instability
        this.maxSubSteps = options.maxSubSteps ?? 10; // cap sub-steps to avoid spiral of death

        this.status = 'stopped'; // ['stopped', 'playing', 'paused']
        this.time = 0;
        this.timeNs = 0;
        this.steps = 0;
        this.frames = 0;
        this.speed = 1;
        this.maxSteps = null;
        
        this.realtime = true; // whether to run in real-time (vs. as fast as possible)

        this.deterministic = true; // whether to use fixed time steps (vs. variable time steps)

        this.modules = {
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
        }

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.accumulator = 0; // for fixed time step simulation
        this.accumulatorNs = 0;
        this.lastFrameMs = 0; // for calculating delta time
        this.rafId = null; // for canceling the animation frame
        this.looping = false; // to prevent multiple simultaneous loops

        this.listeners = new Set();
        this.resetHandlers = new Set();
        this.viewportActive = true;
        this.telemetry = this.data.bindings?.()?.signalStore ?? null;
        this.resolvedRun = null;
        this.inputQueue = new TopicInputQueue();
        this.topicRouter = null;
        this.localizationTruthPublisher = null;
        this.assertionEngine = new AssertionEngine([], this.telemetry);
        this.scenarioRuntime = new ScenarioRuntime(this.data, { telemetry: this.telemetry });
        this.scenarioDiagnostics = new ScenarioDiagnostics();
        this.environmentRuntime = null;
        this.lastStepPhases = [];

        this._defineTelemetrySignals();

        this._frame = this._frame.bind(this);
    }

    _defineTelemetrySignals() {
        const define = (path, options) => this.telemetry?.defineSignal?.({ path, source: "simulation", ...options });
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

    _publishRuntimeState() {
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

    _emitLifecycle(name, payload = {}) {
        this.telemetry?.emitTelemetryEvent?.({
            timeUs: Math.round(this.timeNs / 1000),
            category: "simulation",
            name,
            severity: "info",
            payload: { time: this.time, step: this.steps, ...payload },
        });
    }

    configure({ scene, camera, renderer, controls = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;
        this.scenarioDiagnostics.attach(scene, camera);
    }

    setEnvironmentRuntime({ loader = null, persistence = null } = {}) {
        this.environmentRuntime = loader ? { loader, persistence } : null;
    }

    _applyResolvedEnvironment(resolvedEnvironment) {
        const frozenManifest = resolvedEnvironment?.manifest;
        const loader = this.environmentRuntime?.loader;
        if (!frozenManifest || !loader) return;

        const loadedTemplate = loader.manifest?.templateId ?? this.data.environment?.()?.templateId;
        const frozenTemplate = frozenManifest.templateId ?? loadedTemplate;
        if (loadedTemplate && frozenTemplate && loadedTemplate !== frozenTemplate) {
            throw new Error("The environment template changed after this run was resolved; resolve the run again.");
        }

        const persistence = this.environmentRuntime?.persistence;
        persistence?.suspendAutosave?.();
        try {
            const manifest = structuredClone(frozenManifest);
            const environment = this.data.environment?.();
            if (environment) {
                environment.name = manifest.name ?? environment.name;
                environment.templateId = frozenTemplate ?? environment.templateId;
                environment.roadStylePreset = manifest.roadStylePreset ?? environment.roadStylePreset;
            }
            loader.apply(manifest);
            loader.manifest = manifest;
            const common = { timeUs: 0, cycle: 0, source: "resolved-run", replayRole: "input", logClass: "core" };
            this.telemetry?.publishSignal?.("environment.id", environment?.environmentId ?? this.resolvedRun?.manifest?.environment?.id, { ...common, type: "string" });
            this.telemetry?.publishSignal?.("environment.manifest", manifest, { ...common, type: "json" });
        } finally {
            persistence?.resumeAutosave?.();
        }
    }

    getSnapshot() {
        return {
            status: this.status,
            time: this.time,
            timeNs: this.timeNs,
            stepNs: this.stepNs,
            steps: this.steps,
            frames: this.frames,
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
            scenario: this.scenarioRuntime.getSnapshot(),
            scenarioDiagnostics: { enabled: this.scenarioDiagnostics.enabled },
        }
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    _emit() {
        this._publishRuntimeState();
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    onReset(handler) {
        this.resetHandlers.add(handler);
        return () => this.resetHandlers.delete(handler);
    }

    startLoop() {
        if (this.looping) return;
        this.looping = true;
        this.lastFrameMs = performance.now();
        this.rafId = requestAnimationFrame(this._frame);
    }

    stopLoop() {
        this.looping = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    dispose() {
        this.stop();
        this.stopLoop();

        this.controls?.dispose();
        this.scenarioRuntime.dispose();
        this.scenarioDiagnostics.dispose();
        this.listeners.clear();
        this.resetHandlers.clear();
    }

    play() {
        this.startLoop();
        this.status = 'playing';
        this._emitLifecycle("play");
        this._emit();
    }

    pause() {
        this.status = 'paused';
        this._emitLifecycle("pause");
        this._emit();
    }

    stop({ reset = true} = {}) {
        this.status = 'stopped';
        this.accumulator = 0;
        this.accumulatorNs = 0;

        if (reset) {
            this.reset();
        }

        this.render();
        this._emitLifecycle("stop", { reset });
        this._emit();
    }

    reset() {
        this.time = 0;
        this.timeNs = 0;
        this.steps = 0;
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this.inputQueue.reset();
        this.assertionEngine.reset();
        this.scenarioRuntime.reset();
        this.localizationTruthPublisher?.reset?.();
        
        for (const handler of this.resetHandlers) {
            handler();
        }
        this._emitLifecycle("reset");
        if (this.resolvedRun) this._applyInitialState(this.resolvedRun.manifest.initialState);
        this.transformRuntime?.publishStaticTransforms?.(0);
    }

    step(count = 1) {
        this.status = 'paused';

        for (let i = 0; i < count; i++) {
            if (this._fixedStep(this.fixedDt) === false) break;
        }

        this.render();
        this._emitLifecycle("step", { count });
        this._emit();
    }

    setSpeed(speed) {
        this.speed = Math.max(0, Number(speed) || 0);
        this._emit();
    }

    setRealtime(realtime) {
        this.realtime = Boolean(realtime);
        this._emit();
    }

    setDeterministic(deterministic) {
        this.deterministic = this.resolvedRun ? true : Boolean(deterministic);
        this._emit();
    }

    async setPhysicsEnabled(enabled) {
        this.modules.physics = Boolean(enabled);

        if (enabled) {
            await this.data.physics()?.start?.();
        } else {
            await this.data.physics()?.stop?.();
        }

        this._emit();
    }

    setModule(name, enabled) {
        if (!(name in this.modules)) return;

        this.modules[name] = Boolean(enabled);
        this._emit();
    }

    setScenarioDiagnosticsEnabled(enabled) {
        this.scenarioDiagnostics.setEnabled(enabled);
        this.render();
        this._emit();
    }

    setWorkspaceActive(active, { preservePlayback = false } = {}) {
        const nextActive = Boolean(active);
        if (nextActive) {
            if (this.viewportActive && this.looping) return;
            this.viewportActive = true;
            this.startLoop();
            this.render();
            this._emit();
            return;
        }

        if (!this.viewportActive && !this.looping && !preservePlayback) return;
        this.viewportActive = false;
        if (this.controls) this.controls.enabled = false;
        if (preservePlayback) {
            if (this.status === "playing") this.startLoop();
            else this.stopLoop();
            this._emit();
            return;
        }
        if (this.status === "playing") this.pause();
        this.stopLoop();
        this._emit();
    }

    setViewportActive(active) {
        this.setWorkspaceActive(active);
    }

    async applyRunManifest(resolved) {
        if (!resolved?.manifest) throw new Error("Resolved run manifest is required.");
        this.pause();
        this.scenarioRuntime.configure(null);
        this.scenarioDiagnostics.configure(null);
        this.telemetry?.resetRunState?.();
        this.resolvedRun = structuredClone(resolved);
        const manifest = this.resolvedRun.manifest;
        this._applyResolvedEnvironment(this.resolvedRun.environment);
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
        this.transformRuntime = resolved.calibration
            ? new TransformRuntime(resolved.calibration, this.topicRouter, {
                client: this.data.client?.()?.get?.(),
            })
            : null;
        this.assertionEngine = new AssertionEngine(manifest.assertions, this.telemetry);
        this.data.bindings?.()?.setTopicScheduler?.((info) => this.queueTopicInput(info));

        await this.data.vehicles?.()?.configureFromManifest?.(manifest.initialState.vehicles, this.scene, {
            resolvedVehicles: this.resolvedRun.vehicles || [],
        });

        const selectedBindings = resolved.bindings?.entries || [];
        await this.data.bindings?.()?.setManifest?.({
            kind: "cev-sim.script-bindings",
            version: 2,
            enabled: manifest.scripts.enabled,
            folders: [],
            bindings: selectedBindings,
        }, { persist: false });
        await this.data.bindings?.()?.prepareResolvedScripts?.(resolved.scripts || [], {
            seed: manifest.seed,
            parameterBindings: [
                ...(resolved.parameters?.manifest?.bindings || []),
                ...(resolved.parameters?.scenario?.bindings || []),
            ],
        });
        this.data.bindings?.()?.setTopicScheduler?.((info) => this.queueTopicInput(info));
        this.data.bindings?.()?.setTopicRouter?.(this.topicRouter, manifest.topics);
        this.data.devices?.()?.configureFromManifest?.(manifest.sensorRig, {
            seed: manifest.seed,
            topics: manifest.topics,
            topicRouter: this.topicRouter,
            transformRuntime: this.transformRuntime,
            calibrationHash: resolved.calibration?.hash ?? null,
            stepNs: manifest.clock.stepNs,
        });
        await this.data.physics?.()?.configureRun?.(manifest, resolved.environment?.manifest);
        this.reset();
        this.transformRuntime?.publishStaticTransforms?.(0);
        for (const [path, value] of Object.entries(manifest.initialState.signals || {})) {
            this.telemetry?.publishSignal?.(path, value, { timeUs: 0, cycle: 0, source: "manifest", replayRole: "input", logClass: "core" });
        }
        this.scenarioRuntime.configure(this.resolvedRun);
        this.scenarioDiagnostics.configure(this.resolvedRun?.scenario?.scenario ?? null);
        this.status = "paused";
        this._publishClock();
        this._emitLifecycle("manifest-applied", { manifestId: manifest.id, resolvedHash: resolved.resolvedHash });
        this._emit();
        this.render();
        return this.getSnapshot();
    }

    queueTopicInput(info) {
        if (!this.resolvedRun) {
            this.data.bindings?.()?.applyTopicUpdate?.(info);
            return null;
        }
        const arrivalTimeNs = this.timeNs;
        return this.inputQueue.enqueue(info, this.steps + 1, { arrivalTimeNs });
    }

    _frame(nowMs) {
        if (!this.looping) return;

        const rawFrameDt = (nowMs - this.lastFrameMs) / 1000;
        this.lastFrameMs = nowMs;

        const frameDt = clamp(rawFrameDt, 0, this.maxFrameDt);

        if (this.controls) {
            const cameraControlsEnabled = this.modules.controls && this.data.settings()?.cameraControlsEnabled !== false;
            this.controls.enabled = this.viewportActive && cameraControlsEnabled;

            if (this.viewportActive && cameraControlsEnabled) {
                this.controls.update();
            }
        }

        if (this.status === 'playing') {
            this._advanceSimulation(frameDt);
            this._emit();
        }

        if (this.viewportActive && this.modules.rendering) {
            this.render();
        }

        if (this.looping) this.rafId = requestAnimationFrame(this._frame);
    }

    _advanceSimulation(frameDt) {
        const scaledDt = frameDt * this.speed;

        if (!this.deterministic) {
            this._fixedStep(scaledDt);
            return;
        }

        this.accumulatorNs += this.realtime
            ? Math.max(0, Math.round(scaledDt * 1e9))
            : this.stepNs * Math.max(1, this.maxSubSteps);
        this.accumulator = this.accumulatorNs / 1e9;

        let subSteps = 0;

        while (this.accumulatorNs >= this.stepNs && subSteps < this.maxSubSteps) {
            const previousStep = this.steps;
            const shouldContinue = this._fixedStep(this.fixedDt);
            if (this.steps > previousStep) this.accumulatorNs -= this.stepNs;
            this.accumulator = this.accumulatorNs / 1e9;
            subSteps++;
            if (shouldContinue === false) break;
        }

        // Remaining accumulated simulation time is intentionally retained.
        // Rendering may lag or skip, but deterministic simulation steps are never dropped.
    }

    _fixedStep(dt) {
        if (this.maxSteps !== null && this.steps >= this.maxSteps) {
            this.status = "paused";
            this._emitLifecycle("max-steps-reached", { maxSteps: this.maxSteps });
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
            this.data.keys()?.update?.(dt);
            this._applyQueuedInputs(nextStep);
        });

        phase("scripts", () => {
            if (this.modules.scripting) {
                this.data.bindings?.()?.update?.(dt, { step: nextStep, timeNs: nextTimeNs });
            }
        });

        let scenarioPreTerminal = false;
        if (this.scenarioRuntime.active) {
            phase("scenario-before-motion", () => {
                const snapshot = this.scenarioRuntime.preMotion({ step: nextStep, timeNs: nextTimeNs, dt });
                scenarioPreTerminal = Boolean(snapshot.terminal);
            });
        }

        this.data.physics?.()?.beginStep?.();
        phase("vehicles", () => {
            if (!scenarioPreTerminal && this.modules.vehicles) this.data.vehicles()?.update?.(dt);
        });

        phase("physics", () => {
            if (!scenarioPreTerminal && this.modules.physics) this.data.physics()?.step?.(dt);
        });

        let contacts = null;
        phase("contacts", () => {
            contacts = this.data.physics?.()?.syncAndPublishContacts?.({ step: nextStep, timeNs: nextTimeNs }) ?? null;
            return contacts;
        });

        this.steps = nextStep;
        this.timeNs = nextTimeNs;
        this.time = this.timeNs / 1e9;
        phase("clock", () => this._publishClock());

        phase("transforms", () => {
            if (this.transformRuntime) {
                const vehicles = this.data.vehicles?.()?.vehicles || [];
                this.transformRuntime.publishDynamicTransforms(this.timeNs, this.steps, vehicles);
                this.localizationTruthPublisher?.publish(this.timeNs, this.steps, vehicles);
            }
        });

        phase("sensors", () => {
            if (this.modules.sensors) this.data.devices()?.update?.(dt, { step: this.steps, timeNs: this.timeNs });
        });

        phase("delivery", () => this.data.devices?.()?.deliver?.({ step: this.steps, timeNs: this.timeNs }));

        if (this.modules.baking) this.data.baking()?.update?.(dt);

        this._publishSimulationEntities();
        this._publishRuntimeState();
        if (this.scenarioRuntime.active || this.scenarioDiagnostics.enabled) {
            phase("scenario-after-telemetry", () => {
                const snapshot = this.scenarioRuntime.active
                    ? this.scenarioRuntime.postTelemetry({
                        step: this.steps,
                        timeNs: this.timeNs,
                        dt,
                        contacts,
                    })
                    : {};
                if (snapshot.terminal) {
                    this.status = "paused";
                    shouldContinue = false;
                }
                this.scenarioDiagnostics.update({
                    ...snapshot,
                    actorPoses: this._actorPoses(),
                });
            });
        }
        phase("assertions", () => {
            if (!this.resolvedRun || this.modules.assertions === false) return;
            const evaluated = this.assertionEngine.evaluate(this.steps);
            this.telemetry?.publishSignal?.("simulation.assertions", evaluated.results, {
                timeUs: Math.round(this.timeNs / 1000), cycle: this.steps, source: "assertions", type: "json",
            });
            if (evaluated.shouldStop) {
                this.status = "paused";
                shouldContinue = false;
                this._emitLifecycle("assertion-stop", { results: evaluated.results });
            }
            const scenario = this.scenarioRuntime.observeAssertions(evaluated.results);
            if (scenario.terminal) {
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
            if (routed && routed.ok === false && routed.code !== "stale") {
                continue;
            }
            this.data.bindings?.()?.applyTopicUpdate?.(entry.info);
            const scenarioOwnsVehicleCommands = this.scenarioRuntime.active;
            const handledByScenario = this.scenarioRuntime.applyExternalTopic(entry.info);
            const controlTopic = this.resolvedRun?.manifest?.topics?.find((topic) =>
                topic.direction === "input" && (topic.name === entry.info.name || topic.id === "ackdrive")
            );
            const isLegacyAck = controlTopic?.contractId === "ackdrive-legacy"
                || entry.info.name === "/ackdrive";
            if (!scenarioOwnsVehicleCommands && !handledByScenario && isLegacyAck) {
                const vehicle = this.data.vehicles?.()?.vehicles?.find((candidate) => candidate.telemetryId === "ego")
                    ?? this.data.vehicles?.()?.vehicles?.[0];
                if (vehicle) {
                    vehicle.velocity.x = Number(entry.info.value?.speed || 0) * 0.44704;
                    vehicle.steeringAngle = -Number(entry.info.value?.steering_angle || 0) * Math.PI / 180;
                }
            }
            this.telemetry?.emitTelemetryEvent?.({
                timeUs: Math.round(applyTimeNs / 1000),
                category: "topics",
                name: "input-applied",
                payload: { topic: entry.info.name, step, sequence: entry.sequence, routed: routed?.ok ?? null },
            });
        }
    }

    _applyInitialState(initialState = {}) {
        const byId = new Map((initialState.vehicles || []).map((vehicle) => [vehicle.id, vehicle]));
        for (const [index, vehicle] of (this.data.vehicles?.()?.vehicles || []).entries()) {
            const configured = byId.get(vehicle.telemetryId) || initialState.vehicles?.[index];
            if (!configured) continue;
            vehicle.position?.set?.(configured.pose.position.x, configured.pose.position.y, configured.pose.position.z);
            vehicle.rotation?.set?.(configured.pose.rotation.x, configured.pose.rotation.y, configured.pose.rotation.z, configured.pose.rotation.order || "XYZ");
            vehicle.velocity?.set?.(configured.linearVelocity.x, configured.linearVelocity.y, configured.linearVelocity.z);
            if (Number.isFinite(configured.steeringAngle)) vehicle.steeringAngle = configured.steeringAngle;
            vehicle.updatePosition?.(vehicle.position);
            vehicle.updateRotation?.(vehicle.rotation);
        }
        this.data.physics?.()?.resetRun?.();
        this.data.devices?.()?.resetSchedule?.();
    }

    _publishClock() {
        if (!this.telemetry) return;
        const stamp = {
            sec: Math.floor(this.timeNs / 1e9),
            nanosec: this.timeNs % 1e9,
        };
        this.telemetry.publishSignal("simulation.clock", stamp, {
            timeUs: Math.round(this.timeNs / 1000), cycle: this.steps, source: "simulation", type: "json",
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

    _actorPoses() {
        const poses = {};
        const vehicles = this.data.vehicles?.()?.vehicles || [];
        vehicles.forEach((vehicle, index) => {
            const id = vehicle.telemetryId || `vehicle-${index + 1}`;
            poses[id] = {
                x: Number(vehicle.position?.x || 0),
                y: Number(vehicle.position?.y || 0),
                z: Number(vehicle.position?.z || 0),
            };
        });
        return poses;
    }

    _publishSimulationEntities() {
        if (!this.telemetry) return;
        const timeUs = Math.round(this.timeNs / 1000);
        const vehicles = this.data.vehicles?.()?.vehicles || [];
        vehicles.forEach((vehicle, index) => {
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
            const options = { timeUs, cycle: this.steps, source: "simulation", category: "vehicles", replayRole: "state", logClass: "core" };
            this.telemetry.publishSignal(`${prefix}.pose`, pose, { ...options, type: "pose3" });
            this.telemetry.publishSignal(`${prefix}.velocity`, {
                x: Number(vehicle.velocity?.x || 0),
                y: Number(vehicle.velocity?.y || 0),
                z: Number(vehicle.velocity?.z || 0),
            }, { ...options, type: "vec3", unit: "m/s" });
            if (Number.isFinite(vehicle.steeringAngle)) {
                this.telemetry.publishSignal(`${prefix}.steeringAngle`, vehicle.steeringAngle, {
                    ...options,
                    type: "float64",
                    unit: "rad",
                    replayRole: "input",
                });
            }
        });
    }

    render() {
        if (!this.scene || !this.camera || !this.renderer) return;

        this.data.earthTilesManager?.()?.update?.();

        if (this.data.skyManager?.()?.render?.()) {
            this.frames += 1;
            return;
        }

        this.renderer.render(this.scene, this.camera);
        this.frames += 1;
    }
}
