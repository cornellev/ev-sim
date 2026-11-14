import {
    eulerToQuaternion,
    threeEulerToRep103,
    threeToRep103Vector,
} from "../autonomy/CoordinateFrames.js";

export const GOAL_TOPIC = "/goal";

const IDENTITY_ORIENTATION = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/**
 * Map-frame pose of the attached scenario's final waypoint.
 * Returns null when the run has no scenario route to publish.
 */
export function scenarioGoalPose(resolvedRun) {
    const routes = resolvedRun?.scenario?.scenario?.routes;
    if (!Array.isArray(routes) || routes.length === 0) return null;
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const route = routes.find((entry) => entry?.actorId === egoId) ?? routes[0];
    const waypoints = route?.waypoints;
    if (!Array.isArray(waypoints) || waypoints.length === 0) return null;
    const position = waypointPosition(waypoints.at(-1));
    if (!position) return null;
    return {
        position: threeToRep103Vector(position),
        orientation: orientationFromArrival(route, position),
    };
}

export class GoalPublisher {
    constructor(options = {}) {
        this.topicRouter = options.topicRouter ?? null;
        this.telemetry = options.telemetry ?? null;
        this.resolvedRun = options.resolvedRun ?? null;
    }

    publish(timeNs = 0) {
        const pose = scenarioGoalPose(this.resolvedRun);
        if (!pose) return null;
        const goalTopic = this.resolvedRun.manifest.topics.find((topic) => topic.valueContract?.id === "cev.goal" && topic.direction === "output");
        const declared = this.topicRouter?.getTopic?.(goalTopic?.id ?? GOAL_TOPIC) ?? null;
        const value = { pose };
        if (declared) {
            if (!isPoseGoalOutput(declared)) return null;
            this.topicRouter.routeOutbound(declared.id || declared.name, {
                value,
                ...({ valueContract: declared.valueContract }),
            }, {
                captureTimeNs: timeNs,
                ...({ simTimeNs: timeNs, frameId: this.resolvedRun.calibration?.frames?.map ?? "map", sequenceId: "0", actualDeliveryStep: 0 }),
                deliveryTimeNs: timeNs,
                cycle: 0,
                logClass: "standard",
            });
        }
        return pose;
    }
}

function waypointPosition(waypoint) {
    const position = waypoint?.position;
    if (!position || typeof position !== "object") return null;
    return {
        x: Number(position.x) || 0,
        y: Number(position.y) || 0,
        z: Number(position.z) || 0,
    };
}

function orientationFromArrival(route, position) {
    const polyline = route?.verification?.polyline;
    const previous = Array.isArray(polyline) ? polyline.at(-2) : null;
    const previousX = Number(previous?.x);
    const previousZ = Number(previous?.z);
    if (!Number.isFinite(previousX) || !Number.isFinite(previousZ)) return { ...IDENTITY_ORIENTATION };
    const yaw = Math.atan2(-(position.z - previousZ), position.x - previousX);
    return eulerToQuaternion(threeEulerToRep103({ x: 0, y: yaw, z: 0 }));
}

function isPoseGoalOutput(topic) {
    return topic?.direction === "output" && topic?.valueContract?.id === "cev.goal";
}
