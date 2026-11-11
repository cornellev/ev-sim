import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AnalyticGpuScene, prepareAnalyticGpuFrame } from "../../app/simulation/sensors/AnalyticGpuScene.js";
import { LIVE_CAMERA_OBJECT_MOTION, snapshotCameraObjectPoses } from "../../app/simulation/render/CameraObjectMotion.js";
import { isScanningLidarType } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { supervisorError } from "./HeadlessProtocol.js";
import {
    assertVisualCaptureInput,
    CORRECTED_VISUAL_CAPTURE_MODE,
    createVisualCameraCalibration,
} from "../../app/3d/environment/visual/VisualCapturePipeline.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../../package.json").version;
const REQUIRE = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASIS_ROOT = path.dirname(REQUIRE.resolve("three/examples/jsm/libs/basis/basis_transcoder.js"));
const RUNTIME_ORIGIN = "http://cev-sim.invalid";
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|software rasterizer/i;
const RUNTIME_ENTRY = path.join(REPOSITORY_ROOT, "app/3d/perception/HeadlessPbrPageRuntime.js");
const THREE_ROOT = path.join(REPOSITORY_ROOT, "node_modules/three");
const NOBLE_HASHES_ROOT = path.join(REPOSITORY_ROOT, "node_modules/@noble/hashes");
const ATMOSPHERE_ROOT = path.join(REPOSITORY_ROOT, "node_modules/@takram/three-atmosphere");
const CLOUDS_ROOT = path.join(REPOSITORY_ROOT, "node_modules/@takram/three-clouds");
const GEOSPATIAL_ROOT = path.join(REPOSITORY_ROOT, "node_modules/@takram/three-geospatial");
const POSTPROCESSING_ROOT = path.join(REPOSITORY_ROOT, "node_modules/postprocessing");
const RUNTIME_PACKAGE_ENTRIES = Object.freeze({
    "@takram/three-atmosphere": path.join(ATMOSPHERE_ROOT, "build/index.js"),
    "@takram/three-atmosphere/shaders/bruneton": path.join(ATMOSPHERE_ROOT, "build/shaders/bruneton.js"),
    "@takram/three-clouds": path.join(CLOUDS_ROOT, "build/index.js"),
    "@takram/three-geospatial": path.join(GEOSPATIAL_ROOT, "build/index.js"),
    "@takram/three-geospatial/shaders": path.join(GEOSPATIAL_ROOT, "build/shaders.js"),
    postprocessing: path.join(POSTPROCESSING_ROOT, "build/index.js"),
});

const MIME = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".bin": "application/octet-stream",
});
const CLOUD_ASSET_PREFIX = "/runtime/node_modules/@takram/three-clouds/assets/";
const CLOUD_ASSET_TYPES = Object.freeze({
    "local_weather.png": MIME[".png"],
    "shape.bin": MIME[".bin"],
    "shape_detail.bin": MIME[".bin"],
    "turbulence.png": MIME[".png"],
});

/** Packaged Takram cloud bytes. The private page cannot fetch the library's GitHub URLs. */
export function packagedCloudAsset(pathname) {
    let decoded = pathname;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (!decoded.startsWith(CLOUD_ASSET_PREFIX)) return null;
    const name = decoded.slice(CLOUD_ASSET_PREFIX.length);
    const contentType = CLOUD_ASSET_TYPES[name];
    if (!contentType) return null;
    return {
        file: path.join(CLOUDS_ROOT, "assets", name),
        contentType,
    };
}

function runtimeHtml() {
    return `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify({
        imports: {
            three: "/runtime/node_modules/three/build/three.module.js",
            "three/addons/": "/runtime/node_modules/three/examples/jsm/",
            "three/examples/jsm/": "/runtime/node_modules/three/examples/jsm/",
            "@noble/hashes/": "/runtime/node_modules/@noble/hashes/",
            "@takram/three-atmosphere": "/runtime/node_modules/@takram/three-atmosphere/build/index.js",
            "@takram/three-atmosphere/shaders/bruneton": "/runtime/node_modules/@takram/three-atmosphere/build/shaders/bruneton.js",
            "@takram/three-clouds": "/runtime/node_modules/@takram/three-clouds/build/index.js",
            "@takram/three-geospatial": "/runtime/node_modules/@takram/three-geospatial/build/index.js",
            "@takram/three-geospatial/shaders": "/runtime/node_modules/@takram/three-geospatial/build/shaders.js",
            postprocessing: "/runtime/node_modules/postprocessing/build/index.js",
        },
    })}</script><script type="module" src="/runtime/app/3d/perception/HeadlessPbrPageRuntime.js"></script>`;
}

function safeRuntimePath(pathname, allowedFiles) {
    const decoded = decodeURIComponent(pathname);
    const candidates = [
        ["/runtime/app/", path.join(REPOSITORY_ROOT, "app")],
        ["/runtime/node_modules/three/", THREE_ROOT],
        ["/runtime/node_modules/@noble/hashes/", NOBLE_HASHES_ROOT],
        ["/runtime/node_modules/@takram/three-atmosphere/", ATMOSPHERE_ROOT],
        ["/runtime/node_modules/@takram/three-clouds/", CLOUDS_ROOT],
        ["/runtime/node_modules/@takram/three-geospatial/", GEOSPATIAL_ROOT],
        ["/runtime/node_modules/postprocessing/", POSTPROCESSING_ROOT],
        ["/vendor/basis/", BASIS_ROOT],
    ];
    for (const [prefix, root] of candidates) {
        if (!decoded.startsWith(prefix)) continue;
        const relative = decoded.slice(prefix.length);
        if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
        const resolved = path.resolve(root, relative);
        if (!resolved.startsWith(`${root}${path.sep}`)) return null;
        if (![".js", ".wasm"].includes(path.extname(resolved))) return null;
        if (!allowedFiles.has(resolved)) return null;
        return resolved;
    }
    return null;
}

function resolveRuntimeImport(specifier, importer) {
    if (specifier === "three") return path.join(THREE_ROOT, "build/three.module.js");
    if (specifier.startsWith("three/examples/jsm/")) {
        return path.join(THREE_ROOT, specifier.slice("three/".length));
    }
    if (specifier.startsWith("three/addons/")) {
        return path.join(THREE_ROOT, "examples/jsm", specifier.slice("three/addons/".length));
    }
    if (specifier.startsWith("@noble/hashes/")) {
        return path.join(NOBLE_HASHES_ROOT, specifier.slice("@noble/hashes/".length));
    }
    if (Object.hasOwn(RUNTIME_PACKAGE_ENTRIES, specifier)) return RUNTIME_PACKAGE_ENTRIES[specifier];
    if (specifier.startsWith(".")) return path.resolve(path.dirname(importer), specifier);
    throw new Error(`Headless PBR runtime import "${specifier}" is not allowlisted.`);
}

function isRuntimeModule(file) {
    return [path.join(REPOSITORY_ROOT, "app"), THREE_ROOT, NOBLE_HASHES_ROOT, ATMOSPHERE_ROOT, CLOUDS_ROOT, GEOSPATIAL_ROOT, POSTPROCESSING_ROOT]
        .some((root) => file.startsWith(`${root}${path.sep}`));
}

async function buildRuntimeClosure() {
    const allowed = new Set();
    const pending = [RUNTIME_ENTRY];
    const importPattern = /(?:\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\))/gu;
    while (pending.length > 0) {
        const file = pending.pop();
        if (allowed.has(file)) continue;
        const source = await fs.readFile(file, "utf8");
        const executableSource = source.replace(/\/\*[\s\S]*?\*\//gu, "");
        allowed.add(file);
        for (const match of executableSource.matchAll(importPattern)) {
            const dependency = resolveRuntimeImport(match[1] || match[2], file);
            if (!isRuntimeModule(dependency) || path.extname(dependency) !== ".js") {
                throw new Error(`Headless PBR runtime dependency ${dependency} is outside the allowlisted module roots.`);
            }
            if (!allowed.has(dependency)) pending.push(dependency);
        }
    }
    allowed.add(path.join(BASIS_ROOT, "basis_transcoder.js"));
    allowed.add(path.join(BASIS_ROOT, "basis_transcoder.wasm"));
    return allowed;
}

function utf8Bytes(value) {
    return Buffer.byteLength(JSON.stringify(value));
}

/** RGBA8 target, pack buffer, and returned bytes, plus the float depth target when requested. */
export function analyticGpuCaptureBytes(request) {
    const pixels = Math.max(0, Number(request?.width) || 0) * Math.max(0, Number(request?.height) || 0);
    const products = request?.products;
    if (!products || typeof products !== "object" || Array.isArray(products)) return pixels * 4 * 3;
    let bytes = 0;
    if (products.rgb === true) bytes += pixels * 4 * 3;
    if (products.depth === true) bytes += pixels * 16 * 2 + pixels * 4;
    return bytes;
}

