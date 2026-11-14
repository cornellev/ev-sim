import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ZenohNativeTransport } from "../server/sensor-transports/ZenohNativeTransport.js";
import { resolveZenohTransportHostConfig } from "../server/sensor-transports/ZenohTransportConfig.js";

const addon = process.env.CEV_SIM_ZENOH_TEST_ADDON;
const consumer = process.env.CEV_SIM_ZENOH_TEST_CONSUMER;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await pause(10); } }
async function port() { const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const result = server.address().port; await new Promise((resolve) => server.close(resolve)); return result; }
function childProcess(t, executable, args) {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const exit = once(child, "exit");
    let output = "", error = "";
    const records = [];
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 65536) child.kill("SIGKILL"); let end; while ((end = output.indexOf("\n")) >= 0) { const line = output.slice(0, end); output = output.slice(end + 1); try { records.push(JSON.parse(line)); } catch { /* Router diagnostics are text. */ } } });
    child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-8192); });
    t.after(async () => {
        if (child.exitCode != null || child.signalCode != null) return;
        child.stdin.end("close\n"); await Promise.race([exit, pause(100)]);
        if (child.exitCode == null && child.signalCode == null) {
            child.kill("SIGTERM"); const kill = setTimeout(() => child.kill("SIGKILL"), 5000); await exit; clearTimeout(kill);
        }
    });
    return { child, records, error: () => error };
}

test("native router bytes, SHM retention, mixed consumers, exhaustion and reset", { skip: !addon || !consumer, timeout: 60000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-native-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const localAddon = path.join(root, "transport.node"); await fs.copyFile(path.resolve(addon), localAddon);
    const binding = createRequire(import.meta.url)(localAddon);
    const router = process.env.CEV_SIM_ZENOHD || "zenohd";
    assert.match(spawnSync(router, ["--version"], { encoding: "utf8" }).stdout, /1\.10\.2/);
    const endpoint = `tcp/127.0.0.1:${await port()}`;
    const routerProcess = childProcess(t, router, ["--listen", endpoint, "--no-multicast-scouting", "--cfg", "transport/shared_memory/enabled:true", "--cfg", "transport/shared_memory/transport_optimization/enabled:false"]);
    await pause(200);
    const config = resolveZenohTransportHostConfig({ kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: [endpoint], shm: { mode: "required", poolBytes: 256 * 1024 }, queue: { maxBytes: 1024 * 1024 } });
    const transport = new ZenohNativeTransport({ config, nativeBinding: binding });
    t.after(() => transport.close());
    try { await transport.openSession(); } catch (error) { throw new Error(`${error.message}; router: ${routerProcess.error()}`, { cause: error }); }
    const key = "zpb06/integration";
    const local = childProcess(t, path.resolve(consumer), ["--connect", endpoint, "--key", key, "--hold", "1", "--shm", "true"]);
    const network = childProcess(t, path.resolve(consumer), ["--connect", endpoint, "--key", key, "--hold", "0", "--shm", "false"]);
    await until(() => local.records.some((r) => r.kind === "ready") && network.records.some((r) => r.kind === "ready"), "consumer startup");
    await pause(200);
    const first = new Uint8Array(65536).fill(7);
    assert.equal(transport.publish({ key, bytes: first, routeId: "image", generation: 0 }).ok, true); first.fill(99);
    await until(() => local.records.some((r) => r.kind === "sample") && network.records.some((r) => r.kind === "sample"), "mixed consumer frame");
    assert.equal(local.records.find((r) => r.kind === "sample").shm, true);
    assert.equal(local.records.find((r) => r.kind === "sample").firstByte, 7);
    assert.equal(local.records.find((r) => r.kind === "sample").lastByte, 7);
    assert.equal(network.records.find((r) => r.kind === "sample").shm, false);
    assert.equal(local.records.find((r) => r.kind === "sample").fingerprint, network.records.find((r) => r.kind === "sample").fingerprint);
    for (let i = 0; i < 5; i++) {
        transport.publish({ key, bytes: new Uint8Array(65536).fill(i), routeId: "image", generation: 0 });
        await pause(20);
    }
    assert.ok(local.records.filter((r) => r.kind === "sample").every((r) => r.heldIntegrity));
    for (let i = 0; i < 100; i++) transport.publish({ key, bytes: new Uint8Array(65536), routeId: "image", generation: 0 });
    assert.ok(Number(transport.diagnostics().allocationFailures) + Number(transport.diagnostics().drops) > 0);
    assert.equal(transport.state, "open");
    local.child.stdin.write("release\n"); await until(() => local.records.some((r) => r.kind === "released"), "consumer release");
    for (let generation = 1; generation <= 10; generation++) await transport.reset(generation);
    assert.equal(transport.diagnostics().poolReservedBytes, config.shm.poolBytes);
    assert.equal(transport.diagnostics().queueBytes, 0);
    assert.equal(transport.publish({ key, bytes: new Uint8Array(), routeId: "image", generation: 0 }).ok, false);
    const inbound = [];
    const subscription = await transport.subscribe("input", (bytes) => inbound.push([...bytes]), { key: "zpb06/input" });
    await pause(100);
    transport.publish({ key: "zpb06/input", bytes: new Uint8Array([0, 255, 1]), routeId: "echo", generation: 10 });
    await until(() => inbound.length === 1, "native inbound bytes"); assert.deepEqual(inbound[0], [0, 255, 1]);
    await transport.unsubscribe(subscription);
    local.child.kill("SIGKILL");
    await transport.close(); assert.equal(transport.diagnostics().queueBytes, 0);
    const noShmConfig = { ...config, shm: { ...config.shm, mode: "disabled" } };
    const fallback = new ZenohNativeTransport({ config: noShmConfig, nativeBinding: binding });
    await fallback.openSession(); assert.equal(fallback.diagnostics().shmProviderAvailable, false); await fallback.close();
});

