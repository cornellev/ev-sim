import { getBuiltInVehicleManifest } from "../vehicles/BuiltInVehicleManifests.js";
import {
    distanceXZ,
    finiteNumber,
    normalizeAngle,
    pointFrom,
    vehicleForwardTangent,
    vehicleGroundFootprint,
} from "./route/geometry.js";
import {
    arePointsOnRoadNetwork,
    buildDirectedRoadGraph,
    environmentDocumentFrom,
} from "./route/roadGraph.js";
import {
    projectPoseToRoute,
    routeTangentAtPose,
} from "./route/Route.js";

const EPSILON = 1e-9;

/** Peak absolute longitudinal acceleration above this marks kinematic infeasibility (m/s²). */
export const ACCELERATION_LIMIT_MPS2 = 10.4;
/** Absolute steering curvature above this marks kinematic infeasibility (1/m). */
export const CURVATURE_LIMIT_PER_M = 0.3;
/** Planar speed at or below this suppresses wrong-way evaluation (m/s). */
export const WRONG_WAY_SPEED_THRESHOLD_MPS = 0.05;
/** Default wheelbase used when vehicle / manifest kinematics are unavailable (m). */
export const DEFAULT_WHEELBASE_M = 2.5;

export const SCENARIO_METRIC_IDS = Object.freeze([
    "route-progress",
    "route-progress-ratio",
    "off-road",
    "wrong-way",
    "kinematic-infeasibility",
    "acceleration",
    "jerk",
    "log-divergence",
    "failure",
]);

function clone(value) {
    if (value === undefined) return undefined;
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function vectorComponents(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.x === "number" || typeof value.z === "number" || typeof value.y === "number") {
        return {
            x: finiteNumber(value.x, 0),
            y: finiteNumber(value.y, 0),
            z: finiteNumber(value.z, 0),
        };
    }
    return null;
}

/**
 * Resolve yaw-oriented ground footprint size/center for a vehicle.
 * Prefers live collision/dimensions, then length/width, then built-in vehicle types.
 */
export function resolveVehicleFootprint(vehicle = null, options = {}) {
    const type = String(options.type || vehicle?.type || vehicle?.vehicleManifestId || "").trim();
    const builtIn = type ? getBuiltInVehicleManifest(type) : null;
    const sizeCandidate = vectorComponents(vehicle?.collisionDimensions)
        ?? vectorComponents(vehicle?.dimensions)
        ?? (Number.isFinite(vehicle?.length) && Number.isFinite(vehicle?.width)
            ? { x: vehicle.length, y: finiteNumber(vehicle.height, 1.5), z: vehicle.width }
            : null)
        ?? vectorComponents(options.size)
        ?? vectorComponents(builtIn?.boundingBox?.size);
    if (!sizeCandidate || !(sizeCandidate.x > EPSILON) || !(sizeCandidate.z > EPSILON)) {
        return null;
    }
    const center = vectorComponents(vehicle?.collisionCenter)
        ?? vectorComponents(options.center)
        ?? vectorComponents(builtIn?.boundingBox?.center)
        ?? { x: 0, y: sizeCandidate.y / 2, z: 0 };
    const wheelbase = Math.max(
        Number.EPSILON,
        finiteNumber(
            options.wheelbase
            ?? vehicle?.manifest?.kinematics?.wheelbase
            ?? vehicle?.kinematics?.wheelbase
            ?? vehicle?.wheelbase
            ?? builtIn?.kinematics?.wheelbase,
            DEFAULT_WHEELBASE_M,
        ),
    );
    return {
        size: { x: sizeCandidate.x, y: sizeCandidate.y, z: sizeCandidate.z },
        center: { x: center.x, y: center.y, z: center.z },
        wheelbase,
        type: type || null,
    };
}

/**
 * Normalize keyframe lists from run-manifest vehicles.
 * Accepts ScenarioCar planar frames `{ t, x, y, yaw }` (y = world Z) and pose frames
 * `{ t|time|timeNs, pose: { position, rotation } }`.
 */
