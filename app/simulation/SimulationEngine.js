import { clamp } from "three/src/math/MathUtils.js";
import { AutonomyOverlay } from "../3d/overlay/AutonomyOverlay.js";
import { ScenarioDiagnostics } from "../scenarios/ScenarioDiagnostics.js";
import { ScenarioRuntime } from "../scenarios/ScenarioRuntime.js";
import { SimulationKernel } from "./kernel/SimulationKernel.js";
import { createSimulationRuntimeContext } from "./kernel/SimulationRuntimeContext.js";

const KERNEL_PROPERTIES = [
    "stepNs",
    "fixedDt",
    "status",
    "time",
    "timeNs",
    "steps",
    "speed",
    "maxSteps",
    "realtime",
    "deterministic",
    "modules",
    "telemetry",
    "resolvedRun",
    "inputQueue",
    "topicRouter",
    "localizationTruthPublisher",
    "assertionEngine",
    "scenarioRuntime",
    "candidateOutputRuntime",
    "controlRuntime",
    "transformRuntime",
    "lastStepPhases",
    "resetHandlers",
];

function exposeKernelProperties(engine) {
    for (const property of KERNEL_PROPERTIES) {
        Object.defineProperty(engine, property, {
            configurable: true,
            enumerable: true,
            get: () => engine.kernel[property],
            set: (value) => { engine.kernel[property] = value; },
        });
    }
}

/**
 * Browser adapter for the UI-independent SimulationKernel. RAF pacing,
 * rendering, viewport controls, and visualization overlays stay here.
 */
export class SimulationEngine {
    /**
     * @param {Data} data
     */
    constructor(data, options = {}) {
        this.data = data;
        this.maxFrameDt = options.maxFrameDt ?? 0.1;
        this.maxSubSteps = options.maxSubSteps ?? 10;
        this.gpuCaptureEnabled = true;
        this._displayPixelRatio = null;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this.lastFrameMs = 0;
        this.rafId = null;
        this.looping = false;
        this.listeners = new Set();
        this.viewportActive = true;
        this.environmentRuntime = null;

        this.scenarioDiagnostics = new ScenarioDiagnostics();
        this.autonomyOverlay = new AutonomyOverlay();
        this._autonomyOverlayEnabled = {
            oracle: true,
            candidate: true,
            ekf: true,
            lanes: true,
            controls: true,
        };

        const telemetry = this.data.bindings?.()?.signalStore ?? null;
        const scenarioRuntime = new ScenarioRuntime(this.data, { telemetry });
        this.runtimeContext = createSimulationRuntimeContext({
            telemetry,
            inputs: () => this.data.keys?.(),
            scripts: () => this.data.bindings?.(),
            vehicles: () => this.data.vehicles?.(),
            devices: () => this.data.devices?.(),
            physics: () => this.data.physics?.(),
            scenarios: scenarioRuntime,
            vehicleScene: () => this.scene,
            topicClient: () => this.data.client?.()?.get?.(),
            applyEnvironment: (environment, resolvedRun) => {
                this._applyResolvedEnvironment(environment, resolvedRun);
            },
        });
        this.kernel = new SimulationKernel(this.runtimeContext, options);
        exposeKernelProperties(this);

        this._frame = this._frame.bind(this);
    }

    configure({ scene, camera, renderer, controls = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;
        this.scenarioDiagnostics.attach(scene, camera);
        this.autonomyOverlay?.attach?.(scene, camera);
    }

    setEnvironmentRuntime({ loader = null, persistence = null } = {}) {
        this.environmentRuntime = loader ? { loader, persistence } : null;
    }

    _applyResolvedEnvironment(resolvedEnvironment, resolvedRun = this.resolvedRun) {
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
            const common = {
                timeUs: 0,
                cycle: 0,
                source: "resolved-run",
                replayRole: "input",
                logClass: "core",
            };
            this.telemetry?.publishSignal?.(
                "environment.id",
                environment?.environmentId ?? resolvedRun?.manifest?.environment?.id,
                { ...common, type: "string" },
            );
            this.telemetry?.publishSignal?.("environment.manifest", manifest, {
                ...common,
                type: "json",
            });
        } finally {
            persistence?.resumeAutosave?.();
        }
    }