export function analyticAxialDepthMeters(viewZ) {
    const depth = -Number(viewZ);
    return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

function outputBytes(request) {
    if (request.provider?.id === "pbr-mesh") {
        const pixels = request.width * request.height;
        return pixels * (
            (request.products?.rgb ? 4 : 0)
            + (request.products?.depth ? 4 : 0)
            + (request.products?.semantic ? 2 : 0)
            + (request.products?.instance ? 4 : 0)
        );
    }
    if (request.type === "camera") return analyticGpuCaptureBytes(request);
    return request.width * request.height * 4 * 4 * 3;
}

function analyticTriangleCount(scene) {
    const count = (primitives) => (primitives || []).reduce((total, primitive) => total + (primitive.shape === "triangle" ? 1 : 12), 0);
    return count(scene.staticPrimitives) + (scene.actors || []).reduce((total, actor) => total + count(actor.primitives), 0);
}

function analyticResources(previous, scene, requests, sceneHash) {
    const resources = new Map(previous);
    const count = analyticTriangleCount(scene);
    for (const request of requests) {
        const key = JSON.stringify([sceneHash, request.type, request.id]);
        const targets = new Map(resources.get(key)?.targets);
        const pixels = request.width * request.height;
        if (request.type === "camera") {
            targets.set("rgb", pixels * 8); // RGBA8 attachment and PBO, including depth-only requests.
            if (request.products?.depth) targets.set("float", pixels * 32);
        } else targets.set("float", pixels * 32);
        const geometryBytes = count * (112 + (request.type === "camera" ? 84 : 64))
            + (request.type !== "camera" && count === 0 && scene.planes?.length ? 64 : 0);
        resources.delete(key);
        resources.set(key, { sceneHash, targets, bytes: geometryBytes + [...targets.values()].reduce((total, bytes) => total + bytes, 0) });
    }
    return resources;
}

function pbrRetainedCameraBytes(request) {
    const pixels = request.width * request.height;
    const products = request.products || {};
    const analytic = products.depth || products.semantic || products.instance;
    // CameraRenderProducts base color/depth target and CPU decode buffers.
    let bytes = pixels * 31;
    if (products.rgb) bytes += pixels * 8;
    if (analytic) bytes += pixels * 8;
    if (products.depth) bytes += pixels * 20;
    return bytes;
}

function pbrTransientCaptureBytes(request) {
    const pixels = request.width * request.height;
    const products = request.products || {};
    const productBytes = outputBytes(request);
    const widestReadback = products.depth ? pixels * 16 : pixels * 4;
    // Raw readback, PBO, normalized rows, product arrays, base64/CDP payload,
    // decoded Node buffer, and final typed copy all coexist at the boundary.
    return widestReadback * 3 + productBytes * 6;
}

function pbrResidentBytes(prepared, cameraAllocations = prepared.cameraAllocations) {
    return prepared.bytes + [...(cameraAllocations?.values() || [])]
        .reduce((total, bytes) => total + bytes, 0);
}

function currentPbrBytes(prepared) {
    return prepared ? Math.max(pbrResidentBytes(prepared), ...(prepared.captureAllocations?.values() || [])) : 0;
}

function currentAnalyticBytes(owner) {
    return owner ? Math.max(owner.bytes || 0, owner.captureBytes || 0) : 0;
}

function publicPbrHandle(record) {
    return {
        environmentKey: record.environmentKey,
        generation: record.generation,
        renderSceneHash: record.renderSceneHash,
        analyticSceneHash: record.analyticSceneHash,
        resourceHashes: { ...record.resourceHashes },
        status: record.status,
    };
}

function validatePbrRequests(requests, prepared) {
    if (!Array.isArray(requests) || requests.length === 0) {
        throw supervisorError("INVALID_REQUEST", "PBR capture requires at least one camera request.");
    }
    const ids = new Set();
    return requests.map((request) => {
        if (!request?.id || ids.has(request.id) || request.type !== "camera"
            || request.provider?.id !== "pbr-mesh" || request.provider?.version !== 1) {
            throw supervisorError("INVALID_REQUEST", "PBR capture requests require unique camera IDs and pbr-mesh@1.");
        }
        ids.add(request.id);
        const input = assertVisualCaptureInput(request.captureInput);
        if (input.scene.role !== "measured-appearance"
            || input.scene.generation !== prepared.generation
            || input.scene.descriptionHash !== prepared.renderSceneHash
            || input.captureTimeNs !== request.captureTimeNs
            || input.calibration.image.width !== request.width
            || input.calibration.image.height !== request.height) {
            throw supervisorError("INVALID_REQUEST", `PBR camera ${request.id} capture identity is stale or inconsistent.`);
        }
        const products = request.products;
        if (!products || typeof products !== "object" || Array.isArray(products)
            || Object.keys(products).some((name) => !["rgb", "depth", "semantic", "instance"].includes(name))
            || Object.values(products).some((enabled) => typeof enabled !== "boolean")) {
            throw supervisorError("INVALID_REQUEST", `PBR camera ${request.id} products are invalid.`);
        }
        return request;
    });
}

function validatePbrResults(requests, results) {
    if (!Array.isArray(results) || results.length !== requests.length) {
        throw infrastructureError("PBR renderer returned an incomplete sync group.");
    }
    const byId = new Map(results.map((entry) => [entry.id, entry]));
    if (byId.size !== results.length) throw infrastructureError("PBR renderer returned duplicate camera results.");
    const specs = {
        rgb: [Uint8Array, 4],
        depth: [Float32Array, 1],
        semantic: [Uint16Array, 1],
        instance: [Uint32Array, 1],
    };
    for (const request of requests) {
        const result = byId.get(request.id);
        if (!result || result.type !== "camera" || result.aligned !== true
            || result.captureTimeNs !== request.captureTimeNs) {
            throw infrastructureError(`PBR renderer returned an invalid result for camera ${request.id}.`);
        }
        const pixels = request.width * request.height;
        for (const [name, [Constructor, channels]] of Object.entries(specs)) {
            const value = result.products?.[name];
            if (request.products[name] === true) {
                if (!(value instanceof Constructor) || value.length !== pixels * channels) {
                    throw infrastructureError(`PBR renderer returned an invalid ${name} product for camera ${request.id}.`);
                }
            } else if (value != null) {
                throw infrastructureError(`PBR renderer returned unrequested ${name} data for camera ${request.id}.`);
            }
        }
    }
    return requests.map((request) => byId.get(request.id));
}

async function readOpenedAsset(opened, expectedBytes) {
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of opened.stream) {
            total += chunk.byteLength;
            if (total > expectedBytes) throw new Error("Visual asset stream exceeded its declared size.");
            chunks.push(Buffer.from(chunk));
        }
        if (total !== expectedBytes) {
            throw new Error(`Visual asset stream size mismatch: expected ${expectedBytes}, received ${total}.`);
        }
        return Buffer.concat(chunks, total);
    } finally {
        await opened.release?.();
    }
}

function supportedPbrTarget(target, { platform = process.platform, arch = process.arch } = {}) {
    const selected = String(target || "");
    if (selected === "local-development") return platform === "darwin" && arch === "arm64";
    if (["jetson-agx-orin", "jetson-agx-thor"].includes(selected)) {
        return platform === "linux" && arch === "arm64";
    }
    return false;
}

function infrastructureError(message, details = null) {
    const error = supervisorError("WORKER_CRASHED", message, details);
    error.infrastructureFailure = true;
    return error;
}

export function createCalibratedHeadlessCameraRequest({ id, captureInput, clearColor = [0, 0, 0, 0], ...rest } = {}) {
    const checked = assertVisualCaptureInput(captureInput);
    if (checked.scene.role === "bake-snapshot") {
        throw new Error("Headless camera requests cannot use a bake-snapshot scene.");
    }
    return Object.freeze({
        ...rest,
        id: String(id || ""),
        type: "camera",
        width: checked.calibration.image.width,
        height: checked.calibration.image.height,
        clearColor: Object.freeze([...clearColor]),
        captureMode: CORRECTED_VISUAL_CAPTURE_MODE,
        captureInput: checked,
    });
}

export class ChromiumWebGlRendererAdapter {
    constructor(config = {}) {
        this.config = config;
        this.browser = null;
        this.page = null;
        this.provenance = null;
        this.pbrReady = false;
        this.analyticScenes = new Map();
        this.nextAnalyticSceneGeneration = 1;
    }