export function normalizeReferenceKeyframes(frames = []) {
    const list = Array.isArray(frames) ? frames : [];
    const normalized = [];
    for (let index = 0; index < list.length; index += 1) {
        const frame = list[index];
        if (!frame || typeof frame !== "object") continue;
        let timeSeconds = null;
        if (Number.isFinite(frame.t)) timeSeconds = frame.t;
        else if (Number.isFinite(frame.time)) timeSeconds = frame.time;
        else if (Number.isFinite(frame.timeNs)) timeSeconds = frame.timeNs / 1e9;
        else timeSeconds = index;

        const posePosition = pointFrom(frame.pose?.position ?? frame.position ?? frame.pose);
        const planarY = Number(frame.y);
        const planarX = Number(frame.x);
        let x;
        let z;
        if (posePosition) {
            x = posePosition.x;
            z = posePosition.z;
        } else if (Number.isFinite(planarX) && Number.isFinite(planarY)) {
            // ScenarioCar convention: frame.y is world Z.
            x = planarX;
            z = planarY;
        } else {
            continue;
        }

        const yaw = Number.isFinite(frame.yaw)
            ? frame.yaw
            : Number.isFinite(frame.pose?.rotation?.y)
                ? -finiteNumber(frame.pose.rotation.y)
                : Number.isFinite(frame.rotation?.y)
                    ? -finiteNumber(frame.rotation.y)
                    : 0;

        normalized.push({ t: timeSeconds, x, z, yaw });
    }
    normalized.sort((left, right) => left.t - right.t || left.x - right.x || left.z - right.z);
    return normalized;
}

export function sampleReferenceKeyframe(keyframes, timeSeconds) {
    const frames = Array.isArray(keyframes) ? keyframes : [];
    if (frames.length === 0) return null;
    if (frames.length === 1) {
        return { ...frames[0], covered: true };
    }
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!(timeSeconds + EPSILON >= first.t && timeSeconds - EPSILON <= last.t)) {
        return null;
    }
    if (timeSeconds <= first.t) return { ...first, covered: true };
    if (timeSeconds >= last.t) return { ...last, covered: true };
    for (let index = 1; index < frames.length; index += 1) {
        const prev = frames[index - 1];
        const next = frames[index];
        if (timeSeconds > next.t) continue;
        const span = Math.max(next.t - prev.t, Number.EPSILON);
        const alpha = (timeSeconds - prev.t) / span;
        return {
            t: timeSeconds,
            x: prev.x + (next.x - prev.x) * alpha,
            z: prev.z + (next.z - prev.z) * alpha,
            yaw: prev.yaw + normalizeAngle(next.yaw - prev.yaw) * alpha,
            covered: true,
        };
    }
    return { ...last, covered: true };
}

function emptyCurrent() {
    return {
        "route-progress": null,
        "route-progress-ratio": null,
        "off-road": null,
        "wrong-way": null,
        "kinematic-infeasibility": null,
        acceleration: null,
        jerk: null,
        "log-divergence": null,
        failure: null,
    };
}

function emptyEpisode() {
    return {
        "route-progress": null,
        "route-progress-ratio": null,
        "off-road": null,
        "wrong-way": null,
        "kinematic-infeasibility": null,
        acceleration: null,
        jerk: null,
        "log-divergence": null,
        failure: null,
        sampleCount: 0,
        divergenceSampleCount: 0,
        divergenceSum: 0,
    };
}

/**
 * Pure deterministic ego metric collector. Missing prerequisites yield `null`
 * rather than a false success / zero.
 */
export class ScenarioMetricCollector {
    constructor(options = {}) {
        this._options = { ...options };
        this._route = null;
        this._environment = null;
        this._roadGraph = null;
        this._footprint = null;
        this._keyframes = [];
        this._hasRoadNetwork = false;
        this.reset();
    }

