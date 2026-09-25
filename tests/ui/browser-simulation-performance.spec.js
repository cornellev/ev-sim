import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repositoryRoot = process.cwd();

async function installModuleRoutes(page) {
    await page.route("**/test-modules/**", async (route) => {
        const marker = "/test-modules/";
        const pathname = new URL(route.request().url()).pathname;
        const relative = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
        if (relative.split("/").includes("..")) return route.abort();
        return route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: await readFile(`${repositoryRoot}/${relative}`, "utf8"),
        });
    });
}

test("browser simulation performance report smoke", async ({ page }) => {
    // Keep this smoke independent of the hardware-heavy simulator scene. The
    // operational benchmark exercises the same module through the real scene.
    await page.goto("about:blank");
    await page.addScriptTag({
        path: `${process.cwd()}/app/simulation/performance/BrowserSimulationPerformance.js`,
        type: "module",
    });
    await page.waitForFunction(() => globalThis.__cevSimBrowserPerformance);
    await page.evaluate(() => globalThis.__cevSimBrowserPerformance.start({
        warmupMs: 0,
        workload: {
            fixedStepHz: 60,
            cameraRateHz: 30,
            width: 320,
            height: 180,
            latencyNs: 0,
            products: ["rgb", "depth", "semantic", "instance"],
        },
    }));
    await page.waitForTimeout(100);
    const report = await page.evaluate(() => globalThis.__cevSimBrowserPerformance.stop());
    expect(report.kind).toBe("cev-sim.browser-performance-report");
    expect(report.version).toBe(1);
    expect(report.display).toEqual(expect.objectContaining({ frames: 0 }));
    expect(report.sensors).toEqual(expect.objectContaining({
        due: 0,
        captured: 0,
        delivered: 0,
        skipped: 0,
    }));
    expect(report.queues).toEqual(expect.objectContaining({ maxDepth: 0, finalDepth: 0 }));
    expect(report.websocket).toEqual(expect.objectContaining({ packets: 0, bytes: 0 }));
});

test("rejected PBR worker falls back inline without starving car, follow, or orbit presentation", async ({ page }) => {
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
        const { SimulationEngine } = await import("/test-modules/app/simulation/SimulationEngine.js");
        const { RendererPresentationLease } = await import(
            "/test-modules/app/3d/perception/RendererPresentationLease.js"
        );
        const car = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial());
        const scene = new THREE.Scene();
        scene.add(car);
        const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
        const presented = [];
        const renderer = {
            domElement: { clientWidth: 640, clientHeight: 360, width: 640, height: 360 },
            setPixelRatio() {},
            setSize() {},
            render() {
                camera.updateMatrixWorld(true);
                const projected = car.position.clone().project(camera);
                presented.push({
                    carX: car.position.x,
                    cameraX: camera.position.x,
                    cameraZ: camera.position.z,
                    projectedX: projected.x,
                    projectedY: projected.y,
                    projectedZ: projected.z,
                });
            },
        };
        const runtime = {
            implementation: "inline",
            rendererLease: new RendererPresentationLease(),
            status: { state: "idle", diagnostic: null, error: null },
            listeners: new Set(),
            get presentationBlocked() { return this.rendererLease.blocked; },
            subscribe(listener) {
                this.listeners.add(listener);
                listener(this.status);
                return () => this.listeners.delete(listener);
            },
            subscribePresentationAvailability(listener) {
                return this.rendererLease.subscribe(listener);
            },
            async prepare() {
                this.status = { state: "ready", diagnostic: null, error: null };
                for (const listener of this.listeners) listener(this.status);
            },
            dispose() { this.rendererLease.reset(); },
        };
        const workerFactory = () => {
            const listeners = new Map();
            return {
                addEventListener(name, listener) { listeners.set(name, listener); },
                postMessage(message) {
                    queueMicrotask(() => listeners.get("message")?.({ data: {
                        id: message.id,
                        ok: false,
                        error: {
                            code: "PBR_WORKER_CAPABILITY_UNAVAILABLE",
                            message: "forced worker probe rejection",
                        },
                    } }));
                },
                terminate() {},
            };
        };
        const data = {
            bindings: () => ({ signalStore: null, manifest: { enabled: false, bindings: [] } }),
            vehicles: () => ({ vehicles: [] }),
            devices: () => ({ update() {}, deliver() {} }),
            physics: () => ({ step() {}, syncAndPublishContacts() {} }),
            keys: () => ({ update() {} }),
            client: () => ({ get: () => null }),
            settings: () => ({ cameraControlsEnabled: true }),
            baking: () => null,
            earthTilesManager: () => null,
            skyManager: () => null,
        };
        const engine = new SimulationEngine(data, {
            pbrWorkerFactory: workerFactory,
            pbrInlineFactory: () => runtime,
        });
        engine.configure({ scene, camera, renderer });
        await engine._prepareRendering({
            renderScene: { description: {
                provider: { id: "pbr-mesh", version: 1 },
                productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
            } },
        });

        let follow = true;
        let orbitDelta = 0;
        engine.perspectiveView.applyFrame = () => {
            if (follow) {
                camera.position.set(car.position.x, 2, car.position.z + 5);
                camera.lookAt(car.position);
            } else {
                camera.position.z += orbitDelta;
                orbitDelta = 0;
            }
        };

        let release;
        const held = runtime.rendererLease.runAsync(() => new Promise((resolve) => { release = resolve; }));
        car.position.x = 6;
        const deferred = engine.render() === false;
        release();
        await held;
        await Promise.resolve();
        const followFrame = presented.at(-1);

        follow = false;
        orbitDelta = 2;
        engine.render();
        const orbitFrame = presented.at(-1);
        engine.pause();
        engine.render();
        const pauseFrame = presented.at(-1);
        const implementation = engine.renderRuntime?.implementation;
        const fallbackCode = engine.renderProviderStatus?.fallbackReason?.code;
        const displayedFrames = engine.frames;
        engine.dispose();
        car.geometry.dispose();
        car.material.dispose();
        return { deferred, followFrame, orbitFrame, pauseFrame, implementation, fallbackCode, displayedFrames };
    });

    expect(result.deferred).toBe(true);
    expect(result.followFrame.carX).toBe(6);
    expect(result.followFrame.cameraX).toBe(6);
    expect(Math.abs(result.followFrame.projectedX)).toBeLessThan(0.001);
    expect(Math.abs(result.followFrame.projectedY)).toBeLessThan(0.001);
    expect(result.followFrame.projectedZ).toBeGreaterThan(-1);
    expect(result.followFrame.projectedZ).toBeLessThan(1);
    expect(result.orbitFrame.cameraZ).toBe(result.followFrame.cameraZ + 2);
    expect(result.pauseFrame.cameraZ).toBe(result.orbitFrame.cameraZ);
    expect(result.implementation).toBe("inline");
    expect(result.fallbackCode).toBe("PBR_WORKER_CAPABILITY_UNAVAILABLE");
    expect(result.displayedFrames).toBeGreaterThanOrEqual(3);
});