    async start(contextCount) {
        if (!this.config.chromiumExecutable) {
            throw new Error("renderer.chromiumExecutable is not configured.");
        }
        const allowedFiles = await buildRuntimeClosure();
        const { chromium } = await import("playwright-core");
        const args = [...(this.config.launchArgs || [])];
        if (this.config.angle) args.push(`--use-angle=${this.config.angle}`);
        if (this.config.disableSandbox) args.push("--no-sandbox");
        this.browser = await chromium.launch({
            executablePath: this.config.chromiumExecutable,
            headless: true,
            args,
        });
        this.page = await this.browser.newPage();
        const runtimeErrors = [];
        this.page.on("pageerror", (error) => runtimeErrors.push(error.message));
        this.page.on("console", (message) => {
            if (message.type() === "error") runtimeErrors.push(message.text());
        });
        this.page.on("response", (response) => {
            if (response.status() >= 400) runtimeErrors.push(`${response.status()} ${response.url()}`);
        });
        this.browser.on("disconnected", () => { this.browser = null; });
        await this.page.route("**/*", async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.origin !== RUNTIME_ORIGIN) {
                await route.abort("blockedbyclient");
                return;
            }
            const pathname = requestUrl.pathname;
            if (pathname === "/" || pathname === "/index.html") {
                await route.fulfill({ status: 200, contentType: MIME[".html"], body: runtimeHtml() });
                return;
            }
            const cloudAsset = packagedCloudAsset(pathname);
            if (cloudAsset) {
                try {
                    await route.fulfill({
                        status: 200,
                        contentType: cloudAsset.contentType,
                        body: await fs.readFile(cloudAsset.file),
                    });
                } catch {
                    await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
                }
                return;
            }
            const file = safeRuntimePath(pathname, allowedFiles);
            if (!file) {
                await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
                return;
            }
            try {
                await route.fulfill({
                    status: 200,
                    contentType: MIME[path.extname(file)],
                    body: await fs.readFile(file),
                });
            } catch {
                await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
            }
        });
        await this.page.goto(`${RUNTIME_ORIGIN}/index.html`, { waitUntil: "domcontentloaded" });
        const probe = await this.page.evaluate(async ({ count }) => {
            const contexts = [];
            for (let index = 0; index < count; index += 1) {
                const canvas = new OffscreenCanvas(4, 4);
                const gl = canvas.getContext("webgl2", {
                    antialias: false,
                    depth: true,
                    preserveDrawingBuffer: false,
                });
                if (!gl) throw new Error("WebGL2 context creation failed.");
                contexts.push({ canvas, gl });
            }
            globalThis.__cevGpuContexts = contexts;
            const gl = contexts[0].gl;
            const debug = gl.getExtension("WEBGL_debug_renderer_info");
            const floatExtension = gl.getExtension("EXT_color_buffer_float");
            const texture = gl.createTexture();
            const framebuffer = gl.createFramebuffer();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1, 1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            const floatFramebufferComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            let readbackCheck = false;
            if (floatFramebufferComplete) {
                const pbo = gl.createBuffer();
                gl.viewport(0, 0, 1, 1);
                gl.clearColor(1, 0.5, 0.25, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
                const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                gl.flush();
                await new Promise((resolve, reject) => {
                    const poll = () => {
                        const result = gl.clientWaitSync(fence, 0, 0);
                        if (result === gl.TIMEOUT_EXPIRED) setTimeout(poll, 0);
                        else if (result === gl.WAIT_FAILED) reject(new Error("Probe readback fence failed."));
                        else resolve();
                    };
                    setTimeout(poll, 0);
                });
                const check = new Float32Array(4);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, check);
                readbackCheck = Math.abs(check[0] - 1) < 1e-6 && Math.abs(check[1] - 0.5) < 1e-6;
                gl.deleteSync(fence);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                gl.deleteBuffer(pbo);
            }
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            return {
                webglVersion: gl.getParameter(gl.VERSION),
                shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                vendor: gl.getParameter(gl.VENDOR),
                renderer: debug
                    ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
                    : gl.getParameter(gl.RENDERER),
                unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "",
                maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
                maxViewportDimensions: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)),
                extensions: gl.getSupportedExtensions() || [],
                floatColorBuffer: Boolean(floatExtension),
                floatFramebufferComplete,
                readbackCheck,
                contextCount: contexts.length,
            };
        }, { count: contextCount });
        try {
            await this.page.waitForFunction(() => globalThis.__cevHeadlessPbrReady === true, null, { timeout: 10_000 });
        } catch (error) {
            throw new Error(`PBR page runtime failed to load: ${runtimeErrors.join(" | ") || error.message}`);
        }
        const pbr = await this.page.evaluate((count) => globalThis.__cevHeadlessPbrRuntime.initialize(count), contextCount);
        const pbrProbe = pbr.slots === contextCount
            ? await this.page.evaluate(() => globalThis.__cevHeadlessPbrRuntime.probe())
            : { material: false, decoder: false, asyncReadback: false };
        this.pbrReady = pbr.slots === contextCount
            && pbrProbe.material === true
            && pbrProbe.decoder === true
            && pbrProbe.asyncReadback === true;
        const version = await this.browser.version();
        this.provenance = {
            chromiumVersion: version,
            sidecarVersion: PACKAGE_VERSION,
            executable: this.config.chromiumExecutable,
            launchArguments: args,
            sandboxEnabled: !this.config.disableSandbox,
            angle: this.config.angle || null,
            ...probe,
            pbrRuntime: this.pbrReady,
            pbrProbe,
            pbrPrivateOrigin: RUNTIME_ORIGIN,
        };
        return this.provenance;
    }

    async captureGroup(scene, requests, contextIndex, options = {}) {
        if (!this.page || !this.browser) throw infrastructureError("Chromium renderer is not running.");
        try {
            const environmentKey = options.environmentKey ?? "direct-adapter";
            const sceneHash = options.sceneHash ?? null;
            const cacheIdentity = JSON.stringify([environmentKey, options.sceneHash ?? null, options.generation ?? 0, contextIndex]);
            const environmentIdentity = JSON.stringify([environmentKey, options.generation ?? 0, contextIndex]);
            for (const key of options.evictedKeys || []) {
                const [hash, type, id] = JSON.parse(key);
                const evictedOwnerKey = JSON.stringify([environmentKey, hash, contextIndex]);
                const evicted = this.analyticScenes.get(evictedOwnerKey);
                evicted?.geometry.frames.delete(JSON.stringify([type, id]));
                if (evicted && evicted.geometry.frames.size === 0) {
                    evicted.geometry.dispose();
                    this.analyticScenes.delete(evictedOwnerKey);
                }
            }
            const ownerKey = JSON.stringify([environmentKey, sceneHash, contextIndex]);
            let owner = this.analyticScenes.get(ownerKey);
            if (owner?.cacheIdentity !== cacheIdentity || owner?.scene !== scene) {
                owner?.geometry.dispose();
                owner = { cacheIdentity, identity: JSON.stringify([cacheIdentity, this.nextAnalyticSceneGeneration++]), scene, geometry: new AnalyticGpuScene(scene) };
                this.analyticScenes.set(ownerKey, owner);
            }
            const identity = owner.identity;
            const jobs = prepareAnalyticGpuFrame({ scene, jobs: requests, geometry: owner.geometry })
                .map(({ triangles: _triangles, ...job }) => ({ ...job, geometryKey: JSON.stringify([sceneHash, job.type, job.id]), analyticLidar: isScanningLidarType(job.type) }));
            const values = await this.page.evaluate(async ({ jobs, resolvedScene, slot, identity, environmentIdentity, environmentKey, evictedKeys }) => {
                const context = globalThis.__cevGpuContexts?.[slot];
                if (!context?.gl || context.gl.isContextLost()) throw new Error("WebGL2 context is lost.");
                const gl = context.gl;
                const disposeResource = (resource) => {
                    if (resource.buffer) gl.deleteBuffer(resource.buffer);
                    if (resource.vao) gl.deleteVertexArray(resource.vao);
                    if (resource.triangleTexture) gl.deleteTexture(resource.triangleTexture);
                    for (const target of resource.targets.values()) {
                        gl.deleteTexture(target.texture);
                        gl.deleteFramebuffer(target.framebuffer);
                        gl.deleteBuffer(target.pbo);
                    }
                };
                const cache = context.analyticCache ??= {
                    programs: new Map(), environments: new Map(), lidarVao: gl.createVertexArray(),
                    release(key) {
                        const owner = this.environments.get(key);
                        if (!owner) return;
                        for (const resource of owner.resources.values()) disposeResource(resource);
                        this.environments.delete(key);
                        if (this.environments.size === 0) {
                            for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
                            this.programs.clear();
                            gl.deleteVertexArray(this.lidarVao);
                            this.lidarVao = null;
                        }
                    },
                    dispose() {
                        for (const key of [...this.environments.keys()]) this.release(key);
                        if (this.lidarVao) gl.deleteVertexArray(this.lidarVao);
                        context.analyticCache = null;
                    },
                };
                let owner = cache.environments.get(environmentKey);
                if (owner?.identity !== environmentIdentity) {
                    cache.release(environmentKey);
                    owner = { identity: environmentIdentity, resources: new Map() };
                    cache.environments.set(environmentKey, owner);
                }
                cache.lidarVao ??= gl.createVertexArray();
                for (const key of evictedKeys || []) {
                    const resource = owner.resources.get(key);
                    if (resource) disposeResource(resource);
                    owner.resources.delete(key);
                }
                const resourceFor = (job) => {
                    let resource = owner.resources.get(job.geometryKey);
                    if (resource && (resource.identity !== identity || resource.count !== job.triangleCount
                        || (job.geometryFull && resource.fullRevision !== job.geometryRevision))) {
                        disposeResource(resource);
                        owner.resources.delete(job.geometryKey);
                        resource = null;
                    }
                    if (!resource) {
                        resource = { identity, count: job.triangleCount, fullRevision: job.geometryRevision, revision: 0, targets: new Map() };
                        owner.resources.set(job.geometryKey, resource);
                    }
                    return resource;
                };
                const compile = (type, source) => {
                    const shader = gl.createShader(type);
                    gl.shaderSource(shader, source);
                    gl.compileShader(shader);
                    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                        const message = gl.getShaderInfoLog(shader) || "GPU sensor shader compilation failed.";
                        gl.deleteShader(shader);
                        throw new Error(message);
                    }
                    return shader;
                };
                const linkProgram = (vertexSource, fragmentSource) => {
                    const key = JSON.stringify([vertexSource, fragmentSource]);
                    const existing = cache.programs.get(key);
                    if (existing) {
                        cache.programs.delete(key);
                        cache.programs.set(key, existing);
                        return existing.program;
                    }
                    let vertex, fragment, program;
                    try {
                        vertex = compile(gl.VERTEX_SHADER, vertexSource);
                        fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
                        program = gl.createProgram();
                        gl.attachShader(program, vertex);
                        gl.attachShader(program, fragment);
                        gl.linkProgram(program);
                        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                            throw new Error(gl.getProgramInfoLog(program) || "GPU sensor shader linking failed.");
                        }
                        cache.programs.set(key, { program, uniforms: new Map() });
                        while (cache.programs.size > 32) {
                            const [oldest, entry] = cache.programs.entries().next().value;
                            gl.deleteProgram(entry.program);
                            cache.programs.delete(oldest);
                        }
                        return program;
                    } catch (error) {
                        if (program) gl.deleteProgram(program);
                        throw error;
                    } finally {
                        if (vertex) gl.deleteShader(vertex);
                        if (fragment) gl.deleteShader(fragment);
                    }
                };
                const uniform = (program, name) => {
                    const entry = [...cache.programs.values()].find((entry) => entry.program === program);
                    if (!entry.uniforms.has(name)) entry.uniforms.set(name, gl.getUniformLocation(program, name));
                    return entry.uniforms.get(name);
                };
                const renderLidar = (job) => {
                    const planes = job.planes || [];
                    const dummy = [{
                        vertices: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
                        normal: [0, 1, 0],
                        semanticId: 0,
                        instanceId: 0,
                    }];
                    const count = job.triangleCount || (planes.length > 0 ? 1 : 0);
                    if (count === 0) return;
                    const resource = resourceFor(job);
                    const fresh = !resource.triangleTexture;
                    if (fresh) resource.triangleTexture = gl.createTexture();
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, resource.triangleTexture);
                    if (fresh) {
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, count);
                    }
                    if (resource.revision !== job.geometryRevision) {
                        const updates = job.triangleCount > 0 ? job.triangleUpdates : [{ start: 0, triangles: dummy }];
                        for (const { start, triangles } of updates) {
                            const packed = new Float32Array(triangles.length * 16);
                            triangles.forEach((triangle, index) => {
                                const offset = index * 16;
                                packed.set([...triangle.vertices[0], triangle.semanticId], offset);
                                packed.set([...triangle.vertices[1], triangle.instanceId], offset + 4);
                                packed.set([...triangle.vertices[2], 0], offset + 8);
                                packed.set([...triangle.normal, 0], offset + 12);
                            });
                            if (triangles.length > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, start, 4, triangles.length, gl.RGBA, gl.FLOAT, packed);
                        }
                        resource.revision = job.geometryRevision;
                    }
                    const program = linkProgram(`#version 300 es
                        const vec2 p[3] = vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
                        void main(){gl_Position=vec4(p[gl_VertexID],0.,1.);}`, `#version 300 es
                        precision highp float; precision highp int;
                        // NVIDIA ANGLE otherwise permits half-float texture sampling here.
                        uniform highp sampler2D uTriangles; uniform int uCount;
                        uniform vec3 uOrigin; uniform vec4 uQuaternion;
                        uniform vec3 uScan; uniform vec2 uElevation; uniform float uRange;
                        out vec4 color;
                        vec3 rotateQ(vec3 v, vec4 q){return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
                        float hit(vec3 ro,vec3 rd,vec3 a,vec3 b,vec3 c){
                            vec3 e1=b-a,e2=c-a,p=cross(rd,e2); float d=dot(e1,p);
                            if(abs(d)<1e-7)return -1.; float inv=1./d; vec3 t=ro-a;
                            float u=dot(t,p)*inv; if(u<0.||u>1.)return -1.; vec3 q=cross(t,e1);
                            float v=dot(rd,q)*inv; if(v<0.||u+v>1.)return -1.; return dot(e2,q)*inv;
                        }
                        void main(){
                            float theta=radians(uScan.x+floor(gl_FragCoord.x)*uScan.z);
                            float phi=radians(uElevation.x+floor(gl_FragCoord.y)*uElevation.y);
                            vec3 rd=normalize(rotateQ(vec3(cos(phi)*cos(theta),sin(phi),cos(phi)*sin(theta)),uQuaternion));
                            float best=uRange+1.; float incidence=0.; float semantic=0.; float instance=0.;
                            for(int i=0;i<${count};i++){
                                vec4 av=texelFetch(uTriangles,ivec2(0,i),0); vec4 bv=texelFetch(uTriangles,ivec2(1,i),0);
                                vec3 cv=texelFetch(uTriangles,ivec2(2,i),0).xyz; vec3 n=texelFetch(uTriangles,ivec2(3,i),0).xyz;
                                float distance=hit(uOrigin,rd,av.xyz,bv.xyz,cv);
                                if(distance>=0.0001&&distance<=uRange&&distance<best){best=distance;incidence=abs(dot(n,rd));semantic=av.w;instance=bv.w;}
                            }
                            ${planes.length > 0 ? `if(abs(rd.y)>1e-7){float distance=(${Number(planes[0].y).toExponential(16)}-uOrigin.y)/rd.y;if(distance>=0.0001&&distance<=uRange&&distance<best){best=distance;incidence=abs(rd.y);semantic=${Number(planes[0].semanticId)}.0;instance=${Number(planes[0].instanceId)}.0;}}` : ""}
                            color=best<=uRange?vec4(best,incidence,semantic,instance):vec4(0.);
                        }`);
                    const origin = job.lidarPose.origin;
                    const sensorQ = job.lidarPose.quaternion;
                    gl.useProgram(program);
                    gl.uniform1i(uniform(program, "uTriangles"), 0);
                    gl.uniform1i(uniform(program, "uCount"), count);
                    gl.uniform3fv(uniform(program, "uOrigin"), origin);
                    gl.uniform4fv(uniform(program, "uQuaternion"), sensorQ);
                    const calibration = job.sensor.calibration;
                    gl.uniform3f(uniform(program, "uScan"), calibration.azimuth.startDeg, calibration.azimuth.endDeg, calibration.azimuth.stepDeg);
                    gl.uniform2f(uniform(program, "uElevation"), calibration.elevation.startDeg, calibration.elevation.stepDeg);
                    gl.uniform1f(uniform(program, "uRange"), calibration.range);
                    gl.bindVertexArray(cache.lidarVao);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    gl.bindVertexArray(null);
                };
                const bytesToBase64 = (bytes) => {
                    const chunk = 4096;
                    let binary = "";
                    for (let offset = 0; offset < bytes.length; offset += chunk) {
                        const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunk));
                        binary += String.fromCharCode.apply(null, slice);
                    }
                    return btoa(binary);
                };
                const orientReadback = (job, output) => {
                    if (job.captureMode !== "calibrated-projection@1") return output;
                    const topLeft = new output.constructor(output.length);
                    const rowLength = job.width * 4;
                    for (let row = 0; row < job.height; row += 1) {
                        topLeft.set(
                            output.subarray((job.height - row - 1) * rowLength, (job.height - row) * rowLength),
                            row * rowLength,
                        );
                    }
                    return topLeft;
                };
                const prepareCamera = (job) => {
                    const triangleCount = job.triangleCount;
                    const resource = resourceFor(job);
                    const materials = new Map((resolvedScene.materials || []).map((entry) => [
                        Number(entry.semanticId),
                        (entry.colorRgba || [128, 128, 128, 255]).map((value) => Number(value) / 255),
                    ]));
                    const fresh = !resource.buffer;
                    if (fresh) {
                        resource.buffer = gl.createBuffer();
                        resource.vao = gl.createVertexArray();
                    }
                    const { buffer, vao } = resource;
                    gl.bindVertexArray(vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                    if (fresh) {
                        gl.bufferData(gl.ARRAY_BUFFER, triangleCount * 84, gl.STREAM_DRAW);
                        gl.enableVertexAttribArray(0);
                        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
                        gl.enableVertexAttribArray(1);
                        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
                    }
                    if (resource.revision !== job.geometryRevision) {
                        for (const { start, triangles } of job.triangleUpdates) {
                            const vertices = new Float32Array(triangles.length * 21);
                            let cursor = 0;
                            for (const triangle of triangles) {
                                const color = materials.get(triangle.semanticId) || [0.5, 0.5, 0.5, 1];
                                for (const vertexPosition of triangle.vertices) {
                                    vertices.set([...vertexPosition, ...color], cursor);
                                    cursor += 7;
                                }
                            }
                            if (vertices.length > 0) gl.bufferSubData(gl.ARRAY_BUFFER, start * 84, vertices);
                        }
                        resource.revision = job.geometryRevision;
                    }
                    gl.bindVertexArray(null);
                    const calibrated = job.captureMode === "calibrated-projection@1";
                    const pose = (() => {
                        if (triangleCount === 0) return null;
                        if (calibrated && job.products?.depth !== true) return null;
                        if (!job.sensor) throw new Error(`GPU camera ${job.id} is missing its sensor.`);
                        if (!job.analyticPose) throw new Error(`GPU camera ${job.id} is missing its analytic pose.`);
                        return job.analyticPose;
                    })();
                    const bindPose = (program) => {
                        gl.uniform1i(uniform(program, "uCalibrated"), calibrated ? 1 : 0);
                        if (calibrated) {
                            gl.uniformMatrix4fv(
                                uniform(program, "uViewProjection"),
                                false,
                                new Float32Array(job.captureInput.viewProjectionMatrix),
                            );
                            return;
                        }
                        gl.uniform3fv(uniform(program, "uOrigin"), pose.origin);
                        gl.uniform4fv(uniform(program, "uInverseQuaternion"), pose.inverseQ);
                        gl.uniform4f(
                            uniform(program, "uProjection"),
                            pose.projection[0],
                            pose.projection[1],
                            pose.projection[2],
                            pose.projection[3],
                        );
                    };
                    const draw = (program, bind) => {
                        if (triangleCount === 0) return;
                        gl.bindVertexArray(vao);
                        gl.enable(gl.DEPTH_TEST);
                        gl.depthFunc(gl.LEQUAL);
                        gl.useProgram(program);
                        bind(program);
                        gl.drawArrays(gl.TRIANGLES, 0, triangleCount * 3);
                        gl.disable(gl.DEPTH_TEST);
                        gl.bindVertexArray(null);
                    };
                    const bindDepth = (program) => {
                        bindPose(program);
                        if (!calibrated || !pose) return;
                        gl.uniform3fv(uniform(program, "uOrigin"), pose.origin);
                        gl.uniform4fv(uniform(program, "uInverseQuaternion"), pose.inverseQ);
                    };
                    return {
                        drawRgb() {
                            draw(linkProgram(`#version 300 es
                        precision highp float;
                        layout(location=0) in vec3 position; layout(location=1) in vec4 inputColor;
                        uniform vec3 uOrigin; uniform vec4 uInverseQuaternion;
                        uniform vec4 uProjection; uniform mat4 uViewProjection;
                        uniform bool uCalibrated; out vec4 vertexColor;
                        vec3 rotateQ(vec3 v, vec4 q){return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
                        void main(){
                            if(uCalibrated){
                                gl_Position=uViewProjection*vec4(position,1.);
                            }else{
                                vec3 p=rotateQ(position-uOrigin,uInverseQuaternion);
                                float f=uProjection.x; float aspect=uProjection.y;
                                float near=uProjection.z; float far=uProjection.w;
                                gl_Position=vec4(p.x*f/aspect,p.y*f,((far+near)/(near-far))*p.z+(2.*far*near)/(near-far),-p.z);
                            }
                            vertexColor=inputColor;
                        }`, `#version 300 es
                        precision highp float; in vec4 vertexColor; out vec4 color;
                        void main(){color=vertexColor;}`), bindPose);
                        },
                        drawDepth() {
                            draw(linkProgram(`#version 300 es
                        precision highp float;
                        layout(location=0) in vec3 position;
                        uniform vec3 uOrigin; uniform vec4 uInverseQuaternion;
                        uniform vec4 uProjection; uniform mat4 uViewProjection;
                        uniform bool uCalibrated; out float vViewZ;
                        vec3 rotateQ(vec3 v, vec4 q){return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v);}
                        void main(){
                            vec3 p=rotateQ(position-uOrigin,uInverseQuaternion);
                            vViewZ=p.z;
                            if(uCalibrated){
                                gl_Position=uViewProjection*vec4(position,1.);
                            }else{
                                float f=uProjection.x; float aspect=uProjection.y;
                                float near=uProjection.z; float far=uProjection.w;
                                gl_Position=vec4(p.x*f/aspect,p.y*f,((far+near)/(near-far))*p.z+(2.*far*near)/(near-far),-p.z);
                            }
                        }`, `#version 300 es
                        precision highp float; in float vViewZ; out vec4 color;
                        void main(){color=vec4(-vViewZ,0.,0.,1.);}`), bindDepth);
                        },
                    };
                };
                const readback = async (job, float, clearColor, draw, { resize = true } = {}) => {
                    const { width, height } = job;
                    if (resize) {
                        context.canvas.width = width;
                        context.canvas.height = height;
                    }
                    const resource = resourceFor(job);
                    let target = resource.targets.get(float);
                    if (target && (target.width !== width || target.height !== height)) {
                        gl.deleteTexture(target.texture);
                        gl.deleteFramebuffer(target.framebuffer);
                        gl.deleteBuffer(target.pbo);
                        resource.targets.delete(float);
                        target = null;
                    }
                    const byteLength = width * height * 4 * (float ? 4 : 1);
                    if (!target) {
                        target = { width, height, texture: gl.createTexture(), framebuffer: gl.createFramebuffer(), pbo: gl.createBuffer() };
                        resource.targets.set(float, target);
                        gl.bindTexture(gl.TEXTURE_2D, target.texture);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                        gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA32F : gl.RGBA8, width, height);
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, target.pbo);
                        gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                    }
                    const { texture, framebuffer, pbo } = target;
                    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
                    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                        throw new Error("GPU sensor framebuffer is incomplete.");
                    }
                    gl.viewport(0, 0, width, height);
                    gl.clearColor(...clearColor);
                    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                    if (job.analyticLidar) renderLidar(job);
                    if (draw) draw();
                    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                    gl.readPixels(0, 0, width, height, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
                    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
                    gl.flush();
                    try {
                        await new Promise((resolve, reject) => {
                            const poll = () => {
                                if (gl.isContextLost()) return reject(new Error("WebGL2 context is lost."));
                                const result = gl.clientWaitSync(fence, 0, 0);
                                if (result === gl.TIMEOUT_EXPIRED) setTimeout(poll, 0);
                                else if (result === gl.WAIT_FAILED) reject(new Error("GPU readback fence failed."));
                                else resolve();
                            };
                            setTimeout(poll, 0);
                        });
                        const output = float ? new Float32Array(width * height * 4) : new Uint8Array(byteLength);
                        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, output);
                        return orientReadback(job, output);
                    } finally {
                        gl.deleteSync(fence);
                        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                    }
                };
                const output = [];
                for (const job of jobs) {
                    if (job.type !== "camera") {
                        output.push({
                            id: job.id,
                            type: job.type,
                            data: Array.from(await readback(job, true, [0, 0, 0, 0], null)),
                        });
                        continue;
                    }
                    context.canvas.width = job.width;
                    context.canvas.height = job.height;
                    const prepared = prepareCamera(job);
                    {
                        const rgb = await readback(
                            job,
                            false,
                            job.clearColor || [0, 0, 0, 1],
                            () => prepared.drawRgb(),
                            { resize: false },
                        );
                        const products = { rgb: bytesToBase64(rgb) };
                        if (job.products?.depth === true) {
                            const rendered = await readback(
                                job,
                                true,
                                [0, 0, 0, 0],
                                () => prepared.drawDepth(),
                                { resize: false },
                            );
                            const depth = new Float32Array(job.width * job.height);
                            for (let index = 0; index < depth.length; index += 1) depth[index] = rendered[index * 4];
                            products.depth = bytesToBase64(new Uint8Array(depth.buffer));
                        }
                        output.push({
                            id: job.id,
                            type: job.type,
                            rgbBase64: products.rgb,
                            depthBase64: products.depth || null,
                            requestedProducts: {
                                rgb: job.products?.rgb === true,
                                depth: job.products?.depth === true,
                            },
                            captureTimeNs: job.captureTimeNs ?? null,
                            sampleIndex: job.sampleIndex ?? null,
                        });
                    }
                }
                return output;
            }, { jobs, resolvedScene: scene, slot: contextIndex, identity, environmentIdentity, environmentKey, evictedKeys: options.evictedKeys || [] });
            const decodeBase64 = (value) => Buffer.from(String(value || ""), "base64");
            return values.map((entry) => {
                if (entry.type !== "camera") {
                    return { ...entry, data: Float32Array.from(entry.data) };
                }
                const rgb = new Uint8Array(decodeBase64(entry.rgbBase64));
                const products = {};
                if (entry.requestedProducts?.rgb) products.rgb = rgb;
                if (entry.requestedProducts?.depth) {
                    if (!entry.depthBase64) throw new Error(`Analytic camera ${entry.id} did not return depth.`);
                    const bytes = Uint8Array.from(decodeBase64(entry.depthBase64));
                    products.depth = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
                }
                return {
                    id: entry.id,
                    type: entry.type,
                    data: rgb,
                    products,
                    requestedProducts: entry.requestedProducts,
                    captureTimeNs: entry.captureTimeNs,
                    sampleIndex: entry.sampleIndex,
                };
            });
        } catch (error) {
            throw infrastructureError(`GPU capture failed: ${error.message}`);
        }
    }

    async preparePbr(payload, contextIndex) {
        if (!this.page || !this.browser || !this.pbrReady) {
            throw infrastructureError("Chromium PBR runtime is not running.");
        }
        try {
            return await this.page.evaluate(
                ({ value, slot }) => globalThis.__cevHeadlessPbrRuntime.prepare({ ...value, slot }),
                { value: payload, slot: contextIndex },
            );
        } catch (error) {
            throw infrastructureError(`PBR preparation failed: ${error.message}`);
        }
    }

    async releaseAnalytic(environmentKey) {
        for (const [key, owner] of this.analyticScenes) {
            if (JSON.parse(key)[0] !== environmentKey) continue;
            owner.geometry.dispose();
            this.analyticScenes.delete(key);
        }
        if (!this.page) return;
        await this.page.evaluate((key) => {
            for (const context of globalThis.__cevGpuContexts || []) context.analyticCache?.release(key);
        }, environmentKey);
    }

    async capturePbr(environmentKey, requests) {
        if (!this.page || !this.browser || !this.pbrReady) {
            throw infrastructureError("Chromium PBR runtime is not running.");
        }
        try {
            const values = await this.page.evaluate(
                ({ key, jobs }) => globalThis.__cevHeadlessPbrRuntime.capture(key, jobs),
                { key: environmentKey, jobs: requests },
            );
            const typed = (product) => {
                if (!product) return null;
                const constructors = {
                    uint8: Uint8Array,
                    uint16: Uint16Array,
                    uint32: Uint32Array,
                    float32: Float32Array,
                };
                const Constructor = constructors[product.type];
                if (!Constructor) throw new Error(`Unknown PBR product type ${product.type}.`);
                const bytes = Buffer.from(product.base64, "base64");
                if (bytes.byteLength !== Number(product.length) * Constructor.BYTES_PER_ELEMENT) {
                    throw new Error(`PBR product ${product.type} byte length is invalid.`);
                }
                const copy = Uint8Array.from(bytes).buffer;
                return new Constructor(copy);
            };
            return values.map((entry) => ({
                ...entry,
                products: Object.fromEntries(Object.entries(entry.products).map(([name, value]) => [name, typed(value)])),
            }));
        } catch (error) {
            throw infrastructureError(`PBR capture failed: ${error.message}`);
        }
    }

    async releasePbr(environmentKey) {
        if (!this.page || !this.pbrReady) return false;
        return this.page.evaluate((key) => globalThis.__cevHeadlessPbrRuntime.release(key), environmentKey)
            .catch(() => false);
    }

    isRunning() {
        return Boolean(this.browser && this.page);
    }

    async close() {
        for (const owner of this.analyticScenes.values()) owner.geometry.dispose();
        this.analyticScenes.clear();
        if (this.page) {
            await this.page.evaluate(() => {
                for (const context of globalThis.__cevGpuContexts || []) context.analyticCache?.dispose();
            }).catch(() => {});
        }
        if (this.page && this.pbrReady) {
            await this.page.evaluate(() => globalThis.__cevHeadlessPbrRuntime.close()).catch(() => {});
        }
        await this.browser?.close().catch(() => {});
        this.browser = null;
        this.page = null;
        this.pbrReady = false;
    }
}

