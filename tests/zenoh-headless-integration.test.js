import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeadlessExternalSession } from "../server/headless/HeadlessExternalSession.js";
import { externalBundle, zenohRuntimeFactory } from "./helpers/headlessZenoh.js";
import { launch, launchController, until, sleep, routerEndpoint, runZenohCliSmoke } from "./helpers/headlessZenohSmoke.js";

const addon = process.env.CEV_SIM_ZENOH_TEST_ADDON;
test("independent native controller drives the headless kernel through a pinned router", { skip: !addon, timeout: 30000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-driving-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const localAddon = path.join(root, "transport.node"); await fs.copyFile(path.resolve(addon), localAddon);
    const endpoint = await routerEndpoint();
    const router = launch(process.env.CEV_SIM_ZENOHD || "zenohd", ["--listen", endpoint, "--no-multicast-scouting"]); t.after(() => router.close());
    await sleep(200);
    const config = { kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: [endpoint], shm: { mode: "disabled" } };
    const bundle = await externalBundle({ maxSteps: 120 });
    const bundlePath = path.join(root, "run.json"), configPath = path.join(root, "config.json");
    await fs.writeFile(bundlePath, JSON.stringify(bundle)); await fs.writeFile(configPath, JSON.stringify(config));
    const controller = launchController(localAddon, configPath, bundlePath); t.after(() => controller.close());
    await until(() => controller.records.some((r) => r.kind === "connected"), "controller connection");
    const session = new HeadlessExternalSession({ zenohTransport: config, zenohRuntimeFactory: zenohRuntimeFactory(createRequire(import.meta.url)(localAddon)) });
    t.after(() => session.close());
    const descriptor = await session.prepare(bundle);
    controller.child.stdin.write(`${JSON.stringify(descriptor)}\n`);
    await until(() => controller.records.some((r) => r.kind === "bound"), "controller subscription");
    const before = { ...session.kernel.context.vehicles.list()[0].position };
    await session.start({ outputUri: path.join(root, "result") });
    await until(() => controller.records.some((r) => r.kind === "wheel" && r.speed > 0.1), "vehicle motion");
    await session.waitForCompletion();
    assert.notDeepEqual(session.kernel.context.vehicles.list()[0].position, before);
    const finalized = await session.finalize();
    assert.equal(finalized.runResult.passed, true); assert.ok(finalized.runResult.diagnostics.zenohTransport.routing.inboundAccepted > 0);
    assert.equal(session.health().zenohQueueBytes, 0);
    await session.reset();
    assert.notEqual(session.runId, descriptor.runId);
    await session.start({ outputUri: path.join(root, "failed-result") });
    await router.close();
    const failed = await session.waitForCompletion();
    assert.equal(failed.state, "failed"); assert.equal(failed.error.requiresReset, true);
    await assert.rejects(session.finalize());
    await session.close();
    await assert.rejects(fs.access(path.join(root, "failed-result")), { code: "ENOENT" });
});

for (const options of [{ supervised: false }, { supervised: true }, { supervised: true, interrupt: true }]) {
    test(`native CLI driving ${JSON.stringify(options)}`, { skip: !addon || process.platform !== "linux", timeout: 30000 }, async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-cli-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
        const smoke = await runZenohCliSmoke({ ...options, root, addon, executable: process.env.CEV_SIM_ZENOH_TEST_EXECUTABLE || path.resolve("bin/cev-sim.js") });
        assert.ok(smoke.maxMeasuredSpeed > 0.1);
    });
}
