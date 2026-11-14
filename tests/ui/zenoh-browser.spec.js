import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const bundle = JSON.parse(await readFile(new URL("../fixtures/protobuf/run-controls.v13.json", import.meta.url)));
test("@zenoh real SDK binary round trip, isolated runs, router recovery and cleanup", async ({ page, request }) => {
    test.skip(process.env.CEV_SIM_ZENOH_BROWSER_GATE !== "1", "Run npm run test:zenoh-browser for the pinned real router.");
    test.setTimeout(150000);
    await page.goto("/?browserPerformance=1");
    await expect.poll(() => page.evaluate(() => Boolean(globalThis.__cevSimBenchmarkRuntime)), { timeout: 45000 }).toBe(true);
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
    await page.evaluate(() => globalThis.__cevSimBenchmarkRuntime.play());
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
});