/** Supervisor-owned FIFO pool with a single Chromium page and fixed contexts. */
export class PooledGpuRenderer {
    constructor(config = {}, { adapterFactory = null, hostPlatform = process.platform, hostArch = process.arch } = {}) {
        this.config = {
            contextPoolSize: 1,
            sceneCacheBytes: 512 * 1024 * 1024,
            globalGpuBytes: 2 * 1024 * 1024 * 1024,
            ...config,
        };
        this.adapterFactory = adapterFactory || ((options) => new ChromiumWebGlRendererAdapter(options));
        this.hostPlatform = hostPlatform;
        this.hostArch = hostArch;
        this.adapter = null;
        this.probeResult = null;
        this.startPromise = null;
        this.scenes = new Map();
        this.sceneBytes = 0;
        this.queue = [];
        this.availableContexts = [];
        this.environmentBytes = new Map();
        this.preparedPbr = new Map();
        this.pbrAssetReaders = new Map();
        this.pbrSlotLoads = [];
        this.pbrPreparationPromise = Promise.resolve();
        this.browserLaunches = 0;
        this.busyContexts = 0;
        this.adapterGeneration = 0;
        this.nextPbrGeneration = 1;
        this.nextAnalyticGeneration = 1;
        this.analyticEnvironments = new Map();
        this.analyticOperations = new Map();
        this.analyticLifetimes = new Map();
        this.resetPromise = null;
        this.closed = false;
    }

