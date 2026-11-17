import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const protobuf = require("protobufjs"), descriptor = require("protobufjs/ext/descriptor/index.js");
const root = protobuf.parse(`syntax = "proto3"; package display;
message Sample { double x=1; double z=2; double steering=3; uint32 width=4; uint32 height=5;
bytes cells=6; string frameId=7; uint64 sequenceId=8; uint64 captureTimeNs=9; }`).root;
const descriptorBytes = Buffer.from(descriptor.FileDescriptorSet.encode(root.toDescriptor("proto3")).finish());
const schema = { descriptorBase64: descriptorBytes.toString("base64"), fingerprint: createHash("sha256").update(descriptorBytes).digest("hex") };
const type = root.lookupType("display.Sample");
const sampleBytes = (overrides = {}) => [...type.encode(type.fromObject({ x: 1, z: 0, steering: 0.2,
    width: 2, height: 2, cells: new Uint8Array([0, 1, 1, 0]), frameId: "base_link",
    sequenceId: "18446744073709551615", captureTimeNs: "0", ...overrides })).finish()];

async function openDisplay(page) {
    await page.goto("/?browserPerformance=1");
    await page.waitForFunction(() => globalThis.__cevSimBenchmarkRuntime, null, { timeout: 90_000 });
    await expect(page.getByRole("button", { name: "Switch to map view" })).toBeVisible({ timeout: 90_000 });
    await page.evaluate(async (resource) => {
        const host = await globalThis.__cevSimBenchmarkRuntime.visualization();
        const { engine, waypoints } = host;
        engine.pause();
        engine._clearVisualizationSource();
        const transports = [];
        const counts = { centerlines: 0, conversions: 0, canvasPaints: 0 };
        const manager = engine.visualizationManager;
        engine._visualizationZenoh = {
            schemas: [resource],
            fetchImpl: async () => ({ ok: true, json: async () => ({
                kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://localhost:10000",
            }) }),
            transportFactory: () => {
                const transport = { closed: 0, async connect(connection) { this.connection = connection; },
                    async bindGeneration() {}, async close() { this.closed++; } };
                transports.push(transport); return transport;
            },
        };
        const project = (message) => {
            const position = { x: message.x ?? 0, y: 0, z: message.z ?? 0 };
            const grid = { width: message.width, height: message.height, cells: message.cells,
                resolutionM: 0.5, origin: { x: -1, z: -1 }, vehicleRelative: true };
            return { steeringRad: message.steering ?? 0, achievedSteeringRad: 0.1, wheelbase: 2.2,
                flags: { saturated: true }, points: [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 1 }],
                vehicleRelative: true, position, covarianceEllipse: { sigmaX: 1, sigmaY: 0.5 },
                actors: [{ id: "ego", position }], timeNs: 0, oracle: grid, lidar: grid, stack: grid };
        };
        const data = { id: "independent-data", kind: "zenoh", key: "display/data", schemaId: "display",
            messageType: "display.Sample", project };
        const pose = { ...data, id: "independent-pose", key: "display/pose",
            project: (message) => ({ position: { x: message.x ?? 0, y: 0, z: message.z ?? 0 }, yaw: 0 }) };
        engine.configureVisualizations(Object.fromEntries(Object.keys(manager.tools).map((id) => [id, {
            data: [data], pose: id === "localization" ? [] : [pose], visible: { scene: true, map: true },
            ...(id === "ackermann" ? { predictedPath: true } : {}),
        }])));
        engine._bindLiveVisualizationSource();
        for (const channel of ["oracle", "lidar", "stack"]) {
            manager.setLayerVisible("occupancy", channel, "scene", true);
            manager.setLayerVisible("occupancy", channel, "map", true);
        }
        manager.setLayerVisible("localization", "estimateClone", "scene", false);
        const ackermann = manager.tools.ackermann;
        const centerlines = ackermann._centerlines.bind(ackermann);
        ackermann._centerlines = () => {
            const previous = [...ackermann.arcs]; centerlines();
            counts.centerlines += ackermann.arcs.filter((arc, index) => arc !== previous[index]).length;
        };
        const occupancy = manager.tools.occupancy, paint = occupancy._paint.bind(occupancy);
        occupancy._paint = (channel) => {
            const previous = channel.paintedRevision; paint(channel);
            if (channel.paintedRevision !== previous) counts.conversions++;
        };
        const putImageData = CanvasRenderingContext2D.prototype.putImageData;
        CanvasRenderingContext2D.prototype.putImageData = function (...args) {
            if (this.canvas.closest("[data-plan-view]")) counts.canvasPaints++;
            return putImageData.apply(this, args);
        };
        globalThis.__cevSimVisualizationTest = { ...host, manager, counts, transports,
            async send(bytes, key = "display/data") {
                const connection = transports.at(-1).connection;
                const route = connection.routes.find((route) => route.key === key);
                connection.onSample({ routeId: route.routeId, routeGeneration: connection.generation, bytes: new Uint8Array(bytes) });
                for (let index = 0; index < 12; index++) await Promise.resolve();
                engine.render();
            },
            snapshot() {
                return { counts: { ...counts }, status: engine.status, steps: engine.steps,
                    timings: Object.fromEntries(Object.entries(manager.tools).map(([id, tool]) => [id, tool.getTimings()])),
                    ready: Object.values(manager.getMapSnapshot().tools).every((entry) => entry.ready),
                    poseX: manager.tools.ackermann.group.position.x,
                    plannedX: manager.tools.plannedTrajectory.group.position.x,
                    history: manager.tools.trajectoryPast.history.get("ego")?.length ?? 0,
                    sequenceId: manager.getMapSnapshot().tools.occupancy.metadata?.sequenceId,
                    textureVersions: [...occupancy.channels.values()].map((channel) => channel.texture?.version),
                    ribbonVersions: ackermann.meshes.map((mesh) => mesh?.geometry.getAttribute("position").version),
                    subscriptions: engine.liveVisualizationSource.zenohSource.subscriptions.size,
                    routes: engine.liveVisualizationSource.zenohSource.routes.size,
                };
            },
            cleanup() { CanvasRenderingContext2D.prototype.putImageData = putImageData; waypoints.clearPlanWaypoints(); },
        };
    }, { id: "display", descriptorBase64: schema.descriptorBase64, fingerprint: schema.fingerprint });
    await page.waitForFunction(() => globalThis.__cevSimVisualizationTest.transports.at(-1)?.connection);
    await page.evaluate((bytes) => globalThis.__cevSimVisualizationTest.send(bytes), sampleBytes());
    await page.evaluate((bytes) => globalThis.__cevSimVisualizationTest.send(bytes, "display/pose"), sampleBytes());
}

