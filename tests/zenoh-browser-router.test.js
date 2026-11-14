import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { ZenohBrowserTransport } from "../app/client/ZenohBrowserTransport.js";

const binary = process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY;
const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 250; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error("Real-router condition timed out.");
};

test("official SDK/router binary isolation, owned payloads and reconnection", { skip: !binary, timeout: 30000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cev-browser-router-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const listener = createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
    const routerConfig = path.join(directory, "router.json5");
    await writeFile(routerConfig, JSON.stringify({ listen: { endpoints: [] }, scouting: { multicast: { enabled: false }, gossip: { enabled: false } } }));
    const workerFile = path.join(directory, "worker.mjs");
    await writeFile(workerFile, `import { parentPort } from 'node:worker_threads';
        import * as sdk from ${JSON.stringify(import.meta.resolve("@eclipse-zenoh/zenoh-ts"))};
        import { createZenohBrowserWorkerRuntime } from ${JSON.stringify(new URL("../app/client/ZenohBrowserWorkerRuntime.js", import.meta.url).href)};
        const runtime = createZenohBrowserWorkerRuntime({ sdk, postMessage: (message, transfer) => parentPort.postMessage(message, transfer) });
        parentPort.on('message', message => runtime.handle(message));
        parentPort.postMessage({type:'worker-ready'});`);
    const workerFactory = () => {
        const worker = new Worker(pathToFileURL(workerFile), { execArgv: ["--experimental-default-type=module", "--experimental-wasm-modules"] });
        const adapter = { postMessage: (message, transfer) => worker.postMessage(message, transfer), terminate: () => worker.terminate() };
        worker.on("message", (data) => adapter.onmessage?.({ data })); worker.on("error", (error) => adapter.onerror?.(error)); return adapter;
    };
    const start = () => spawn(binary, ["--config", routerConfig, "--ws-port", `127.0.0.1:${port}`], { stdio: "ignore" });
    let router = start(); t.after(() => router.kill());
    const a = new ZenohBrowserTransport({ workerFactory }), b = new ZenohBrowserTransport({ workerFactory });
    t.after(async () => { await a.close(); await b.close(); });
    const config = { kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: `ws://127.0.0.1:${port}` };
    const received = { a: [], b: [] };
    const connect = async (transport, id, other, generation) => {
        await transport.connect({ config, generation, routes: [
            { routeId: "out", direction: "publish", key: `sim/${id}/wire` },
            { routeId: "in", direction: "subscribe", key: `sim/${other}/wire` },
        ], onSample: (sample) => received[id].push([...sample.bytes]) }); await transport.bindGeneration(generation);
    };
    await Promise.all([connect(a, "a", "b", 1), connect(b, "b", "a", 1)]);
    const bytes = new Uint8Array([0, 128, 255, 1]);
    assert.equal(a.publish({ routeId: "out", key: "sim/a/wire", generation: 1, bytes }).ok, true); bytes.fill(7);
    assert.equal(b.publish({ routeId: "out", key: "sim/b/wire", generation: 1, bytes: new Uint8Array([2, 0, 254]) }).ok, true);
    await waitFor(() => received.a.length && received.b.length);
    assert.deepEqual(received, { a: [[2, 0, 254]], b: [[0, 128, 255, 1]] });
    await new Promise((resolve) => { router.once("exit", resolve); router.kill(); });
    await waitFor(() => a.state === "reconnecting" && b.state === "reconnecting");
    router = start(); await Promise.all([connect(a, "a", "b", 2), connect(b, "b", "a", 2)]);
    assert.equal(a.publish({ routeId: "out", key: "sim/a/wire", generation: 1, bytes: new Uint8Array([8]) }).code, "stale-generation");
    a.publish({ routeId: "out", key: "sim/a/wire", generation: 2, bytes: new Uint8Array([9]) });
    await waitFor(() => received.b.length === 2); assert.deepEqual(received.b, [[0, 128, 255, 1], [9]]);
    await a.close(); await b.close(); assert.equal(a.worker, null); assert.equal(b.worker, null);
});
