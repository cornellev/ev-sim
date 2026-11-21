import { clamp } from "three/src/math/MathUtils.js";
import { assertProtobufExecutionCapabilities } from "../interfaces/ProtobufRunBinding.js";
import { PerspectiveViewController } from "../3d/camera/PerspectiveViewController.js";
import { attachPerspectiveView, detachPerspectiveView } from "../3d/camera/perspectiveViewRegistry.js";
import { AutonomyOverlay } from "../3d/overlay/AutonomyOverlay.js";
import { BrowserAnalyticRenderRuntime, BrowserPbrRenderRuntime } from "../3d/perception/BrowserPbrRenderRuntime.js";
import { BrowserPbrWorkerRuntime } from "../3d/perception/BrowserPbrWorkerRuntime.js";
import { ColliderViewportPreview } from "../3d/perception/ColliderViewportPreview.js";
import { LidarViewportPreview } from "../3d/perception/LidarViewportPreview.js";
import { ScenarioDiagnostics } from "../scenarios/ScenarioDiagnostics.js";
import { ScenarioRuntime } from "../scenarios/ScenarioRuntime.js";
import { editorRigidBodiesReady, SimulationKernel } from "./kernel/SimulationKernel.js";
import { createSimulationRuntimeContext } from "./kernel/SimulationRuntimeContext.js";
import { BrowserPluginModuleSource } from "../plugin/browser/BrowserPluginModuleSource.js";
import { PluginRunSession, pluginRuntimeCapabilitiesForRun } from "../plugin/PluginRunSession.js";
import { browserSimulationPerformance } from "./performance/BrowserSimulationPerformance.js";
import { createPhysicsBackendSelection } from "../physics/PhysicsBackend.js";
import { applyRigidBodyViewportPoses, restoreAuthoredRigidBodyPoses } from "../3d/editor/projection/applyRigidBodyPoses.js";
import { createKeyboardDriveState, stepKeyboardDrive } from "./keyboardDrive.js";
import { BrowserPacketRelaySink } from "./sensors/BrowserPacketRelaySink.js";
import { ProtobufRouteRuntime } from "../interfaces/ProtobufRouteRuntime.js";
import { applyOriginMarkersVisible, applySensorMarkersVisible } from "../3d/runtimeVisibility.js";
import { LIVE_CAMERA_OBJECT_MOTION } from "./render/CameraObjectMotion.js";
import { VisualizationManager } from "../visualization/VisualizationManager.js";
import { LocalizationVisualizer, localizationSnapshotInputs } from "../visualization/visualizers/LocalizationVisualizer.js";
import { AckermannVisualizer, controlsSnapshotInputs } from "../visualization/visualizers/AckermannVisualizer.js";
import { PlannedTrajectoryVisualizer, plannedPathSnapshotInputs } from "../visualization/visualizers/PlannedTrajectoryVisualizer.js";
import { TrajectoryPastVisualizer } from "../visualization/visualizers/TrajectoryPastVisualizer.js";
import { OccupancyVisualizer } from "../visualization/visualizers/OccupancyVisualizer.js";
import { rep103ToThreeVector } from "../autonomy/CoordinateFrames.js";
import { planActorId } from "../spatial/planview/selection.js";
import { LiveVisualizationSource } from "../visualization/sources/LiveVisualizationSource.js";
import { abortable } from "./AsyncCancellation.js";
import { vehiclesLeafPath } from "../scripting/runtime/SignalPaths.js";

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
        this._displayPixelRatio = null;
        this.pbrWorkerEnabled = options.pbrWorkerEnabled !== false;
        this.pbrWorkerFactory = options.pbrWorkerFactory;
        this.cpuLidarWorkerEnabled = options.cpuLidarWorkerEnabled !== false;
        this.cpuLidarWorkerFactory = options.cpuLidarWorkerFactory;
        this.pbrInlineFactory = options.pbrInlineFactory
            ?? ((runtimeOptions) => new BrowserPbrRenderRuntime(runtimeOptions));

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;

        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this.droppedDebtNs = 0;
        this._pacingAdvancedNs = 0;
        this._pacingWallMs = 0;
        this.lastFrameMs = 0;
        this.rafId = null;
        this._dueAdvanceTimer = null;
        this.looping = false;
        this.listeners = new Set();
        this.visualizationRevision = 0;
        this.viewportActive = true;
        this.sceneRenderEnabled = true;
        this.lidarViewport = new LidarViewportPreview(this.data);
        this.colliderViewport = new ColliderViewportPreview(this.data);
        this.environmentRuntime = null;
        this.renderRuntime = null;
        this.renderProviderStatus = null;
        this._asyncAdvanceTail = Promise.resolve();
        this._captureController = new AbortController();
        this._asyncAdvanceCount = 0;
        this._advanceInFlight = null;
        this._advanceGeneration = 0;
        this._pendingFrameNs = 0;
        this._presentationRequested = false;
        this._presentationRequestGeneration = 0;
        this._presentationServiceQueued = false;
        this._visualizationFlush = null;
        this._visualizationBindings = {
            ackermann: {
                data: [{ id: "ackermann-controls", kind: "runtime", signalPath: "visualization.controls.snapshot", project: (snapshot) => this._controlsVisualizationInputs(snapshot) }],
                pose: [{ id: "ackermann-pose", kind: "runtime" }],
                predictedPath: true,
            },
            plannedTrajectory: {
                data: [{ id: "planned-trajectory", kind: "runtime", signalPath: "visualization.plannedTrajectory.snapshot", project: plannedPathSnapshotInputs }],
                pose: [{ id: "planned-trajectory-pose", kind: "runtime" }],
            },
            trajectoryPast: {
                data: [{ id: "trajectory-actors", kind: "runtime", signalPath: "visualization.trajectoryPast.actors" }],
            },
            localization: {
                data: [{ id: "localization", kind: "runtime", signalPath: "visualization.localization.status", project: (_status, metadata) => localizationSnapshotInputs(this.candidateOutputRuntime?.lastLocalization, metadata) }],
            },
            occupancy: {
                data: ["oracle", "lidar", "stack"].map((channel) => ({ id: `occupancy-${channel}`, kind: "runtime", signalPath: `visualization.occupancy.${channel}` })),
                pose: [{ id: "occupancy-pose", kind: "runtime" }],
                visible: { scene: false, map: true },
            },
        };
        this._visualizationGeneration = 0;
        this._visualizationStepActive = false;
        this.liveVisualizationSource = null;
        this._visualizationZenoh = options.visualizationZenoh;
        this.visualizationManager = new VisualizationManager({
            tools: { ackermann: new AckermannVisualizer(), plannedTrajectory: new PlannedTrajectoryVisualizer(), trajectoryPast: new TrajectoryPastVisualizer(), localization: new LocalizationVisualizer({ createAppearanceClone: () => this._estimateVehicle()?.cloneVisualBody?.() ?? null }), occupancy: new OccupancyVisualizer(), ...options.visualizationTools },
            requestFlush: (callback) => {
                this._visualizationFlush = callback;
                this._requestPresentation();
                this._queuePendingPresentation();
                return () => { if (this._visualizationFlush === callback) this._visualizationFlush = null; };
            },
        });
        this._renderPresentationUnsubscribe = null;
        this._editorRigidBodyHash = null;
        this._editorPhysicsSync = Promise.resolve();

        this.scenarioDiagnostics = new ScenarioDiagnostics();
        this.autonomyOverlay = new AutonomyOverlay({ visualizationManager: this.visualizationManager });
        this.perspectiveView = new PerspectiveViewController({
            data: this.data,
            getCamera: () => this.camera,
            getControls: () => this.controls,
            getRenderer: () => this.renderer,
        });
        attachPerspectiveView(this.perspectiveView);
        this._autonomyOverlayEnabled = {
            oracle: true,
            candidate: true,
            ekf: true,
            estimateClone: true,
            lanes: true,
            controls: true,
            oracleOccupancy: false,
            lidarOccupancy: false,
            stackOccupancy: false,
            pastTrajectories: true,
        };
        this.debugVisuals = { sensorMarkers: true, originMarker: true };

        const telemetry = this.data.bindings?.()?.signalStore ?? null;
        const pluginModuleSource = options.pluginModuleSource ?? new BrowserPluginModuleSource();
        const scenarioRuntime = new ScenarioRuntime(this.data, { telemetry });
        this.packetRelay = options.packetRelay === undefined ? new BrowserPacketRelaySink() : options.packetRelay;
        this.protobufRoutes = new ProtobufRouteRuntime();
        this.runtimeContext = createSimulationRuntimeContext({
            protobufRoutes: this.protobufRoutes,
            protobufTransport: "zenoh-browser",
            controlOwnership: () => Boolean(this.ownershipGuard),
            protobufPublicationPort: (packet) => this.data.client?.()?.publishProtobuf?.(packet) ?? false,
            publicationPort: (envelope) => this.protobufRoutes.publishTopic(envelope),
            onProtobufGeneration: (generation) => this.data.client?.()?.stageGeneration?.(generation),
            telemetry,
            nativePacketSink: this.packetRelay,
            sensorTransportHost: () => this.packetRelay?.hostDescriptor(),
            inputs: () => this.data.keys?.(),
            scripts: () => this.data.bindings?.(),
            vehicles: () => this.data.vehicles?.(),
            devices: () => this.data.devices?.(),
            cpuLidarWorkerFactory: () => {
                if (!this.cpuLidarWorkerEnabled) return null;
                return this.cpuLidarWorkerFactory ? this.cpuLidarWorkerFactory()
                    : new Worker(new URL("../3d/devices/cpuLidarCapture.worker.js", import.meta.url), { type: "module" });
            },
            physics: () => this.data.physics?.(),
            scenarios: scenarioRuntime,
            vehicleScene: () => this.scene,
            applyEnvironment: (environment, resolvedRun, worldResource) => {
                return this._applyResolvedEnvironment(environment, resolvedRun, worldResource);
            },
            environmentState: () => this.data.environment?.()?.getDeterministicState?.() ?? null,
            getWorldDescription: () => this.data.environment?.()?.getWorldDescription?.() ?? null,
            renderTarget: "browser",
            prepareRendering: (resolvedRun, options) => this._prepareRendering(resolvedRun, options),
            currentRendering: () => this.renderRuntime,
            renderingStatus: () => this.renderProviderStatus,
            disposeRendering: () => this._disposeRendering(),
            preparePlugins: async (resolvedRun, runtimeOptions = {}) => {
                if ((resolvedRun.plugins?.length ?? 0) === 0) return null;
                const session = new PluginRunSession({
                    moduleSource: pluginModuleSource,
                    plugins: resolvedRun.plugins,
                    authorizePackage: options.authorizePackage,
                    subscribePolicy: options.subscribePolicy,
                    availableCapabilities: pluginRuntimeCapabilitiesForRun(resolvedRun, {
                        renderTarget: runtimeOptions.renderTarget ?? "browser",
                        backendSelections: runtimeOptions.backendSelections
                            ?? resolvedRun.backendSelections,
                    }),
                });
                try {
                    return await session.prepareDefinitions(resolvedRun.pluginPackages);
                } catch (error) {
                    session.dispose();
                    throw error;
                }
            },
        });
        this.kernel = new SimulationKernel(this.runtimeContext, options);
        exposeKernelProperties(this);
        this._bindLiveVisualizationSource();
        this._keyboardDrive = createKeyboardDriveState();
        this._episodeMeshIds = new Set();
        this._episodeMeshSync = Promise.resolve();
        this.kernel.onReset(() => this._syncEpisodeOverlayMeshes());
        this.data.bindings?.()?.setHostContext?.({
            overlay: this.runtimeContext.episodeOverlay,
        });

        this._frame = this._frame.bind(this);
    }

    _syncEpisodeOverlayMeshes() {
        if (!this.scene || !this.kernel?.context?.episodeOverlay) return;
        if (!this.data?.environment?.()?.objects?.()) return;
        this._episodeMeshSync = this._episodeMeshSync
            .catch(() => {})
            .then(() => this._applyEpisodeOverlayMeshes());
    }

    async _applyEpisodeOverlayMeshes() {
        const scene = this.scene;
        const overlay = this.kernel?.context?.episodeOverlay;
        const registry = this.data?.environment?.()?.objects?.();
        if (!scene || !overlay || !registry) return;

        const [{ removeFeatureFromRuntime }, { placeFusionObjectInScene }] = await Promise.all([
            import("../3d/editor/map/mapRuntimeSync.js"),
            import("../3d/editor/placement/placeFusionObject.js"),
        ]);
        if (this.scene !== scene) return;

        const records = overlay.snapshot();
        const nextIds = new Set(records.map((record) => record.id).filter((id) => String(id).startsWith("episode:")));
        for (const id of this._episodeMeshIds) {
            if (!nextIds.has(id) && String(id).startsWith("episode:")) {
                removeFeatureFromRuntime(this.data, scene, id);
            }
        }
        for (const record of records) {
            if (!String(record.id).startsWith("episode:")) continue;
            if (this._episodeMeshIds.has(record.id)) {
                removeFeatureFromRuntime(this.data, scene, record.id);
            }
            const position = record.pose?.position ?? {};
            const placed = placeFusionObjectInScene({
                data: this.data,
                scene,
                registry,
                assetId: record.assetId,
                point: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
                sourceId: record.id,
            });
            const yaw = Number(record.pose?.rotation?.y) || 0;
            if (placed?.object?._mesh) placed.object._mesh.rotation.y = yaw;
        }
        this._episodeMeshIds = nextIds;
    }

    configure({ scene, camera, renderer, controls = null }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;
        this.scenarioDiagnostics.attach(scene, camera);
        this.autonomyOverlay?.attach?.(scene, camera);
        this.visualizationManager.configure(this._resolvedVisualizationBindings(), { sceneContext: { scene, camera, renderer } });
    }

    /** Display bindings are presentation-only and never enter the resolved run. */
    configureVisualizations(toolBindings) {
        const previous = this.visualizationManager.bindings;
        this.visualizationManager.configure(this._resolvedVisualizationBindings(toolBindings, false));
        if (this.visualizationManager.bindings !== previous) this._visualizationBindings = toolBindings;
    }

    _resolvedVisualizationBindings(toolBindings = this._visualizationBindings, preserveVisibility = true) {
        const vehicles = this.runtimeContext?.vehicles.list() ?? [];
        const ego = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === "ego") ?? vehicles[0];
        const targetId = this.resolvedRun?.manifest?.controls?.targetVehicleId
            ?? ego?.telemetryId ?? ego?.id ?? (ego ? `vehicle-${vehicles.indexOf(ego) + 1}` : "ego");
        return Object.fromEntries(Object.entries(toolBindings).map(([toolId, config]) => [toolId, {
            ...config,
            ...(preserveVisibility && this.visualizationManager.entries.has(toolId)
                ? { visible: { ...this.visualizationManager.entries.get(toolId).visible } } : {}),
            data: (config.data ?? []).map((binding) => ({ ...binding, eventType: "data" })),
            pose: (config.pose ?? []).map((binding) => ({
                ...binding,
                ...(binding.kind === "runtime" ? { signalPath: binding.signalPath ?? vehiclesLeafPath(binding.vehicleId ?? targetId, "pose") } : {}),
                eventType: "pose",
            })),
        }]));
    }

    _controlsVisualizationInputs(snapshot) {
        if (!this.controlRuntime) return controlsSnapshotInputs(this._controlsVisualizationSnapshot() ?? {});
        const wheelbase = this.controlRuntime.getLimits(this.resolvedRun?.manifest?.controls?.targetVehicleId ?? "ego").wheelbase;
        return controlsSnapshotInputs({ ...snapshot, wheelbase });
    }

    _controlsVisualizationSnapshot() {
        const vehicles = this.runtimeContext?.vehicles.list() ?? [];
        const targetId = this.resolvedRun?.manifest?.controls?.targetVehicleId;
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === (targetId ?? "ego")) ?? vehicles[0];
        if (this.controlRuntime) return this.controlRuntime.getSnapshot(targetId, { applyTimeNs: this.timeNs });
        if (!vehicle) return null;
        const wheelbase = vehicle.manifest?.kinematics?.wheelbase
            ?? this.resolvedRun?.vehicles?.find((entry) => entry.actorId === targetId)?.manifest?.kinematics?.wheelbase;
        return {
            wheelbase: wheelbase ?? 1.5,
            applied: vehicle.controlsEnabled === false ? null : { steeringRad: vehicle.displaySteeringAngle ?? vehicle.steeringAngle ?? 0 },
            achieved: vehicle.controlsEnabled === false ? null : { steeringRad: vehicle.steeringAngle ?? 0, speedMps: Math.hypot(vehicle.velocity?.x ?? 0, vehicle.velocity?.z ?? 0) },
        };
    }

    _clearVisualizationSource() {
        this._visualizationGeneration += 1;
        this.liveVisualizationSource = null;
        this.visualizationManager.setSource(null);
    }

    _plannedVisualizationSnapshot() {
        const path = this.candidateOutputRuntime?.lastPath;
        if (!path) return null;
        const matching = [...(this.topicRouter?.lastProducer?.values() ?? [])].filter((entry) => entry.valueContract?.id === "cev.path"
            && entry.metadata?.sequenceId === path.sequenceId && entry.metadata?.captureTimeNs === path.captureTimeNs && entry.metadata?.frameId === path.frameId);
        // Normalized paths omit producer identity; ambiguous matches must retain their world points.
        const envelope = matching.length === 1 ? matching[0] : null;
        if (this._plannedVisualizationCache?.path === path && this._plannedVisualizationCache.envelope === envelope) return this._plannedVisualizationCache.snapshot;
        const vehicleFrameId = this.transformRuntime?.frames?.baseLink ?? this.resolvedRun?.manifest?.sensorRig?.frames?.baseLink ?? "base_link";
        const relative = envelope?.metadata?.frameId === vehicleFrameId;
        const snapshot = relative ? {
            ...path,
            points: envelope.value.points.map(rep103ToThreeVector),
            vehicleRelative: true,
            metadata: envelope.metadata,
        } : path;
        this._plannedVisualizationCache = { path, envelope, snapshot };
        return snapshot;
    }

    _bindLiveVisualizationSource(generation = this._visualizationGeneration, seedInitial = true) {
        if (generation !== this._visualizationGeneration || this.kernel.lifecycleState === "disposed") return;
        if (this._visualizationStepActive) {
            // A cancelled capture may still write old telemetry while draining.
            this.whenIdle().then(() => {
                this._bindLiveVisualizationSource(generation, false);
                if (generation === this._visualizationGeneration && this.kernel.lifecycleState !== "disposed") this._emitFrame();
            });
            return;
        }
        const source = new LiveVisualizationSource({
            zenoh: this._visualizationZenoh,
            signalStore: this.telemetry,
            runId: this.resolvedRun ? this.kernel.runId ?? this.resolvedRun.manifest.id : null,
            getTimeNs: () => this.timeNs,
            isStepInFlight: () => this._visualizationStepActive,
            seedInitial,
            getOccupancySources: () => {
                const vehicles = this.runtimeContext.vehicles.list();
                const targetId = this.resolvedRun?.manifest?.controls?.targetVehicleId ?? "ego";
                const ego = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === targetId) ?? vehicles[0];
                return { vehicles, ego: ego?.position, resolvedRun: this.resolvedRun,
                    description: this.resolvedRun?.world?.description ?? this.data?.environment?.()?.worldDescription ?? null,
                    obstacles: this.kernel.context?.episodeOverlay?.toObstacles?.() ?? [], runtime: this.candidateOutputRuntime, topicRouter: this.topicRouter };
            },
            subscribeRuntimeChanges: (callback) => this.data?.environment?.()?.getDocument?.()?.subscribe?.(callback) ?? (() => {}),
            getData: (path) => {
                if (path === "visualization.controls.snapshot") return this._controlsVisualizationSnapshot();
                if (path === "visualization.plannedTrajectory.snapshot") return this._plannedVisualizationSnapshot() ?? { status: "inactive" };
                if (path === "visualization.localization.status") return this.candidateOutputRuntime?.lastLocalization ?? { status: "inactive" };
                if (path !== "visualization.trajectoryPast.actors") return null;
                const roles = new Map((this.scenarioRuntime?.scenario?.actors ?? []).map((actor) => [actor.id, actor.role]));
                return { timeNs: this.timeNs, actors: this.runtimeContext.vehicles.list().map((vehicle, index) => ({
                    id: planActorId(vehicle, index),
                    role: roles.get(planActorId(vehicle, index)),
                    position: { x: vehicle.position?.x ?? 0, y: vehicle.position?.y ?? 0, z: vehicle.position?.z ?? 0 },
                })) };
            },
            getPose: (path) => {
                const vehicles = this.runtimeContext.vehicles.list();
                const index = vehicles.findIndex((vehicle, index) => vehiclesLeafPath(vehicle.telemetryId || vehicle.id || `vehicle-${index + 1}`, "pose") === path);
                const vehicle = vehicles[index];
                return vehicle ? {
                    position: { x: vehicle.position?.x ?? 0, y: vehicle.position?.y ?? 0, z: vehicle.position?.z ?? 0 },
                    rotation: { x: vehicle.rotation?.x ?? 0, y: vehicle.rotation?.y ?? 0, z: vehicle.rotation?.z ?? 0, order: vehicle.rotation?.order ?? "XYZ" },
                } : null;
            },
        });
        this.visualizationManager.configure(this._resolvedVisualizationBindings());
        this.visualizationManager.setSource(source);
        this.liveVisualizationSource = source;
    }

    _bindRenderRuntime(runtime, { fallbackReason = null } = {}) {
        this._renderPresentationUnsubscribe?.();
        this._renderPresentationUnsubscribe = null;
        this.renderRuntime = runtime;
        const operational = {
            implementation: runtime?.implementation ?? null,
            fallbackReason: fallbackReason ? {
                code: fallbackReason.code ?? "PBR_WORKER_UNAVAILABLE",
                message: fallbackReason.message,
                workerCauseCode: fallbackReason.workerCauseCode ?? fallbackReason.code ?? null,
            } : null,
        };
        browserSimulationPerformance.recordRenderRuntime(operational);
        if (fallbackReason && operational.implementation === "inline") {
            const cause = fallbackReason.workerCauseCode ?? fallbackReason.code ?? "PBR_WORKER_UNAVAILABLE";
            console.warn(
                `[cev-sim] PBR capture fell back to inline main-thread rendering (${cause}): ${
                    fallbackReason.message || "PBR worker was unavailable."
                }`,
            );
        }
        runtime?.subscribe?.((status) => {
            this.renderProviderStatus = { ...status, ...operational };
        });
        this._renderPresentationUnsubscribe = runtime?.subscribePresentationAvailability?.((available) => {
            if (available) this._queuePendingPresentation();
        }) ?? null;
    }

    _presentationBlocked() {
        if (!this.renderRuntime) return false;
        if (typeof this.renderRuntime.presentationBlocked === "boolean") {
            return this.renderRuntime.presentationBlocked;
        }
        return Boolean(this._advanceInFlight && this.renderRuntime.implementation !== "worker");
    }

    _requestPresentation() {
        this._presentationRequested = true;
        this._presentationRequestGeneration = this._advanceGeneration;
        browserSimulationPerformance.recordPresentationDeferred();
    }

    _invalidatePendingPresentation() {
        this._presentationRequested = false;
        this._presentationRequestGeneration = this._advanceGeneration;
        this._presentationServiceQueued = false;
        if (this._visualizationFlush) {
            this._requestPresentation();
            this._queuePendingPresentation();
        }
    }

    _queuePendingPresentation() {
        if (!this._presentationRequested || this._presentationServiceQueued) return;
        this._presentationServiceQueued = true;
        queueMicrotask(() => {
            this._presentationServiceQueued = false;
            this._servicePendingPresentation();
        });
    }

    _servicePendingPresentation() {
        if (!this._presentationRequested) return false;
        if (this._presentationRequestGeneration !== this._advanceGeneration) {
            this._presentationRequested = false;
            return false;
        }
        if (this._presentationBlocked()) return false;
        this._presentationRequested = false;
        return this.render();
    }

    async _prepareRendering(resolvedRun, options = {}) {
        this._disposeRendering();
        const provider = resolvedRun?.renderScene?.description?.provider;
        const profile = resolvedRun?.renderScene?.description?.productProfile ?? null;
        if (provider?.id === "canonical-analytic" && Number(provider.version) === 1
            && resolvedRun.renderScene.description.objectMotion === LIVE_CAMERA_OBJECT_MOTION) {
            const runtime = new BrowserAnalyticRenderRuntime({
                renderer: this.renderer,
                vehicles: () => this.data.vehicles?.()?.vehicles ?? [],
            });
            this._bindRenderRuntime(runtime);
            await runtime.prepare(resolvedRun, { vehicles: options.vehicles });
            return runtime;
        }
        if (provider?.id !== "pbr-mesh" || Number(provider?.version) !== 1) {
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
        const vehicles = () => this.data.vehicles?.()?.vehicles ?? [];
        let fallbackReason = null;
        if (this.pbrWorkerEnabled && (this.pbrWorkerFactory || BrowserPbrWorkerRuntime.supported())) {
            const workerRuntime = new BrowserPbrWorkerRuntime({
                ...(this.pbrWorkerFactory ? { workerFactory: this.pbrWorkerFactory } : {}),
                vehicles,
            });
            this._bindRenderRuntime(workerRuntime);
            try {
                await workerRuntime.prepare(resolvedRun, {
                    sensorRig: options.sensorRig,
                    vehicles: options.vehicles,
                });
                return workerRuntime;
            } catch (error) {
                workerRuntime.dispose();
                if (error?.code !== "PBR_WORKER_UNAVAILABLE"
                    && error?.code !== "PBR_WORKER_REQUEST_FAILED"
                    && error?.code !== "PBR_WORKER_FAILED") {
                    throw error;
                }
                fallbackReason = {
                    code: error.code ?? "PBR_WORKER_UNAVAILABLE",
                    message: error.message,
                    workerCauseCode: error.workerCauseCode ?? error.code ?? "PBR_WORKER_UNAVAILABLE",
                };
            }
        } else if (this.pbrWorkerEnabled) {
            fallbackReason = {
                code: "PBR_WORKER_UNSUPPORTED",
                message: "This browser does not expose Worker and OffscreenCanvas PBR capture support.",
            };
        } else {
            fallbackReason = {
                code: "PBR_WORKER_DISABLED",
                message: "PBR worker capture was disabled for this run.",
            };
        }
        const inlineRuntime = this.pbrInlineFactory({ renderer: this.renderer, vehicles });
        this._bindRenderRuntime(inlineRuntime, { fallbackReason });
        await inlineRuntime.prepare(resolvedRun, {
            sensorRig: options.sensorRig,
            vehicles: options.vehicles,
        });
        return inlineRuntime;
    }

    _disposeRendering() {
        this._renderPresentationUnsubscribe?.();
        this._renderPresentationUnsubscribe = null;
        this.renderRuntime?.dispose?.();
        this.renderRuntime = null;
        this.renderProviderStatus = null;
        browserSimulationPerformance.recordRenderRuntime();
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
        const start = browserSimulationPerformance.now();
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
            browserSimulationPerformance.recordTiming("environmentApply", browserSimulationPerformance.now() - start);
        }
    }

    getSnapshot() {
        return {
            ...this.kernel.getSnapshot(),
            cpuLidar: this.data.devices?.()?.pluginSensorScene?.status ?? null,
            frames: this.frames,
            droppedDebtNs: this.droppedDebtNs,
            effectiveRealtimeRate: this._effectiveRealtimeRate(),
            scenarioDiagnostics: { enabled: this.scenarioDiagnostics.enabled },
            autonomyOverlay: this._autonomyOverlaySnapshot(),
            visualizationRevision: this.visualizationRevision,
            debugVisuals: { ...this.debugVisuals },
        };
    }

    _effectiveRealtimeRate() {
        if (!(this._pacingWallMs > 0) || !(this._pacingAdvancedNs > 0)) return null;
        return this._pacingAdvancedNs / (this._pacingWallMs * 1e6);
    }

    _clampAccumulatorDebt() {
        const capNs = this.stepNs * Math.max(1, this.maxSubSteps);
        if (this.accumulatorNs <= capNs) {
            this.accumulator = this.accumulatorNs / 1e9;
            return 0;
        }
        const dropped = this.accumulatorNs - capNs;
        this.accumulatorNs = capNs;
        this.droppedDebtNs += dropped;
        browserSimulationPerformance.recordDroppedDebt(dropped);
        this.accumulator = this.accumulatorNs / 1e9;
        return dropped;
    }

    _resetPacingState() {
        this.droppedDebtNs = 0;
        this._pacingAdvancedNs = 0;
        this._pacingWallMs = 0;
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
            cpuLidar: this.data.devices?.()?.pluginSensorScene?.status ?? null,
            frames: this.frames,
            droppedDebtNs: this.droppedDebtNs,
            effectiveRealtimeRate: this._effectiveRealtimeRate(),
            scenarioDiagnostics: { enabled: this.scenarioDiagnostics.enabled },
            autonomyOverlay: this._autonomyOverlaySnapshot(),
            visualizationRevision: this.visualizationRevision,
            debugVisuals: { ...this.debugVisuals },
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
        this._advanceGeneration += 1;
        this._pendingFrameNs = 0;
        this._clearDueAdvance();
        this._invalidatePendingPresentation();
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    dispose() {
        if (this.kernel.lifecycleState === "disposed") return;
        this.cancelPendingAdvance();
        this.perspectiveView?.exit?.();
        detachPerspectiveView(this.perspectiveView);
        this.stopLoop();
        this._clearVisualizationSource();
        this.visualizationManager.dispose();
        this.controls?.dispose();
        this.kernel.dispose();
        this.packetRelay?.close();
        this.scenarioDiagnostics.dispose();
        this.autonomyOverlay?.dispose?.();
        this.lidarViewport?.dispose();
        this.lidarViewport = null;
        this.colliderViewport?.dispose();
        this.colliderViewport = null;
        this.listeners.clear();
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.environmentRuntime = null;
        this._disposeRendering();
    }

    play() {
        this.syncEditorRigidBodies();
        this.restoreStoppedEditorBodies();
        this.startLoop();
        if (this.ownershipGuard?.lease && this.status !== "playing") this.lastFrameMs = this._nowMs();
        this.kernel.play();
        this._syncEpisodeOverlayMeshes();
        this._emit();
    }

    // Play from stopped puts rigid bodies back on the authored pose. Pause
    // resumes in place. A resolved run keeps the world it was prepared with.
    restoreStoppedEditorBodies() {
        if (this.resolvedRun || this.kernel.status !== "stopped") return;
        const physics = this.data?.physics?.();
        if (!editorRigidBodiesReady(physics)) return;
        physics.resetRun();
        restoreAuthoredRigidBodyPoses(this.data);
    }

    // Stop, reset, and the environment editor show the authored pose. Pause
    // inside Simulation still resumes from the live pose.
    parkRigidBodiesAtAuthoredPose() {
        const physics = this.data?.physics?.();
        if (physics?.world && editorRigidBodiesReady(physics)) physics.resetRun();
        restoreAuthoredRigidBodyPoses(this.data);
    }

    // A resolved run keeps the world it was prepared with. Editor play uses the
    // live description so a rigid body falls without a managed run.
    syncEditorRigidBodies() {
        if (this.resolvedRun) return;
        const environment = this.data?.environment?.();
        const description = environment?.getWorldDescription?.() ?? null;
        const hash = description?.rigidBodies?.length ? environment.worldHash ?? "" : null;
        const physics = this.data?.physics?.();
        if (!physics) return;
        if (hash === this._editorRigidBodyHash && (hash === null || physics.world)) return;
        this._editorRigidBodyHash = hash;
        const captured = description;
        this._editorPhysicsSync = this._editorPhysicsSync.then(async () => {
            if (this.resolvedRun || this._editorRigidBodyHash !== hash) return;
            if (!hash) {
                if (physics.preparedWorldDescription) physics.disposeRun();
                return;
            }
            await physics.configureRun({
                manifest: null,
                worldDescription: captured,
                backendSelection: createPhysicsBackendSelection(captured),
            });
        }).catch((error) => {
            this._editorRigidBodyHash = null;
            console.warn("[simulation] rigid body world sync failed:", error);
        });
    }

    pause() {
        this._advanceGeneration += 1;
        this._pendingFrameNs = 0;
        this._clearDueAdvance();
        this._invalidatePendingPresentation();
        this.kernel.pause();
        this._emit();
    }

    /** Pause remains immediate; lifecycle acknowledgements wait for capture to settle. */
    async whenIdle() {
        await this._asyncAdvanceTail;
        return this.getSnapshot();
    }

    cancelPendingAdvance(error = Object.assign(new Error("Simulation work was cancelled."), {
        code: "SIMULATION_CANCELLED", infrastructureFailure: true, requiresReset: true,
    })) {
        this._advanceGeneration += 1;
        this._captureController.abort(error);
        this._captureController = new AbortController();
        if (this._asyncAdvanceCount > 0) {
            if (error.requiresReset && this.resolvedRun && this.lifecycleState !== "finalized") this.kernel.lifecycleState = "failed";
            try { this.data?.devices?.()?.cancelCaptures?.(error); }
            finally { this.renderRuntime?.cancelCaptures?.(error); }
        }
    }

    stop({ reset = true, dispatchEpisode = true } = {}) {
        try {
            this.cancelPendingAdvance();
            this._clearVisualizationSource();
            this._advanceGeneration += 1;
            this._pendingFrameNs = 0;
            this._clearDueAdvance();
            this._invalidatePendingPresentation();
            this.accumulator = 0;
            this.accumulatorNs = 0;
            this._resetPacingState();
            if (reset) this.frames = 0;
            this._keyboardDrive = createKeyboardDriveState();
        } finally { this.kernel.stop({ reset, dispatchEpisode }); }
        this._bindLiveVisualizationSource();
        this.autonomyOverlay?.disposeEstimateClone?.();
        if (reset) this.autonomyOverlay?.clear?.();
        this._syncEpisodeOverlayMeshes();
        this.parkRigidBodiesAtAuthoredPose();
        this.render();
        this._emit();
    }

    reset(episodeSpec = null) {
        this.cancelPendingAdvance();
        this._clearVisualizationSource();
        this._advanceGeneration += 1;
        this._pendingFrameNs = 0;
        this._clearDueAdvance();
        this._invalidatePendingPresentation();
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this._resetPacingState();
        this._keyboardDrive = createKeyboardDriveState();
        this.kernel.reset(episodeSpec);
        this._bindLiveVisualizationSource();
        this.autonomyOverlay?.clear?.();
        this.parkRigidBodiesAtAuthoredPose();
        this._emit();
        return this.getSnapshot();
    }

    step(count = 1) {
        if (this._usesAsyncSensors()) {
            return this._serializeAsyncAdvance((signal) => this._stepAsync(count, signal));
        }
        let source;
        try {
            this.kernel.step(count, {
                beforeStep: () => { this._assertOwnedStep(); this._visualizationStepActive = true; source = this.liveVisualizationSource; this._submitKeyboardDrive(); },
                afterStep: (dt) => this._updatePresentationAfterStep(dt, source),
            });
        } finally { this._visualizationStepActive = false; }
        this.render();
        this._emit();
    }

    async _stepAsync(count, signal) {
        let source;
        try {
            await this.kernel.stepAsync(count, {
                signal,
                beforeStep: () => { this._assertOwnedStep(); this._visualizationStepActive = true; source = this.liveVisualizationSource; this._submitKeyboardDrive(); },
                afterStep: (dt) => this._updatePresentationAfterStep(dt, source),
            });
        } finally { this._visualizationStepActive = false; }
        this.render();
        this._emit();
    }

    _serializeAsyncAdvance(operation) {
        const signal = this._captureController.signal;
        this._asyncAdvanceCount += 1;
        const advance = () => { signal.throwIfAborted(); return abortable(operation(signal), signal); };
        const pending = this._asyncAdvanceTail.then(advance, advance).finally(() => { this._asyncAdvanceCount -= 1; });
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
        for (const [key, toolId] of [["controls", "ackermann"], ["candidate", "plannedTrajectory"], ["pastTrajectories", "trajectoryPast"]]) {
            if (patch[key] !== undefined && this.visualizationManager.entries.has(toolId)) this.visualizationManager.setVisible(toolId, "scene", patch[key] !== false);
        }
        if (this.visualizationManager.entries.has("occupancy")) {
            const entry = this.visualizationManager.entries.get("occupancy");
            if (!entry.visible.scene && ["oracleOccupancy", "lidarOccupancy", "stackOccupancy"].some((key) => patch[key] !== undefined)) {
                for (const channel of ["oracle", "lidar", "stack"]) {
                    if (entry.tool.layerVisibility.scene[channel] === undefined) this.visualizationManager.setLayerVisible("occupancy", channel, "scene", false);
                }
            }
            let changed = false;
            for (const [key, channel] of [["oracleOccupancy", "oracle"], ["lidarOccupancy", "lidar"], ["stackOccupancy", "stack"]]) {
                if (patch[key] === undefined) continue;
                this.visualizationManager.setLayerVisible("occupancy", channel, "scene", patch[key] !== false);
                changed = true;
            }
            if (changed) this.visualizationManager.setVisible("occupancy", "scene", ["oracle", "lidar", "stack"].some((channel) => this.visualizationManager.tools.occupancy.layerVisibility.scene[channel] !== false));
        }
        if (this.visualizationManager.entries.has("localization")) {
            for (const key of ["ekf", "estimateClone"]) {
                if (patch[key] !== undefined) this.visualizationManager.setLayerVisible("localization", key, "scene", patch[key] !== false);
            }
            if (patch.ekf === true || patch.estimateClone === true) this.visualizationManager.setVisible("localization", "scene", true);
        }
        if (this.candidateOutputRuntime || this.controlRuntime) {
            this.autonomyOverlay?.updateFromRuntime?.(
                this.candidateOutputRuntime,
                this._autonomyOverlayEnabled,
                {
                    controlRuntime: this.controlRuntime,
                    vehiclePose: this.kernel.targetVehiclePose?.(),
                    estimateVehicle: this._estimateVehicle(),
                },
            );
        } else {
            this.autonomyOverlay?.setLayers?.(this._autonomyOverlayEnabled);
        }
        this.render();
        this._emit();
    }

    _autonomyOverlaySnapshot() {
        const snapshot = { ...this._autonomyOverlayEnabled };
        for (const [key, toolId] of [["controls", "ackermann"], ["candidate", "plannedTrajectory"], ["pastTrajectories", "trajectoryPast"]]) {
            const entry = this.visualizationManager.entries.get(toolId);
            if (entry) snapshot[key] = entry.visible.scene;
        }
        const localization = this.visualizationManager.entries.get("localization");
        if (localization) for (const key of ["ekf", "estimateClone"]) snapshot[key] = localization.visible.scene && localization.tool.layerVisibility.scene[key] !== false;
        const occupancy = this.visualizationManager.entries.get("occupancy");
        if (occupancy) for (const [key, channel] of [["oracleOccupancy", "oracle"], ["lidarOccupancy", "lidar"], ["stackOccupancy", "stack"]]) snapshot[key] = occupancy.visible.scene && occupancy.tool.layerVisibility.scene[channel] !== false;
        return snapshot;
    }

    /** Paused device edits update display data without waiting for another simulation step. */
    notifyVisualizationChange() {
        this.visualizationRevision += 1;
        if (!this._visualizationStepActive) this.liveVisualizationSource?.releasePending(this.timeNs);
        this._emitFrame();
        this._requestPresentation();
        this._queuePendingPresentation();
    }

    setDebugVisuals(patch = {}) {
        this.debugVisuals = { ...this.debugVisuals, ...patch };
        applySensorMarkersVisible(this.data, this.debugVisuals.sensorMarkers);
        applyOriginMarkersVisible(this.data, this.debugVisuals.originMarker);
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

    setSceneRenderEnabled(enabled) {
        const next = enabled !== false;
        if (this.sceneRenderEnabled === next) return;
        this.sceneRenderEnabled = next;
        if (next) this.render();
    }

    setLidarViewportEnabled(enabled) {
        const next = enabled === true;
        if (next) this.colliderViewport?.setEnabled(false);
        if (!this.lidarViewport || this.lidarViewport.enabled === next) return;
        this.lidarViewport.setEnabled(next);
        if (this.sceneRenderEnabled) this.render();
    }

    setColliderViewportEnabled(enabled) {
        const next = enabled === true;
        if (next) this.lidarViewport?.setEnabled(false);
        if (!this.colliderViewport || this.colliderViewport.enabled === next) return;
        this.colliderViewport.setEnabled(next);
        if (this.sceneRenderEnabled) this.render();
    }

    async applyRunManifest(resolved, options = {}) {
        if (!resolved?.manifest) throw new Error("Resolved run manifest is required.");
        assertProtobufExecutionCapabilities(resolved, { target: "browser", transport: "zenoh-browser", controlOwnership: Boolean(this.ownershipGuard) });
        this._clearVisualizationSource();
        this.pause();
        await this.whenIdle();
        this.scenarioDiagnostics.configure(null);
        this.autonomyOverlay?.clear?.();
        this.frames = 0;
        this.accumulator = 0;
        this.accumulatorNs = 0;
        this._resetPacingState();
        this._keyboardDrive = createKeyboardDriveState();

        await this.packetRelay?.refreshHost();
        await this.kernel.prepare(resolved, options);
        try {
            await this.packetRelay?.configure({
                bindings: this.resolvedRun.manifest.sensorTransports?.bindings ?? [],
                stepNs: this.stepNs,
            });
        } catch (error) {
            this.kernel.clearRun();
            throw error;
        }
        this.scenarioDiagnostics.configure(this.resolvedRun?.scenario?.scenario ?? null);
        this._bindLiveVisualizationSource();
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
        this.cancelPendingAdvance();
        this._clearVisualizationSource();
        this.stopLoop();
        this._keyboardDrive = createKeyboardDriveState();
        this.kernel.clearRun();
        this.packetRelay?.close();
        this.autonomyOverlay?.clear?.();
        this._bindLiveVisualizationSource();
        this._emit();
    }

    queueTopicInput(info) {
        return this.kernel.queueTopicInput(info);
    }

    _frame(nowMs) {
        if (!this.looping) return;
        this.rafId = requestAnimationFrame(this._frame);
        browserSimulationPerformance.recordRaf(nowMs);

        const frameDt = this._takeFrameDt(nowMs);

        if (this.controls) {
            const cameraControlsEnabled = this.modules.controls
                && this.data.settings()?.cameraControlsEnabled !== false;
            this.controls.enabled = this.viewportActive && this.sceneRenderEnabled && cameraControlsEnabled;
            if (this.viewportActive && this.sceneRenderEnabled && cameraControlsEnabled) this.controls.update();
        }

        if (this.status === "playing") {
            if (this._usesAsyncSensors()) {
                this._clearDueAdvance();
                this._accruePendingFrame(frameDt);
                this._launchAsyncAdvance();
            } else {
                try {
                    this._advanceSimulation(frameDt);
                    this._emitFrame();
                } catch (error) {
                    this._handleAdvanceError(error);
                }
            }
        } else {
            this._pendingFrameNs = 0;
        }
        if (this.viewportActive && this.sceneRenderEnabled && this.modules.rendering) {
            this.render();
        }
    }

    _launchAsyncAdvance() {
        if (this._advanceInFlight || this.status !== "playing" || this._pendingFrameNs <= 0) return;
        const frameNs = this._pendingFrameNs;
        this._pendingFrameNs = 0;
        const generation = this._advanceGeneration;
        const pending = this._serializeAsyncAdvance((signal) => {
            if (generation !== this._advanceGeneration) return;
            return this._advanceSimulationAsync(frameNs / 1e9, signal);
        });
        this._advanceInFlight = pending;
        pending.then(() => {
            if (generation === this._advanceGeneration) {
                this._emitFrame();
            }
        }).catch((error) => {
            if (generation !== this._advanceGeneration) return;
            this._handleAdvanceError(error);
        }).finally(() => {
            if (this._advanceInFlight !== pending) return;
            this._advanceInFlight = null;
            this._servicePendingPresentation();
            if (generation !== this._advanceGeneration) return;
            if (this._pendingFrameNs > 0) queueMicrotask(() => this._launchAsyncAdvance());
            else this._armDueAdvance();
        });
    }

    // Wall time is shared by RAF and the due-step timer. RAF timestamps can
    // precede a timer's `now`, so the accounted point only moves forward.
    _takeFrameDt(nowMs) {
        const elapsedMs = nowMs - this.lastFrameMs;
        if (!(elapsedMs > 0)) return 0;
        this.lastFrameMs = nowMs;
        return clamp(elapsedMs / 1000, 0, this.maxFrameDt);
    }

    _accruePendingFrame(frameDt) {
        const maxDebtNs = Math.max(this.stepNs, Math.round(this.maxFrameDt * 1e9));
        this._pendingFrameNs = Math.min(
            maxDebtNs,
            this._pendingFrameNs + Math.max(0, Math.round(frameDt * 1e9)),
        );
    }

    /**
     * Launch the next realtime step when it falls due instead of waiting for
     * the next RAF. A capture step that overruns the budget otherwise idles
     * until the following display frame. Hidden documents keep RAF pacing.
     */
    _armDueAdvance() {
        this._clearDueAdvance();
        if (!this.looping || this.status !== "playing" || !this._usesAsyncSensors()) return;
        if (!this.realtime || !this.deterministic || !(this.stepNs > 0)) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        if (typeof setTimeout !== "function") return;
        const speed = this.speed > 0 ? this.speed : 1;
        const elapsedMs = Math.max(0, this._nowMs() - this.lastFrameMs);
        const remainingNs = Math.max(0, this.stepNs - this.accumulatorNs) / speed;
        const dueMs = Math.max(0, remainingNs / 1e6 - elapsedMs);
        const generation = this._advanceGeneration;
        this._dueAdvanceTimer = setTimeout(() => {
            this._dueAdvanceTimer = null;
            if (generation !== this._advanceGeneration || !this.looping || this.status !== "playing") return;
            this._accruePendingFrame(this._takeFrameDt(this._nowMs()));
            if (this.accumulatorNs + this._pendingFrameNs * speed < this.stepNs) {
                this._armDueAdvance();
                return;
            }
            this._launchAsyncAdvance();
        }, dueMs);
    }

    _clearDueAdvance() {
        if (this._dueAdvanceTimer === null) return;
        clearTimeout(this._dueAdvanceTimer);
        this._dueAdvanceTimer = null;
    }

    _handleAdvanceError(error) {
        this.kernel.pause();
        this._pendingFrameNs = 0;
        if (String(error.code || "").startsWith("CPU_LIDAR_")) {
            this.kernel.emitLifecycle("sensor-runtime-failed", { code: error.code, message: error.message });
            this._emit();
            return;
        }
        if (this.renderProviderStatus?.state === "error") return;
        this.renderProviderStatus = {
            ...(this.renderProviderStatus ?? {}),
            state: "error",
            diagnostic: { code: error.code ?? "PBR_CAPTURE_FAILED", message: error.message },
            error: { code: error.code ?? "PBR_CAPTURE_FAILED", message: error.message },
        };
    }

    _advanceSimulation(frameDt) {
        const scaledDt = frameDt * this.speed;
        const frameStartMs = this.realtime ? this._nowMs() : 0;
        const pacingStartMs = this._nowMs();
        const pacingStartNs = this.timeNs;
        const pacingStartSteps = this.steps;
        if (!this.deterministic) {
            this._fixedStep(scaledDt);
            this._recordPacingWindow(pacingStartNs, pacingStartMs, pacingStartSteps);
            return;
        }

        this.accumulatorNs += this.realtime
            ? Math.max(0, Math.round(scaledDt * 1e9))
            : this.stepNs * Math.max(1, this.maxSubSteps);
        this._clampAccumulatorDebt();

        let subSteps = 0;
        while (this.accumulatorNs >= this.stepNs && subSteps < this.maxSubSteps) {
            const previousStep = this.steps;
            const shouldContinue = this._fixedStep(this.fixedDt);
            if (this.steps > previousStep) this.accumulatorNs -= this.stepNs;
            this.accumulator = this.accumulatorNs / 1e9;
            subSteps += 1;
            if (shouldContinue === false) break;
            if (this.realtime && subSteps > 0 && this._nowMs() - frameStartMs > this.realtimeStepBudgetMs) {
                break;
            }
        }
        this._recordPacingWindow(pacingStartNs, pacingStartMs, pacingStartSteps);
    }

    _usesAsyncSensors() {
        return Boolean(this.renderRuntime || this.data.devices?.()?.requiresAsyncCapture);
    }

    _recordPacingWindow(startTimeNs, startWallMs, startSteps) {
        const advancedNs = Math.max(0, this.timeNs - startTimeNs);
        const wallMs = Math.max(0, this._nowMs() - startWallMs);
        this._pacingAdvancedNs += advancedNs;
        this._pacingWallMs += wallMs;
        if (this.steps > startSteps) {
            browserSimulationPerformance.recordTiming("simulationAdvance", wallMs);
            browserSimulationPerformance.recordSimulation(advancedNs, wallMs, this.steps - startSteps);
        }
    }

    _submitKeyboardDrive() {
        const manifest = this.resolvedRun?.manifest;
        const controls = manifest?.controls;
        const targetId = controls?.targetVehicleId || "ego";
        const target = this.runtimeContext.vehicles.list().find((vehicle) => (vehicle.telemetryId || vehicle.id) === targetId);
        const physicalLimits = target?.plant?.kinematics ?? target?.kinematics
            ?? this.resolvedRun?.vehicles?.find((vehicle) => vehicle.actorId === targetId)?.manifest?.kinematics;
        const effectiveLimits = this.controlRuntime?.getLimits(targetId);
        const limits = effectiveLimits && { ...effectiveLimits };
        for (const key of ["maxSpeed", "maxSteeringAngle", "maxSteeringRate"]) {
            if (limits && Number.isFinite(physicalLimits?.[key])) limits[key] = Math.min(limits[key], physicalLimits[key]);
        }
        const enabled = Boolean(this.controlRuntime)
            && controls?.keyboardDrive === true
            && controls?.authority === "candidate"
            && this.scenarioRuntime?.active !== true
            && this.modules?.controls !== false
            && Boolean(target)
            && manifest.initialState.vehicles.some((vehicle) => vehicle.id === targetId);
        const stepped = stepKeyboardDrive(this._keyboardDrive, {
            down: this.data.keys?.()?.down,
            dt: this.fixedDt,
            enabled,
            limits,
            currentSteeringRad: target?.plant?.steeringAngle ?? target?.steeringAngle,
        });
        this._keyboardDrive = stepped.state;
        if (!stepped.command || !this.controlRuntime) return;
        this.controlRuntime.submitSiSpeedSteer(controls?.targetVehicleId || "ego", {
            ...stepped.command,
            captureTimeNs: this.timeNs,
            producer: "candidate",
            source: "keyboard",
        });
    }

    _canAdvanceOwnedRun() {
        return !this.ownershipGuard?.lease || (globalThis.document?.visibilityState !== "hidden" && this.ownershipGuard.check());
    }

    _assertOwnedStep() {
        if (!this._canAdvanceOwnedRun()) throw new Error("A verified control lease is required before stepping.");
    }

    _fixedStep(dt) {
        if (!this._canAdvanceOwnedRun()) return false;
        const source = this.liveVisualizationSource;
        this._visualizationStepActive = true;
        const previousStep = this.steps;
        try {
            this._submitKeyboardDrive();
            const shouldContinue = this.kernel.advanceStep(dt);
            if (this.steps > previousStep) this._updatePresentationAfterStep(dt, source);
            return shouldContinue;
        } finally { this._visualizationStepActive = false; }
    }

    async _advanceSimulationAsync(frameDt, signal) {
        const generation = this._advanceGeneration;
        const scaledDt = frameDt * this.speed;
        const frameStartMs = this.realtime ? this._nowMs() : 0;
        const pacingStartMs = this._nowMs();
        const pacingStartNs = this.timeNs;
        const pacingStartSteps = this.steps;
        if (!this.deterministic) {
            await this._fixedStepAsync(scaledDt, signal);
            if (generation === this._advanceGeneration) this._recordPacingWindow(pacingStartNs, pacingStartMs, pacingStartSteps);
            return;
        }

        this.accumulatorNs += this.realtime
            ? Math.max(0, Math.round(scaledDt * 1e9))
            : this.stepNs * Math.max(1, this.maxSubSteps);
        this._clampAccumulatorDebt();

        let subSteps = 0;
        while (this.accumulatorNs >= this.stepNs && subSteps < this.maxSubSteps) {
            const previousStep = this.steps;
            const shouldContinue = await this._fixedStepAsync(this.fixedDt, signal);
            if (this.steps > previousStep) this.accumulatorNs -= this.stepNs;
            this.accumulator = this.accumulatorNs / 1e9;
            subSteps += 1;
            if (generation !== this._advanceGeneration) break;
            if (shouldContinue === false) break;
            if (this.realtime && this._nowMs() - frameStartMs > this.realtimeStepBudgetMs) break;
        }
        if (generation === this._advanceGeneration) this._recordPacingWindow(pacingStartNs, pacingStartMs, pacingStartSteps);
    }

    async _fixedStepAsync(dt, signal = this._captureController.signal) {
        if (!this._canAdvanceOwnedRun()) return false;
        const source = this.liveVisualizationSource;
        this._visualizationStepActive = true;
        const previousStep = this.steps;
        try {
            this._submitKeyboardDrive();
            const shouldContinue = await this.kernel.advanceStepAsync(dt, { signal });
            signal?.throwIfAborted();
            if (this.steps > previousStep) this._updatePresentationAfterStep(dt, source);
            return shouldContinue;
        } finally { this._visualizationStepActive = false; }
    }

    _updatePresentationAfterStep(dt, source = this.liveVisualizationSource) {
        this._visualizationStepActive = false;
        if (source === this.liveVisualizationSource) source?.releasePending(this.timeNs);
        this.autonomyOverlay?.updateFromRuntime?.(
            this.candidateOutputRuntime,
            this._autonomyOverlayEnabled,
            {
                controlRuntime: this.controlRuntime,
                vehiclePose: this.kernel.targetVehiclePose(),
                estimateVehicle: this._estimateVehicle(),
            },
        );
        if (this.modules.baking) this.data.baking()?.update?.(dt);
        if (this.scenarioRuntime?.active || this.scenarioDiagnostics.enabled) {
            this.scenarioDiagnostics.update({
                ...(this.scenarioRuntime?.active ? this.scenarioRuntime.getSnapshot() : {}),
                actorPoses: this.kernel.actorPoses(),
            });
        }
        this._applyRigidBodyPoses();
    }

    _estimateVehicle() {
        const targetId = this.resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
        const vehicles = this.kernel.context?.vehicles?.list?.() || [];
        return vehicles.find((candidate) => (candidate.telemetryId || candidate.id) === targetId) ?? vehicles[0] ?? null;
    }

    _applyRigidBodyPoses() {
        applyRigidBodyViewportPoses(this.data, this.kernel.context.physics.rigidBodyPoses?.() ?? []);
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
        const sceneReady = this.sceneRenderEnabled && this.scene && this.camera && this.renderer;
        if (!this._visualizationFlush && !sceneReady) return false;
        if (this._presentationBlocked()) {
            this._requestPresentation();
            return false;
        }
        this._presentationRequested = false;
        const flush = this._visualizationFlush;
        this._visualizationFlush = null;
        flush?.();
        if (!sceneReady) return false;
        this.perspectiveView?.applyFrame?.(this.camera, this.controls);
        this._applyDisplayPerformance();
        this.data.earthTilesManager?.()?.update?.(this.camera, {
            width: this.renderer.domElement?.width,
            height: this.renderer.domElement?.height,
        });
        if (this.lidarViewport?.enabled && this.lidarViewport.render(this.renderer, this.camera)) {
            this.frames += 1;
            browserSimulationPerformance.recordPresentation();
            return true;
        }
        if (this.colliderViewport?.enabled && this.colliderViewport.render(this.renderer, this.camera)) {
            this.frames += 1;
            browserSimulationPerformance.recordPresentation();
            return true;
        }
        if (this.data.skyManager?.()?.render?.()) {
            this.frames += 1;
            browserSimulationPerformance.recordPresentation();
            return true;
        }
        this.renderer.render(this.scene, this.camera);
        this.frames += 1;
        browserSimulationPerformance.recordPresentation();
        this._reconcileVisualInterest();
        return true;
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
