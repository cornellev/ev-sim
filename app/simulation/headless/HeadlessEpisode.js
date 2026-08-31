import { assertPhysicsBackendSelection } from "../../physics/PhysicsBackend.js";
import { validateRouteVerification } from "../../scenarios/route/Route.js";
import { SimulationKernel } from "../kernel/SimulationKernel.js";
import { createHeadlessRuntimeContext } from "./HeadlessRuntimeContext.js";
import { HeadlessEpisodeError } from "./HeadlessErrors.js";
import {
    createMeasuredStateObservationSpace,
    MeasuredStateObservationBuilder,
    resolveEgoRoute,
} from "./MeasuredStateObservation.js";
import {
    measuredStateProfileRef,
    resolveObservationProfile,
    resolveRewardProfile,
    routeSafetyProfileRef,
} from "./ProfileRegistry.js";
import { assertCompatibleSpaces } from "./SpaceCompatibility.js";
import {
    assertStateSensorBackendSelection,
    createStateSensorBackendSelection,
    getStateSensorModel,
} from "../sensors/StateSensorBackend.js";
import {
    assertCpuLidarBackendSelection,
    CPU_LIDAR_BACKEND_KIND,
    createCpuLidarBackendSelection,
} from "../sensors/CpuLidarBackend.js";
import {
    ACTION_SPACE,
    compareUtf8,
    hashSpace,
    normalizeAction,
} from "./TensorProtocol.js";

export const TERMINATION_REASON = Object.freeze({
    NONE: 1,
    SUCCESS: 2,
    COLLISION: 3,
    OFF_ROAD: 4,
    WRONG_WAY: 5,
    SCENARIO_FAILURE: 6,
    ASSERTION_FAILURE: 7,
});

export const TRUNCATION_REASON = Object.freeze({
    NONE: 1,
    MAX_EPISODE_STEPS: 2,
    MAX_SIMULATION_TIME: 3,
});

const REWARD_ORDER = Object.freeze([
    "route-progress-ratio",
    "completion",
    "collision",
    "off-road",
    "wrong-way",
    "acceleration-smoothness",
    "jerk-smoothness",
]);

function normalizedBackend(entry = {}) {
    return {
        kind: Number(entry.kind),
        capabilityId: String(entry.capabilityId || entry.capability_id || ""),
        version: String(entry.version || ""),
        configHash: String(entry.configHash || entry.config_hash || ""),
    };
}

function compareBackends(left, right) {
    return left.kind - right.kind || compareUtf8(left.capabilityId, right.capabilityId);
}

function normalizeEpisodeSpec(resolvedRun, spec = {}) {
    const requestsLidar = resolvedRun.manifest.sensorRig?.sensors?.some(
        (sensor) => sensor.enabled !== false && sensor.type === "lidar3d",
    );
    const requestedBackends = spec.backendSelections ?? spec.backend_selections;
    const backends = ((Array.isArray(requestedBackends) && requestedBackends.length > 0) ? requestedBackends : [
        ...(resolvedRun.backendSelections || []),
        createStateSensorBackendSelection(),
        ...(requestsLidar ? [createCpuLidarBackendSelection()] : []),
    ]).map(normalizedBackend);
    return {
        protocolMajor: 1,
        environmentIndex: Number(spec.environmentIndex ?? spec.environment_index ?? 0),
        environmentId: String(spec.environmentId || spec.environment_id || resolvedRun.manifest.id || "environment-0"),
        runBundleId: String(spec.runBundleId || spec.run_bundle_id || resolvedRun.resolvedHash || ""),
        resetSeed: String(spec.resetSeed ?? spec.reset_seed ?? resolvedRun.manifest.seed ?? "0"),
        actionRepeat: Number(spec.actionRepeat ?? spec.action_repeat ?? 1),
        maxEpisodeSteps: String(spec.maxEpisodeSteps ?? spec.max_episode_steps ?? "0"),
        observationProfile: spec.observationProfile || spec.observation_profile || measuredStateProfileRef(),
        rewardProfile: spec.rewardProfile || spec.reward_profile || routeSafetyProfileRef(),
        backendSelections: backends,
    };
}

function finiteMetric(metrics, id) {
    const value = Number(metrics?.[id]);
    return Number.isFinite(value) ? value : 0;
}

function assertionFailure(snapshot) {
    return (snapshot?.assertions || []).some((result) => (
        result.status === "failed" && result.severity === "error" && result.onFailure === "stop"
    ));
}

