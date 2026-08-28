import { buildOdometryMessage } from "../3d/devices/SensorMessages.js";
import {
    buildTruthOdometry,
    captureVehicleSnapshot,
} from "../autonomy/LocalizationMeasurements.js";

export class LocalizationTruthPublisher {
    constructor(options = {}) {
        this.topicRouter = options.topicRouter ?? null;
        this.frames = options.frames ?? {};
        this.vehicleId = options.vehicleId || "ego";
        this.lastSnapshot = null;
    }

    publish(timeNs, step, vehicles = []) {
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === this.vehicleId) || vehicles[0];
        if (!vehicle) return null;

        const snapshot = captureVehicleSnapshot(
            vehicle,
            timeNs,
            this.lastSnapshot,
            optionsStepNs(this),
        );
        this.lastSnapshot = snapshot;

        const truth = buildTruthOdometry(snapshot, this.frames);
        const payload = buildOdometryMessage({
            timeNs,
            frameId: truth.headerFrameId,
            childFrameId: truth.childFrameId,
            position: truth.position,
            orientation: truth.orientation,
            linearVelocity: truth.linearVelocity,
            angularVelocity: truth.angularVelocity,
            poseCovariance: truth.poseCovariance,
            twistCovariance: truth.twistCovariance,
        });

        this.topicRouter?.routeOutbound?.("truth-odometry", {
            value: payload,
            typeStr: "nav_msgs/Odometry",
        }, {
            producer: "oracle",
            captureTimeNs: timeNs,
            deliveryTimeNs: timeNs,
            cycle: step,
            logClass: "standard",
            frameId: truth.headerFrameId,
        });

        return payload;
    }

    reset() {
        this.lastSnapshot = null;
    }
}

function optionsStepNs(publisher) {
    return Number(publisher.stepNs || 16_666_667);
}

export function createLocalizationTruthPublisher(manifest, topicRouter) {
    const sensorRig = manifest?.sensorRig || {};
    return new LocalizationTruthPublisher({
        topicRouter,
        frames: {
            map: sensorRig.mapFrameId || "map",
            odom: sensorRig.odomFrameId || "odom",
            baseLink: sensorRig.rootFrameId || "base_link",
        },
        vehicleId: sensorRig.vehicleId || "ego",
    });
}