    async probe() {
        await this.resetPromise;
        if (this.probeResult) return this.probeResult;
        if (!this.config.chromiumExecutable) {
            this.probeResult = { available: false, reason: "renderer.chromiumExecutable is not configured." };
            return this.probeResult;
        }
        try {
            await this._start();
            const software = SOFTWARE_RENDERERS.test(this.adapter.provenance?.renderer || "");
            const formats = this.adapter.provenance?.floatColorBuffer
                && this.adapter.provenance?.floatFramebufferComplete
                && this.adapter.provenance?.readbackCheck !== false;
            const available = formats && !software;
            this.probeResult = {
                available,
                reason: available ? "" : software
                    ? "Software WebGL renderer is not a production GPU capability."
                    : "Required float WebGL2 render targets are unavailable.",
                production: !software,
                provenance: this.adapter.provenance,
            };
        } catch (error) {
            await this.adapter?.close().catch(() => {});
            this.adapter = null;
            this.startPromise = null;
            this.probeResult = { available: false, reason: error.message };
        }
        return this.probeResult;
    }

    async _start() {
        await this.resetPromise;
        if (this.adapter) return;
        this.startPromise ||= (async () => {
            this.adapter = this.adapterFactory(this.config);
            await this.adapter.start(this.config.contextPoolSize);
            this.browserLaunches += 1;
            this.adapterGeneration += 1;
            this.availableContexts = Array.from(
                { length: this.config.contextPoolSize },
                (_, index) => index,
            );
            this.pbrSlotLoads = Array.from({ length: this.config.contextPoolSize }, () => 0);
        })();
        return this.startPromise;
    }

