import { clamp } from "three/src/math/MathUtils.js";
import { AutonomyOverlay } from "../3d/overlay/AutonomyOverlay.js";
import { BrowserPbrRenderRuntime } from "../3d/perception/BrowserPbrRenderRuntime.js";
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
    "lifecycleState",
    "simulationSemanticHash",
    "episodeIdentity",
    "episodeHash",
    "trajectoryHash",
    "lastAcceptedActions",
    "finalizedResult",
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
        this.realtimeStepBudgetMs = options.realtimeStepBudgetMs ?? 12;
        this._nowMs = typeof options.nowMs === "function" ? options.nowMs : () => performance.now();
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
        this.renderRuntime = null;
        this.renderProviderStatus = null;
        this._asyncAdvanceTail = Promise.resolve();

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
            applyEnvironment: (environment, resolvedRun, worldResource) => {
                return this._applyResolvedEnvironment(environment, resolvedRun, worldResource);
            },
            environmentState: () => this.data.environment?.()?.getDeterministicState?.() ?? null,
            renderTarget: "browser",
            prepareRendering: (resolvedRun, options) => this._prepareRendering(resolvedRun, options),
            currentRendering: () => this.renderRuntime,
            renderingStatus: () => this.renderProviderStatus,
            disposeRendering: () => this._disposeRendering(),
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

    async _prepareRendering(resolvedRun, options = {}) {
        this._disposeRendering();
        const provider = resolvedRun?.renderScene?.description?.provider;
        const profile = resolvedRun?.renderScene?.description?.productProfile ?? null;
        if (provider?.id !== "pbr-mesh" || ![1, 2].includes(Number(provider?.version))) {
            this.renderProviderStatus = provider ? {
                provider: { ...provider },
                productProfile: profile ? { ...profile } : null,
                state: "ready",
                residency: null,
                diagnostic: null,
                error: null,
            } : null;
            return null;
        }
        const runtime = new BrowserPbrRenderRuntime({
            renderer: this.renderer,
            vehicles: () => this.data.vehicles?.()?.vehicles ?? [],
        });
        this.renderRuntime = runtime;
        runtime.subscribe((status) => {
            this.renderProviderStatus = status;
        });
        await runtime.prepare(resolvedRun, {
            sensorRig: options.sensorRig,
            vehicles: options.vehicles,
        });
        return runtime;
    }

    _disposeRendering() {
        this.renderRuntime?.dispose?.();
        this.renderRuntime = null;
        this.renderProviderStatus = null;
    }

    setEnvironmentRuntime({ loader = null, persistence = null } = {}) {
        this.environmentRuntime = loader ? { loader, persistence } : null;
    }

    async _applyResolvedEnvironment(resolvedEnvironment, resolvedRun = this.resolvedRun, worldResource = resolvedRun?.world) {
        const frozenManifest = resolvedEnvironment?.manifest;
        const loader = this.environmentRuntime?.loader;
        if (!frozenManifest || !loader) return;

        const loadedTemplate = loader.manifest?.templateId ?? this.data.environment?.()?.templateId;
        const frozenTemplate = frozenManifest.templateId ?? loadedTemplate;
        if (loadedTemplate && frozenTemplate && loadedTemplate !== frozenTemplate) {
            throw new Error("The environment template changed after this run was resolved; resolve the run again.");
        }

        const persistence = this.environmentRuntime?.persistence;
        await persistence?.suspendAutosave?.();
        try {
            const manifest = structuredClone(frozenManifest);
            const environment = this.data.environment?.();
            if (environment) {
                environment.name = manifest.name ?? environment.name;
                environment.templateId = frozenTemplate ?? environment.templateId;
                environment.roadStylePreset = manifest.roadStylePreset ?? environment.roadStylePreset;
            }
            await loader.apply(manifest, worldResource);
            loader.manifest = manifest;
            persistence?.adoptRevision?.(manifest.revision, { force: true });
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
            this.telemetry?.publishSignal?.("environment.revision", manifest.revision ?? null, {
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

    /** Shallow HUD snapshot for the RAF play path — no structuredClone of assertions/scenario. */
    _getFrameSnapshot() {
        const assertions = this.assertionEngine
            ? [...this.assertionEngine.results.values()].map((result) => ({
                id: result.id,
                name: result.name,
                status: result.status,
                severity: result.severity,
                onFailure: result.onFailure,
                evaluations: result.evaluations,
                firstFailureStep: result.firstFailureStep,
            }))
            : [];
        const scenarioRuntime = this.scenarioRuntime;
        return {
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
                simulationSemanticHash: this.simulationSemanticHash,
            } : null,
            lifecycleState: this.lifecycleState,
            episodeHash: this.episodeHash,
            trajectoryHash: this.trajectoryHash,
            assertions,
            scenario: scenarioRuntime ? {
                active: scenarioRuntime.active,
                scenarioId: scenarioRuntime.scenario?.id ?? null,
                status: !scenarioRuntime.active
                    ? "inactive"
                    : scenarioRuntime.terminal
                        ? scenarioRuntime.terminal.status
                        : "running",
                terminal: scenarioRuntime.terminal,
            } : null,
            renderProvider: this.renderProviderStatus,
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

    /** Notify UI after a play-frame step without republishing telemetry or deep-cloning. */
    _emitFrame() {
        const snapshot = this._getFrameSnapshot();
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
        if (this.kernel.lifecycleState === "disposed") return;
        this.stopLoop();
        this.controls?.dispose();
        this.kernel.dispose();
        this.scenarioDiagnostics.dispose();
        this.autonomyOverlay?.dispose?.();
        this.listeners.clear();
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.environmentRuntime = null;
        this._disposeRendering();
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

    reset(episodeSpec = null) {
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this.kernel.reset(episodeSpec);
        this.autonomyOverlay?.clear?.();
        this._emit();
        return this.getSnapshot();
    }

    step(count = 1) {
        if (this.renderRuntime) {
            return this._serializeAsyncAdvance(() => this._stepAsync(count));
        }
        this.kernel.step(count, {
            afterStep: (dt) => this._updatePresentationAfterStep(dt),
        });
        this.render();
        this._emit();
    }

    async _stepAsync(count) {
        await this.kernel.stepAsync(count, {
            afterStep: (dt) => this._updatePresentationAfterStep(dt),
        });
        this.render();
        this._emit();
    }

    _serializeAsyncAdvance(operation) {
        const pending = this._asyncAdvanceTail.then(operation, operation);
        this._asyncAdvanceTail = pending.catch(() => {});
        return pending;
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

    async applyRunManifest(resolved, options = {}) {
        if (!resolved?.manifest) throw new Error("Resolved run manifest is required.");
        this.pause();
        this.scenarioDiagnostics.configure(null);
        this.autonomyOverlay?.clear?.();
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;

        await this.kernel.prepare(resolved, options);
        this.scenarioDiagnostics.configure(this.resolvedRun?.scenario?.scenario ?? null);
        this._emit();
        this.render();
        return this.getSnapshot();
    }

    async prepare(resolved, options = {}) {
        return this.applyRunManifest(resolved, options);
    }

    finalize(options = {}) {
        const result = this.kernel.finalize(options);
        this._emit();
        return result;
    }

    clearRun() {
        this.stopLoop();
        this.kernel.clearRun();
        this.autonomyOverlay?.clear?.();
        this._emit();
    }

    queueTopicInput(info) {
        return this.kernel.queueTopicInput(info);
    }

    async _frame(nowMs) {
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
            try {
                if (this.renderRuntime) {
                    await this._serializeAsyncAdvance(() => this._advanceSimulationAsync(frameDt));
                }
                else this._advanceSimulation(frameDt);
            } catch (error) {
                this.kernel.pause();
                if (this.renderProviderStatus?.state !== "error") {
                    this.renderProviderStatus = {
                        ...(this.renderProviderStatus ?? {}),
                        state: "error",
                        diagnostic: { code: error.code ?? "PBR_CAPTURE_FAILED", message: error.message },
                        error: { code: error.code ?? "PBR_CAPTURE_FAILED", message: error.message },
                    };
                }
            }
            this._emitFrame();
        }
        if (this.viewportActive && this.modules.rendering) this.render();
        if (this.looping) this.rafId = requestAnimationFrame(this._frame);
    }

    _advanceSimulation(frameDt) {
        const scaledDt = frameDt * this.speed;
        const frameStartMs = this.realtime ? this._nowMs() : 0;
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
            if (this.realtime && subSteps > 0 && this._nowMs() - frameStartMs > this.realtimeStepBudgetMs) {
                break;
            }
        }
    }

    _fixedStep(dt) {
        const previousStep = this.steps;
        const shouldContinue = this.kernel.advanceStep(dt);
        if (this.steps > previousStep) this._updatePresentationAfterStep(dt);
        return shouldContinue;
    }

    async _advanceSimulationAsync(frameDt) {
        const scaledDt = frameDt * this.speed;
        const frameStartMs = this.realtime ? this._nowMs() : 0;
        this.gpuCaptureEnabled = true;
        if (!this.deterministic) {
            await this._fixedStepAsync(scaledDt);
            return;
        }

        this.accumulatorNs += this.realtime
            ? Math.max(0, Math.round(scaledDt * 1e9))
            : this.stepNs * Math.max(1, this.maxSubSteps);
        this.accumulator = this.accumulatorNs / 1e9;

        let subSteps = 0;
        while (this.accumulatorNs >= this.stepNs && subSteps < this.maxSubSteps) {
            const previousStep = this.steps;
            const shouldContinue = await this._fixedStepAsync(this.fixedDt);
            if (this.steps > previousStep) this.accumulatorNs -= this.stepNs;
            this.accumulator = this.accumulatorNs / 1e9;
            subSteps += 1;
            if (shouldContinue === false) break;
            if (this.realtime && this._nowMs() - frameStartMs > this.realtimeStepBudgetMs) break;
        }
    }

    async _fixedStepAsync(dt) {
        const previousStep = this.steps;
        const shouldContinue = await this.kernel.advanceStepAsync(dt);
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
        this._reconcileVisualInterest();
    }

    _reconcileVisualInterest() {
        const loader = this.environmentRuntime?.loader;
        if (!loader?.updateVisualInterest || !this.camera) return;
        const position = this.camera.position;
        try {
            loader.updateVisualInterest({
                position: { x: position.x, y: position.y, z: position.z },
            });
        } catch (error) {
            if (error?.code === "VISUAL_PREVIEW_CONTEXT_LOST") return;
            throw error;
        }
    }
}
