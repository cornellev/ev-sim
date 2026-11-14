import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Config, Session, Encoding } from "@eclipse-zenoh/zenoh-ts";
import { encodeMessage, decodeMessage, loadDescriptorSet } from "../../app/interfaces/ProtobufSchema.js";

const retiredRequests = new WeakMap();
test.beforeEach(({ page }) => {
    const requests = [];
    retiredRequests.set(page, requests);
    const track = (address) => {
        const url = new URL(address);
        if (["8080", "8090"].includes(url.port) || url.pathname.startsWith("/messages/") || ["/types", "/protobuf/publish", "/request_all"].includes(url.pathname)) requests.push(address);
    };
    page.on("request", (request) => track(request.url()));
    page.on("websocket", (socket) => track(socket.url()));
});
test.afterEach(({ page }) => expect(retiredRequests.get(page)).toEqual([]));

test("@zenoh real SDK binary round trip, isolated runs, router recovery and cleanup", async ({ page, request }) => {
    test.skip(process.env.CEV_SIM_ZENOH_BROWSER_GATE !== "1", "Run npm run test:zenoh-browser for the pinned real router.");
    test.setTimeout(150000);
    await page.goto("/?browserPerformance=1");
    await expect.poll(() => page.evaluate(() => Boolean(globalThis.__cevSimBenchmarkRuntime)), { timeout: 45000 }).toBe(true);
    const bundle = JSON.parse(await readFile(process.env.CEV_SIM_ZENOH_BROWSER_TEST_BUNDLE, "utf8"));
    const controllerSchema = loadDescriptorSet(Buffer.from(bundle.resolved.protobufInterface.document.schemas[0].descriptorBase64, "base64"));
    await page.evaluate((resolved) => globalThis.__cevSimBenchmarkRuntime.prepare(resolved), bundle.resolved);
    const initial = await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().run);
    expect(initial.status).toBe("ready"); expect(initial.transport.state).toBe("ready");
    const binary = await page.evaluate(async () => {
        const Constructor = window.clientHandler.transport.constructor;
        const config = await (await fetch("/api/zenoh/browser-config")).json();
        const results = { a: [], b: [] };
        const transports = [];
        for (const id of ["a", "b"]) {
            const transport = new Constructor(); transports.push(transport);
            await transport.connect({ config, generation: 1, routes: [
                { routeId: "put", direction: "publish", key: `gate/${id}/binary` }, { routeId: "get", direction: "subscribe", key: `gate/${id}/binary` },
            ], onSample: (sample) => results[id].push([...sample.bytes]) });
            await transport.bindGeneration(1);
        }
        transports[0].publish({ routeId: "put", key: "gate/a/binary", generation: 1, bytes: new Uint8Array([0, 128, 255, 1]) });
        transports[1].publish({ routeId: "put", key: "gate/b/binary", generation: 1, bytes: new Uint8Array([2, 0, 254]) });
        for (let index = 0; index < 100 && (!results.a.length || !results.b.length); index++) await new Promise((resolve) => setTimeout(resolve, 20));
        await Promise.all(transports.map((transport) => transport.close())); return results;
    });
    expect(binary).toEqual({ a: [[0, 128, 255, 1]], b: [[2, 0, 254]] });
    const controller = await Session.open(new Config("ws://127.0.0.1:10005", 5000));
    const stateType = controllerSchema.root.lookupType("headless_test.State");
    const commandType = controllerSchema.root.lookupType("headless_test.Command");
    const wheelSpeeds = [], controllerErrors = [];
    let sequence = 0, stopping = false, clockSubscription, wheelSubscription;
    try {
        wheelSubscription = await controller.declareSubscriber(`sim/${initial.activeRunId}/wheel`, { handler: (sample) => {
            wheelSpeeds.push(decodeMessage(stateType, sample.payload().toBytes()).speed);
        } });
        clockSubscription = await controller.declareSubscriber(`sim/${initial.activeRunId}/clock`, { handler: (sample) => {
            if (stopping) return;
            const state = decodeMessage(stateType, sample.payload().toBytes());
            const bytes = encodeMessage(commandType, { run: initial.activeRunId, sequence: String(++sequence), capture: state.time,
                deadline: String(BigInt(state.time) + 300000000n), speed: 0.5, steering: 0 });
            controller.put(`sim/${initial.activeRunId}/command`, bytes, { encoding: Encoding.APPLICATION_PROTOBUF }).catch((error) => controllerErrors.push(error.message));
        } });
        await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.play());
        await expect.poll(() => Math.max(0, ...wheelSpeeds), { timeout: 15000 }).toBeGreaterThan(0.1);
        const product = await page.evaluate(() => {
            const runtime = window.clientHandler.data.simulation();
            const entry = runtime.telemetry.read("devices.wheel.odometry");
            return { value: entry?.value, metadata: runtime.telemetry.descriptor("devices.wheel.odometry")?.metadata };
        });
        expect(product.value).toHaveProperty("linearVelocity");
        expect(product.value).not.toHaveProperty("header");
        expect(product.metadata.valueContract).toEqual({ id: "cev.odometry", version: 1 });
        expect(product.metadata).not.toHaveProperty("rosType");
        expect(controllerErrors).toEqual([]);
    } finally {
        stopping = true;
        await clockSubscription?.undeclare(); await wheelSubscription?.undeclare(); await controller.close();
    }
    await expect.poll(() => page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().simulation.steps)).toBeGreaterThan(1);
    const restarted = request.post("http://127.0.0.1:10006/restart");
    await expect.poll(() => page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().run.transport.state), { timeout: 12000 }).toBe("reconnecting");
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting…" }).last()).toBeVisible();
    const pausedStep = await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().simulation.steps);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().simulation.steps)).toBe(pausedStep);
    expect((await restarted).ok()).toBe(true);
    await expect.poll(() => page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().run.status), { timeout: 20000 }).toBe("running");
    const recovered = await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().run);
    expect(recovered.activeRunId).toBe(initial.activeRunId);
    expect(recovered.activeResolved.resolvedHash).toBe(initial.activeResolved.resolvedHash);
    await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.pause());
    await page.evaluate(() => window.clientHandler.closeRun());
    expect(await page.evaluate(() => window.clientHandler.transport.worker)).toBeNull();
    const closed = await page.evaluate(() => window.clientHandler.transport.getSnapshot());
    expect(closed.diagnostics.queuedEntries).toBe(0);
    expect(closed.diagnostics.queuedBytes).toBe(0);
});