function classifyScenarioTerminal(terminal) {
    if (!terminal) return null;
    if (["trigger", "finish-predicate"].includes(terminal.reason)) return "success";
    if (terminal.reason === "max-duration") return "simulation-time";
    if (terminal.reason === "ego-collision") return "collision";
    if (terminal.reason === "fatal-assertion") return "assertion";
    return "scenario-failure";
}

export function createRouteSafetyRewardTerms(values, smoothness) {
    const weights = {
        "route-progress-ratio": 1,
        completion: 1,
        collision: -1,
        "off-road": -1,
        "wrong-way": -0.25,
        "acceleration-smoothness": smoothness ? -0.05 : 0,
        "jerk-smoothness": smoothness ? -0.01 : 0,
    };
    return REWARD_ORDER.map((id) => ({
        id,
        value: Number(values[id]) || 0,
        weight: weights[id],
        weightedValue: (Number(values[id]) || 0) * weights[id],
    }));
}

export function resolveEpisodeOutcome(transition, rewardConfig, scenarioTerminal, {
    policyLimitReached = false,
    simulationLimitReached = false,
} = {}) {
    let terminationReason = TERMINATION_REASON.NONE;
    if (transition.collision && (rewardConfig.terminateOnCollision || scenarioTerminal?.reason === "ego-collision")) terminationReason = TERMINATION_REASON.COLLISION;
    else if (transition.offRoad && rewardConfig.terminateOnOffRoad) terminationReason = TERMINATION_REASON.OFF_ROAD;
    else if (transition.wrongWay && rewardConfig.terminateOnWrongWay) terminationReason = TERMINATION_REASON.WRONG_WAY;
    else if (transition.assertion) terminationReason = TERMINATION_REASON.ASSERTION_FAILURE;
    else if (transition.scenarioFailure) terminationReason = TERMINATION_REASON.SCENARIO_FAILURE;
    else if (transition.success) terminationReason = TERMINATION_REASON.SUCCESS;
    const terminated = terminationReason !== TERMINATION_REASON.NONE;
    let truncationReason = TRUNCATION_REASON.NONE;
    if (!terminated && policyLimitReached) truncationReason = TRUNCATION_REASON.MAX_EPISODE_STEPS;
    else if (!terminated && simulationLimitReached) truncationReason = TRUNCATION_REASON.MAX_SIMULATION_TIME;
    return {
        terminated,
        truncated: truncationReason !== TRUNCATION_REASON.NONE,
        terminationReason,
        truncationReason,
    };
}

export class HeadlessEpisode {
    constructor(options = {}) {
        this.runtime = options.runtime ?? createHeadlessRuntimeContext(options);
        this.kernel = options.kernel ?? new SimulationKernel(this.runtime.context);
        this.lifecycleState = "idle";
        this.policyStep = 0;
        this.terminal = false;
        this.resolvedRun = null;
        this.episodeSpec = null;
        this.rewardConfig = null;
        this.route = null;
        this.observationBuilder = null;
        this.spaces = null;
        this.previousProgress = 0;
        this.lastResult = null;
    }

