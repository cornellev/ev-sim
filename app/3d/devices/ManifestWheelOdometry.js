import * as THREE from "three";

import Device from "./Device.js";
import { SensorPublisher } from "./SensorPublisher.js";
import { buildOdometryMessage } from "./SensorMessages.js";
import {
    buildWheelOdometryMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
    stateSensorSampleDropped,
} from "../../autonomy/LocalizationMeasurements.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";

export class ManifestWheelOdometry extends Device {
    constructor(config, options = {}) {
        const threePose = rep103PoseToThree(config.pose);
        super("Manifest Wheel Odometry", {
            telemetryId: config.id,
            position: new THREE.Vector3(threePose.position.x, threePose.position.y, threePose.position.z),
            rotation: new THREE.Euler(threePose.rotation.x, threePose.rotation.y, threePose.rotation.z, threePose.rotation.order || "XYZ"),
        });
        this.telemetryId = config.id;
        this.config = config;
        this.transformRuntime = options.transformRuntime ?? null;
        this.calibrationHash = options.calibrationHash ?? null;
        this.contractPublisher = new SensorPublisher(this, config, options);
        this.manifestManaged = true;
        this.measurementState = null;
    }

    resetMeasurementState(seedRng) {
        this.measurementState = createMeasurementSeedState(this.config, seedRng);
    }

    captureAt({ captureTimeNs, sampleIndex, rng }) {
        const data = this.getParent()?.getParent?.();
        const vehicles = data?.vehicles?.()?.vehicles || [];
        const frameResolution = this.transformRuntime?.resolveCaptureFrames?.(this.config, vehicles, captureTimeNs);
        if (frameResolution && frameResolution.ok === false) {
            this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
            return [];
        }
        const vehicle = vehicles.find((entry) => (entry.telemetryId || entry.id) === this.config.parentId) || vehicles[0];
        if (!vehicle) return [];

        if (!this.measurementState) {
            this.resetMeasurementState(rng);
        }

        const snapshot = captureVehicleSnapshot(
            vehicle,
            captureTimeNs,
            this.measurementState.vehicleSnapshot,
            this.contractPublisher?.stepNs || 16_666_667,
        );
        this.measurementState.vehicleSnapshot = snapshot;

        const { measurement, nextState } = buildWheelOdometryMeasurement(snapshot, this.config, rng, this.measurementState);
        this.measurementState = { ...this.measurementState, ...nextState };

        if (stateSensorSampleDropped(this.config, rng)) {
            this.contractPublisher?._event?.("sample-dropped", "warning", { sampleIndex, reason: "wheel-odometry-dropout" });
            return [];
        }

        const frameId = this.config.calibration.odomFrameId || "odom";
        return [{
            topicId: this.config.outputs.odometryTopicId,
            signal: "odometry",
            frameId,
            value: buildOdometryMessage({
                timeNs: captureTimeNs,
                frameId,
                childFrameId: measurement.childFrameId,
                position: measurement.position,
                orientation: measurement.orientation,
                linearVelocity: measurement.linearVelocity,
                angularVelocity: measurement.angularVelocity,
                poseCovariance: measurement.poseCovariance,
                twistCovariance: measurement.twistCovariance,
            }),
        }];
    }
}
