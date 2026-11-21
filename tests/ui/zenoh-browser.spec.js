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
    const host = JSON.parse(await readFile(process.env.CEV_SIM_ZENOH_BROWSER_CONFIG, "utf8"));
    const controller = await Session.open(new Config(host.endpoint, 5000));
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
    const restarted = request.post(`${process.env.CEV_SIM_ZENOH_BROWSER_GATE_CONTROL}/restart`);
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

test("@zenoh an owned run verifies its owner before advancing after a tab break", async ({ page, request }) => {
    test.skip(process.env.CEV_SIM_ZENOH_BROWSER_GATE !== "1", "Run npm run test:zenoh-browser for the pinned real router.");
    test.setTimeout(120000);
    const api = "/api/browser-sim";
    const ownership = "/api/interfaces/control-ownership";
    const { resolved } = JSON.parse(await readFile(process.env.CEV_SIM_ZENOH_BROWSER_OWNED_BUNDLE, "utf8"));
    const manifest = { ...resolved.manifest, id: "pw-zenoh-owned", logging: { ...resolved.manifest.logging, policy: "disabled" } };
    const saved = await request.post("/api/storage/protobuf-interfaces", { data: { document: resolved.protobufInterface.document } });
    expect(saved.ok(), await saved.text()).toBe(true);
    const savedManifest = await request.post("/api/storage/run-manifests", { data: manifest });
    expect(savedManifest.ok(), await savedManifest.text()).toBe(true);
    const listBrowsers = async () => (await (await request.get(`${api}/browsers`)).json()).browsers;
    const previousBrowsers = new Set((await listBrowsers()).map((entry) => entry.browserId));
    let reportedHidden = false;
    let blockVerification = false;
    await page.route("**/api/browser-sim/bridge/*/heartbeat", async (route) => {
        const state = route.request().postDataJSON().snapshot.controlOwnershipState;
        if ((state === "backgrounded" && reportedHidden) || (state === "checking" && blockVerification)) return route.abort();
        if (state === "backgrounded") reportedHidden = true;
        return route.continue();
    });
    const setHidden = (hidden) => page.evaluate((hidden) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
    await page.goto("/?browserPerformance=1");
    await expect.poll(() => page.evaluate(() => Boolean(globalThis.__cevSimBenchmarkRuntime)), { timeout: 45000 }).toBe(true);
    let browserId;
    await expect.poll(async () => {
        browserId = (await listBrowsers()).find((entry) => entry.connected && !previousBrowsers.has(entry.browserId))?.browserId;
        return Boolean(browserId);
    }).toBe(true);
    const acquire = await request.post(ownership, { data: { target: { kind: "browser", id: browserId, vehicleId: manifest.controls.targetVehicleId }, mode: "autonomous" } });
    expect(acquire.ok(), await acquire.text()).toBe(true);
    const { leaseId, token } = await acquire.json();
    const headers = { Authorization: `Bearer ${token}` };
    const renew = async () => {
        const response = await request.post(`${ownership}/${leaseId}/renew`, { headers });
        if (!response.ok()) throw new Error(await response.text());
    };
    let renewFailure;
    const timer = setInterval(() => renew().catch((error) => { renewFailure = error; }), 250);
    const owned = { controlLeaseId: leaseId, controlLeaseToken: token };
    const command = async (action, fields) => {
        const response = await request.post(`${api}/commands`, { data: { action, browserId, ...fields } });
        expect(response.status(), await response.text()).toBe(202);
        const { commandId } = await response.json();
        let receipt;
        await expect.poll(async () => {
            receipt = await (await request.get(`${api}/commands/${commandId}`)).json();
            return receipt.state;
        }, { timeout: 30_000 }).toMatch(/^(succeeded|failed|unknown)$/);
        expect(receipt.state, JSON.stringify(receipt)).toBe("succeeded");
        return receipt.snapshot;
    };
    const readStatus = async () => (await listBrowsers()).find((entry) => entry.browserId === browserId);
    const currentStep = () => page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.snapshot().simulation.steps);
    let runId, session, clock, wheel;
    try {
        ({ runId } = await command("start", { manifestId: manifest.id, autoplay: false, ...owned }));
        const schema = loadDescriptorSet(Buffer.from(resolved.protobufInterface.document.schemas[0].descriptorBase64, "base64"));
        const stateType = schema.root.lookupType("headless_test.State");
        const commandType = schema.root.lookupType("headless_test.Command");
        const config = JSON.parse(await readFile(process.env.CEV_SIM_ZENOH_BROWSER_CONFIG, "utf8"));
        session = await Session.open(new Config(config.endpoint, 5000));
        let sequence = 0;
        let moving = false;
        wheel = await session.declareSubscriber(`sim/${runId}/wheel`, { handler: (sample) => {
            moving ||= decodeMessage(stateType, sample.payload().toBytes()).speed > 0.1;
        } });
        clock = await session.declareSubscriber(`sim/${runId}/clock`, { handler: (sample) => {
            const { time } = decodeMessage(stateType, sample.payload().toBytes());
            const bytes = encodeMessage(commandType, { run: runId, lease: leaseId, sequence: String(++sequence), capture: time,
                deadline: String(BigInt(time) + 300000000n), speed: 0.5, steering: 0 });
            session.put(`sim/${runId}/command`, bytes, { encoding: Encoding.APPLICATION_PROTOBUF }).catch(() => {});
        } });
        await command("resume", { runId, ...owned });
        await expect.poll(() => moving, { timeout: 10000 }).toBe(true);
        await setHidden(true);
        await expect.poll(async () => (await readStatus()).controlOwnershipState).toBe("backgrounded");
        const frozen = await currentStep();
        await expect.poll(async () => (await readStatus()).connected, { timeout: 20000 }).toBe(false);
        expect(await currentStep()).toBe(frozen);
        expect((await readStatus()).controlOwnershipState).toBe("backgrounded");
        expect(renewFailure).toBeUndefined();
        blockVerification = true;
        await setHidden(false);
        await expect(page.getByRole("status").filter({ hasText: "Checking controller" }).last()).toBeVisible();
        expect(await currentStep()).toBe(frozen);
        blockVerification = false;
        await expect.poll(currentStep).toBeGreaterThan(frozen);
        expect((await readStatus()).runId).toBe(runId);

        clearInterval(timer);
        reportedHidden = false;
        await setHidden(true);
        await expect.poll(async () => (await (await request.get(`${ownership}/${leaseId}`)).json()).status, { timeout: 8000 }).toBe("expired");
        const lostStep = await currentStep();
        await setHidden(false);
        await expect(page.getByRole("status").filter({ hasText: "Controller disconnected" }).last()).toBeVisible();
        expect(await currentStep()).toBe(lostStep);
        expect((await readStatus()).status).toBe("paused");
    } finally {
        clearInterval(timer);
        await clock?.undeclare();
        await wheel?.undeclare();
        await session?.close();
        if (runId) await command("stop", { runId });
        await request.delete(`${ownership}/${leaseId}`, { headers });
        await request.delete(`/api/storage/run-manifests/${manifest.id}`);
    }
});
