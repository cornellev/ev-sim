import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";

const base = "/api/browser-sim";

async function command(request, input) {
    const response = await request.post(`${base}/commands`, { data: input });
    expect(response.status(), await response.text()).toBe(202);
    const accepted = await response.json();
    let receipt;
    await expect.poll(async () => {
        receipt = await (await request.get(`${base}/commands/${accepted.commandId}`)).json();
        return receipt.state;
    }, { timeout: 45_000 }).toMatch(/^(succeeded|failed|unknown)$/);
    expect(receipt.state, JSON.stringify(receipt)).toBe("succeeded");
    return receipt;
}

async function registerPage(page, request, url = "/") {
    const before = new Set((await (await request.get(`${base}/browsers`)).json()).browsers.map((browser) => browser.browserId));
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 45_000 });
    let browserId;
    await expect.poll(async () => {
        const listing = await (await request.get(`${base}/browsers`)).json();
        browserId = listing.browsers.find((browser) => browser.connected && !before.has(browser.browserId))?.browserId;
        return Boolean(browserId);
    }, { timeout: 30_000 }).toBe(true);
    const beforeInteraction = (await (await request.get(`${base}/status`, { params: { browserId } })).json()).interactionOrder;
    await page.mouse.click(100, 100);
    await expect.poll(async () => (await (await request.get(`${base}/status`, { params: { browserId } })).json()).interactionOrder, { timeout: 10_000 }).toBeGreaterThan(beforeInteraction);
    return browserId;
}

async function installTabFixture(page) {
    // The first test owns real scene/physics coverage. Isolate native tab input
    // and command routing here so two GPU-heavy scene loads do not skew activity.
    await page.route("**/test-modules/**", async (route) => {
        const relative = decodeURIComponent(new URL(route.request().url()).pathname.split("/test-modules/")[1]);
        if (relative.split("/").includes("..")) return route.abort();
        return route.fulfill({ contentType: "text/javascript", body: await readFile(`${process.cwd()}/${relative}`, "utf8") });
    });
    await page.route("**/browser-sim-control-fixture", (route) => route.fulfill({
        contentType: "text/html",
        body: `<button>Play</button><script type="module">
            import { BrowserSimBridge } from '/test-modules/app/simulation/BrowserSimBridge.js';
            const listeners = new Set();
            const simulation = { steps: 0, timeNs: 0, stepNs: 20000000 };
            const controller = {
                state: { status: 'idle' },
                data: { simulation: () => simulation },
                getSnapshot() { return this.state; },
                subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
                async prepare(resolved, options) {
                    this.state = { status: options.autoplay ? 'running' : 'ready', activeRunId: crypto.randomUUID(), activeResolved: resolved, manifestRevision: options.manifestRevision };
                    for (const listener of listeners) listener();
                },
                async stop() {
                    this.state.status = 'stopped';
                    for (const listener of listeners) listener();
                },
            };
            new BrowserSimBridge({ controller, getContext: () => ({ navigationBlocked: () => false, openSimulation: () => true }) }).start();
        </script>`,
    }));
}

async function saveManifest(request) {
    const id = `pw-browser-api-${Date.now().toString(36)}`;
    const manifest = createDefaultRunManifest({
        id,
        sensorRig: { sensors: [], syncGroups: [] },
        controls: { authority: "reference" },
        clock: { pacing: "realtime", stepNs: 20_000_000, maxSteps: null },
        scripts: { bindingSource: "embedded", embeddedBindings: [], artifacts: [], bindingIds: [] },
        logging: { policy: "disabled" },
    });
    const response = await request.post("/api/storage/run-manifests", { data: manifest });
    expect(response.ok(), await response.text()).toBeTruthy();
    return id;
}

