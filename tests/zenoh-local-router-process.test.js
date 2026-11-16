import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { acquireLocalZenohRouter, zenohProcessIdentity } from "../server/interfaces/ZenohLocalRouter.js";

const exec = promisify(execFile);
async function port() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return result;
}

test("real parent and child identities attach across processes and stop only the owned child", {
    skip: process.env.CEV_SIM_ZENOH_LOCAL_PROCESS_TEST !== "1" || process.platform === "win32", timeout: 20000,
}, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-local-router-process-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const [tcp, ws] = [await port(), await port()];
    const endpoints = { tcp: `tcp/127.0.0.1:${tcp}`, websocket: `ws://127.0.0.1:${ws}/`, wsAddress: `127.0.0.1:${ws}` };
    const source = `
        import net from 'node:net'; import http from 'node:http'; import { createHash } from 'node:crypto';
        const tcp = net.createServer(socket => socket.end()); tcp.listen(${tcp}, '127.0.0.1');
        const ws = http.createServer(); ws.on('upgrade', (request, socket) => {
            const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
            socket.on('data', () => socket.end()); socket.on('error', () => {});
        }); ws.listen(${ws}, '127.0.0.1'); process.on('SIGTERM', () => process.exit(0));
    `;
    let child;
    const logs = [];
    const owner = await acquireLocalZenohRouter({ env: {}, onLog: (line) => logs.push(line), dependencies: {
        root, endpoints, install: async () => ({ binary: process.execPath }),
        spawn: () => { child = spawn(process.execPath, ["--input-type=module", "-e", source], { detached: true, stdio: ["ignore", "pipe", "pipe"] }); return child; },
    } });
    t.after(() => owner.close());
    const attached = await exec(process.execPath, ["--experimental-default-type=module", "--input-type=module", "-e", `
        import { acquireLocalZenohRouter } from ${JSON.stringify(new URL("../server/interfaces/ZenohLocalRouter.js", import.meta.url).href)};
        const router = await acquireLocalZenohRouter({ env: {}, dependencies: { root: ${JSON.stringify(root)}, endpoints: ${JSON.stringify(endpoints)},
            install: async () => { throw Error('attached process must not install'); } } });
        process.stdout.write(JSON.stringify({ role: router.role })); await router.close();
    `], { timeout: 10000 });
    assert.equal(JSON.parse(attached.stdout).role, "attached");
    assert.ok(await zenohProcessIdentity(child.pid));
    await owner.close();
    assert.equal(await zenohProcessIdentity(child.pid), null);
    await assert.rejects(fs.stat(path.join(root, "router.owner.json")), { code: "ENOENT" });
    assert.ok(logs.some((line) => line.endsWith("owner")));
});

test("pinned real router acquires both ephemeral endpoints in router mode", {
    skip: !process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY || process.platform === "win32", timeout: 20000,
}, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-pinned-router-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const [tcp, ws] = [await port(), await port()];
    const endpoints = { tcp: `tcp/127.0.0.1:${tcp}`, websocket: `ws://127.0.0.1:${ws}/`, wsAddress: `127.0.0.1:${ws}` };
    const logs = [];
    const router = await acquireLocalZenohRouter({ env: {}, onLog: (line) => logs.push(line), dependencies: { root, endpoints,
        install: async () => ({ binary: process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY }),
    } });
    t.after(() => router.close());
    assert.equal(router.role, "owner");
    assert.match(logs.join("\n"), /mode.{0,24}[Rr]outer/);
    const attached = await acquireLocalZenohRouter({ env: {}, onLog() {}, dependencies: { root, endpoints } });
    assert.equal(attached.role, "attached"); await attached.close();
    await router.close();
    await assert.rejects(fs.stat(path.join(root, "router.owner.json")), { code: "ENOENT" });
});

