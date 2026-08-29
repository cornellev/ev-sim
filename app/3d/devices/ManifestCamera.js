import * as THREE from "three";

import Device from "./Device.js";
import { SensorPublisher } from "./SensorPublisher.js";
import {
    buildCameraInfo,
    buildDetection2DArray,
    buildDetection3DArray,
    buildImageMessage,
    buildStampedLanes,
    buildTrafficControlStates,
} from "./SensorMessages.js";
import { rep103PoseToThree, threeCameraLookAlongMountForwardEuler } from "../../autonomy/CoordinateFrames.js";
import {
    CameraRenderProducts,
    projectTruthBoundsToImage,
    warpBrownConrady,
} from "../perception/CameraRenderProducts.js";
import { getSharedPerceptionTruthIndex } from "../../autonomy/PerceptionTruthIndex.js";

function gaussian(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

export class ManifestCamera extends Device {
    constructor(config, options = {}) {
        const threePose = rep103PoseToThree(config.pose);
        super("Manifest Camera", {
            telemetryId: config.id,
            position: new THREE.Vector3(threePose.position.x, threePose.position.y, threePose.position.z),
            rotation: new THREE.Euler(threePose.rotation.x, threePose.rotation.y, threePose.rotation.z, threePose.rotation.order || "XYZ"),
        });
        this.telemetryId = config.id;
        this.config = config;
        this.transformRuntime = options.transformRuntime ?? null;
        this.calibrationHash = options.calibrationHash ?? null;
        this.contractPublisher = new SensorPublisher(this, config, options);
        this.sensorCamera = null;
        this.renderProducts = null;
        this.truthIndex = options.perceptionTruthIndex ?? null;
        const look = threeCameraLookAlongMountForwardEuler();
        this.opticalQuaternion = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(look.x, look.y, look.z, look.order),
        );
        this.manifestManaged = true;
        this.gpuCapture = true;
        this._issuedCapture = null;
    }

    setup(scene) {
        const calibration = this.config.calibration;
        this.sensorCamera = new THREE.PerspectiveCamera(
            calibration.verticalFovDeg,
            calibration.width / calibration.height,
            calibration.near,
            calibration.far,
        );
        scene.add(this.sensorCamera);
        const data = this.getParent()?.getParent?.();
        this.renderProducts = new CameraRenderProducts({
            renderer: data?.renderer,
            scene,
            camera: this.sensorCamera,
            width: calibration.width,
            height: calibration.height,
            near: calibration.near,
            far: calibration.far,
        });
    }

    _enabledProducts() {
        const products = this.config.calibration.products || {};
        const outputs = this.config.outputs || {};
        return {
            rgb: products.rgb === true && Boolean(outputs.imageTopicId),
            depth: products.depth === true && Boolean(outputs.depthTopicId),
            semantic: products.semantic === true && Boolean(outputs.semanticTopicId),
            instance: products.instance === true && Boolean(outputs.instanceTopicId),
        };
    }

    _applyPose() {
        this.sensorCamera.position.copy(this.getPosition());
        const mountQuaternion = new THREE.Quaternion().setFromEuler(this.getRotation());
        this.sensorCamera.quaternion.copy(mountQuaternion.multiply(this.opticalQuaternion));
        this.sensorCamera.updateMatrixWorld(true);
    }

    _refreshTruth(data, scene, vehicles) {
        this.truthIndex ||= getSharedPerceptionTruthIndex(data);
        return this.truthIndex.refresh({
            scene,
            vehicles,
            environmentRegistry: data?.environment?.()?.objects?.(),
        });
    }

    _buildMessages(stamp, captured) {
        const { captureTimeNs, sampleIndex, rng } = stamp;
        const noise = this.config.noise;
        const frameId = this.config.measurementFrameId || this.config.frameId;
        // World AABBs / lane polylines are map geometry. Stamping them as the
        // camera optical frame makes overlay TF treat map meters as optical
        // and scatter boxes into the void.
        const mapFrameId = this.transformRuntime?.frames?.map
            || this.transformRuntime?.bundle?.frames?.map
            || "map";
        const calibration = this.config.calibration;
        const products = calibration.products || {};
        const outputs = this.config.outputs || {};
        const warp = (pixels, channels, interpolation) => warpBrownConrady({
            data: pixels,
            width: calibration.width,
            height: calibration.height,
            intrinsics: calibration.intrinsics,
            distortion: calibration.distortion,
            channels,
            interpolation,
        });
        const pixels = captured.rgb ? warp(captured.rgb, 4, "linear") : null;
        if (pixels && (noise.model === "gaussian" || noise.bias !== 0)) {
            for (let offset = 0; offset < pixels.length; offset += 4) {
                for (let channel = 0; channel < 3; channel += 1) {
                    const perturbation = noise.bias + (noise.model === "gaussian" ? gaussian(rng) * noise.standardDeviation : 0);
                    pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(pixels[offset + channel] + perturbation)));
                }
            }
        }
        const truth = stamp.truth || [];
        const imageDetections = stamp.imageDetections || projectTruthBoundsToImage(
            truth.filter((record) => record.visible && record.semanticId !== 0),
            this.sensorCamera,
            calibration.width,
            calibration.height,
        );
        const stepNs = this.contractPublisher?.stepNs || this.contractPublisher?.manifestStepNs || 16_666_667;
        const syncGroupKey = this.config.syncGroupId
            ? `${this.config.syncGroupId}:${Math.round(captureTimeNs / stepNs)}`
            : "";
        const sequence = Number(sampleIndex || 0);
        const messages = [];
        if (pixels && outputs.imageTopicId) {
            messages.push({
                topicId: outputs.imageTopicId,
                signal: "image",
                frameId,
                value: buildImageMessage({
                    data: pixels,
                    width: calibration.width,
                    height: calibration.height,
                    timeNs: captureTimeNs,
                    frameId,
                    encoding: calibration.encoding,
                }),
            });
        }
        if (products.cameraInfo === true && outputs.cameraInfoTopicId) {
            messages.push({
                topicId: outputs.cameraInfoTopicId,
                signal: "cameraInfo",
                frameId,
                value: buildCameraInfo({
                    ...calibration,
                    timeNs: captureTimeNs,
                    frameId,
                }),
            });
        }
        if (captured.depth && outputs.depthTopicId) {
            messages.push({
                topicId: outputs.depthTopicId,
                signal: "depth",
                frameId,
                value: buildImageMessage({
                    data: warp(captured.depth, 1, "nearest"),
                    width: calibration.width,
                    height: calibration.height,
                    timeNs: captureTimeNs,
                    frameId,
                    encoding: "32FC1",
                }),
            });
        }
        if (captured.semantic && outputs.semanticTopicId) {
            messages.push({
                topicId: outputs.semanticTopicId,
                signal: "semantic",
                frameId,
                value: buildImageMessage({
                    data: warp(captured.semantic, 1, "nearest"),
                    width: calibration.width,
                    height: calibration.height,
                    timeNs: captureTimeNs,
                    frameId,
                    encoding: "16UC1",
                }),
            });
        }
        if (captured.instance && outputs.instanceTopicId) {
            messages.push({
                topicId: outputs.instanceTopicId,
                signal: "instance",
                frameId,
                value: buildImageMessage({
                    data: new Int32Array(warp(captured.instance, 1, "nearest")),
                    width: calibration.width,
                    height: calibration.height,
                    timeNs: captureTimeNs,
                    frameId,
                    encoding: "32SC1",
                }),
            });
        }
        if (products.detections2d === true && outputs.detections2dTopicId) {
            messages.push({
                topicId: outputs.detections2dTopicId,
                signal: "detections2d",
                frameId,
                value: buildDetection2DArray({ detections: imageDetections, timeNs: captureTimeNs, frameId }),
            });
        }
        if (products.detections3d === true && outputs.detections3dTopicId) {
            messages.push({
                topicId: outputs.detections3dTopicId,
                signal: "detections3d",
                frameId: mapFrameId,
                value: buildDetection3DArray({
                    detections: imageDetections,
                    timeNs: captureTimeNs,
                    frameId: mapFrameId,
                }),
            });
        }
        if (products.lanes === true && outputs.lanesTopicId) {
            messages.push({
                topicId: outputs.lanesTopicId,
                signal: "lanes",
                frameId: mapFrameId,
                value: buildStampedLanes({
                    lanes: truth.filter((record) => record.lane).map((record) => record.lane),
                    timeNs: captureTimeNs,
                    frameId: mapFrameId,
                    sequence,
                    syncGroupKey,
                    calibrationHash: this.calibrationHash,
                }),
            });
        }
        if (products.trafficControls === true && outputs.trafficControlsTopicId) {
            messages.push({
                topicId: outputs.trafficControlsTopicId,
                signal: "trafficControls",
                frameId: mapFrameId,
                value: buildTrafficControlStates({
                    controls: truth.filter((record) => record.control).map((record) => ({
                        ...record,
                        ...record.control,
                    })),
                    timeNs: captureTimeNs,
                    frameId: mapFrameId,
                    sequence,
                    syncGroupKey,
                    calibrationHash: this.calibrationHash,
                }),
            });
        }
        return messages;
    }

    captureAt({ captureTimeNs, sampleIndex, rng }) {
        const data = this.getParent()?.getParent?.();
        const renderer = data?.renderer;
        const scene = data?.scene;
        if (!renderer || !scene || !this.sensorCamera || !this.renderProducts) return [];
        const vehicles = data?.vehicles?.()?.vehicles || [];
        const frameResolution = this.transformRuntime?.resolveCaptureFrames?.(this.config, vehicles, captureTimeNs);
        const noise = this.config.noise;
        const enabled = this._enabledProducts();
        const needsGpu = enabled.rgb || enabled.depth || enabled.semantic || enabled.instance;
        const asyncRead = needsGpu && this.renderProducts.usesAsyncReadback;

        if (asyncRead) {
            let delivered = [];
            const issued = this._issuedCapture;
            if (this.renderProducts.pending) {
                const polled = this.renderProducts.poll();
                if (!polled) {
                    this.contractPublisher?.recordShaderBusy?.(sampleIndex);
                    return { messages: [], captureTimeNs, sampleIndex };
                }
                if (issued) delivered = this._buildMessages(issued, polled);
                this._issuedCapture = null;
            }
            if (frameResolution && frameResolution.ok === false) {
                this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
                return {
                    messages: delivered,
                    captureTimeNs: issued?.captureTimeNs ?? captureTimeNs,
                    sampleIndex: issued?.sampleIndex ?? sampleIndex,
                    rng: issued?.rng,
                };
            }
            if (noise.dropoutProbability > 0 && rng.next() < noise.dropoutProbability) {
                this.contractPublisher?.recordFrameDrop?.("camera-frame-dropout", sampleIndex);
                return {
                    messages: delivered,
                    captureTimeNs: issued?.captureTimeNs ?? captureTimeNs,
                    sampleIndex: issued?.sampleIndex ?? sampleIndex,
                    rng: issued?.rng,
                };
            }
            this._applyPose();
            const truth = this._refreshTruth(data, scene, vehicles);
            const calibration = this.config.calibration;
            const imageDetections = projectTruthBoundsToImage(
                truth.filter((record) => record.visible && record.semanticId !== 0),
                this.sensorCamera,
                calibration.width,
                calibration.height,
            );
            const submitted = this.renderProducts.submit(enabled);
            if (!submitted) {
                this.contractPublisher?.recordShaderBusy?.(sampleIndex);
            } else {
                this._issuedCapture = {
                    captureTimeNs,
                    sampleIndex,
                    rng,
                    truth,
                    imageDetections,
                };
            }
            return {
                messages: delivered,
                captureTimeNs: issued?.captureTimeNs ?? captureTimeNs,
                sampleIndex: issued?.sampleIndex ?? sampleIndex,
                rng: issued?.rng,
            };
        }

        if (frameResolution && frameResolution.ok === false) {
            this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
            return [];
        }
        if (noise.dropoutProbability > 0 && rng.next() < noise.dropoutProbability) {
            this.contractPublisher?.recordFrameDrop?.("camera-frame-dropout", sampleIndex);
            return [];
        }
        this._applyPose();
        const truth = this._refreshTruth(data, scene, vehicles);
        const captured = this.renderProducts.capture(enabled);
        return this._buildMessages({ captureTimeNs, sampleIndex, rng, truth }, captured);
    }

    dispose() {
        this._issuedCapture = null;
        this.contractPublisher?.dispose?.();
        this.sensorCamera?.removeFromParent?.();
        this.renderProducts?.dispose?.();
        this.sensorCamera = null;
        this.renderProducts = null;
        super.dispose();
    }
}
