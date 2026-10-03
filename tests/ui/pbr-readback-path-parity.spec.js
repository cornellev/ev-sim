import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repositoryRoot = process.cwd();

async function installModuleRoutes(page) {
    await page.route("**/test-modules/**", async (route) => {
        const marker = "/test-modules/";
        const pathname = new URL(route.request().url()).pathname;
        const relative = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
        if (relative.split("/").includes("..")) {
            await route.abort();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: await readFile(`${repositoryRoot}/${relative}`, "utf8"),
        });
    });
}

// Both readback paths need hardware WebGL2 fences; SwiftShader is not admitted.
test.use({ launchOptions: { args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=default"] } });

test("pipelined PBO readback matches injected fenced readback bytes", async ({ page }) => {
    test.setTimeout(180_000);
    await installModuleRoutes(page);
    await page.goto("/");
    const softwareRenderer = await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const debug = gl?.getExtension("WEBGL_debug_renderer_info");
        const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
        return !gl || /swiftshader/i.test(renderer);
    });
    test.skip(softwareRenderer, "Hardware WebGL2 is unavailable; PBO/fence readback is not admitted on SwiftShader.");
    await page.setContent(`<script type="importmap">${JSON.stringify({ imports: {
        "@/": "/test-modules/",
        three: "/test-modules/node_modules/three/build/three.module.js",
        "three/addons/": "/test-modules/node_modules/three/examples/jsm/",
        "three/": "/test-modules/node_modules/three/",
        postprocessing: "/test-modules/node_modules/postprocessing/build/index.js",
        "@noble/hashes/sha2.js": "/test-modules/node_modules/@noble/hashes/sha2.js",
        "@noble/hashes/utils.js": "/test-modules/node_modules/@noble/hashes/utils.js",
        "node:crypto": "/test-modules/tests/helpers/browserCryptoShim.js",
        semver: "/test-modules/tests/helpers/browserSemverShim.js",
        "@sparkjsdev/spark": "/test-modules/node_modules/@sparkjsdev/spark/dist/spark.module.js",
        acorn: "/test-modules/node_modules/acorn/dist/acorn.mjs",
        "@takram/three-atmosphere": "/test-modules/node_modules/@takram/three-atmosphere/build/index.js",
        "@takram/three-atmosphere/shaders": "/test-modules/node_modules/@takram/three-atmosphere/build/shaders.js",
        "@takram/three-atmosphere/shaders/bruneton": "/test-modules/node_modules/@takram/three-atmosphere/build/shaders/bruneton.js",
        "@takram/three-clouds": "/test-modules/node_modules/@takram/three-clouds/build/index.js",
        "@takram/three-geospatial": "/test-modules/node_modules/@takram/three-geospatial/build/index.js",
        "@takram/three-geospatial/shaders": "/test-modules/node_modules/@takram/three-geospatial/build/shaders.js",
        "@takram/three-geospatial-effects": "/test-modules/node_modules/@takram/three-geospatial-effects/build/index.js",
        "three-mesh-bvh": "/test-modules/node_modules/three-mesh-bvh/src/index.js",
    } })}</script>`);

    const result = await page.evaluate(async () => {
        const THREE = await import("three");
        const { BrowserPbrRenderRuntime } = await import(
            "/test-modules/app/3d/perception/BrowserPbrRenderRuntime.js"
        );
        const { CameraRenderProducts } = await import(
            "/test-modules/app/3d/perception/CameraRenderProducts.js"
        );
        const {
            createVisualCameraCalibration,
            createVisualCaptureInput,
            createVisualCapturePassSet,
            VISUAL_CAPTURE_PASS_FAMILIES,
        } = await import("/test-modules/app/3d/environment/visual/VisualCapturePipeline.js");
        const { resolvedPbrRun } = await import("/test-modules/tests/helpers/pbrResolved.js");
        const { readRenderTargetPixelsWithFence } = await import("/test-modules/app/3d/util/glReadback.js");

        function digest(view) {
            if (!view) return null;
            let hash = 2166136261;
            for (let index = 0; index < view.length; index += 1) {
                hash ^= view[index] & 0xff;
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16).padStart(8, "0");
        }

        function bytesEqual(left, right) {
            if (!left || !right || left.length !== right.length) return false;
            for (let index = 0; index < left.length; index += 1) {
                if (left[index] !== right[index]) return false;
            }
            return true;
        }

        function createRenderer() {
            const canvas = document.createElement("canvas");
            canvas.width = 64;
            canvas.height = 36;
            const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
            if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
                throw new Error("WebGL2 float color buffers are required.");
            }
            return new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: true });
        }

        async function captureOnce({ alignedReadback }) {
            const renderer = createRenderer();
            const resolved = resolvedPbrRun();
            const vehicle = {
                telemetryId: "ego",
                position: new THREE.Vector3(0, 0, 0),
                rotation: new THREE.Euler(0, 0, 0),
            };
            const runtime = new BrowserPbrRenderRuntime({
                renderer,
                assetClient: {
                    async validateClosure() { return { allowed: true }; },
                    async validateAccessSet() { return { allowed: true }; },
                },
                materializerFactory: (options) => ({
                    async replaceResolved() {
                        return {
                            status: "ready",
                            error: null,
                            residency: {
                                requiredChunkIds: [],
                                residentChunkIds: [],
                                queuedChunkIds: [],
                                requiredChunks: 0,
                                residentChunks: 0,
                                queuedChunks: 0,
                                prefetchShed: 0,
                                pressure: {},
                            },
                        };
                    },
                    async updateInterest() { return this.replaceResolved(); },
                    residencySnapshot() {
                        return {
                            requiredChunkIds: [],
                            residentChunkIds: [],
                            queuedChunkIds: [],
                            requiredChunks: 0,
                            residentChunks: 0,
                            queuedChunks: 0,
                            prefetchShed: 0,
                            pressure: {},
                        };
                    },
                    async materializeAssetUse() {
                        const root = new THREE.Group();
                        options.previewRoot?.add?.(root);
                        return { root, release() { root.removeFromParent(); } };
                    },
                    dispose() {},
                }),
                vehicles: () => [vehicle],
            });
            try {
                await runtime.prepare(resolved, {
                    sensorRig: { sensors: [] },
                    vehicles: [vehicle],
                });
                const camera = new THREE.PerspectiveCamera(60, 64 / 36, 0.1, 100);
                camera.position.set(2, 4, 8);
                camera.lookAt(5, 0, 0);
                camera.updateMatrixWorld(true);
                const options = runtime.cameraOptions();
                const products = new CameraRenderProducts({
                    renderer,
                    scene: runtime.appearanceScene,
                    camera,
                    captureMode: "calibrated-projection@1",
                    calibration: createVisualCameraCalibration({
                        width: 64,
                        height: 36,
                        intrinsics: { fx: 48, fy: 48, cx: 32, cy: 18 },
                        near: 0.1,
                        far: 100,
                        distortionModel: "none",
                        distortion: [],
                    }),
                    sceneHandle: options.captureSceneHandle,
                    analyticSceneHandle: options.analyticSceneHandle,
                    authorizeSourceUse: options.authorizeSourceUse,
                    renderPolicy: options.renderPolicy,
                    rendererLease: options.rendererLease,
                    alignedReadback,
                });
                const captureInput = createVisualCaptureInput({
                    calibration: products.calibration,
                    pose: {
                        matrixWorld: camera.matrixWorld.elements,
                        quaternion: camera.quaternion,
                    },
                    sceneHandle: options.captureSceneHandle,
                    captureTimeNs: 0,
                });
                const visualPassSet = createVisualCapturePassSet({
                    family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
                    captureInput,
                    products: ["beauty", "validity"],
                    bindings: [],
                    sourceUseHashes: runtime.rootUseHashes,
                });
                const analyticInput = createVisualCaptureInput({
                    calibration: products.calibration,
                    pose: captureInput.pose,
                    sceneHandle: options.analyticSceneHandle,
                    captureTimeNs: 0,
                });
                const analyticPassSet = createVisualCapturePassSet({
                    family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
                    captureInput: analyticInput,
                    products: ["axial-depth", "semantic-id", "instance-id", "validity"],
                    bindings: runtime.analyticBindings,
                });
                const captured = await products.captureAlignedProducts({
                    visualPassSet,
                    visualRenderables: new Map(),
                    analyticPassSet,
                    analyticRenderables: runtime.analyticRenderables,
                    signal: new AbortController().signal,
                });
                const pipelined = products._alignedProducts?._pipelinesReads?.() ?? null;
                products.dispose();
                return {
                    pipelined,
                    beauty: captured.visual?.products?.beauty
                        ? new Uint8Array(captured.visual.products.beauty.buffer.slice(0))
                        : null,
                    validity: captured.visual?.products?.validity
                        ? new Uint8Array(captured.visual.products.validity.buffer.slice(0))
                        : null,
                    depth: captured.analytic?.products?.axialDepth
                        ? new Uint8Array(captured.analytic.products.axialDepth.buffer.slice(0))
                        : null,
                    semantic: captured.analytic?.products?.semanticId
                        ? new Uint8Array(captured.analytic.products.semanticId.buffer.slice(0))
                        : null,
                    instance: captured.analytic?.products?.instanceId
                        ? new Uint8Array(captured.analytic.products.instanceId.buffer.slice(0))
                        : null,
                    digests: {
                        beauty: digest(captured.visual?.products?.beauty),
                        validity: digest(captured.visual?.products?.validity),
                        depth: digest(captured.analytic?.products?.axialDepth),
                        semantic: digest(captured.analytic?.products?.semanticId),
                        instance: digest(captured.analytic?.products?.instanceId),
                    },
                };
            } finally {
                runtime.dispose();
                renderer.dispose();
                renderer.forceContextLoss?.();
            }
        }

        const fenced = await captureOnce({ alignedReadback: readRenderTargetPixelsWithFence });
        const pipelined = await captureOnce({ alignedReadback: null });
        return {
            fencedPipelined: fenced.pipelined,
            pipelinedPipelined: pipelined.pipelined,
            equal: {
                beauty: bytesEqual(pipelined.beauty, fenced.beauty),
                validity: bytesEqual(pipelined.validity, fenced.validity),
                depth: bytesEqual(pipelined.depth, fenced.depth),
                semantic: bytesEqual(pipelined.semantic, fenced.semantic),
                instance: bytesEqual(pipelined.instance, fenced.instance),
            },
            digests: { fenced: fenced.digests, pipelined: pipelined.digests },
        };
    });

    expect(result.fencedPipelined).toBe(false);
    expect(result.pipelinedPipelined).toBe(true);
    expect(result.digests.pipelined.semantic).not.toBeNull();
    expect(result.digests.pipelined.instance).not.toBeNull();
    expect(result.equal).toEqual({
        beauty: true,
        validity: true,
        depth: true,
        semantic: true,
        instance: true,
    });
});
