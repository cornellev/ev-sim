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

test("production calibrated capture isolates measured and analytic scenes from preview mutations", async ({ page }) => {
    test.setTimeout(60_000);
    await installModuleRoutes(page);
    await page.goto("/");
    await page.setContent(`<script type="importmap">${JSON.stringify({
        imports: {
            three: "/test-modules/node_modules/three/build/three.module.js",
            "@noble/hashes/sha2.js": "/test-modules/node_modules/@noble/hashes/sha2.js",
            "@noble/hashes/utils.js": "/test-modules/node_modules/@noble/hashes/utils.js",
        },
    })}</script>`);
    const result = await page.evaluate(async () => {
        const THREE = await import("three");
        const {
            CameraRenderProducts,
        } = await import("/test-modules/app/3d/perception/CameraRenderProducts.js");
        const {
            CORRECTED_VISUAL_CAPTURE_MODE,
            createOwnedCaptureScene,
            createVisualCameraCalibration,
            createVisualCaptureInput,
            createVisualCapturePassSet,
            projectWorldPoint,
            VISUAL_CAPTURE_PASS_FAMILIES,
        } = await import("/test-modules/app/3d/environment/visual/VisualCapturePipeline.js");

        const width = 8;
        const height = 6;
        const calibration = createVisualCameraCalibration({
            width,
            height,
            intrinsics: { fx: 5, fy: 7, cx: 2.25, cy: 1.75 },
            near: 0.1,
            far: 20,
            distortionModel: "none",
            distortion: [],
        });
        const mount = new THREE.Matrix4().compose(
            new THREE.Vector3(3, 1, -2),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, 0.35, -0.12)),
            new THREE.Vector3(1, 1, 1),
        );

        const measuredScene = new THREE.Scene();
        const measuredGroup = new THREE.Group();
        measuredGroup.matrixAutoUpdate = false;
        measuredGroup.matrix.copy(mount);
        const measuredMaterial = new THREE.MeshBasicMaterial({ color: 0x168a45 });
        const measuredSurface = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), measuredMaterial);
        measuredSurface.position.z = -4;
        measuredGroup.add(measuredSurface);
        measuredScene.add(measuredGroup);
        measuredScene.updateMatrixWorld(true);

        const analyticScene = new THREE.Scene();
        const analyticGroup = new THREE.Group();
        analyticGroup.matrixAutoUpdate = false;
        analyticGroup.matrix.copy(mount);
        const analyticMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const analyticSurface = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), analyticMaterial);
        analyticSurface.position.z = -3;
        analyticGroup.add(analyticSurface);
        analyticScene.add(analyticGroup);
        analyticScene.updateMatrixWorld(true);

        const previewScene = new THREE.Scene();
        previewScene.background = new THREE.Color(0x87ceeb);
        const previewMaterial = new THREE.MeshBasicMaterial({ color: 0x2255aa });
        const previewAsset = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), previewMaterial);
        previewScene.add(previewAsset);
        previewScene.userData.assets = ["preview-a"];
        previewScene.userData.bakeOverlays = [];

        const measuredHandle = createOwnedCaptureScene({
            role: "measured-appearance",
            scene: measuredScene,
            generation: 7,
            descriptionHash: "measured-v7",
        });
        const analyticHandle = createOwnedCaptureScene({
            role: "analytic-truth",
            scene: analyticScene,
            generation: 3,
            descriptionHash: "analytic-v3",
        });
        const makePassSets = (captureTimeNs) => ({
            visualPassSet: createVisualCapturePassSet({
                family: VISUAL_CAPTURE_PASS_FAMILIES.visual,
                captureInput: createVisualCaptureInput({
                    calibration,
                    pose: { matrixWorld: mount.elements },
                    sceneHandle: measuredHandle,
                    captureTimeNs,
                }),
                bindings: [{
                    renderableId: "measured-surface",
                    objectKey: "measured-surface",
                    materialKeys: ["unlit-green"],
                }],
                sourceUseHashes: ["a".repeat(64)],
            }),
            analyticPassSet: createVisualCapturePassSet({
                family: VISUAL_CAPTURE_PASS_FAMILIES.analytic,
                captureInput: createVisualCaptureInput({
                    calibration,
                    pose: { matrixWorld: mount.elements },
                    sceneHandle: analyticHandle,
                    captureTimeNs,
                }),
                bindings: [{ renderableId: "analytic-surface", semanticId: 9, instanceId: 90 }],
            }),
        });

        const canvas = document.createElement("canvas");
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        const camera = new THREE.PerspectiveCamera();
        let pauseAuthorization = false;
        let releaseAuthorization = null;
        let gate = null;
        const adapter = new CameraRenderProducts({
            renderer,
            camera,
            captureMode: CORRECTED_VISUAL_CAPTURE_MODE,
            calibration,
            sceneHandle: measuredHandle,
            analyticSceneHandle: analyticHandle,
            authorizeSourceUse: async () => {
                if (pauseAuthorization) await gate;
            },
        });
        const capture = async (captureTimeNs) => {
            const passSets = makePassSets(captureTimeNs);
            const output = await adapter.captureAlignedProducts({
                ...passSets,
                visualRenderables: new Map([["measured-surface", measuredSurface]]),
                analyticRenderables: new Map([["analytic-surface", analyticSurface]]),
                signal: new AbortController().signal,
            });
            return {
                beauty: [...output.visual.products.beauty],
                depth: [...output.visual.products.axialDepth],
                object: [...output.visual.products.objectId],
                analyticDepth: [...output.analytic.products.axialDepth],
                semantic: [...output.analytic.products.semanticId],
            };
        };

        const before = await capture(1_000_000_001);
        pauseAuthorization = true;
        gate = new Promise((resolve) => { releaseAuthorization = resolve; });
        const pending = capture(1_000_000_002);
        while (!releaseAuthorization) await Promise.resolve();
        previewScene.userData.assets.push("preview-b");
        previewScene.background.set(0x02030a);
        previewMaterial.color.set(0xff00ff);
        previewAsset.visible = false;
        previewScene.userData.bakeOverlays.push("mask", "splat");
        releaseAuthorization();
        const during = await pending;
        pauseAuthorization = false;
        const after = await capture(1_000_000_003);

        const localOptical = new THREE.Vector3(0.5, -0.25, -4);
        const worldPoint = localOptical.clone().applyMatrix4(mount);
        const pipelinePixel = projectWorldPoint(worldPoint, calibration, { matrixWorld: mount.elements });
        camera.matrixAutoUpdate = false;
        camera.matrix.copy(mount);
        camera.matrixWorld.copy(mount);
        camera.matrixWorldInverse.copy(mount).invert();
        const ndc = worldPoint.clone().project(camera);
        const adapterPixel = {
            u: (ndc.x + 1) * width / 2 - 0.5,
            v: (1 - ndc.y) * height / 2 - 0.5,
        };

        const response = {
            before,
            during,
            after,
            preview: {
                assets: previewScene.userData.assets,
                background: previewScene.background.getHex(),
                material: previewMaterial.color.getHex(),
                visible: previewAsset.visible,
                bakeOverlays: previewScene.userData.bakeOverlays,
            },
            pipelinePixel,
            adapterPixel,
        };
        adapter.dispose();
        renderer.dispose();
        measuredSurface.geometry.dispose();
        measuredMaterial.dispose();
        analyticSurface.geometry.dispose();
        analyticMaterial.dispose();
        previewAsset.geometry.dispose();
        previewMaterial.dispose();
        return response;
    });

    expect(result.during).toEqual(result.before);
    expect(result.after).toEqual(result.before);
    expect(result.before.beauty.some((value) => value !== 0)).toBe(true);
    expect(result.before.depth.every((value) => Math.abs(value - 4) < 0.001)).toBe(true);
    expect(result.before.analyticDepth.every((value) => Math.abs(value - 3) < 0.001)).toBe(true);
    expect(result.before.semantic.every((value) => value === 9)).toBe(true);
    expect(result.preview).toEqual({
        assets: ["preview-a", "preview-b"],
        background: 0x02030a,
        material: 0xff00ff,
        visible: false,
        bakeOverlays: ["mask", "splat"],
    });
    expect(result.pipelinePixel.pixel.x).toBeCloseTo(2.875, 6);
    expect(result.pipelinePixel.pixel.y).toBeCloseTo(2.1875, 6);
    expect(result.adapterPixel.u).toBeCloseTo(result.pipelinePixel.pixel.x, 6);
    expect(result.adapterPixel.v).toBeCloseTo(result.pipelinePixel.pixel.y, 6);
});

