import * as THREE from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

import { BrowserPbrRenderRuntime } from "./BrowserPbrRenderRuntime.js";
import { CameraRenderProducts } from "./CameraRenderProducts.js";
import { readRenderTargetPixelsWithFence } from "../util/glReadback.js";

function decodeBase64(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function assetClientFor(payload) {
    const uses = new Map((payload.uses || []).map((entry) => [entry.useHash, entry]));
    const assets = new Map((payload.assets || []).map((entry) => [entry.sha256, {
        ...entry,
        bytes: decodeBase64(entry.base64),
    }]));
    const checked = (useHash) => {
        const entry = uses.get(String(useHash || ""));
        if (!entry) throw new Error(`Visual use ${useHash} is outside the prepared closure.`);
        const asset = assets.get(entry.use.asset.sha256);
        if (!asset) throw new Error(`Prepared visual asset ${entry.use.asset.sha256} is missing.`);
        return { entry, asset };
    };
    return {
        async getUse(useHash) {
            return checked(useHash).entry.use;
        },
        async getUseContent(useHash) {
            const { entry, asset } = checked(useHash);
            return {
                bytes: asset.bytes,
                status: 200,
                mediaType: entry.use.asset.mediaType,
                etag: `"${entry.use.asset.sha256}"`,
                contentRange: null,
                length: asset.bytes.byteLength,
            };
        },
        async validateClosure({ useHash, operations = [] } = {}) {
            checked(useHash);
            const allowed = new Set(["display", "machine-interpretation"]);
            if (operations.some((operation) => !allowed.has(operation))) {
                throw new Error(`Unsupported headless PBR asset operation for ${useHash}.`);
            }
            return { allowed: true };
        },
    };
}

function serializedProduct(value, type) {
    if (!value) return null;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return { type, length: value.length, base64: btoa(binary) };
}

class PreparedPbrEnvironment {
    constructor({ environmentKey, slot, renderer, runtime, vehicles, sensorRig }) {
        this.environmentKey = environmentKey;
        this.slot = slot;
        this.renderer = renderer;
        this.runtime = runtime;
        this.vehicles = vehicles;
        this.sensorRig = sensorRig;
        this.cameras = new Map();
    }

    camera(request) {
        const existing = this.cameras.get(request.id);
        if (existing) return existing;
        const calibration = request.captureInput.calibration;
        const camera = new THREE.PerspectiveCamera(50, calibration.image.width / calibration.image.height,
            calibration.clipping.near, calibration.clipping.far);
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
        this.cameras.set(request.id, created);
        return created;
    }

    async capture(requests) {
        const vehicles = requests[0]?.vehicles || this.vehicles;
        const devices = requests.map((request) => ({
            renderRuntime: this.runtime,
            getPosition: () => request.captureInput.pose.position,
        }));
        await this.runtime.prepareCapture({ devices, vehicles });
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
            completed.push({
                id: request.id,
                type: "camera",
                captureTimeNs: request.captureInput.captureTimeNs,
                aligned: true,
                products: {
                    rgb: serializedProduct(captured.rgb, "uint8"),
                    depth: serializedProduct(captured.depth, "float32"),
                    semantic: serializedProduct(captured.semantic, "uint16"),
                    instance: serializedProduct(captured.instance, "uint32"),
                },
            });
        }
        return completed;
    }

    dispose() {
        for (const camera of this.cameras.values()) camera.products.dispose();
        this.cameras.clear();
        this.runtime.dispose();
    }
}

class HeadlessPbrPageRuntime {
    constructor() {
        this.environments = new Map();
        this.slots = [];
    }