test("direct peer network fallback, required SHM rejection and required queue failure", { skip: !addon || !consumer, timeout: 30000 }, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-peer-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const binary = path.join(root, "transport.node"); await fs.copyFile(path.resolve(addon), binary);
    const binding = createRequire(import.meta.url)(binary), endpoint = `tcp/127.0.0.1:${await port()}`, key = "zpb06/direct";
    const peer = childProcess(t, path.resolve(consumer), ["--listen", endpoint, "--key", key, "--hold", "0", "--shm", "false"]);
    await until(() => peer.records.some((r) => r.kind === "ready"), "direct peer startup");
    const config = { kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: [endpoint], connectTimeoutMs: 300 };
    const normalized = resolveZenohTransportHostConfig(config);
    assert.throws(() => binding.createSession(" ".repeat(32769), () => {}), /32 KiB/);
    assert.throws(() => binding.createSession(JSON.stringify({ ...normalized, connect: [endpoint, endpoint] }), () => {}), /configuration/);
    assert.throws(() => binding.createSession(JSON.stringify({ ...normalized, unexpected: true }), () => {}), /unknown field/);
    const gcCheck = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "--eval", `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        const binding = createRequire(import.meta.url)(process.argv[1]);
        let marker = { retained: true };
        const weak = new WeakRef(marker);
        let callback = ((root) => () => { void root.retained; })(marker);
        const session = binding.createSession(process.argv[2], callback);
        await session.close(); await session.close(); marker = null; callback = null;
        for (let i = 0; i < 30; i++) { await new Promise(setImmediate); global.gc(); }
        assert.equal(weak.deref(), undefined);
    `, binary, JSON.stringify(normalized)], { encoding: "utf8", timeout: 10000 });
    assert.equal(gcCheck.status, 0, gcCheck.stderr);
    const preferred = new ZenohNativeTransport({ config, nativeBinding: binding }); t.after(() => preferred.close());
    await preferred.openSession();
    assert.ok(preferred.diagnostics().transports.every((entry) => !entry.shm));
    await pause(100);
    assert.equal(preferred.publish({ key, routeId: "image", bytes: new Uint8Array(65536).fill(31), generation: 0 }).ok, true);
    await until(() => peer.records.some((r) => r.kind === "sample"), "direct network payload");
    assert.equal(peer.records.find((r) => r.kind === "sample").shm, false);
    await preferred.close();
    const required = new ZenohNativeTransport({ config: { ...config, shm: { mode: "required" } }, nativeBinding: binding });
    await assert.rejects(required.openSession(), /Required SHM/); await required.close();
    const events = [], bounded = new ZenohNativeTransport({ config: { ...config, shm: { mode: "disabled" }, queue: { maxBytes: 16, maxEntries: 1 } }, nativeBinding: binding, onEvent: (event) => events.push(event) });
    t.after(() => bounded.close()); await bounded.openSession();
    const packet = { key, routeId: "image", bytes: new Uint8Array(17), generation: 0 };
    assert.equal(bounded.publish(packet).fatal, false); assert.equal(bounded.state, "open");
    assert.equal(bounded.publish({ ...packet, required: true }).fatal, true);
    assert.equal(bounded.state, "failed"); assert.equal(events.length, 1);
    await bounded.close(); assert.equal(bounded.diagnostics().queueBytes, 0);
});