    configure(options = {}) {
        this._options = { ...this._options, ...options };
        this._route = options.route ?? this._route;
        this._environment = options.environment ?? this._environment;
        this._footprint = options.footprint === undefined
            ? this._footprint
            : (options.footprint || null);
        this._keyframes = normalizeReferenceKeyframes(options.keyframes ?? this._keyframes);
        this._roadGraph = null;
        this._hasRoadNetwork = false;
        if (this._environment) {
            const document = environmentDocumentFrom(this._environment);
            this._hasRoadNetwork = (document.roads?.nodes?.length ?? 0) > 0
                && (document.roads?.edges?.length ?? 0) > 0;
            if (this._hasRoadNetwork) {
                this._roadGraph = buildDirectedRoadGraph(this._environment);
            }
        }
        return this;
    }

    observeEgoCollision(value = true) {
        if (value) this._egoCollision = true;
        this._current = {
            ...this._current,
            failure: this._finalizeFailure(),
        };
        this._episode.failure = this._finalizeFailure();
        return this;
    }

    reset() {
        this._prevPose = null;
        this._prevTimeNs = null;
        this._prevSpeed = null;
        this._prevAccel = null;
        this._startAlong = null;
        this._remainingAtStart = null;
        this._routeAvailable = null;
        this._current = emptyCurrent();
        this._episode = emptyEpisode();
        this._everOffRoad = false;
        this._everWrongWay = false;
        this._everKinematicInfeasible = false;
        this._egoCollision = false;
        return this;
    }

    observe({
        timeNs = 0,
        dt = null,
        pose = null,
        velocity = null,
        steeringAngle = null,
        egoCollision = false,
    } = {}) {
        if (egoCollision) this._egoCollision = true;
        const position = pointFrom(pose?.position ?? pose);
        if (!position) {
            this._current = {
                ...emptyCurrent(),
                failure: this._finalizeFailure(),
            };
            this._episode.failure = this._finalizeFailure();
            return this.current();
        }

        const yaw = finiteNumber(pose?.rotation?.y ?? pose?.yaw ?? pose?.rotationY, 0);
        const time = Math.max(0, Math.floor(finiteNumber(timeNs, 0)));
        const timeSeconds = time / 1e9;
        let stepDt = Number.isFinite(dt) && dt > EPSILON
            ? dt
            : (this._prevTimeNs !== null ? Math.max(0, (time - this._prevTimeNs) / 1e9) : null);

        const current = emptyCurrent();
        this._observeRoute(position, current);
        this._observeOffRoad({ position, yaw }, current);
        this._observeWrongWay({ position, yaw, velocity, stepDt }, current);
        this._observeKinematics({
            position,
            yaw,
            velocity,
            steeringAngle,
            stepDt,
        }, current);
        this._observeDivergence({ position, timeSeconds }, current);

        current.failure = this._computeFailure();

        this._mergeEpisode(current);
        this._current = current;
        this._prevPose = { position: { ...position }, yaw };
        this._prevTimeNs = time;
        return this.current();
    }

    _observeRoute(position, current) {
        const route = this._route;
        const totalLength = finiteNumber(route?.totalLength ?? route?.verification?.totalLength, NaN);
        if (!route || !(totalLength >= 0) || !Number.isFinite(totalLength)) {
            this._routeAvailable = false;
            current["route-progress"] = null;
            current["route-progress-ratio"] = null;
            return;
        }
        const projection = projectPoseToRoute(route, position);
        if (!projection) {
            this._routeAvailable = false;
            current["route-progress"] = null;
            current["route-progress-ratio"] = null;
            return;
        }
        this._routeAvailable = true;
        if (this._startAlong === null) {
            this._startAlong = projection.distanceAlong;
            this._remainingAtStart = Math.max(0, totalLength - this._startAlong);
        }
        const progress = Math.max(0, projection.distanceAlong - this._startAlong);
        current["route-progress"] = progress;
        current["route-progress-ratio"] = this._remainingAtStart > EPSILON
            ? progress / this._remainingAtStart
            : null;
    }

    _observeOffRoad(pose, current) {
        if (!this._hasRoadNetwork || !this._roadGraph) {
            current["off-road"] = null;
            return;
        }
        if (!this._footprint) {
            current["off-road"] = null;
            return;
        }
        const corners = vehicleGroundFootprint(pose, this._footprint.size, this._footprint.center);
        if (!corners) {
            current["off-road"] = null;
            return;
        }
        const onRoad = arePointsOnRoadNetwork(corners, this._environment, { graph: this._roadGraph });
        current["off-road"] = onRoad ? 0 : 1;
        if (!onRoad) this._everOffRoad = true;
    }

