import * as THREE from "three";

import { LiDAR3d } from "./LiDAR3d.js";
import { SensorPublisher } from "./SensorPublisher.js";
import { buildPointCloud2 } from "./SensorMessages.js";

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

export class ManifestLidar3d extends LiDAR3d {
    constructor(config, options = {}) {
        const calibration = config.calibration;
        super(
            new THREE.Vector3(config.pose.position.x, config.pose.position.y, config.pose.position.z),
            new THREE.Euler(config.pose.rotation.x, config.pose.rotation.y, config.pose.rotation.z, config.pose.rotation.order || "XYZ"),
            calibration.range,
            calibration.azimuth.stepDeg,
            [calibration.azimuth.startDeg, calibration.azimuth.endDeg],
            calibration.elevation.stepDeg,
            [calibration.elevation.startDeg, calibration.elevation.endDeg],
        );
        this.name = "Manifest LiDAR 3D";
        this.telemetryId = config.id;
        this.settings.telemetryId = config.id;
        this.config = config;
        this.contractPublisher = new SensorPublisher(this, config, options);
        this.manifestManaged = true;
        this.captureContext = null;
        this.captureMessages = [];
    }

    captureAt(context) {
        this.captureContext = context;
        this.captureMessages = [];
        super.execute(context.captureTimeNs / 1e9);
        this.captureContext = null;
        return this.captureMessages;
    }

    onShaderUpdate(buffer) {
        super.onShaderUpdate(buffer);
        if (!this.captureContext) return;
        const { captureTimeNs, rng } = this.captureContext;
        const noise = this.config.noise;
        const pointCloud = buildPointCloud2({
            buffer,
            calibration: this.config.calibration,
            timeNs: captureTimeNs,
            frameId: this.config.frameId,
            sampleRange: (range) => range + noise.bias + (noise.model === "gaussian" ? gaussian(rng) * noise.standardDeviation : 0),
            shouldDrop: () => noise.dropoutProbability > 0 && rng.next() < noise.dropoutProbability,
        });
        this.captureMessages.push({ topicId: this.config.outputs.pointCloudTopicId, signal: "pointCloud", value: pointCloud });
    }
}