    _preflight(resolvedRun, inputSpec) {
        if (!resolvedRun?.manifest || !resolvedRun?.resolvedHash || !resolvedRun?.world?.description) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "An immutable resolved run bundle with world data is required.");
        }
        const spec = normalizeEpisodeSpec(resolvedRun, inputSpec);
        if (!Number.isSafeInteger(spec.environmentIndex) || spec.environmentIndex < 0 || spec.environmentIndex > 0xffff_ffff) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "environment_index must be a uint32 value.");
        }
        if (!spec.environmentId || !spec.runBundleId) throw new HeadlessEpisodeError("INVALID_REQUEST", "environment_id and run_bundle_id are required.");
        if (!Number.isInteger(spec.actionRepeat) || spec.actionRepeat < 1 || spec.actionRepeat > 0xffff_ffff) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "action_repeat must be an integer in [1, 2^32-1].");
        }
        if (!/^\d+$/.test(spec.maxEpisodeSteps)) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "max_episode_steps must be an unsigned integer.");
        }
        if (BigInt(spec.maxEpisodeSteps) > 0xffff_ffff_ffff_ffffn) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "max_episode_steps exceeds uint64.");
        }
        if (!/^\d+$/.test(spec.resetSeed) || BigInt(spec.resetSeed) > 0xffff_ffff_ffff_ffffn) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "reset_seed must be a uint64 value.");
        }
        resolveObservationProfile(spec.observationProfile);
        const rewardConfig = resolveRewardProfile(spec.rewardProfile);
        const normalized = spec.backendSelections.map(normalizedBackend);
        const sorted = [...normalized].sort(compareBackends);
        if (normalized.some((entry, index) => compareBackends(entry, sorted[index]) !== 0)) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "backend_selections must be sorted by kind and capability_id.");
        }
        if (resolvedRun.manifest.clock?.modules?.physics === false || resolvedRun.manifest.clock?.modules?.sensors === false) {
            throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", "HeadlessEpisode requires enabled physics and sensors modules.");
        }
        if (resolvedRun.manifest.controls?.authority !== "candidate") {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "HeadlessEpisode requires candidate control authority.");
        }
        const physics = normalized.find((entry) => entry.kind === 1);
        const stateSensors = normalized.find((entry) => entry.kind === 2);
        const cpuLidar = normalized.find((entry) => entry.kind === CPU_LIDAR_BACKEND_KIND);
        const enabledSensors = (resolvedRun.manifest.sensorRig?.sensors || []).filter((sensor) => sensor.enabled !== false);
        const lidarSensors = enabledSensors.filter((sensor) => sensor.type === "lidar3d");
        const stateSensorConfigs = enabledSensors.filter((sensor) => getStateSensorModel(sensor.type));
        try {
            assertPhysicsBackendSelection(physics);
            assertStateSensorBackendSelection(stateSensors);
            if (lidarSensors.length > 0) assertCpuLidarBackendSelection(cpuLidar);
        } catch (error) {
            throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", error.message);
        }
        if (normalized.filter((entry) => entry.kind === 1).length !== 1
            || normalized.filter((entry) => entry.kind === 2).length !== 1
            || normalized.filter((entry) => entry.kind === CPU_LIDAR_BACKEND_KIND).length !== (lidarSensors.length > 0 ? 1 : 0)
            || normalized.some((entry) => ![1, 2, CPU_LIDAR_BACKEND_KIND].includes(entry.kind))) {
            throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", "Headless execution requires exactly one physics and state backend, plus one CPU LiDAR backend iff lidar3d is enabled.");
        }
        const unsupported = enabledSensors.filter((sensor) => !getStateSensorModel(sensor.type) && sensor.type !== "lidar3d");
        if (unsupported.length) {
            throw new HeadlessEpisodeError("UNSUPPORTED_CAPABILITY", `Unsupported headless sensor(s): ${unsupported.map((sensor) => `${sensor.id}:${sensor.type}`).sort().join(", ")}.`);
        }
        if (stateSensorConfigs.length === 0) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "At least one enabled state sensor is required.");
        }
        if (lidarSensors.length > 0 && !resolvedRun.lidarGeometry) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "LiDAR geometry twins are missing; re-resolve and export the run manifest.");
        }
        const sensorIds = new Set();
        const vehicleIds = new Set((resolvedRun.manifest.initialState?.vehicles || []).map((vehicle) => vehicle.id));
        for (const sensor of enabledSensors) {
            if (!sensor.id || sensorIds.has(sensor.id)) throw new HeadlessEpisodeError("BUNDLE_INVALID", "Enabled state sensor IDs must be unique and non-empty.");
            if (!vehicleIds.has(sensor.parentId)) throw new HeadlessEpisodeError("BUNDLE_INVALID", `Sensor ${sensor.id} references unknown parent vehicle ${sensor.parentId}.`);
            sensorIds.add(sensor.id);
        }
        const route = resolveEgoRoute(resolvedRun);
        if (!route?.verification || !Array.isArray(route.polyline) || route.polyline.length < 2 || !(Number(route.totalLength) > 0)) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "A verified, non-empty ego route is required.");
        }
        const routeValidation = validateRouteVerification(route, resolvedRun.environment?.manifest);
        if (!routeValidation.ok) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "The ego route verification is stale or non-canonical.", routeValidation.issues);
        }
        const roads = resolvedRun.world.description.roads;
        if (!(roads?.nodes?.length > 0) || !(roads?.edges?.length > 0) || !(resolvedRun.world.description.drivableSurfaces?.length > 0)) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "Road-network and drivable-surface data are required.");
        }
        const controlTarget = resolvedRun.manifest.controls.targetVehicleId || "ego";
        if (route.actorId !== controlTarget) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", `The candidate control target ${controlTarget} does not own the verified ego route ${route.id}.`);
        }
        const initialVehicle = (resolvedRun.manifest.initialState?.vehicles || []).find((entry) => entry.id === route.actorId)
            ?? resolvedRun.manifest.initialState?.vehicles?.[0];
        const vehicleDependency = (resolvedRun.vehicles || []).find((entry) => entry.actorId === initialVehicle?.id)
            ?? resolvedRun.vehicles?.[0];
        if (!initialVehicle || !vehicleDependency?.manifest?.boundingBox?.size || !vehicleDependency.manifest.kinematics?.wheelbase) {
            throw new HeadlessEpisodeError("BUNDLE_INVALID", "The ego vehicle requires resolved footprint and kinematics data.");
        }
        const descriptors = stateSensorConfigs.map((sensor) => ({ id: sensor.id, type: sensor.type }));
        const spaces = {
            actionSpace: ACTION_SPACE,
            observationSpace: createMeasuredStateObservationSpace(descriptors),
        };
        return { spec, rewardConfig, route, spaces };
    }

    async prepare(resolvedRun, episodeSpec = {}) {
        const prepared = this._preflight(resolvedRun, episodeSpec);
        await this.kernel.prepare(resolvedRun, { episode: prepared.spec, requireStateSensors: true });
        this.resolvedRun = this.kernel.resolvedRun;
        this.episodeSpec = prepared.spec;
        this.rewardConfig = prepared.rewardConfig;
        this.route = prepared.route;
        this.spaces = prepared.spaces;
        this.observationBuilder = new MeasuredStateObservationBuilder(this.runtime.devices, this.route, () => this.runtime.vehicles);
        this.lifecycleState = "prepared";
        return {
            episodeHash: this.kernel.episodeHash,
            actionSpace: this.spaces.actionSpace,
            observationSpace: this.spaces.observationSpace,
            actionSpaceHash: hashSpace(this.spaces.actionSpace),
            observationSpaceHash: hashSpace(this.spaces.observationSpace),
        };
    }

    reset(inputSpec = this.episodeSpec) {
        if (!this.resolvedRun || !this.episodeSpec) throw new HeadlessEpisodeError("ENVIRONMENT_NOT_FOUND", "Prepare the episode before reset.");
        const prepared = this._preflight(this.resolvedRun, inputSpec);
        for (const field of ["environmentIndex", "environmentId", "runBundleId"]) {
            if (prepared.spec[field] !== this.episodeSpec[field]) {
                throw new HeadlessEpisodeError("INVALID_REQUEST", `Reset may not change ${field}.`);
            }
        }
        assertCompatibleSpaces(this.spaces, prepared.spaces);
        this.episodeSpec = prepared.spec;
        this.rewardConfig = prepared.rewardConfig;
        this.kernel.reset(prepared.spec);
        this.policyStep = 0;
        this.terminal = false;
        this.lastResult = null;
        this.observationBuilder.reset();
        const scenario = this.kernel.scenarioRuntime?.getSnapshot?.() ?? null;
        const initialTask = this._taskProgress(scenario);
        this.previousProgress = initialTask;
        this.lifecycleState = "ready";
        return {
            observation: this.observationBuilder.build({ step: 0, policyStep: 0, scenario }),
            info: {
                episodeHash: this.kernel.episodeHash,
                resolvedHash: this.resolvedRun.resolvedHash,
                step: 0,
                simulationTimeNs: 0,
                actionSpaceHash: hashSpace(this.spaces.actionSpace),
                observationSpaceHash: hashSpace(this.spaces.observationSpace),
            },
        };
    }

    _taskProgress(scenario) {
        const metric = Number(scenario?.metrics?.["route-progress-ratio"]);
        if (Number.isFinite(metric)) return Math.max(0, Math.min(1, metric));
        return 0;
    }

    step(action) {
        if (this.lifecycleState !== "ready") {
            throw new HeadlessEpisodeError(this.terminal ? "EPISODE_TERMINAL" : "ENVIRONMENT_NOT_FOUND", this.terminal ? "Reset the terminal episode before stepping." : "Prepare and reset the episode before stepping.");
        }
        const normalized = normalizeAction(action);
        const target = this.resolvedRun.manifest.controls.targetVehicleId || "ego";
        const limits = this.kernel.controlRuntime.getLimits(target);
        const physical = {
            speedMps: normalized[0] * limits.maxSpeed,
            steeringRadRep103: normalized[1] * limits.maxSteeringAngle,
        };
        const transition = { collision: false, offRoad: false, wrongWay: false, assertion: false, scenarioFailure: false, success: false, simulationTime: false };
        const collisionBefore = this.kernel.scenarioRuntime?.getSnapshot?.()?.egoCollisionCount ?? 0;
        let substeps = 0;
        let scenario = this.kernel.scenarioRuntime?.getSnapshot?.() ?? null;
        for (let repeat = 0; repeat < this.episodeSpec.actionRepeat; repeat += 1) {
            const nextTimeNs = (this.kernel.steps + 1) * this.kernel.stepNs;
            this.kernel.controlRuntime.submitSiSpeedSteer(target, {
                ...physical,
                captureTimeNs: nextTimeNs,
                producer: "candidate",
                source: "headless-policy",
            });
            if (repeat === 0) {
                this.kernel.recordAcceptedPolicyAction({
                    kind: "normalized-speed-steering",
                    speed: normalized[0],
                    steering: normalized[1],
                });
            }
            const previousStep = this.kernel.steps;
            const continued = this.kernel.advanceStep();
            if (this.kernel.steps === previousStep) {
                transition.simulationTime = true;
                break;
            }
            substeps += 1;
            const snapshot = this.kernel.getSnapshot();
            scenario = snapshot.scenario;
            transition.collision ||= (scenario?.egoCollisionCount ?? 0) > collisionBefore;
            transition.offRoad ||= finiteMetric(scenario?.metrics, "off-road") > 0;
            transition.wrongWay ||= finiteMetric(scenario?.metrics, "wrong-way") > 0;
            transition.assertion ||= assertionFailure(snapshot);
            const scenarioOutcome = classifyScenarioTerminal(scenario?.terminal);
            transition.success ||= scenarioOutcome === "success";
            transition.simulationTime ||= scenarioOutcome === "simulation-time";
            transition.collision ||= scenarioOutcome === "collision";
            transition.assertion ||= scenarioOutcome === "assertion";
            transition.scenarioFailure ||= scenarioOutcome === "scenario-failure";
            const safetyStop = (transition.collision && this.rewardConfig.terminateOnCollision)
                || (transition.offRoad && this.rewardConfig.terminateOnOffRoad)
                || (transition.wrongWay && this.rewardConfig.terminateOnWrongWay);
            if (!continued || safetyStop || transition.assertion || transition.scenarioFailure || transition.success || transition.simulationTime) break;
        }
        this.policyStep += 1;
        const progress = this._taskProgress(scenario);
        const completion = transition.success ? 1 : 0;
        const acceleration = finiteMetric(scenario?.metrics, "acceleration") / Math.max(Number.EPSILON, limits.maxAcceleration);
        const jerk = finiteMetric(scenario?.metrics, "jerk") / Math.max(Number.EPSILON, limits.maxJerk);
        const terms = createRouteSafetyRewardTerms({
            "route-progress-ratio": progress - this.previousProgress,
            completion,
            collision: transition.collision ? 1 : 0,
            "off-road": transition.offRoad ? 1 : 0,
            "wrong-way": transition.wrongWay ? 1 : 0,
            "acceleration-smoothness": acceleration,
            "jerk-smoothness": jerk,
        }, this.rewardConfig.smoothness);
        this.previousProgress = progress;

        const maxPolicySteps = BigInt(this.episodeSpec.maxEpisodeSteps);
        const outcome = resolveEpisodeOutcome(transition, this.rewardConfig, scenario?.terminal, {
            policyLimitReached: maxPolicySteps > 0n && BigInt(this.policyStep) >= maxPolicySteps,
            simulationLimitReached: transition.simulationTime || (this.kernel.maxSteps !== null && this.kernel.steps >= this.kernel.maxSteps),
        });
        const { terminated, truncated, terminationReason, truncationReason } = outcome;
        this.terminal = terminated || truncated;
        if (this.terminal) this.lifecycleState = "terminal";
        const reward = terms.reduce((total, term) => total + term.weightedValue, 0);
        const info = {
            episodeHash: this.kernel.episodeHash,
            trajectoryHash: this.kernel.trajectoryHash,
            step: this.kernel.steps,
            simulationTimeNs: this.kernel.timeNs,
            rewardTerms: terms,
            terminationReason,
            truncationReason,
            diagnosticJson: new TextEncoder().encode(JSON.stringify({
                advancedSubsteps: substeps,
                requestedActionRepeat: this.episodeSpec.actionRepeat,
            })),
            diagnostics: { advancedSubsteps: substeps, requestedActionRepeat: this.episodeSpec.actionRepeat },
        };
        const result = {
            observation: this.observationBuilder.build({ step: this.kernel.steps, policyStep: this.policyStep, scenario }),
            reward,
            terminated,
            truncated,
            info,
        };
        this.lastResult = result;
        return result;
    }

    finalize(options = {}) {
        if (!this.resolvedRun) throw new HeadlessEpisodeError("ENVIRONMENT_NOT_FOUND", "No prepared episode exists.");
        const result = this.kernel.finalize(options);
        this.lifecycleState = "finalized";
        return result;
    }

    dispose() {
        this.kernel.dispose();
        this.lifecycleState = "disposed";
    }
}