    _observeWrongWay({ position, yaw, velocity, stepDt }, current) {
        if (this._routeAvailable === false || !this._route) {
            current["wrong-way"] = null;
            return;
        }
        const tangentInfo = routeTangentAtPose(this._route, position);
        if (!tangentInfo?.tangent) {
            current["wrong-way"] = null;
            return;
        }

        let motionX = 0;
        let motionZ = 0;
        let speed = 0;
        if (this._prevPose && stepDt !== null && stepDt > EPSILON) {
            motionX = position.x - this._prevPose.position.x;
            motionZ = position.z - this._prevPose.position.z;
            speed = Math.hypot(motionX, motionZ) / stepDt;
        } else if (velocity && Number.isFinite(velocity.x)) {
            const tangent = vehicleForwardTangent(yaw);
            speed = Math.abs(finiteNumber(velocity.x));
            motionX = tangent.x * finiteNumber(velocity.x);
            motionZ = tangent.z * finiteNumber(velocity.x);
        }

        if (!(speed > WRONG_WAY_SPEED_THRESHOLD_MPS)) {
            current["wrong-way"] = 0;
            return;
        }

        const motionLength = Math.hypot(motionX, motionZ);
        if (!(motionLength > EPSILON)) {
            current["wrong-way"] = 0;
            return;
        }
        const motionDir = { x: motionX / motionLength, z: motionZ / motionLength };
        const alignment = motionDir.x * tangentInfo.tangent.x + motionDir.z * tangentInfo.tangent.z;
        const wrongWay = alignment < -EPSILON;
        current["wrong-way"] = wrongWay ? 1 : 0;
        if (wrongWay) this._everWrongWay = true;
    }

    _observeKinematics({ position, yaw, velocity, steeringAngle, stepDt }, current) {
        let speed = null;
        if (this._prevPose && stepDt !== null && stepDt > EPSILON) {
            const dx = position.x - this._prevPose.position.x;
            const dz = position.z - this._prevPose.position.z;
            const distance = Math.hypot(dx, dz);
            const forward = vehicleForwardTangent(this._prevPose.yaw);
            const signed = distance <= EPSILON
                ? 0
                : ((dx / distance) * forward.x + (dz / distance) * forward.z) * distance;
            speed = signed / stepDt;
        } else if (velocity && Number.isFinite(velocity.x)) {
            speed = finiteNumber(velocity.x);
        }

        let acceleration = null;
        let jerk = null;
        if (speed !== null && this._prevSpeed !== null && stepDt !== null && stepDt > EPSILON) {
            acceleration = (speed - this._prevSpeed) / stepDt;
            if (this._prevAccel !== null) {
                jerk = (acceleration - this._prevAccel) / stepDt;
            }
        }

        let curvature = null;
        const wheelbase = Math.max(
            Number.EPSILON,
            finiteNumber(this._footprint?.wheelbase, DEFAULT_WHEELBASE_M),
        );
        if (Number.isFinite(steeringAngle)) {
            curvature = Math.tan(finiteNumber(steeringAngle)) / wheelbase;
        } else if (this._prevPose && stepDt !== null && stepDt > EPSILON) {
            const distance = distanceXZ(position, this._prevPose.position);
            if (distance > EPSILON) {
                const dYaw = normalizeAngle(yaw - this._prevPose.yaw);
                // Vehicle yaw is opposite of travel heading atan2(dx,dz); absolute curvature matches.
                curvature = Math.abs(dYaw) / distance;
            } else {
                curvature = 0;
            }
        }

        current.acceleration = acceleration === null ? null : Math.abs(acceleration);
        current.jerk = jerk === null ? null : Math.abs(jerk);

        let infeasible = null;
        if (acceleration !== null || curvature !== null) {
            infeasible = 0;
            if (acceleration !== null && Math.abs(acceleration) > ACCELERATION_LIMIT_MPS2 + EPSILON) {
                infeasible = 1;
            }
            if (curvature !== null && Math.abs(curvature) > CURVATURE_LIMIT_PER_M + EPSILON) {
                infeasible = 1;
            }
        }
        current["kinematic-infeasibility"] = infeasible;
        if (infeasible === 1) this._everKinematicInfeasible = true;

        if (speed !== null) this._prevSpeed = speed;
        if (acceleration !== null) this._prevAccel = acceleration;
    }

