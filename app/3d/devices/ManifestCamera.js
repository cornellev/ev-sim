import * as THREE from "three";

import Device from "./Device.js";
import { SensorPublisher } from "./SensorPublisher.js";
import { buildCameraInfo, buildImageMessage, flipRgbaRows } from "./SensorMessages.js";
import { withPixelPackBufferUnbound } from "../util/glReadback.js";
import { rep103PoseToThree } from "../../autonomy/CoordinateFrames.js";

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
        this.renderTarget = null;
        this.pixelBuffer = null;
        this.opticalQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2, "XYZ"));
        this.manifestManaged = true;
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
        this.renderTarget = new THREE.WebGLRenderTarget(calibration.width, calibration.height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
        });
        this.pixelBuffer = new Uint8Array(calibration.width * calibration.height * 4);
    }

    captureAt({ captureTimeNs, rng }) {
        const data = this.getParent()?.getParent?.();
        const renderer = data?.renderer;
        const scene = data?.scene;
        if (!renderer || !scene || !this.sensorCamera || !this.renderTarget) return [];
        const vehicles = data?.vehicles?.()?.vehicles || [];
        const frameResolution = this.transformRuntime?.resolveCaptureFrames?.(this.config, vehicles, captureTimeNs);
        if (frameResolution && frameResolution.ok === false) {
            this.contractPublisher?._event?.("frame-invalid", "error", { reason: frameResolution.message });
            return [];
        }
        this.sensorCamera.position.copy(this.getPosition());
        const mountQuaternion = new THREE.Quaternion().setFromEuler(this.getRotation());
        this.sensorCamera.quaternion.copy(mountQuaternion.multiply(this.opticalQuaternion));
        this.sensorCamera.updateMatrixWorld(true);
        const frameId = this.config.measurementFrameId || this.config.frameId;
        const previousTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(this.renderTarget);
        renderer.render(scene, this.sensorCamera);
        withPixelPackBufferUnbound(renderer, () => renderer.readRenderTargetPixels(
            this.renderTarget, 0, 0, this.config.calibration.width, this.config.calibration.height, this.pixelBuffer,
        ));
        renderer.setRenderTarget(previousTarget);
        const pixels = flipRgbaRows(this.pixelBuffer, this.config.calibration.width, this.config.calibration.height);
        const noise = this.config.noise;
        if (noise.dropoutProbability > 0 && rng.next() < noise.dropoutProbability) return [];
        if (noise.model === "gaussian" || noise.bias !== 0) {
            for (let offset = 0; offset < pixels.length; offset += 4) {
                for (let channel = 0; channel < 3; channel += 1) {
                    const perturbation = noise.bias + (noise.model === "gaussian" ? gaussian(rng) * noise.standardDeviation : 0);
                    pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(pixels[offset + channel] + perturbation)));
                }
            }
        }
        return [
            {
                topicId: this.config.outputs.imageTopicId,
                signal: "image",
                value: buildImageMessage({
                    data: pixels,
                    width: this.config.calibration.width,
                    height: this.config.calibration.height,
                    timeNs: captureTimeNs,
                    frameId,
                    encoding: this.config.calibration.encoding,
                }),
            },
            {
                topicId: this.config.outputs.cameraInfoTopicId,
                signal: "cameraInfo",
                value: buildCameraInfo({
                    ...this.config.calibration,
                    timeNs: captureTimeNs,
                    frameId,
                }),
            },
        ];
    }

    dispose() {
        this.sensorCamera?.removeFromParent?.();
        this.renderTarget?.dispose?.();
        this.sensorCamera = null;
        this.renderTarget = null;
        this.pixelBuffer = null;
        super.dispose();
    }
}