test("HTTP lifecycle starts, pauses with a stable clock, resumes, stops, and resets", async ({ page, request }) => {
    test.setTimeout(120_000);
    const browserId = await registerPage(page, request);
    const manifestId = await saveManifest(request);
    const environmentId = `${manifestId}-world`;
    try {
        const started = await command(request, { action: "start", manifestId, browserId });
        expect(started.snapshot.status).toBe("running");
        expect(started.snapshot.manifestRevision).toBe(1);
        const runId = started.snapshot.runId;
        const paused = await command(request, { action: "pause", runId, browserId });
        expect(paused.snapshot.status).toBe("paused");
        expect(typeof paused.snapshot.timeNs).toBe("string");
        await page.waitForTimeout(150);
        const state = await (await request.get(`${base}/status`, { params: { browserId } })).json();
        expect(state.timeNs).toBe(paused.snapshot.timeNs);
        const conflict = await request.post(`${base}/commands`, { data: { action: "start", manifestId, browserId } });
        expect(conflict.status()).toBe(409);
        await command(request, { action: "resume", runId, browserId });
        const stopped = await command(request, { action: "stop", runId, browserId });
        expect(stopped.snapshot.status).toBe("stopped");
        expect(stopped.snapshot.runResult.runId).toBe(runId);
        const reset = await command(request, { action: "reset", runId, browserId });
        expect(reset.snapshot.status).toBe("ready");
        expect(reset.snapshot.timeNs).toBe("0");
        expect(reset.snapshot.runId).not.toBe(runId);
        await command(request, { action: "stop", runId: reset.snapshot.runId, browserId });

        const created = await request.post("/api/storage/environments", { data: { id: environmentId, name: "Browser API reset world" } });
        expect(created.ok(), await created.text()).toBeTruthy();
        const saved = await (await request.get(`/api/storage/run-manifests/${manifestId}`)).json();
        const updated = await request.put(`/api/storage/run-manifests/${manifestId}`, {
            data: { expectedRevision: saved.revision, manifest: { ...saved, environment: { id: environmentId, expectedHash: null } } },
        });
        expect(updated.ok(), await updated.text()).toBeTruthy();
        const latest = await command(request, { action: "reset", runId: reset.snapshot.runId, browserId });
        expect(latest.snapshot.status).toBe("ready");
        expect(latest.snapshot.manifestRevision).toBe(2);
        expect(latest.snapshot.timeNs).toBe("0");
        expect(latest.snapshot.resolvedHash).not.toBe(reset.snapshot.resolvedHash);
        await command(request, { action: "stop", runId: latest.snapshot.runId, browserId });
    } finally {
        await request.delete(`/api/storage/run-manifests/${manifestId}`);
        const environment = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
        if (environment?.revision) await request.delete(`/api/storage/environments/${environmentId}`, { params: { expectedRevision: environment.revision } });
        await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
    }
});

test("default commands and status follow human interaction while accepted commands keep their target", async ({ page, context, request }) => {
    test.setTimeout(120_000);
    await installTabFixture(page);
    const a = await registerPage(page, request, "/browser-sim-control-fixture");
    const second = await context.newPage();
    await installTabFixture(second);
    const b = await registerPage(second, request, "/browser-sim-control-fixture");
    const manifestId = await saveManifest(request);
    try {
        await page.bringToFront();
        await page.mouse.click(100, 100);
        await expect.poll(async () => (await (await request.get(`${base}/status`)).json()).browserId).toBe(a);
        const acceptedResponse = await request.post(`${base}/commands`, { data: { action: "start", manifestId, autoplay: false, requestId: manifestId } });
        expect(acceptedResponse.status()).toBe(202);
        const accepted = await acceptedResponse.json();
        expect(accepted.browserId).toBe(a);
        await second.bringToFront();
        await second.keyboard.press("Shift");
        await expect.poll(async () => (await (await request.get(`${base}/status`)).json()).browserId).toBe(b);
        await expect.poll(async () => (await (await request.get(`${base}/commands/${accepted.commandId}`)).json()).state, { timeout: 45_000 }).toBe("succeeded");
        const retry = await (await request.post(`${base}/commands`, { data: { action: "start", manifestId, autoplay: false, requestId: manifestId } })).json();
        expect(retry.commandId).toBe(accepted.commandId);
        expect(retry.browserId).toBe(a);
        const stateA = await (await request.get(`${base}/status`, { params: { browserId: a } })).json();
        const stateB = await (await request.get(`${base}/status`, { params: { browserId: b } })).json();
        expect(stateA.manifestId).toBe(manifestId);
        expect(stateB.manifestId).toBeNull();
        await command(request, { action: "stop", runId: stateA.runId, browserId: a });
    } finally {
        await second.close();
        await request.delete(`/api/storage/run-manifests/${manifestId}`);
    }
});