    initialize(count) {
        const contexts = globalThis.__cevGpuContexts || [];
        if (contexts.length !== count) throw new Error("PBR runtime context count does not match the renderer pool.");
        this.slots = contexts.map(({ canvas, gl }, index) => ({
            index,
            renderer: new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: true }),
            environments: new Set(),
        }));
        return { slots: this.slots.length };
    }

    async probe() {
        const slot = this.slots[0];
        if (!slot) throw new Error("The PBR probe requires one renderer slot.");
        const loader = new KTX2Loader();
        let target;
        let geometry;
        let material;
        try {
            loader.setTranscoderPath("/vendor/basis/").detectSupport(slot.renderer);
            const [basisJs, basisWasm] = await Promise.all([
                fetch("/vendor/basis/basis_transcoder.js"),
                fetch("/vendor/basis/basis_transcoder.wasm"),
            ]);
            const decoder = basisJs.ok && basisWasm.ok
                && (await basisJs.arrayBuffer()).byteLength > 0
                && (await basisWasm.arrayBuffer()).byteLength > 0;
            const scene = new THREE.Scene();
            const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
            camera.position.z = 2;
            scene.add(new THREE.AmbientLight(0xffffff, 2));
            geometry = new THREE.PlaneGeometry(2, 2);
            material = new THREE.MeshStandardMaterial({ color: 0x80c040, roughness: 0.4, metalness: 0.1 });
            scene.add(new THREE.Mesh(geometry, material));
            target = new THREE.WebGLRenderTarget(2, 2, {
                format: THREE.RGBAFormat,
                type: THREE.UnsignedByteType,
                depthBuffer: true,
            });
            slot.renderer.setRenderTarget(target);
            slot.renderer.render(scene, camera);
            const output = new Uint8Array(16);
            await readRenderTargetPixelsWithFence(slot.renderer, target, output, { timeoutMs: 2000 });
            return {
                material: output.some((value, index) => index % 4 !== 3 && value > 0),
                decoder,
                asyncReadback: output[3] > 0,
            };
        } finally {
            slot.renderer.setRenderTarget(null);
            target?.dispose();
            material?.dispose();
            geometry?.dispose();
            loader.dispose();
        }
    }

    async prepare(payload) {
        if (this.environments.has(payload.environmentKey)) this.release(payload.environmentKey);
        const slot = this.slots[payload.slot];
        if (!slot) {
            throw new Error("The PBR renderer slot is unavailable.");
        }
        const renderer = slot.renderer;
        const vehicles = payload.vehicles || [];
        const runtime = new BrowserPbrRenderRuntime({
            renderer,
            assetClient: assetClientFor(payload),
            vehicles: () => vehicles,
        });
        try {
            await runtime.prepare(payload.resolved, {
                sensorRig: payload.sensorRig,
                vehicles,
            });
            const prepared = new PreparedPbrEnvironment({
                environmentKey: payload.environmentKey,
                slot: payload.slot,
                renderer,
                runtime,
                vehicles,
                sensorRig: payload.sensorRig,
            });
            this.environments.set(payload.environmentKey, prepared);
            slot.environments.add(payload.environmentKey);
            return {
                environmentKey: payload.environmentKey,
                generation: runtime.generation,
                renderSceneHash: payload.resolved.renderScene.hash,
                analyticSceneHash: payload.resolved.renderScene.description.analyticTruth.hash,
                status: runtime.status,
            };
        } catch (error) {
            runtime.dispose();
            throw error;
        }
    }

    async capture(environmentKey, requests) {
        const prepared = this.environments.get(environmentKey);
        if (!prepared) throw new Error("The prepared PBR environment handle is stale or unknown.");
        return prepared.capture(requests);
    }

    release(environmentKey) {
        const prepared = this.environments.get(environmentKey);
        if (!prepared) return false;
        this.environments.delete(environmentKey);
        prepared.dispose();
        this.slots[prepared.slot]?.environments.delete(environmentKey);
        return true;
    }

    diagnostics() {
        return {
            preparedPbrEnvironments: this.environments.size,
            occupiedPbrSlots: this.slots.filter((slot) => slot.environments.size > 0).length,
        };
    }

    close() {
        for (const key of [...this.environments.keys()]) this.release(key);
        for (const slot of this.slots) slot.renderer.dispose();
        this.slots = [];
    }
}

globalThis.__cevHeadlessPbrRuntime = new HeadlessPbrPageRuntime();
globalThis.__cevHeadlessPbrReady = true;
