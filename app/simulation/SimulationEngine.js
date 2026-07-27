import { clamp } from "three/src/math/MathUtils.js";
import { AssertionEngine } from "./AssertionEngine.js";
import { TopicInputQueue } from "./TopicInputQueue.js";

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
        this.assertionEngine = new AssertionEngine([], this.telemetry);
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
        
        for (const handler of this.resetHandlers) {
            handler();
        }
        this._emitLifecycle("reset");
        if (this.resolvedRun) this._applyInitialState(this.resolvedRun.manifest.initialState);
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

    setWorkspaceActive(active) {
        const nextActive = Boolean(active);
        if (this.viewportActive === nextActive && (nextActive ? this.looping : !this.looping)) return;
        this.viewportActive = nextActive;
        if (!nextActive) {
            if (this.status === "playing") this.pause();
            this.stopLoop();
            if (this.controls) this.controls.enabled = false;
            this._emit();
            return;
        }
        this.startLoop();
        this.render();
        this._emit();
    }

    setViewportActive(active) {
        this.setWorkspaceActive(active);
    }

    async applyRunManifest(resolved) {
        if (!resolved?.manifest) throw new Error("Resolved run manifest is required.");
        this.pause();
        this.resolvedRun = structuredClone(resolved);
        const manifest = this.resolvedRun.manifest;
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
        this.assertionEngine = new AssertionEngine(manifest.assertions, this.telemetry);
        this.data.bindings?.()?.setTopicScheduler?.((info) => this.queueTopicInput(info));

        await this.data.vehicles?.()?.configureFromManifest?.(manifest.initialState.vehicles, this.scene);

        const selectedBindings = resolved.bindings?.entries || [];
        await this.data.bindings?.()?.setManifest?.({
            kind: "cev-sim.script-bindings",
            version: 2,
            enabled: manifest.scripts.enabled,
            folders: [],
            bindings: selectedBindings,
        }, { persist: false });
        await this.data.bindings?.()?.prepareResolvedScripts?.(resolved.scripts || []);
        this.data.bindings?.()?.setTopicScheduler?.((info) => this.queueTopicInput(info));
        this.data.devices?.()?.configureFromManifest?.(manifest.sensorRig, {
            seed: manifest.seed,
            topics: manifest.topics,
        });
        await this.data.physics?.()?.configureRun?.(manifest, resolved.environment?.manifest);
        this.reset();
        for (const [path, value] of Object.entries(manifest.initialState.signals || {})) {
            this.telemetry?.publishSignal?.(path, value, { timeUs: 0, cycle: 0, source: "manifest", replayRole: "input", logClass: "core" });
        }
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
        return this.inputQueue.enqueue(info, this.steps + 1);
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

        this.data.physics?.()?.beginStep?.();
        phase("vehicles", () => {
            if (this.modules.vehicles) this.data.vehicles()?.update?.(dt);
        });

        phase("physics", () => {
            if (this.modules.physics) this.data.physics()?.step?.(dt);
        });

        phase("contacts", () => this.data.physics?.()?.syncAndPublishContacts?.({ step: nextStep, timeNs: nextTimeNs }));

        this.steps = nextStep;
        this.timeNs = nextTimeNs;
        this.time = this.timeNs / 1e9;
        phase("clock", () => this._publishClock());

        phase("sensors", () => {
            if (this.modules.sensors) this.data.devices()?.update?.(dt, { step: this.steps, timeNs: this.timeNs });
        });

        phase("delivery", () => this.data.devices?.()?.deliver?.({ step: this.steps, timeNs: this.timeNs }));

        if (this.modules.baking) this.data.baking()?.update?.(dt);

        this._publishSimulationEntities();
        this._publishRuntimeState();
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
        });
        return shouldContinue;
    }

    _applyQueuedInputs(step) {
        for (const entry of this.inputQueue.drain(step)) {
            this.data.bindings?.()?.applyTopicUpdate?.(entry.info);
            if (entry.info.name === "/ackdrive") {
                const vehicle = this.data.vehicles?.()?.vehicles?.find((candidate) => candidate.telemetryId === "ego")
                    ?? this.data.vehicles?.()?.vehicles?.[0];
                if (vehicle) {
                    vehicle.velocity.x = Number(entry.info.value?.speed || 0) * 0.44704;
                    vehicle.steeringAngle = -Number(entry.info.value?.steering_angle || 0) * Math.PI / 180;
                }
            }
            this.telemetry?.emitTelemetryEvent?.({
                timeUs: Math.round(((step - 1) * this.stepNs) / 1000),
                category: "topics",
                name: "input-applied",
                payload: { topic: entry.info.name, step, sequence: entry.sequence },
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
            const client = this.data.client?.()?.get?.();
            if (topic && client?.isOpen?.()) client.publish(topic.name, topic.type, { clock: stamp }).catch?.(() => {});
        }
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