    _observeDivergence({ position, timeSeconds }, current) {
        if (!this._keyframes.length) {
            current["log-divergence"] = null;
            return;
        }
        const sample = sampleReferenceKeyframe(this._keyframes, timeSeconds);
        if (!sample) {
            current["log-divergence"] = null;
            return;
        }
        current["log-divergence"] = distanceXZ(position, { x: sample.x, z: sample.z });
    }

    _computeFailure() {
        return this._finalizeFailure();
    }

    _mergeEpisode(current) {
        const episode = this._episode;
        episode.sampleCount += 1;

        if (current["route-progress"] !== null) {
            episode["route-progress"] = episode["route-progress"] === null
                ? current["route-progress"]
                : Math.max(episode["route-progress"], current["route-progress"]);
        }
        if (current["route-progress-ratio"] !== null) {
            episode["route-progress-ratio"] = episode["route-progress-ratio"] === null
                ? current["route-progress-ratio"]
                : Math.max(episode["route-progress-ratio"], current["route-progress-ratio"]);
        }

        if (this._routeAvailable === false) {
            episode["route-progress"] = null;
            episode["route-progress-ratio"] = null;
            episode["wrong-way"] = null;
        } else if (this._routeAvailable === true) {
            episode["wrong-way"] = this._everWrongWay ? 1 : 0;
        }

        if (current["off-road"] !== null || this._everOffRoad) {
            episode["off-road"] = this._everOffRoad ? 1 : 0;
        }

        if (current["kinematic-infeasibility"] !== null || this._everKinematicInfeasible) {
            episode["kinematic-infeasibility"] = this._everKinematicInfeasible ? 1 : 0;
        }

        if (current.acceleration !== null) {
            episode.acceleration = episode.acceleration === null
                ? current.acceleration
                : Math.max(episode.acceleration, current.acceleration);
        }
        if (current.jerk !== null) {
            episode.jerk = episode.jerk === null
                ? current.jerk
                : Math.max(episode.jerk, current.jerk);
        }

        if (current["log-divergence"] !== null) {
            episode.divergenceSampleCount += 1;
            episode.divergenceSum += current["log-divergence"];
            episode["log-divergence"] = episode.divergenceSum / episode.divergenceSampleCount;
        }

        episode.failure = this._finalizeFailure();
    }

    _finalizeFailure() {
        // Collision alone can force failure. Without a road/footprint prerequisite,
        // a non-colliding run cannot claim success (off-road is unknown → null).
        if (this._egoCollision) return 1;
        if (!(this._hasRoadNetwork && this._footprint)) return null;
        return this._everOffRoad ? 1 : 0;
    }

    current() {
        return clone(this._current);
    }

    episode() {
        return {
            "route-progress": this._episode["route-progress"],
            "route-progress-ratio": this._episode["route-progress-ratio"],
            "off-road": this._episode["off-road"],
            "wrong-way": this._episode["wrong-way"],
            "kinematic-infeasibility": this._episode["kinematic-infeasibility"],
            acceleration: this._episode.acceleration,
            jerk: this._episode.jerk,
            "log-divergence": this._episode["log-divergence"],
            failure: this._finalizeFailure(),
        };
    }

    finalize() {
        return clone(this.episode());
    }

    snapshot() {
        return {
            current: this.current(),
            episode: this.episode(),
            sampleCount: this._episode.sampleCount,
            startAlong: this._startAlong,
            remainingAtStart: this._remainingAtStart,
            egoCollision: this._egoCollision,
            everOffRoad: this._everOffRoad,
            everWrongWay: this._everWrongWay,
            everKinematicInfeasible: this._everKinematicInfeasible,
        };
    }
}

export function createScenarioMetricCollector(options) {
    return new ScenarioMetricCollector(options);
}
