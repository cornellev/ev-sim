import * as THREE from "three";

import { LiDAR3d } from "./LiDAR3d.js";
import { SensorPublisher } from "./SensorPublisher.js";
import { buildPointCloud2, buildSemanticPointCloud2 } from "./SensorMessages.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";
import { getSharedPerceptionTruthIndex } from "../../autonomy/PerceptionTruthIndex.js";

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

export class ManifestLidar3d extends LiDAR3d {
    constructor(config, options = {}) {
        const calibration = config.calibration;
        const threePose = rep103PoseToThree(config.pose);
        super(
            new THREE.Vector3(threePose.position.x, threePose.position.y, threePose.position.z),
            new THREE.Euler(threePose.rotation.x, threePose.rotation.y, threePose.rotation.z, threePose.rotation.order || "XYZ"),
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
        this.transformRuntime = options.transformRuntime ?? null;
        this.calibrationHash = options.calibrationHash ?? null;
        this.contractPublisher = new SensorPublisher(this, config, options);
        this.manifestManaged = true;
        this.captureContext = null;
        this.captureMessages = [];
        this.truthIndex = options.perceptionTruthIndex ?? null;
        this.gpuCapture = true;
        this._issuedCapture = null;
    }

    captureAt(context) {
        const data = this.getParent?.()?.getParent?.();
        const vehicles = data?.vehicles?.()?.vehicles || [];
        const frameResolution = this.transformRuntime?.resolveCaptureFrames?.(this.config, vehicles, context.captureTimeNs);
        const asyncRead = this.shader?.usesAsyncReadback;

        if (asyncRead) {
            this.captureContext = this._issuedCapture;
            this.captureMessages = [];
            const ready = this.shader.completePending();
            if (!ready) {
                this.contractPublisher?.recordShaderBusy?.(context.sampleIndex);
                this.captureContext = null;
                return { messages: [], captureTimeNs: context.captureTimeNs, sampleIndex: context.sampleIndex };
            }
            const delivered = this.captureMessages.slice();
            const issued = this._issuedCapture;
            this.captureContext = null;
            this._issuedCapture = null;
            this.captureMessages = [];

            if (frameResolution && frameResolution.ok === false) {
                this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
                return {
                    messages: delivered,
                    captureTimeNs: issued?.captureTimeNs ?? context.captureTimeNs,
                    sampleIndex: issued?.sampleIndex ?? context.sampleIndex,
                    rng: issued?.rng,
                };
            }
            if (this.config.noise.dropoutProbability > 0 && context.rng.next() < this.config.noise.dropoutProbability) {
                this.contractPublisher?.recordFrameDrop?.("lidar-frame-dropout", context.sampleIndex);
                return {
                    messages: delivered,
                    captureTimeNs: issued?.captureTimeNs ?? context.captureTimeNs,
                    sampleIndex: issued?.sampleIndex ?? context.sampleIndex,
                    rng: issued?.rng,
                };
            }
            this.truthIndex ||= getSharedPerceptionTruthIndex(data);
            this.truthIndex.refresh({
                scene: data?.scene,
                vehicles,
                environmentRegistry: data?.environment?.()?.objects?.(),
            });
            this.captureContext = context;
            const rendered = super.execute(context.captureTimeNs / 1e9);
            if (this.captureMessages.length) {
                const syncMessages = this.captureMessages;
                this.captureContext = null;
                return {
                    messages: syncMessages,
                    captureTimeNs: context.captureTimeNs,
                    sampleIndex: context.sampleIndex,
                    rng: context.rng,
                };
            }
            this.captureContext = null;
            if (!rendered) {
                this.contractPublisher?.recordShaderBusy?.(context.sampleIndex);
            } else {
                this._issuedCapture = context;
            }
            return {
                messages: delivered,
                captureTimeNs: issued?.captureTimeNs ?? context.captureTimeNs,
                sampleIndex: issued?.sampleIndex ?? context.sampleIndex,
                rng: issued?.rng,
            };
        }

        if (frameResolution && frameResolution.ok === false) {
            this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
            return [];
        }
        if (this.config.noise.dropoutProbability > 0 && context.rng.next() < this.config.noise.dropoutProbability) {
            this.contractPublisher?.recordFrameDrop?.("lidar-frame-dropout", context.sampleIndex);
            return [];
        }
        this.truthIndex ||= getSharedPerceptionTruthIndex(data);
        this.truthIndex.refresh({
            scene: data?.scene,
            vehicles,
            environmentRegistry: data?.environment?.()?.objects?.(),
        });
        this.captureContext = context;
        this.captureMessages = [];
        const rendered = super.execute(context.captureTimeNs / 1e9);
        if (!rendered) {
            this.contractPublisher?.recordShaderBusy?.(context.sampleIndex);
        }
        this.captureContext = null;
        return this.captureMessages;
    }

    onShaderUpdate(buffer) {
        super.onShaderUpdate(buffer);
        if (!this.captureContext) return;
        const { captureTimeNs, rng } = this.captureContext;
        const noise = this.config.noise;
        const products = this.config.calibration.products || {};
        const frameId = this.config.measurementFrameId || this.config.frameId;
        if (products.pointCloud === true && this.config.outputs.pointCloudTopicId) {
            let pointDrops = 0;
            const hasRangeNoise = Number(noise.bias) !== 0
                || (noise.model === "gaussian" && Number(noise.standardDeviation) > 0);
            const hasPointDropout = Number(noise.pointDropoutProbability) > 0;
            const pointCloud = buildPointCloud2({
                buffer,
                bufferEncoding: "metric-v2",
                calibration: this.config.calibration,
                timeNs: captureTimeNs,
                frameId,
                ...(hasRangeNoise ? {
                    sampleRange: (range) => range + noise.bias + (noise.model === "gaussian" ? gaussian(rng) * noise.standardDeviation : 0),
                } : {}),
                ...(hasPointDropout ? {
                    shouldDrop: () => rng.next() < noise.pointDropoutProbability,
                    onPointDrop: () => { pointDrops += 1; },
                } : {}),
            });
            this.contractPublisher?.recordPointDrops?.(pointDrops);
            this.captureMessages.push({
                topicId: this.config.outputs.pointCloudTopicId,
                signal: "pointCloud",
                frameId,
                value: pointCloud,
            });
        }
        if (products.semanticPointCloud === true && this.config.outputs.semanticPointCloudTopicId) {
            this.captureMessages.push({
                topicId: this.config.outputs.semanticPointCloudTopicId,
                signal: "semanticPointCloud",
                frameId,
                value: buildSemanticPointCloud2({
                    buffer,
                    bufferEncoding: "metric-v2",
                    calibration: this.config.calibration,
                    timeNs: captureTimeNs,
                    frameId,
                }),
            });
        }
    }

    resetRunState() {
        this._issuedCapture = null;
        this.captureContext = null;
        this.captureMessages = [];
        this.shader?.reset?.();
    }

    dispose() {
        this._issuedCapture = null;
        this.captureContext = null;
        this.captureMessages = [];
        this.contractPublisher?.dispose?.();
        super.dispose();
    }
}
