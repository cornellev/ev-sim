import * as THREE from "three";

import { CameraRenderProducts } from "./CameraRenderProducts.js";
import { readRenderTargetPixelsWithFence } from "../util/glReadback.js";

function identity(value) {
    return value;
}

/**
 * Prepared PBR capture state shared by the hosted Chromium page and the
 * interactive browser worker. The caller owns the renderer and runtime.
 */
export class PbrCaptureEnvironment {
    constructor({
        environmentKey,
        slot = null,
        renderer,
        runtime,
        vehicles = [],
        sensorRig = null,
        mapProduct = identity,
        includeTimings = false,
    }) {
        this.environmentKey = environmentKey;
        this.slot = slot;
        this.renderer = renderer;
        this.runtime = runtime;
        this.vehicles = vehicles;
        this.sensorRig = sensorRig;
        this.mapProduct = mapProduct;
        this.includeTimings = includeTimings;
        this.cameras = new Map();
    }

    camera(request) {
        const cameraId = String(request.id);
        const existing = this.cameras.get(cameraId);
        if (existing) return existing;
        const calibration = request.captureInput.calibration;
        const camera = new THREE.PerspectiveCamera(
            50,
            calibration.image.width / calibration.image.height,
            calibration.clipping.near,
            calibration.clipping.far,
        );
        const options = this.runtime.cameraOptions();
        const products = new CameraRenderProducts({
            renderer: this.renderer,
            scene: options.captureSceneHandle.scene,
            camera,
            width: calibration.image.width,
            height: calibration.image.height,
            near: calibration.clipping.near,
            far: calibration.clipping.far,
            captureMode: options.captureMode,
            calibration,
            sceneHandle: options.captureSceneHandle,
            analyticSceneHandle: options.analyticSceneHandle,
            authorizeSourceUse: options.authorizeSourceUse,
            renderPolicy: options.renderPolicy,
            alignedReadback: readRenderTargetPixelsWithFence,
        });
        const created = { camera, products };
        this.cameras.set(cameraId, created);
        return created;
    }

    async capture(requests, {
        vehicles = requests[0]?.vehicles ?? this.vehicles,
        prepare = true,
    } = {}) {
        if (prepare) {
            const devices = requests.map((request) => ({
                renderRuntime: this.runtime,
                getPosition: () => request.captureInput.pose.position,
            }));
            await this.runtime.prepareCapture({ devices, vehicles });
        }
        const completed = [];
        for (const request of requests) {
            const enabled = request.products || {};
            const wantsPixels = enabled.rgb || enabled.depth || enabled.semantic || enabled.instance;
            const camera = wantsPixels ? this.camera(request) : null;
            const localScene = this.runtime.cameraOptions().captureSceneHandle;
            const captureInput = {
                ...request.captureInput,
                scene: {
                    role: localScene.role,
                    generation: localScene.generation,
                    descriptionHash: localScene.descriptionHash,
                },
            };
            const captured = wantsPixels ? await this.runtime.captureCamera({
                captureInput,
                enabled,
                renderProducts: camera.products,
            }) : {};
            const result = {
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureInput.captureTimeNs,
                aligned: true,
                products: {
                    rgb: this.mapProduct(captured.rgb, "uint8"),
                    depth: this.mapProduct(captured.depth, "float32"),
                    semantic: this.mapProduct(captured.semantic, "uint16"),
                    instance: this.mapProduct(captured.instance, "uint32"),
                },
            };
            if (this.includeTimings) {
                result.timings = { ...(camera?.products?._alignedProducts?.lastCaptureTimings ?? {}) };
            }
            completed.push(result);
        }
        return completed;
    }

    reset() {
        for (const camera of this.cameras.values()) camera.products.reset?.();
    }

    dispose() {
        for (const camera of this.cameras.values()) camera.products.dispose();
        this.cameras.clear();
        this.runtime.dispose();
    }
}
