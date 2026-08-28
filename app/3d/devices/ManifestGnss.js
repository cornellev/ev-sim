import * as THREE from "three";

import Device from "./Device.js";
import { SensorPublisher } from "./SensorPublisher.js";
import { buildNavSatFixMessage } from "./SensorMessages.js";
import {
    buildGnssMeasurement,
    captureVehicleSnapshot,
    createMeasurementSeedState,
} from "../../autonomy/LocalizationMeasurements.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";

export class ManifestGnss extends Device {
    constructor(config, options = {}) {
        const threePose = rep103PoseToThree(config.pose);
        super("Manifest GNSS", {
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

        const { measurement, nextState } = buildGnssMeasurement(snapshot, this.config, rng, this.measurementState);
        this.measurementState = { ...this.measurementState, ...nextState };

        if (nextState.dropped) {
            this.contractPublisher?._event?.("sample-dropped", "warning", { sampleIndex, reason: "gnss-dropout" });
            return [];
        }
        if (measurement?.noFix) {
            this.contractPublisher?._event?.("gnss-outage", "warning", { sampleIndex });
        }

        const frameId = this.config.measurementFrameId || this.config.frameId;
        const fix = measurement.noFix
            ? buildNavSatFixMessage({
                timeNs: captureTimeNs,
                frameId,
                status: -1,
                service: measurement.service,
                latitude: 0,
                longitude: 0,
                altitude: 0,
                positionCovariance: measurement.positionCovariance,
                positionCovarianceType: 0,
            })
            : buildNavSatFixMessage({
                timeNs: captureTimeNs,
                frameId,
                status: measurement.status,
                service: measurement.service,
                latitude: measurement.latitude,
                longitude: measurement.longitude,
                altitude: measurement.altitude,
                positionCovariance: measurement.positionCovariance,
                positionCovarianceType: measurement.positionCovarianceType,
            });

        return [{
            topicId: this.config.outputs.gnssTopicId,
            signal: "gnss",
            frameId,
            value: fix,
        }];
    }
}
