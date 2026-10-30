import {
    eulerToQuaternion,
    threeEulerToRep103,
    threeToRep103Vector,
} from "../autonomy/CoordinateFrames.js";
import { topicSignalPath } from "../scripting/runtime/SignalPaths.js";

export const GOAL_TOPIC = "/goal";
export const GOAL_MESSAGE_TYPE = "geometry_msgs/Pose";

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
        this.client = options.client ?? null;
        this.resolvedRun = options.resolvedRun ?? null;
    }

    publish(timeNs = 0) {
        const pose = scenarioGoalPose(this.resolvedRun);
        if (!pose) return null;
        const declared = this.topicRouter?.getTopic?.(GOAL_TOPIC) ?? null;
        if (declared && declared.name === GOAL_TOPIC) {
            if (!isPoseGoalOutput(declared)) return null;
            this.topicRouter.routeOutbound(declared.id || declared.name, {
                value: pose,
                typeStr: GOAL_MESSAGE_TYPE,
            }, {
                captureTimeNs: timeNs,
                deliveryTimeNs: timeNs,
                cycle: 0,
                logClass: "standard",
            });
        } else {
            this.telemetry?.publishSignal?.(topicSignalPath(GOAL_TOPIC), pose, {
                timeUs: Math.round(Number(timeNs) / 1000),
                cycle: 0,
                source: "oracle",
                type: "json",
                category: "topics",
                replayRole: "derived",
                logClass: "standard",
                descriptorMetadata: {
                    rosType: GOAL_MESSAGE_TYPE,
                    topic: GOAL_TOPIC,
                },
            });
        }
        if (this.client?.isOpen?.()) {
            this.client.publish(GOAL_TOPIC, GOAL_MESSAGE_TYPE, pose).catch?.(() => {});
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
    const type = topic?.schema?.type || topic?.type;
    return topic?.direction === "output" && type === GOAL_MESSAGE_TYPE;
}
