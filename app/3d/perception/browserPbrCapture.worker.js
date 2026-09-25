import * as THREE from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

import { BrowserPbrRenderRuntime } from "./BrowserPbrRenderRuntime.js";
import { PbrCaptureEnvironment } from "./PbrCaptureEnvironment.js";
import { VisualLayerMaterializer } from "../environment/visual/VisualLayerMaterializer.js";
import { readRenderTargetPixelsWithFence } from "../util/glReadback.js";
import { getSkyRuntimeSource } from "../skybox/EnvironmentSkyConfig.js";
import { assertAllowedBrowserResourceUrl } from "../../security/BrowserResourcePolicy.js";

let renderer = null;
let runtime = null;
let environment = null;
let activeGeneration = 0;
let actors = [];
let operationTail = Promise.resolve();

function transferableProducts(products) {
    const transfers = new Set();
    for (const value of Object.values(products || {})) {
        if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) transfers.add(value.buffer);
    }
    return [...transfers];
}

function serializeError(error, fallbackCode = "PBR_WORKER_FAILED") {
    return {
        name: error?.name || "Error",
        message: error?.message || String(error || "PBR capture worker failed."),
        code: error?.code || fallbackCode,
        infrastructureFailure: true,
    };
}

async function decodeWorkerTexture(bytes, mediaType) {
    if (mediaType === "image/ktx2") return undefined;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

async function installWorkerImageSky({ scene, sky }) {
    const source = assertAllowedBrowserResourceUrl(getSkyRuntimeSource(sky));
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Image sky load failed (${response.status} ${response.statusText}).`);
    const bitmap = await createImageBitmap(await response.blob());
    const texture = new THREE.Texture(bitmap);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.name = "EnvironmentEditorImageSky";
    texture.needsUpdate = true;
    scene.background = texture;
    scene.environment = texture;
    const exposure = sky.image?.exposure;
    if (exposure != null) {
        scene.backgroundIntensity = exposure;
        scene.environmentIntensity = exposure;
    }
    return texture;
}

function materializerFactory(options) {
    return new VisualLayerMaterializer({
        ...options,
        decodeTexture: decodeWorkerTexture,
    });
}

function releaseEnvironment() {
    environment?.dispose();
    environment = null;
    runtime = null;
    if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss?.();
    }
    renderer = null;
    actors = [];
}

async function probe() {
    if (typeof OffscreenCanvas !== "function") throw new Error("OffscreenCanvas is unavailable.");
    if (typeof createImageBitmap !== "function") throw new Error("Worker image decoding is unavailable.");
    const canvas = new OffscreenCanvas(2, 2);
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
    if (!gl) throw new Error("Worker WebGL2 is unavailable.");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("Float render attachments are unavailable.");
    for (const name of ["fenceSync", "clientWaitSync", "getBufferSubData"]) {
        if (typeof gl[name] !== "function") throw new Error(`WebGL2 ${name} is unavailable.`);
    }

    const probeRenderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: true });
    const loader = new KTX2Loader();
    let target;
    let geometry;
    let material;
    try {
        loader.setTranscoderPath("/vendor/basis/").detectSupport(probeRenderer);
        const [basisJs, basisWasm] = await Promise.all([
            fetch("/vendor/basis/basis_transcoder.js"),
            fetch("/vendor/basis/basis_transcoder.wasm"),
        ]);
        if (!basisJs.ok || !basisWasm.ok
            || (await basisJs.arrayBuffer()).byteLength === 0
            || (await basisWasm.arrayBuffer()).byteLength === 0) {
            throw new Error("The KTX2 transcoder is unavailable in the capture worker.");
        }
        const decodeCanvas = new OffscreenCanvas(1, 1);
        const decodeContext = decodeCanvas.getContext("2d");
        decodeContext.fillStyle = "#fff";
        decodeContext.fillRect(0, 0, 1, 1);
        const bitmap = await createImageBitmap(await decodeCanvas.convertToBlob({ type: "image/png" }));
        bitmap.close?.();

        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        camera.position.z = 2;
        geometry = new THREE.PlaneGeometry(2, 2);
        material = new THREE.MeshBasicMaterial({ color: 0x80c040 });
        scene.add(new THREE.Mesh(geometry, material));
        target = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true });
        probeRenderer.setRenderTarget(target);
        probeRenderer.render(scene, camera);
        const output = new Uint8Array(16);
        await readRenderTargetPixelsWithFence(probeRenderer, target, output, { timeoutMs: 2000 });
        if (!output.some((value, index) => index % 4 !== 3 && value > 0)) {
            throw new Error("The worker representative capture produced no pixels.");
        }
        return {
            webgl2: true,
            floatAttachments: true,
            asyncReadback: true,
            imageDecoding: true,
            ktx2: true,
            representativeCapture: true,
        };
    } finally {
        probeRenderer.setRenderTarget(null);
        target?.dispose();
        material?.dispose();
        geometry?.dispose();
        loader.dispose();
        probeRenderer.dispose();
        probeRenderer.forceContextLoss?.();
    }
}

async function dispatch(method, payload = {}) {
    if (method === "probe") return probe();
    if (method === "prepare") {
        releaseEnvironment();
        activeGeneration = payload.generation;
        actors = payload.vehicles || [];
        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
        if (!gl) throw new Error("Worker WebGL2 became unavailable.");
        renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: true });
        runtime = new BrowserPbrRenderRuntime({
            renderer,
            materializerFactory,
            installImageSky: installWorkerImageSky,
            vehicles: () => actors,
        });
        await runtime.prepare(payload.resolved, {
            sensorRig: payload.sensorRig,
            vehicles: actors,
        });
        environment = new PbrCaptureEnvironment({
            environmentKey: `browser-worker:${activeGeneration}`,
            renderer,
            runtime,
            vehicles: actors,
            sensorRig: payload.sensorRig,
            includeTimings: true,
        });
        const options = runtime.cameraOptions();
        return {
            generation: runtime.generation,
            status: runtime.status,
            renderPolicy: options.renderPolicy,
            appearance: {
                role: options.captureSceneHandle.role,
                generation: options.captureSceneHandle.generation,
                descriptionHash: options.captureSceneHandle.descriptionHash,
            },
            analytic: {
                role: options.analyticSceneHandle.role,
                generation: options.analyticSceneHandle.generation,
                descriptionHash: options.analyticSceneHandle.descriptionHash,
            },
        };
    }
    if (payload.generation !== activeGeneration || !environment || !runtime) {
        const error = new Error("The PBR capture worker request belongs to a stale run generation.");
        error.code = "PBR_WORKER_GENERATION_STALE";
        throw error;
    }
    if (method === "prepareCapture") {
        actors = payload.vehicles || [];
        const devices = (payload.positions || []).map((position) => ({
            renderRuntime: runtime,
            getPosition: () => position,
        }));
        await runtime.prepareCapture({ devices, vehicles: actors });
        return { status: runtime.status };
    }
    if (method === "capture") {
        const [completed] = await environment.capture([payload.request], {
            vehicles: actors,
            prepare: false,
        });
        return {
            aligned: completed.aligned,
            ...completed.products,
            timings: completed.timings,
            status: runtime.status,
        };
    }
    if (method === "reset") {
        environment.reset();
        return { reset: true };
    }
    if (method === "dispose") {
        releaseEnvironment();
        activeGeneration += 1;
        return { disposed: true };
    }
    throw new Error(`Unsupported PBR capture worker method "${method}".`);
}

self.onmessage = (event) => {
    const request = event.data || {};
    operationTail = operationTail.then(async () => {
        try {
            const result = await dispatch(request.method, request.payload);
            const transfers = request.method === "capture" ? transferableProducts(result) : [];
            self.postMessage({ id: request.id, ok: true, result }, transfers);
        } catch (error) {
            self.postMessage({ id: request.id, ok: false, error: serializeError(error) });
        }
    });
};