const snapshot = (page) => page.evaluate(() => globalThis.__cevSimVisualizationTest.snapshot());
const countDelta = (after, before) => Object.fromEntries(Object.keys(after.counts).map((key) => [key, after.counts[key] - before.counts[key]]));

test("paused independent displays redraw all five tools, preserve comparison layers, and coalesce browser work", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await openDisplay(page);
    await page.getByRole("button", { name: "Switch to map view" }).click();
    await expect(page.getByRole("img", { name: "Simulation map" })).toBeVisible();
    await expect(page.locator("[data-plan-view] canvas")).toHaveCount(3);
    await expect(page.locator("[data-plan-view] text").filter({ hasText: "SAT" })).toBeVisible();
    const initial = await snapshot(page);
    expect(initial.ready).toBe(true);
    expect(initial.status).toBe("paused");
    expect(initial.sequenceId).toBe("18446744073709551615");
    expect(initial.subscriptions).toBe(1);
    expect(initial.routes).toBe(2);
    const pixelsMatch = await page.evaluate(() => {
        const grids = globalThis.__cevSimVisualizationTest.manager.getMapSnapshot().tools.occupancy.output.grids;
        return [...document.querySelectorAll("[data-plan-view] canvas")].every((canvas, index) => {
            const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
            return data.every((value, offset) => value === Object.values(grids)[index].rgba[offset]);
        });
    });
    expect(pixelsMatch).toBe(true);
    await page.evaluate(() => globalThis.__cevSimBrowserPerformance.start({ workload: { runtimeVisualization: true }, warmupMs: 0 }));
    const wall = {};
    let before = await snapshot(page), started = Date.now();
    await page.waitForTimeout(150);
    let after = await snapshot(page);
    wall.idleMs = Date.now() - started;
    const idle = countDelta(after, before);
    expect(idle).toEqual({ centerlines: 0, conversions: 0, canvasPaints: 0 });
    for (const id of Object.keys(before.timings)) {
        expect(after.timings[id].display.count).toBe(before.timings[id].display.count);
        expect(after.timings[id].displayMap.count).toBe(before.timings[id].displayMap.count);
    }
    before = after; started = Date.now();
    for (const x of [2, 3, 4]) await page.evaluate((bytes) => globalThis.__cevSimVisualizationTest.send(bytes, "display/pose"), sampleBytes({ x }));
    after = await snapshot(page); wall.poseOnlyMs = Date.now() - started;
    const poseOnly = countDelta(after, before);
    expect(poseOnly).toEqual({ centerlines: 0, conversions: 0, canvasPaints: 0 });
    expect(after.poseX).toBe(4); expect(after.plannedX).toBe(4);
    expect(after.textureVersions).toEqual(before.textureVersions);
    expect(after.ribbonVersions).toEqual(before.ribbonVersions);
    expect(after.history).toBeGreaterThan(before.history);

    await page.getByRole("button", { name: "Layers", exact: true }).click();
    const layers = page.getByRole("group", { name: "Map layers" });
    await layers.getByRole("checkbox", { name: "Stack occupancy" }).uncheck();
    await expect(page.locator("[data-plan-view] canvas")).toHaveCount(2);
    await layers.getByRole("checkbox", { name: "Stack occupancy" }).check();
    await expect(page.locator("[data-plan-view] canvas")).toHaveCount(3);
    await layers.getByRole("checkbox", { name: "Planned trajectory" }).uncheck();
    expect(await page.evaluate(() => globalThis.__cevSimVisualizationTest.manager.tools.plannedTrajectory.visible.map)).toBe(false);
    await layers.getByRole("checkbox", { name: "Planned trajectory" }).check();
    await page.getByRole("button", { name: "Layers", exact: true }).click();
    before = await snapshot(page);
    await page.evaluate(() => globalThis.__cevSimVisualizationTest.waypoints.setPlanWaypoints([{ x: 5, z: 1 }, { x: 8, z: 2 }]));
    await expect(page.locator('[data-plan-view] circle[fill="#f97316"]')).toHaveCount(2);
    expect((await snapshot(page)).steps).toBe(initial.steps);
    await page.getByRole("img", { name: "Simulation map" }).hover();
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(100);
    after = await snapshot(page);
    expect(countDelta(after, before)).toEqual({ centerlines: 0, conversions: 0, canvasPaints: 0 });

    const large = sampleBytes({ width: 512, height: 512, cells: new Uint8Array(512 * 512).fill(1) });
    before = after; started = Date.now();
    await page.evaluate((bytes) => globalThis.__cevSimVisualizationTest.send(bytes), sampleBytes({ x: 5,
        width: 512, height: 512, cells: new Uint8Array(512 * 512).fill(1) }));
    await expect(page.locator("[data-plan-view] canvas").first()).toHaveAttribute("width", "512");
    after = await snapshot(page); wall.largeGridMs = Date.now() - started;
    const largeGrid = countDelta(after, before);
    expect(largeGrid).toEqual({ centerlines: 0, conversions: 3, canvasPaints: 3 });
    before = after; started = Date.now();
    await page.evaluate(() => globalThis.__cevSimVisualizationTest.engine.setSceneRenderEnabled(true));
    await page.evaluate((bytes) => globalThis.__cevSimVisualizationTest.send(bytes), large);
    await expect.poll(async () => (await snapshot(page)).counts.canvasPaints).toBe(before.counts.canvasPaints + 3);
    after = await snapshot(page); wall.simultaneousViewsMs = Date.now() - started;
    const simultaneousViews = countDelta(after, before);
    expect(simultaneousViews).toEqual({ centerlines: 0, conversions: 3, canvasPaints: 3 });
    for (const id of Object.keys(before.timings)) {
        expect(after.timings[id].display.count - before.timings[id].display.count, id).toBe(1);
        expect(after.timings[id].displayMap.count - before.timings[id].displayMap.count, id).toBe(1);
    }
    const monitor = await page.evaluate(() => globalThis.__cevSimBrowserPerformance.stop());
    const report = { kind: "cev-sim.runtime-visualization-acceptance", wall,
        operations: { idle, poseOnly, largeGrid, simultaneousViews }, timings: after.timings, monitor };
    const reportPath = "/private/tmp/cev-runtime-visualization-browser.json";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await testInfo.attach("runtime visualization browser report", { path: reportPath, contentType: "application/json" });
    await page.evaluate(() => globalThis.__cevSimVisualizationTest.cleanup());
});