    _cacheScene(resource) {
        const hash = String(resource?.hash || "");
        if (!hash || !resource?.description) throw new Error("A resolved render scene is required.");
        const existing = this.scenes.get(hash);
        if (existing) {
            this.scenes.delete(hash);
            this.scenes.set(hash, existing);
            return existing;
        }
        const bytes = utf8Bytes(resource.description);
        if (bytes > this.config.sceneCacheBytes) throw supervisorError("RESOURCE_LIMIT", "Render scene exceeds the renderer cache budget.");
        while (this.sceneBytes + bytes > this.config.sceneCacheBytes && this.scenes.size > 0) {
            const [oldestHash, oldest] = this.scenes.entries().next().value;
            this.scenes.delete(oldestHash);
            this.sceneBytes -= oldest.bytes;
        }
        const cached = { hash, description: resource.description, bytes };
        this.scenes.set(hash, cached);
        this.sceneBytes += bytes;
        return cached;
    }

    pbrCapability() {
        if (!this.config.pbrEnabled) {
            return { available: false, reason: "renderer.pbrEnabled is false." };
        }
        if (!supportedPbrTarget(this.config.pbrTarget, {
            platform: this.hostPlatform,
            arch: this.hostArch,
        })) {
            return { available: false, reason: `PBR target ${this.config.pbrTarget} is not supported on ${this.hostPlatform}/${this.hostArch}.` };
        }
        const pbrProbe = this.adapter?.provenance?.pbrProbe;
        const available = this.probeResult?.available === true
            && this.adapter?.provenance?.pbrRuntime === true
            && pbrProbe?.material === true
            && pbrProbe?.decoder === true
            && pbrProbe?.asyncReadback === true;
        return {
            available,
            reason: available ? "" : this.probeResult?.reason || "The PBR runtime probe has not succeeded.",
            target: this.config.pbrTarget,
            products: ["rgba8", "camera-info", "32FC1", "16UC1", "32SC1"],
            readback: "pixel-pack-buffer-fence-event-loop-poll-v1",
        };
    }