test("automatic router forwards exact bytes between official WebSocket SDK and Rust TCP", {
    skip: !process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY || !process.env.CEV_SIM_ZENOH_TEST_CONSUMER || process.platform === "win32", timeout: 20000,
}, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-router-wire-"));
    let router, consumer, consumerExit, session, publisher, subscriber;
    t.after(async () => {
        try {
            await publisher?.undeclare(); await subscriber?.undeclare(); await session?.close();
            if (consumer && consumer.exitCode == null && consumer.signalCode == null) {
                consumer.stdin.end("close\n");
                const kill = setTimeout(() => consumer.kill("SIGKILL"), 2000);
                try { await consumerExit; } finally { clearTimeout(kill); }
            }
        } finally { try { await router?.close(); } finally { await fs.rm(root, { recursive: true, force: true }); } }
    });
    const tcp = await port(), ws = await port();
    const endpoints = { tcp: `tcp/127.0.0.1:${tcp}`, websocket: `ws://127.0.0.1:${ws}/`, wsAddress: `127.0.0.1:${ws}` };
    router = await acquireLocalZenohRouter({ env: {}, onLog() {}, dependencies: { root, endpoints,
        install: async () => ({ binary: process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY }),
    } });
    const key = "sim/router-gate/wire", records = [], inbound = [];
    consumer = spawn(process.env.CEV_SIM_ZENOH_TEST_CONSUMER, ["--connect", endpoints.tcp, "--key", key, "--hold", "0", "--shm", "false"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    consumerExit = new Promise((resolve, reject) => { consumer.once("error", reject); consumer.once("exit", resolve); });
    consumer.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-8192); });
    consumer.stdout.on("data", (chunk) => {
        output += chunk;
        let end;
        while ((end = output.indexOf("\n")) >= 0) { records.push(JSON.parse(output.slice(0, end))); output = output.slice(end + 1); }
    });
    const until = async (check) => {
        const deadline = Date.now() + 5000;
        while (!check()) {
            assert.ok(Date.now() < deadline && consumer.exitCode == null, `Rust wire check timed out: ${errors}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };
    await until(() => records.some((record) => record.kind === "ready"));
    const { Session, Config, Encoding } = await import("@eclipse-zenoh/zenoh-ts");
    session = await Session.open(new Config(endpoints.websocket, 5000));
    subscriber = await session.declareSubscriber(key, { handler: (sample) => inbound.push([...sample.payload().toBytes()]) });
    publisher = await session.declarePublisher(key, { encoding: Encoding.APPLICATION_PROTOBUF });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await publisher.put(new Uint8Array([0, 128, 255, 1]));
    await until(() => records.some((record) => record.kind === "sample") && inbound.length === 1);
    assert.deepEqual(records.find((record) => record.kind === "sample").bytes, [0, 128, 255, 1]);
    consumer.stdin.write("put\n");
    await until(() => inbound.length === 2 && records.some((record) => record.kind === "published"));
    assert.deepEqual(inbound, [[0, 128, 255, 1], [0, 128, 255, 1]]);
});

test("server serves local browser defaults without endpoint files and exits cleanly", {
    skip: process.env.CEV_SIM_ZENOH_LOCAL_PROCESS_TEST !== "1" || process.platform === "win32", timeout: 30000,
}, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-router-server-"));
    const nextDirectory = `.next-router-test-${process.pid}`;
    const httpPort = await port();
    const child = spawn(process.execPath, [new URL("../server/App.js", import.meta.url).pathname], { env: {
        ...process.env, NODE_ENV: "test", PORT: String(httpPort), CEV_SIM_ZENOH_ROUTER: "off", CEV_SIM_REVISION_CHECK: "0",
        CEV_SIM_ZENOH_BROWSER_CONFIG: "", CEV_SIM_HEADLESS_SUPERVISOR_CONFIG: "", CEV_SIM_SUPERVISOR_CONFIG: "",
        CEV_SIM_MARKETPLACE_ENABLED: "0", CEV_SIM_NEXT_DIR: nextDirectory,
        CEV_SIM_DATA_DIR: path.join(root, "data"), CEV_SIM_LOGS_DIR: path.join(root, "logs"),
    }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-8192); });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
    t.after(async () => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { await exited; } finally {
            clearTimeout(kill);
            await fs.rm(root, { recursive: true, force: true });
            await fs.rm(nextDirectory, { recursive: true, force: true });
        }
    });
    const deadline = Date.now() + 20000;
    while (!output.includes("> Ready on")) {
        assert.ok(child.exitCode == null && Date.now() < deadline, output);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const response = await fetch(`http://127.0.0.1:${httpPort}/api/zenoh/browser-config`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).endpoint, "ws://127.0.0.1:10000/");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { assert.equal(await exited, 0, output); } finally { clearTimeout(timeout); }
});