    getSnapshot() {
        return {
            ...this.kernel.getSnapshot(),
            frames: this.frames,
            scenarioDiagnostics: { enabled: this.scenarioDiagnostics.enabled },
            autonomyOverlay: { ...this._autonomyOverlayEnabled },
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    _emit() {
        this.kernel.publishRuntimeState();
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }

    onReset(handler) {
        return this.kernel.onReset(handler);
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
        this.kernel.dispose();
        this.scenarioDiagnostics.dispose();
        this.autonomyOverlay?.dispose?.();
        this.listeners.clear();
    }

    play() {
        this.startLoop();
        this.kernel.play();
        this._emit();
    }

    pause() {
        this.kernel.pause();
        this._emit();
    }

    stop({ reset = true } = {}) {
        this.accumulator = 0;
        this.accumulatorNs = 0;
        if (reset) this.frames = 0;
        this.kernel.stop({ reset });
        if (reset) this.autonomyOverlay?.clear?.();
        this.render();
        this._emit();
    }

    reset() {
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this.kernel.reset();
        this.autonomyOverlay?.clear?.();
    }

    step(count = 1) {
        this.kernel.step(count, {
            afterStep: (dt) => this._updatePresentationAfterStep(dt),
        });
        this.render();
        this._emit();
    }

    setSpeed(speed) {
        this.kernel.setSpeed(speed);
        this._emit();
    }

    setRealtime(realtime) {
        this.kernel.setRealtime(realtime);
        this._emit();
    }

    setDeterministic(deterministic) {
        this.kernel.setDeterministic(deterministic);
        this._emit();
    }

    async setPhysicsEnabled(enabled) {
        await this.kernel.setPhysicsEnabled(enabled);
        this._emit();
    }

    setModule(name, enabled) {
        this.kernel.setModule(name, enabled);
        this._emit();
    }

    setScenarioDiagnosticsEnabled(enabled) {
        this.scenarioDiagnostics.setEnabled(enabled);
        this.render();
        this._emit();
    }

    setAutonomyOverlayEnabled(patch = {}) {
        this._autonomyOverlayEnabled = {
            ...this._autonomyOverlayEnabled,
            ...patch,
        };
        this.autonomyOverlay?.setLayers?.(this._autonomyOverlayEnabled);
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
        this.scenarioDiagnostics.configure(null);
        this.autonomyOverlay?.clear?.();
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;

        await this.kernel.configureRun(resolved);
        this.scenarioDiagnostics.configure(this.resolvedRun?.scenario?.scenario ?? null);
        this._emit();
        this.render();
        return this.getSnapshot();
    }

    queueTopicInput(info) {
        return this.kernel.queueTopicInput(info);
    }

    _frame(nowMs) {
        if (!this.looping) return;

        const rawFrameDt = (nowMs - this.lastFrameMs) / 1000;
        this.lastFrameMs = nowMs;
        const frameDt = clamp(rawFrameDt, 0, this.maxFrameDt);

        if (this.controls) {
            const cameraControlsEnabled = this.modules.controls
                && this.data.settings()?.cameraControlsEnabled !== false;
            this.controls.enabled = this.viewportActive && cameraControlsEnabled;
            if (this.viewportActive && cameraControlsEnabled) this.controls.update();
        }

        if (this.status === "playing") {
            this._advanceSimulation(frameDt);
            this._emit();
        }
        if (this.viewportActive && this.modules.rendering) this.render();
        if (this.looping) this.rafId = requestAnimationFrame(this._frame);
    }

    _advanceSimulation(frameDt) {
        const scaledDt = frameDt * this.speed;
        this.gpuCaptureEnabled = true;
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
            subSteps += 1;
            this.gpuCaptureEnabled = false;
            if (shouldContinue === false) break;
        }
    }

    _fixedStep(dt) {
        const previousStep = this.steps;
        const shouldContinue = this.kernel.advanceStep(dt);
        if (this.steps > previousStep) this._updatePresentationAfterStep(dt);
        return shouldContinue;
    }

    _updatePresentationAfterStep(dt) {
        this.autonomyOverlay?.updateFromRuntime?.(
            this.candidateOutputRuntime,
            this._autonomyOverlayEnabled,
            {
                controlRuntime: this.controlRuntime,
                vehiclePose: this.kernel.targetVehiclePose(),
            },
        );
        if (this.modules.baking) this.data.baking()?.update?.(dt);
        if (this.scenarioRuntime?.active || this.scenarioDiagnostics.enabled) {
            this.scenarioDiagnostics.update({
                ...(this.scenarioRuntime?.active ? this.scenarioRuntime.getSnapshot() : {}),
                actorPoses: this.kernel.actorPoses(),
            });
        }
    }

    // Compatibility delegates for existing tests and integrations that use
    // the former SimulationEngine implementation helpers.
    _defineTelemetrySignals() {
        return this.kernel._defineTelemetrySignals();
    }

    _publishRuntimeState() {
        return this.kernel.publishRuntimeState();
    }

    _emitLifecycle(name, payload = {}) {
        return this.kernel.emitLifecycle(name, payload);
    }

    _applyQueuedInputs(step) {
        return this.kernel._applyQueuedInputs(step);
    }

    _configureControlRuntimeLimits(manifest) {
        return this.kernel._configureControlRuntimeLimits(manifest);
    }

    _applyControlSetpoints(appliedMap) {
        return this.runtimeContext.controls.applySetpoints(appliedMap);
    }

    _sampleControlAchieved() {
        return this.runtimeContext.controls.sampleAchieved(this.controlRuntime, {
            targetVehicleId: this.resolvedRun?.manifest?.controls?.targetVehicleId || "ego",
            step: this.steps,
            timeNs: this.timeNs,
        });
    }

    _applyInitialState(initialState = {}) {
        this.runtimeContext.vehicles.applyInitialState(initialState);
        this.runtimeContext.physics.resetRun();
        this.runtimeContext.devices.resetSchedule();
    }

    _publishClock() {
        return this.kernel.publishClock();
    }

    _actorPoses() {
        return this.kernel.actorPoses();
    }

    _publishSimulationEntities() {
        return this.kernel.publishSimulationEntities();
    }

    _applyDisplayPerformance() {
        const playing = this.status === "playing";
        this.data.skyManager?.()?.setPerformanceTier?.(playing ? "high-performance" : "quality");
        if (!this.renderer || typeof window === "undefined") return;
        const cap = playing ? 1 : 1.25;
        const ratio = Math.min(window.devicePixelRatio || 1, cap);
        if (this._displayPixelRatio === ratio) return;
        this._displayPixelRatio = ratio;
        this.renderer.setPixelRatio(ratio);
        const width = this.renderer.domElement?.clientWidth || 0;
        const height = this.renderer.domElement?.clientHeight || 0;
        if (width > 0 && height > 0) {
            this.renderer.setSize(width, height, false);
            this.data.skyManager?.()?.resize?.(width, height);
        }
    }

    render() {
        if (!this.scene || !this.camera || !this.renderer) return;
        this._applyDisplayPerformance();
        this.data.earthTilesManager?.()?.update?.();
        if (this.data.skyManager?.()?.render?.()) {
            this.frames += 1;
            return;
        }
        this.renderer.render(this.scene, this.camera);
        this.frames += 1;
    }
}