test("all five actual operator tools leave camera RGB/depth/semantic/instance bytes unchanged", async ({ page }) => {
    test.setTimeout(180_000);
    await openDisplay(page);
    const result = await page.evaluate(() => {
        const { manager, THREE, CameraRenderProducts } = globalThis.__cevSimVisualizationTest;
        const localization = manager.tools.localization;
        localization.createAppearanceClone = () => new THREE.Group();
        manager.setLayerVisible("localization", "estimateClone", "scene", true);
        const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, -0.3));
        localization.acceptDataUpdate({ orientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w } }, []);
        manager.flush();
        const internalOrientation = localization.clone.quaternion.angleTo(orientation) < 1e-7;
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2", { antialias: false, alpha: true });
        if (!gl) throw new Error("WebGL2 is required for sensor isolation acceptance.");
        const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
        renderer.setSize(64, 48); renderer.setPixelRatio(1);
        const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 64 / 48, 0.1, 100);
        camera.position.set(8, 8, 8); camera.lookAt(0, 0, 0); camera.layers.enable(31);
        const surface = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 4), new THREE.MeshBasicMaterial({ color: 0x2255aa }));
        scene.add(surface);
        const products = new CameraRenderProducts({ renderer, scene, camera, width: 64, height: 48 });
        const modes = ["rgb", "depth", "semantic", "instance"];
        const baseline = modes.map((mode) => products._render({ mode }).slice());
        const parents = Object.values(manager.tools).map((tool) => ({ group: tool.group, parent: tool.group.parent }));
        parents.forEach(({ group }) => scene.add(group)); scene.updateMatrixWorld(true);
        const operator = new Uint8Array(64 * 48 * 4);
        renderer.setRenderTarget(products.target); renderer.render(scene, camera);
        renderer.readRenderTargetPixels(products.target, 0, 0, 64, 48, operator);
        const operatorDiffers = operator.some((value, index) => value !== baseline[0][index]);
        const equal = modes.map((mode, index) => products._render({ mode }).every((value, offset) => value === baseline[index][offset]));
        const isolated = parents.every(({ group }) => {
            let valid = group.userData.nonColliding === true;
            group.traverse((object) => {
                const hits = []; object.raycast(new THREE.Raycaster(), hits);
                valid &&= object.layers.mask === 2 ** 31 && object.userData.autonomyOverlay === true && hits.length === 0;
            });
            return valid;
        });
        parents.forEach(({ group, parent }) => parent.add(group));
        products.dispose(); surface.geometry.dispose(); surface.material.dispose(); renderer.dispose();
        return { operatorDiffers, equal, isolated, tools: parents.length, internalOrientation };
    });
    expect(result.tools).toBe(5); expect(result.operatorDiffers).toBe(true);
    expect(result.equal).toEqual([true, true, true, true]); expect(result.isolated).toBe(true);
    expect(result.internalOrientation).toBe(true);
    await page.evaluate(() => globalThis.__cevSimVisualizationTest.cleanup());
});
