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
        if (relative.endsWith(".png") || relative.endsWith(".bin")) {
            await route.fulfill({
                status: 200,
                contentType: relative.endsWith(".png") ? "image/png" : "application/octet-stream",
                body: await readFile(`${repositoryRoot}/${relative}`),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: await readFile(`${repositoryRoot}/${relative}`, "utf8"),
        });
    });
}

test("worker-safe cloud texture loader yields stable beauty/depth/id captures", async ({ page }) => {
    test.setTimeout(180_000);
    await installModuleRoutes(page);
    await page.goto("/");
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
        // Mirror PbrAppearanceSky.loadImageBitmapTexture without importing Takram.
        async function loadImageBitmapTexture(url) {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Cloud texture load failed (${response.status}): ${url}`);
            const bitmap = await createImageBitmap(await response.blob(), {
                colorSpaceConversion: "none",
                premultiplyAlpha: "none",
            });
            try {
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = canvas.getContext("2d", {
                    alpha: true,
                    colorSpace: "srgb",
                    willReadFrequently: true,
                });
                context.drawImage(bitmap, 0, 0);
                const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
                const flipped = new Uint8ClampedArray(data.length);
                const stride = width * 4;
                for (let y = 0; y < height; y += 1) {
                    flipped.set(data.subarray(y * stride, y * stride + stride), (height - 1 - y) * stride);
                }
                const texture = new THREE.DataTexture(flipped, width, height, THREE.RGBAFormat);
                texture.flipY = false;
                texture.colorSpace = THREE.NoColorSpace;
                texture.needsUpdate = true;
                return texture;
            } finally {
                bitmap.close?.();
            }
        }

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

        const weatherUrl = "/test-modules/node_modules/@takram/three-clouds/assets/local_weather.png";

        function digest(view) {
            if (!view) return null;
            let hash = 2166136261;
            for (let index = 0; index < view.length; index += 1) {
                hash ^= view[index] & 0xff;
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16).padStart(8, "0");
        }

        function createRenderer() {
            const canvas = document.createElement("canvas");
            canvas.width = 32;
            canvas.height = 18;
            const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
            if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
                throw new Error("WebGL2 float color buffers are required.");
            }
            return new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: true });
        }

        async function installParitySky({ scene, loadImageTexture }) {
            const texture = await loadImageTexture(weatherUrl);
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                depthWrite: false,
                depthTest: false,
                side: THREE.DoubleSide,
            });
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), material);
            quad.position.set(0, 2, -4);
            quad.userData.cevSimSky = true;
            quad.userData.cevSimRenderRuntimeOwned = true;
            const group = new THREE.Group();
            group.userData.cevSimSky = true;
            group.add(quad);
            scene.add(group);
            return { texture };
        }

        async function captureOnce() {
            const renderer = createRenderer();
            const resolved = resolvedPbrRun({
                sky: {
                    mode: "takram",
                    takram: {
                        timeOfDay: 14,
                        date: "2026-06-28",
                        cloudsEnabled: true,
                        cloudQuality: "low",
                    },
                },
            });
            const vehicle = {
                telemetryId: "ego",
                position: new THREE.Vector3(0, 0, 0),
                rotation: new THREE.Euler(0, 0, 0),
            };
            let injected = false;
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
                // Same injection shape as browserPbrCapture.worker.js.
                installTakramSky: (args) => {
                    injected = true;
                    return installParitySky({
                        ...args,
                        loadImageTexture: loadImageBitmapTexture,
                    });
                },
            });
            try {
                await runtime.prepare(resolved, {
                    sensorRig: { sensors: [] },
                    vehicles: [vehicle],
                });
                const camera = new THREE.PerspectiveCamera(60, 32 / 18, 0.1, 100);
                camera.position.set(0, 2, 6);
                camera.lookAt(0, 0, 0);
                camera.updateMatrixWorld(true);
                const options = runtime.cameraOptions();
                const products = new CameraRenderProducts({
                    renderer,
                    scene: runtime.appearanceScene,
                    camera,
                    captureMode: "calibrated-projection@1",
                    calibration: createVisualCameraCalibration({
                        width: 32,
                        height: 18,
                        intrinsics: { fx: 24, fy: 24, cx: 16, cy: 9 },
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
                products.dispose();
                return {
                    injected,
                    beauty: digest(captured.visual?.products?.beauty),
                    validity: digest(captured.visual?.products?.validity),
                    depth: digest(captured.analytic?.products?.axialDepth),
                    semantic: digest(captured.analytic?.products?.semanticId),
                    instance: digest(captured.analytic?.products?.instanceId),
                };
            } finally {
                runtime.dispose();
                renderer.dispose();
                renderer.forceContextLoss?.();
            }
        }

        const first = await captureOnce();
        const second = await captureOnce();
        const textureA = await loadImageBitmapTexture(weatherUrl);
        const textureB = await loadImageBitmapTexture(weatherUrl);
        const bytesEqual = textureA.image.data.length === textureB.image.data.length
            && textureA.image.data.every((value, index) => value === textureB.image.data[index]);
        textureA.dispose();
        textureB.dispose();
        return { first, second, bytesEqual };
    });

    expect(result.bytesEqual).toBe(true);
    expect(result.first.injected).toBe(true);
    expect(result.first.beauty).toBeTruthy();
    expect(result.second).toEqual(result.first);
});