    async preparePbr({ environmentKey, resolved, sensorRig, vehicles, maxGpuBytes, assetReader }) {
        const operation = async () => {
            const probe = await this.probe();
            const capability = this.pbrCapability();
            if (!probe.available || !capability.available) {
                throw supervisorError("UNSUPPORTED_CAPABILITY", `Headless PBR unavailable: ${capability.reason || probe.reason}`);
            }
            if (!environmentKey || !resolved?.renderScene || resolved.renderScene.description?.provider?.id !== "pbr-mesh") {
                throw supervisorError("INVALID_REQUEST", "PBR preparation requires an environment key and resolved pbr-mesh@1 scene.");
            }
            for (const camera of (sensorRig?.sensors || []).filter(
                (sensor) => sensor.enabled !== false && sensor.type === "camera",
            )) {
                createVisualCameraCalibration(camera.calibration);
            }
            await this.releasePbr(environmentKey);
            const uses = resolved.evidence?.visualAssets?.uses || [];
            if (uses.length > 0 && (!assetReader
                || typeof assetReader.authorizeUse !== "function"
                || typeof assetReader.openUse !== "function")) {
                throw supervisorError(
                    "UNSUPPORTED_CAPABILITY",
                    "PBR asset bytes require exact-use access from a same-host admitted run package.",
                );
            }
            const bytesByDigest = new Map();
            for (const entry of uses) {
                await assetReader.authorizeUse(entry.useHash, ["display", "machine-interpretation"]);
                if (bytesByDigest.has(entry.use.asset.sha256)) continue;
                const opened = await assetReader.openUse(entry.useHash);
                bytesByDigest.set(entry.use.asset.sha256, await readOpenedAsset(opened, entry.use.asset.sizeBytes));
            }
            const staticBytes = utf8Bytes(resolved.renderScene.description)
                + [...bytesByDigest.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
            const analyticBytes = currentAnalyticBytes(this.analyticEnvironments.get(environmentKey));
            if (staticBytes + analyticBytes > maxGpuBytes) {
                throw supervisorError("RESOURCE_LIMIT", `PBR preparation requires ${staticBytes} bytes; environment limit is ${maxGpuBytes}.`);
            }
            const others = [...this.environmentBytes.entries()].filter(([key]) => key !== environmentKey)
                .reduce((total, [, bytes]) => total + bytes, 0);
            if (others + staticBytes + analyticBytes > this.config.globalGpuBytes) {
                throw supervisorError("RESOURCE_LIMIT", "GPU renderer global allocation budget is exhausted.");
            }
            const slot = this.pbrSlotLoads.reduce(
                (best, load, index, values) => load < values[best] ? index : best,
                0,
            );
            const payload = {
                environmentKey,
                resolved,
                sensorRig,
                vehicles,
                uses,
                assets: [...bytesByDigest].map(([sha256, bytes]) => ({
                    sha256,
                    base64: bytes.toString("base64"),
                })),
            };
            const handle = await new Promise((resolve, reject) => {
                this.queue.push({
                    kind: "prepare-pbr",
                    requiredContext: slot,
                    payload,
                    resolve,
                    reject,
                    timeoutMs: 30_000,
                });
                this._drain();
            });
            const record = {
                ...handle,
                pageGeneration: handle.generation,
                generation: this.nextPbrGeneration++,
                resourceHashes: {
                    renderScene: resolved.renderScene.hash,
                    visualLayer: resolved.visualLayer?.hash || null,
                    world: resolved.world?.hash || null,
                    evidence: resolved.renderScene.description.evidenceHash || null,
                },
                slot,
                bytes: staticBytes,
                assetDigests: [...bytesByDigest.keys()].sort(),
                useHashes: [...new Set(uses.map((entry) => entry.useHash))].sort(),
                cameraAllocations: new Map(),
            };
            this.preparedPbr.set(environmentKey, record);
            if (assetReader) this.pbrAssetReaders.set(environmentKey, assetReader);
            this.pbrSlotLoads[slot] += 1;
            this.environmentBytes.set(environmentKey, staticBytes + analyticBytes);
            return publicPbrHandle(record);
        };
        const pending = this.pbrPreparationPromise.then(operation, operation);
        this.pbrPreparationPromise = pending.catch(() => {});
        return pending;
    }

    async capturePbrGroup({ environmentKey, handle, requests, maxGpuBytes, timeoutMs = 30_000 }) {
        if (this.closed) throw infrastructureError("GPU renderer pool is closed.");
        const prepared = this.preparedPbr.get(environmentKey);
        if (!prepared || handle?.environmentKey !== environmentKey
            || handle.generation !== prepared.generation
            || handle.renderSceneHash !== prepared.renderSceneHash) {
            throw supervisorError("INVALID_REQUEST", "The PBR renderer handle is stale or belongs to another environment.");
        }
        const checkedRequests = validatePbrRequests(requests, prepared);
        const assetReader = this.pbrAssetReaders.get(environmentKey);
        for (const useHash of prepared.useHashes) {
            await assetReader.authorizeUse(useHash, ["display", "machine-interpretation"]);
        }
        if (prepared.captureAllocations?.size > 0) {
            throw supervisorError("INVALID_REQUEST", "Concurrent PBR captures for one environment are unsupported.");
        }
        const cameraAllocations = new Map(prepared.cameraAllocations);
        for (const request of checkedRequests) {
            const bytes = pbrRetainedCameraBytes(request);
            cameraAllocations.set(request.id, Math.max(bytes, cameraAllocations.get(request.id) || 0));
        }
        const transientBytes = checkedRequests.reduce(
            (total, request) => total + pbrTransientCaptureBytes(request),
            0,
        );
        const analyticBytes = currentAnalyticBytes(this.analyticEnvironments.get(environmentKey));
        const allocation = pbrResidentBytes(prepared, cameraAllocations) + transientBytes;
        if (allocation + analyticBytes > maxGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", `PBR capture requires ${allocation} bytes; environment limit is ${maxGpuBytes}.`);
        }
        const others = [...this.environmentBytes.entries()]
            .filter(([key]) => key !== environmentKey)
            .reduce((total, [, value]) => total + value, 0);
        const environmentAllocation = Math.max(
            allocation,
            ...(prepared.captureAllocations?.values() || []),
        );
        if (others + environmentAllocation + analyticBytes > this.config.globalGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", "GPU renderer global allocation budget is exhausted.");
        }
        const allocationToken = Symbol(environmentKey);
        prepared.captureAllocations ??= new Map();
        prepared.captureAllocations.set(allocationToken, allocation);
        this.environmentBytes.set(environmentKey, analyticBytes + Math.max(
            prepared.bytes,
            ...prepared.captureAllocations.values(),
        ));
        const pending = new Promise((resolve, reject) => {
            this.queue.push({
                kind: "pbr",
                requiredContext: prepared.slot,
                environmentKey,
                requests: checkedRequests,
                resolve,
                reject,
                timeoutMs: Math.max(1, Number(timeoutMs) || 30_000),
            });
            this._drain();
        });
        return pending.then((result) => {
            const validated = validatePbrResults(checkedRequests, result);
            prepared.cameraAllocations = cameraAllocations;
            return validated;
        }).finally(() => {
            prepared.captureAllocations?.delete(allocationToken);
            if (this.preparedPbr.get(environmentKey) !== prepared) return;
            this.environmentBytes.set(environmentKey, currentAnalyticBytes(this.analyticEnvironments.get(environmentKey)) + Math.max(
                pbrResidentBytes(prepared),
                ...prepared.captureAllocations.values(),
            ));
        });
    }

    captureGroup(payload) {
        if (this.closed) return Promise.reject(infrastructureError("GPU renderer pool is closed."));
        const { environmentKey } = payload;
        if (!this.analyticLifetimes.has(environmentKey)) this.analyticLifetimes.set(environmentKey, Symbol(environmentKey));
        const lifetime = this.analyticLifetimes.get(environmentKey);
        const pending = (this.analyticOperations.get(environmentKey) || Promise.resolve())
            .catch(() => {}).then(() => this._captureAnalyticGroup(payload, lifetime));
        this.analyticOperations.set(environmentKey, pending);
        const clear = () => {
            if (this.analyticOperations.get(environmentKey) === pending) this.analyticOperations.delete(environmentKey);
        };
        pending.then(clear, clear);
        return pending;
    }

    async _captureAnalyticGroup({ environmentKey, scene, requests, maxGpuBytes, timeoutMs = 30_000, assetReader = null }, lifetime) {
        if (this.closed) throw infrastructureError("GPU renderer pool is closed.");
        if (this.adapter?.isRunning?.() === false) {
            this._invalidateAdapter(
                this.adapter,
                this.adapterGeneration,
                infrastructureError("Chromium renderer disconnected."),
            );
            await this.resetPromise;
        }
        for (const request of requests) {
            const liveCamera = request.type === "camera" && scene?.description?.objectMotion === LIVE_CAMERA_OBJECT_MOTION;
            if (request.type === "camera" && !liveCamera
                && (request.cameraObjectMotion === LIVE_CAMERA_OBJECT_MOTION || request.captureInput?.version === 2)) {
                throw new Error("Live camera motion requires a policy-bound render scene.");
            }
            if (liveCamera && request.captureInput?.version !== 2) {
                throw new Error("Live camera motion requires capture input v2.");
            }
            if (request.captureMode !== CORRECTED_VISUAL_CAPTURE_MODE && !liveCamera) continue;
            const captureInput = assertVisualCaptureInput(request.captureInput);
            if (liveCamera) snapshotCameraObjectPoses(captureInput.objectPoses, scene.description.objectMotionBindings);
            if (liveCamera && request.captureTimeNs !== captureInput.captureTimeNs) {
                throw new Error("Live camera request time must match its frozen capture input.");
            }
            if (request.width !== captureInput.calibration.image.width
                || request.height !== captureInput.calibration.image.height) {
                throw new Error("Corrected camera request dimensions must match its calibration.");
            }
            if ((liveCamera || captureInput.scene.descriptionHash) && captureInput.scene.descriptionHash !== scene?.hash) {
                throw new Error("Corrected camera request scene hash does not match the resolved scene.");
            }
        }
        requests = requests.map((request) => request.type === "camera" && request.captureInput?.version === 2
            ? { ...request, cameraObjectMotion: LIVE_CAMERA_OBJECT_MOTION, rigidBodyPoses: undefined }
            : request);
        const probe = await this.probe();
        if (!probe.available) throw infrastructureError(`GPU backend unavailable: ${probe.reason}`);
        const cached = this._cacheScene(scene);
        let owner = this.analyticEnvironments.get(environmentKey);
        if (owner?.releasePromise) {
            await owner.releasePromise;
            owner = this.analyticEnvironments.get(environmentKey);
        }
        const resources = analyticResources(owner?.resources, cached.description, requests, cached.hash);
        const scenes = new Map(owner?.scenes);
        scenes.set(cached.hash, cached.bytes + analyticTriangleCount(cached.description) * 112);
        const transientBytes = requests.reduce((total, request) => total + (request.type === "camera"
            ? Math.max(outputBytes(request), request.width * request.height * 12)
            : outputBytes(request)), 0);
        const retained = () => [...scenes.values()].reduce((total, bytes) => total + bytes, 0)
            + [...resources.values()].reduce((total, resource) => total + resource.bytes, 0);
        const requestedKeys = new Set(requests.map((request) => JSON.stringify([cached.hash, request.type, request.id])));
        const evictedKeys = [];
        const pbrBytes = currentPbrBytes(this.preparedPbr.get(environmentKey));
        for (const key of resources.keys()) {
            if (retained() + transientBytes + pbrBytes <= Math.min(maxGpuBytes, this.config.globalGpuBytes)) break;
            if (requestedKeys.has(key)) continue;
            const hash = resources.get(key).sceneHash;
            resources.delete(key);
            if (![...resources.values()].some((resource) => resource.sceneHash === hash)) scenes.delete(hash);
            evictedKeys.push(key);
        }
        const allocation = retained() + transientBytes + pbrBytes;
        if (allocation > maxGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", `GPU job requires ${allocation} bytes; environment limit is ${maxGpuBytes}.`);
        }
        const others = () => [...this.environmentBytes.entries()]
            .filter(([key]) => key !== environmentKey)
            .reduce((total, [, value]) => total + value, 0);
        for (const [key, entry] of this.analyticEnvironments) {
            if (others() + allocation <= this.config.globalGpuBytes) break;
            if (key !== environmentKey && !entry.active && !entry.releasePromise) await this._releaseAnalytic(key);
        }
        if (others() + allocation > this.config.globalGpuBytes) {
            throw supervisorError("RESOURCE_LIMIT", "GPU renderer global allocation budget is exhausted.");
        }
        if (this.closed || this.analyticLifetimes.get(environmentKey) !== lifetime) {
            throw infrastructureError("GPU capture was cancelled while releasing its environment.");
        }
        if (!owner) {
            const loads = Array.from({ length: this.config.contextPoolSize }, () => 0);
            for (const entry of this.analyticEnvironments.values()) loads[entry.slot] += 1;
            owner = { generation: this.nextAnalyticGeneration++, slot: loads.indexOf(Math.min(...loads)) };
        }
        owner.resources = resources;
        owner.scenes = scenes;
        owner.bytes = retained();
        owner.captureBytes = allocation - pbrBytes;
        owner.active = true;
        this.analyticEnvironments.delete(environmentKey);
        this.analyticEnvironments.set(environmentKey, owner);
        this.environmentBytes.set(environmentKey, allocation);
        return new Promise((resolve, reject) => {
            this.queue.push({
                kind: "analytic",
                environmentKey,
                analyticOwner: owner,
                lifetime,
                requiredContext: owner.slot,
                evictedKeys,
                cached,
                requests,
                resolve,
                reject,
                assetReader,
                timeoutMs: Math.max(1, Number(timeoutMs) || 30_000),
            });
            this._drain();
        }).finally(() => {
            owner.active = false;
            owner.captureBytes = 0;
            if (this.analyticEnvironments.get(environmentKey) !== owner) return;
            this.environmentBytes.set(environmentKey, owner.bytes + currentPbrBytes(this.preparedPbr.get(environmentKey)));
        });
    }

    async _releaseAnalytic(environmentKey) {
        const owner = this.analyticEnvironments.get(environmentKey);
        if (!owner) return;
        if (owner.releasePromise) return owner.releasePromise;
        if (!this.adapter?.releaseAnalytic) {
            this.analyticEnvironments.delete(environmentKey);
            const pbr = this.preparedPbr.get(environmentKey);
            if (pbr) this.environmentBytes.set(environmentKey, currentPbrBytes(pbr));
            else this.environmentBytes.delete(environmentKey);
            return;
        }
        owner.active = true;
        owner.releasePromise = new Promise((resolve, reject) => {
            this.queue.push({ kind: "release-analytic", environmentKey, requiredContext: owner.slot, resolve, reject, timeoutMs: 30_000 });
            this._drain();
        }).finally(() => {
            if (this.analyticEnvironments.get(environmentKey) !== owner) return;
            this.analyticEnvironments.delete(environmentKey);
            const pbr = this.preparedPbr.get(environmentKey);
            if (pbr) this.environmentBytes.set(environmentKey, currentPbrBytes(pbr));
            else this.environmentBytes.delete(environmentKey);
        });
        return owner.releasePromise;
    }

    _invalidateAdapter(adapter, generation, error) {
        if (this.adapter !== adapter || this.adapterGeneration !== generation) return;
        this.adapter = null;
        this.startPromise = null;
        this.probeResult = null;
        this.availableContexts = [];
        this.preparedPbr.clear();
        this.pbrAssetReaders.clear();
        this.pbrSlotLoads = [];
        this.analyticEnvironments.clear();
        this.analyticLifetimes.clear();
        const failure = infrastructureError(`GPU renderer must restart: ${error.message}`);
        for (const queued of this.queue.splice(0)) queued.reject(failure);
        const closing = Promise.resolve().then(() => adapter.close()).catch(() => {});
        let cleanup;
        cleanup = closing.finally(() => {
            this.environmentBytes.clear();
            if (this.resetPromise === cleanup) this.resetPromise = null;
        });
        this.resetPromise = cleanup;
    }

    _drain() {
        while (this.availableContexts.length > 0 && this.queue.length > 0) {
            const jobIndex = this.queue.findIndex((entry) => (
                entry.requiredContext === undefined || this.availableContexts.includes(entry.requiredContext)
            ));
            if (jobIndex < 0) return;
            const job = this.queue.splice(jobIndex, 1)[0];
            const contextIndex = job.requiredContext === undefined
                ? 0
                : this.availableContexts.indexOf(job.requiredContext);
            const context = this.availableContexts.splice(contextIndex, 1)[0];
            const adapter = this.adapter;
            const generation = this.adapterGeneration;
            this.busyContexts += 1;
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(infrastructureError(
                    `GPU capture exceeded its ${job.timeoutMs}-ms wall timeout.`,
                )), job.timeoutMs);
            });
            let capture;
            if (job.kind === "prepare-pbr") capture = adapter.preparePbr(job.payload, context);
            else if (job.kind === "release-pbr") capture = adapter.releasePbr(job.environmentKey);
            else if (job.kind === "release-analytic") capture = adapter.releaseAnalytic(job.environmentKey);
            else if (job.kind === "pbr") capture = adapter.capturePbr(job.environmentKey, job.requests);
            else {
                capture = adapter.captureGroup(job.cached.description, job.requests, context, {
                    assetReader: job.assetReader,
                    environmentKey: job.environmentKey,
                    sceneHash: job.cached.hash,
                    generation: job.analyticOwner.generation,
                    evictedKeys: job.evictedKeys,
                });
            }
            Promise.race([capture, timeout])
                .then((result) => {
                    if (job.kind === "analytic" && (this.analyticEnvironments.get(job.environmentKey) !== job.analyticOwner
                        || this.analyticLifetimes.get(job.environmentKey) !== job.lifetime)) {
                        job.reject(infrastructureError("GPU capture belongs to a released environment."));
                        return;
                    }
                    job.resolve(result);
                })
                .catch((error) => {
                    job.reject(error);
                    this._invalidateAdapter(adapter, generation, error);
                })
                .finally(() => {
                    clearTimeout(timer);
                    this.busyContexts -= 1;
                    if (this.adapter === adapter && this.adapterGeneration === generation) {
                        this.availableContexts.push(context);
                        this.availableContexts.sort((left, right) => left - right);
                    }
                    this._drain();
                });
        }
    }

    async releasePbr(environmentKey) {
        const prepared = this.preparedPbr.get(environmentKey);
        if (!prepared) return false;
        this.preparedPbr.delete(environmentKey);
        this.pbrAssetReaders.delete(environmentKey);
        this.pbrSlotLoads[prepared.slot] = Math.max(0, this.pbrSlotLoads[prepared.slot] - 1);
        const cancellation = infrastructureError("PBR capture was cancelled while releasing its environment.");
        this.queue = this.queue.filter((job) => {
            if (job.kind !== "pbr" || job.environmentKey !== environmentKey) return true;
            job.reject(cancellation);
            return false;
        });
        if (this.adapter?.releasePbr) {
            await new Promise((resolve, reject) => {
                this.queue.push({
                    kind: "release-pbr",
                    requiredContext: prepared.slot,
                    environmentKey,
                    resolve,
                    reject,
                    timeoutMs: 30_000,
                });
                this._drain();
            });
        }
        const analyticBytes = currentAnalyticBytes(this.analyticEnvironments.get(environmentKey));
        if (analyticBytes) this.environmentBytes.set(environmentKey, analyticBytes);
        else this.environmentBytes.delete(environmentKey);
        return true;
    }

    releaseEnvironment(environmentKey) {
        this.analyticLifetimes.delete(environmentKey);
        const cancellation = infrastructureError("GPU capture was cancelled while releasing its environment.");
        this.queue = this.queue.filter((job) => {
            if (job.kind !== "analytic" || job.environmentKey !== environmentKey) return true;
            job.reject(cancellation);
            return false;
        });
        const analytic = this._releaseAnalytic(environmentKey);
        const pbr = this.releasePbr(environmentKey);
        if (!this.analyticEnvironments.has(environmentKey)) this.environmentBytes.delete(environmentKey);
        const pending = Promise.all([analytic, pbr]).then(() => {
            if (!this.analyticEnvironments.has(environmentKey) && !this.preparedPbr.has(environmentKey)) this.environmentBytes.delete(environmentKey);
        });
        pending.catch(() => {});
        return pending;
    }

    diagnostics() {
        return {
            browserLaunches: this.browserLaunches,
            contextCount: this.browserLaunches > 0 ? this.config.contextPoolSize : 0,
            busyContexts: this.busyContexts,
            queuedJobs: this.queue.length,
            sceneCount: this.scenes.size,
            sceneBytes: this.sceneBytes,
            preparedPbrEnvironments: this.preparedPbr.size,
            pbrSlotLoads: [...this.pbrSlotLoads],
            pbrCapability: this.pbrCapability(),
            trackedGpuBytes: [...this.environmentBytes.values()].reduce((total, value) => total + value, 0),
            provenance: this.probeResult?.provenance || null,
        };
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        const error = infrastructureError("GPU renderer pool closed.");
        for (const job of this.queue.splice(0)) job.reject(error);
        await this.resetPromise;
        await this.adapter?.close().catch(() => {});
        this.adapter = null;
        this.environmentBytes.clear();
        this.preparedPbr.clear();
        this.pbrAssetReaders.clear();
        this.pbrSlotLoads = [];
        this.scenes.clear();
        this.sceneBytes = 0;
        this.analyticEnvironments.clear();
        this.analyticLifetimes.clear();
    }
}