test("VIS-14 browser PBR runtime captures measured RGB and analytic oracle products", async ({ page }) => {
    test.setTimeout(120_000);
    await installModuleRoutes(page);
    await page.goto("/");
    await page.setContent(`<script type="importmap">${JSON.stringify({
        imports: {
            three: "/test-modules/node_modules/three/build/three.module.js",
            "@noble/hashes/sha2.js": "/test-modules/node_modules/@noble/hashes/sha2.js",
            "@noble/hashes/utils.js": "/test-modules/node_modules/@noble/hashes/utils.js",
        },
    })}</script>`);
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
        } = await import(
            "/test-modules/app/3d/environment/visual/VisualCapturePipeline.js"
        );
        const {
            createPbrRenderSceneResource,
            defaultPbrRenderRecipe,
            normalizePbrAssetClosure,
            normalizePbrRunEvidence,
        } = await import("/test-modules/app/simulation/render/PbrRenderScene.js");
        const {
            hashVisualLayer,
            hashVisualLayerAccess,
            normalizeVisualLayer,
            normalizeVisualLayerAccess,
        } = await import("/test-modules/app/simulation/visual/VisualLayer.js");
        const { createWorldResource } = await import(
            "/test-modules/app/simulation/world/WorldDescription.js"
        );
        const { getBuiltInVehicleManifest } = await import(
            "/test-modules/app/vehicles/BuiltInVehicleManifests.js"
        );

        const environment = {
            environmentId: "vis14-browser",
            name: "VIS-14 browser",
            schemaVersion: 2,
            templateId: "blank",
            roadStylePreset: "default",
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
            document: {
                environmentId: "vis14-browser",
                chunkSize: 20,
                roads: {
                    nodes: [{ id: "a", x: 20, z: 20 }, { id: "b", x: 30, z: 20 }],
                    edges: [{ id: "road", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 4, laneCount: 1 }],
                },
                buildings: [],
                features: [],
                earth: null,
                roadsAuthored: true,
                buildingsAuthored: true,
                featuresAuthored: false,
            },
        };
        const world = createWorldResource(environment);
        const visualDescription = normalizeVisualLayer({
            sourceWorldHash: world.hash,
            assets: [], materials: [], chunks: [], instances: [], bindings: [], appearanceDependencies: [],
        });
        const visualLayer = { description: visualDescription, hash: hashVisualLayer(visualDescription) };
        const access = normalizeVisualLayerAccess({ descriptorHash: visualLayer.hash, assets: [] });
        const renderScene = createPbrRenderSceneResource({
            worldResource: world,
            vehicleDependencies: [{ actorId: "ego", manifest: getBuiltInVehicleManifest("big-car") }],
            selection: {
                provider: { id: "pbr-mesh", version: 1 },
                productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
            },
            visualLayerResource: visualLayer,
            renderRecipe: defaultPbrRenderRecipe(),
            assetClosure: normalizePbrAssetClosure({ assets: [] }),
        });
        const evidence = normalizePbrRunEvidence({
            visualAssets: {
                descriptorHash: visualLayer.hash,
                accessHash: hashVisualLayerAccess(access),
                access,
                roots: [],
                uses: [],
                assetClosureHash: renderScene.description.assetClosureHash,
                permissions: {
                    operations: ["display", "machine-interpretation"],
                    evaluatedSourceIds: [],
                    obligations: { attribution: [], requirements: [], retentionUntil: null },
                },
            },
            correspondence: null,
        });
        const vehicle = {
            telemetryId: "ego",
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
        };
        const residency = {
            requiredChunkIds: [], residentChunkIds: [], queuedChunkIds: [],
            requiredChunks: 0, residentChunks: 0, queuedChunks: 0,
            prefetchShed: 0, pressure: {},
        };
        const runtime = new BrowserPbrRenderRuntime({
            renderer: null,
            assetClient: { async validateClosure() {} },
            materializerFactory: () => ({
                async replaceResolved() { return { status: "ready", error: null, residency }; },
                async updateInterest() { return { status: "ready", error: null, residency }; },
                residencySnapshot() { return residency; },
                dispose() {},
            }),
            vehicles: () => [vehicle],
        });
        const width = 16;
        const height = 12;
        const canvas = document.createElement("canvas");
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        runtime.renderer = renderer;
        await runtime.prepare({ world, visualLayer, renderScene, evidence });
        const calibration = createVisualCameraCalibration({
            width,
            height,
            intrinsics: { fx: 14, fy: 14, cx: 7.5, cy: 5.5 },
            near: 0.1,
            far: 20,
            distortionModel: "none",
            distortion: [],
        });
        const camera = new THREE.PerspectiveCamera();
        const cameraMatrix = new THREE.Matrix4().makeTranslation(0, 0.7, 5);
        const options = runtime.cameraOptions();
        const products = new CameraRenderProducts({
            renderer,
            camera,
            captureMode: options.captureMode,
            calibration,
            sceneHandle: options.captureSceneHandle,
            analyticSceneHandle: options.analyticSceneHandle,
            authorizeSourceUse: options.authorizeSourceUse,
            renderPolicy: options.renderPolicy,
        });
        const capture = async (captureTimeNs) => runtime.captureCamera({
            captureInput: createVisualCaptureInput({
                calibration,
                pose: { matrixWorld: cameraMatrix.elements },
                sceneHandle: runtime.appearanceSceneHandle,
                captureTimeNs,
            }),
            enabled: { rgb: true, depth: true, semantic: true, instance: true },
            renderProducts: products,
            signal: new AbortController().signal,
        });
        await runtime.prepareCapture({
            devices: [{ renderRuntime: runtime, getPosition: () => new THREE.Vector3(0, 0.7, 5) }],
            vehicles: [vehicle],
        });
        const before = await capture(41);
        const preview = new THREE.Scene();
        preview.background = new THREE.Color(0xff00ff);
        preview.add(new THREE.Mesh(
            new THREE.BoxGeometry(100, 100, 100),
            new THREE.MeshBasicMaterial({ color: 0x00ffff }),
        ));
        preview.children[0].visible = false;
        const after = await capture(42);
        const response = {
            rgbBefore: [...before.rgb],
            rgbAfter: [...after.rgb],
            finiteDepth: [...before.depth].filter(Number.isFinite),
            semantic: [...before.semantic],
            instance: [...before.instance],
            status: runtime.status,
        };
        products.dispose();
        runtime.dispose();
        renderer.dispose();
        preview.traverse((object) => {
            object.geometry?.dispose?.();
            object.material?.dispose?.();
        });
        return response;
    });

    expect(result.rgbBefore).toEqual(result.rgbAfter);
    expect(result.rgbBefore.some((value) => value !== 0)).toBe(true);
    expect(result.finiteDepth.length).toBeGreaterThan(0);
    expect(result.semantic.some((value) => value !== 0)).toBe(true);
    expect(result.instance.some((value) => value !== 0)).toBe(true);
    expect(["streaming", "degraded"]).toContain(result.status.state);
});
