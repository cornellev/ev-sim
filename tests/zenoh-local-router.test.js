import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { acquireLocalZenohRouter, installZenohRouter, localZenohEndpoints, localZenohBrowserConfig,
    localZenohCacheRoot, localZenohHostId, withLocalZenohTransportDefaults, zenohProcessIdentity, zenohProcessImage, zenohRouterLaunch } from "../server/interfaces/ZenohLocalRouter.js";
import { fsyncDir, writeExclusiveFile } from "../server/storage/visual-assets/atomicFs.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const host = (connect) => ({ kind: "cev-sim.zenoh-transport-host-config", version: 1, connect });
const HOST_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_HOST_ID = "22222222-2222-2222-2222-222222222222";
const legacyOwner = (extra) => ({ kind: "cev-sim.zenoh-router-owner", version: 1, token: "33333333-3333-3333-3333-333333333333",
    hostname: "MacBookPro.localdomain", parent: { pid: 99991, startTime: "gone" }, child: { pid: 99992, startTime: "gone" },
    state: "ready", tcp: "tcp/127.0.0.1:7447", websocket: "ws://127.0.0.1:10000/", ...extra });
async function rootFor(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-local-zenoh-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function harness(t, overrides = {}) {
    const root = await rootFor(t), kills = [], signals = [], logs = [];
    const identities = new Map([[process.pid, { pid: process.pid, startTime: "parent" }]]);
    let child, spawns = 0, installs = 0;
    const dependencies = {
        root, platform: "win32", architecture: "x64", readyMs: 300, stopMs: 30, acquireMs: 1000,
        hostId: async () => HOST_ID, processImage: async () => null,
        identity: async (pid) => identities.get(pid) ?? null,
        signal: async (pid, signalName) => { signals.push(signalName); identities.delete(pid); },
        probe: async () => ({ tcp: !!child && identities.has(child.pid), websocket: !!child && identities.has(child.pid) }),
        install: async () => { installs++; return { binary: path.join(root, "zenohd.exe"), plugin: path.join(root, "zenoh_plugin_remote_api.dll") }; },
        spawn: (binary, args, options) => {
            spawns++; child = new EventEmitter(); child.pid = 91001;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
            child.kill = (signal) => { kills.push(signal); identities.delete(child.pid); child.emit("exit", null, signal); return true; };
            identities.set(child.pid, { pid: child.pid, startTime: "child" });
            child.launch = { binary, args, options };
            return child;
        }, ...overrides,
    };
    const options = { env: {}, dependencies, onLog: (line) => logs.push(line) };
    return { root, dependencies, options, identities, kills, signals, logs, get child() { return child; },
        get spawns() { return spawns; }, get installs() { return installs; } };
}

test("local endpoints validate TCP overrides and keep browser URL canonical", () => {
    assert.deepEqual(localZenohEndpoints({}), { tcp: "tcp/127.0.0.1:7447", websocket: "ws://127.0.0.1:10000/", wsAddress: "127.0.0.1:10000" });
    assert.equal(localZenohEndpoints({ CEV_SIM_ZENOH_TCP_PORT: "65535" }).tcp, "tcp/127.0.0.1:65535");
    for (const value of ["", "0", "-1", "7447.0", " 7447", "07447", "65536", "10000", "abc"]) {
        assert.throws(() => localZenohEndpoints({ CEV_SIM_ZENOH_TCP_PORT: value }), /decimal port/);
    }
    assert.equal(localZenohBrowserConfig({}).endpoint, "ws://127.0.0.1:10000/");
    assert.deepEqual(withLocalZenohTransportDefaults(null, {}).connect, ["tcp/127.0.0.1:7447"]);
    assert.deepEqual(withLocalZenohTransportDefaults(host(["tcp/other:7448"]), {}).connect, ["tcp/other:7448"]);
    assert.throws(() => withLocalZenohTransportDefaults(host([]), {}), /connect/);
    assert.throws(() => withLocalZenohTransportDefaults({ connect: undefined }, {}), /requires/);
    assert.equal(localZenohCacheRoot({}, { platform: "linux", home: "/users/test" }), "/users/test/.cache/cev-sim/zenoh");
    assert.equal(localZenohCacheRoot({ LOCALAPPDATA: "C:\\User Data\\Local" }, { platform: "win32" }), "C:\\User Data\\Local\\cev-sim\\zenoh");
    assert.equal(localZenohCacheRoot({}, { platform: "win32", home: "C:\\Users\\test" }), "C:\\Users\\test\\AppData\\Local\\cev-sim\\zenoh");
});

test("opt-outs and custom endpoints do not touch ownership, cache or ports", async () => {
    const dependencies = { probe() { assert.fail("probe"); }, readPins() { assert.fail("pins"); } };
    for (const env of [{ CEV_SIM_ZENOH_ROUTER: "off", CEV_SIM_ZENOH_TCP_PORT: "bad" }, { NODE_TEST_CONTEXT: "child-v8" }]) {
        const result = await acquireLocalZenohRouter({ env, dependencies }); assert.equal(result.role, "disabled"); await result.close();
    }
    assert.equal((await acquireLocalZenohRouter({ env: {}, dependencies, zenohTransport: host(["tcp/remote:7447"]) })).role, "external");
    assert.equal((await acquireLocalZenohRouter({ env: {}, dependencies, browserConfig: { ...localZenohBrowserConfig({}), endpoint: "ws://remote:10000" } })).role, "external");
    await assert.rejects(acquireLocalZenohRouter({ env: {}, dependencies, zenohTransport: host([]) }), /connect/);
    await assert.rejects(acquireLocalZenohRouter({ env: { CEV_SIM_ZENOH_BROWSER_CONFIG: "/missing/browser.json" }, dependencies }), /ENOENT|not found/i);
});

test("one owner starts while concurrent callers attach; attached close leaves it alive", async (t) => {
    const h = await harness(t);
    const handles = await Promise.all([acquireLocalZenohRouter(h.options), acquireLocalZenohRouter(h.options)]);
    const owner = handles.find((handle) => handle.role === "owner"), attached = handles.find((handle) => handle.role === "attached");
    t.after(() => owner.close());
    assert.ok(owner); assert.ok(attached);
    assert.equal(h.spawns, 1); assert.equal(h.installs, 1);
    const record = JSON.parse(await fs.readFile(path.join(h.root, "router.owner.json")));
    assert.equal(record.state, "ready"); assert.equal(record.child.startTime, "child"); assert.equal(record.hostId, HOST_ID);
    const config = JSON.parse(await fs.readFile(record.config));
    assert.equal(config.plugins.remote_api.__path__, h.child.launch.binary.replace("zenohd.exe", "zenoh_plugin_remote_api.dll"));
    assert.equal(config.plugins.remote_api.__required__, true);
    assert.equal(config.transport.shared_memory.enabled, false);
    assert.equal(h.child.launch.options.shell, false); assert.equal(h.child.launch.options.windowsHide, true);
    await attached.close(); assert.deepEqual(h.kills, []); assert.deepEqual(h.signals, []);
    await Promise.all([owner.close(), owner.close()]); assert.deepEqual(h.kills, ["SIGKILL"]);
    await assert.rejects(fs.stat(path.join(h.root, "router.owner.json")), { code: "ENOENT" });
    assert.ok(h.logs.some((line) => line.endsWith("owner"))); assert.ok(h.logs.some((line) => line.startsWith("attached")));
});

test("POSIX launch explicitly overrides bridge peer mode and shutdown signals its child", async (t) => {
    const launch = zenohRouterLaunch({ binary: "/router" }, localZenohEndpoints({}), "linux");
    assert.deepEqual(launch.args, ["--ws-port", "127.0.0.1:10000", "--cfg", 'mode:"router"']);
    assert.equal(launch.config.mode, "router"); assert.equal(launch.config.scouting.gossip.enabled, false);
    const h = await harness(t, { platform: "darwin", architecture: "arm64" });
    const router = await acquireLocalZenohRouter(h.options); await router.close(); assert.deepEqual(h.kills, ["SIGTERM"]);
});

test("foreign or ambiguous listeners fail before download without killing anything", async (t) => {
    for (const probe of [async () => ({ tcp: true, websocket: false }), async () => { throw new Error("probe denied"); }]) {
        const h = await harness(t, { probe });
        await assert.rejects(acquireLocalZenohRouter(h.options), /foreign|denied/);
        assert.equal(h.installs, 0); assert.deepEqual(h.kills, []);
        await assert.rejects(fs.stat(path.join(h.root, "router.owner.json")), { code: "ENOENT" });
    }
});

test("stale dead identities recover only with both ports free; a non-cache listener is left alone", async (t) => {
    const h = await harness(t);
    const owner = await acquireLocalZenohRouter(h.options);
    const file = path.join(h.root, "router.owner.json"), record = JSON.parse(await fs.readFile(file));
    record.parent = { pid: 99991, startTime: "gone" }; await fs.writeFile(file, JSON.stringify(record));
    h.dependencies.processImage = async () => "/usr/local/bin/other-router";
    await assert.rejects(acquireLocalZenohRouter(h.options), /orphan/);
    assert.deepEqual(h.signals, []); assert.deepEqual(h.kills, []);
    record.child = { pid: 99992, startTime: "gone" }; await fs.writeFile(file, JSON.stringify(record));
    h.dependencies.probe = async () => ({ tcp: false, websocket: false });
    await owner.close();
    await fs.writeFile(file, JSON.stringify(record));
    h.dependencies.probe = async (_, handshake) => ({ tcp: !!handshake, websocket: !!handshake });
    const next = await acquireLocalZenohRouter(h.options); await next.close();
    assert.equal(h.spawns, 2); assert.deepEqual(h.signals, []);
});

test("a dead parent reaps the cache router and a deaf child keeps its record", async (t) => {
    const h = await harness(t, { platform: "linux", architecture: "x64" });
    const owner = await acquireLocalZenohRouter(h.options);
    const file = path.join(h.root, "router.owner.json"), record = JSON.parse(await fs.readFile(file));
    record.parent = { pid: 99991, startTime: "gone" }; record.hostname = "dhcp-vl2041.eduroam.example";
    await fs.writeFile(file, JSON.stringify(record));
    h.dependencies.processImage = async (pid) => pid === h.child.pid ? path.join(h.root, "router", "zenoh-bridge-remote-api") : null;
    const next = await acquireLocalZenohRouter(h.options);
    assert.deepEqual(h.signals, ["SIGTERM"]); assert.equal(next.role, "owner"); assert.equal(h.spawns, 2);
    await next.close();
    h.signals.length = 0;
    const retained = JSON.parse(await fs.readFile(file));
    retained.parent = { pid: 99991, startTime: "gone" }; retained.child = { pid: h.child.pid, startTime: "child" };
    h.identities.set(h.child.pid, { pid: h.child.pid, startTime: "child" });
    await fs.writeFile(file, JSON.stringify(retained));
    h.dependencies.signal = async (_pid, signalName) => { h.signals.push(signalName); };
    await assert.rejects(acquireLocalZenohRouter(h.options), /retained/);
    assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(JSON.parse(await fs.readFile(file)).token, retained.token);
    await owner.close();
});

test("a changed hostname recovers when both ports are free, and another machine is not signaled", async (t) => {
    const h = await harness(t);
    const file = path.join(h.root, "router.owner.json");
    await fs.writeFile(file, JSON.stringify(legacyOwner()));
    h.dependencies.probe = async (_, handshake) => ({ tcp: !!handshake, websocket: !!handshake });
    const recovered = await acquireLocalZenohRouter(h.options);
    assert.equal(recovered.role, "owner"); assert.equal(JSON.parse(await fs.readFile(file)).hostId, HOST_ID);
    const foreign = JSON.parse(await fs.readFile(file));
    foreign.hostId = OTHER_HOST_ID; foreign.parent = { pid: 99991, startTime: "gone" };
    await fs.writeFile(file, JSON.stringify(foreign));
    h.dependencies.probe = async () => ({ tcp: true, websocket: false });
    h.dependencies.processImage = async () => path.join(h.root, "router", "zenoh-bridge-remote-api");
    await assert.rejects(acquireLocalZenohRouter(h.options), /another machine/);
    assert.deepEqual(h.signals, []);
    await recovered.close();
});

test("live owner with a reused child PID, changed pins, or dead child cannot attach", async (t) => {
    const h = await harness(t), owner = await acquireLocalZenohRouter(h.options); t.after(() => owner.close());
    h.identities.set(h.child.pid, { pid: h.child.pid, startTime: "reused" });
    await assert.rejects(acquireLocalZenohRouter(h.options), /child is absent/);
    h.identities.set(h.child.pid, { pid: h.child.pid, startTime: "child" });
    const file = path.join(h.root, "router.owner.json"), record = JSON.parse(await fs.readFile(file));
    record.artifact.version = "other"; await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(acquireLocalZenohRouter(h.options), /different endpoints or artifact/);
    h.child.emit("exit", 1, null); h.identities.delete(h.child.pid);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(acquireLocalZenohRouter(h.options), /failed/);
    assert.equal(h.spawns, 1);
});

test("stale recovery probes recorded ports even when the requested TCP port changes", async (t) => {
    const h = await harness(t), owner = await acquireLocalZenohRouter(h.options);
    const file = path.join(h.root, "router.owner.json"), record = JSON.parse(await fs.readFile(file));
    await owner.close();
    record.parent = { pid: 99991, startTime: "gone" }; record.child = { pid: 99992, startTime: "gone" };
    await fs.writeFile(file, JSON.stringify(record));
    h.dependencies.endpoints = { tcp: "tcp/127.0.0.1:7448", websocket: "ws://127.0.0.1:10000/" };
    h.dependencies.probe = async (endpoints) => ({ tcp: endpoints.tcp === record.tcp, websocket: false });
    await assert.rejects(acquireLocalZenohRouter(h.options), /orphan/);
    assert.equal(h.installs, 1); assert.equal(h.spawns, 1);
});

test("readiness failure, bind diagnostics and cancellation clean up owned children", async (t) => {
    for (const reason of ["timeout", "bind", "abort"]) {
        const controller = new AbortController();
        const h = await harness(t, { readyMs: 20 });
        h.dependencies.probe = async (_, handshake) => {
            if (handshake && reason === "abort") controller.abort();
            if (handshake && reason === "bind") h.child.stderr.emit("data", Buffer.from("Unable to start TcpListener\n"));
            return { tcp: false, websocket: false };
        };
        await assert.rejects(acquireLocalZenohRouter({ ...h.options, signal: controller.signal }));
        assert.deepEqual(h.kills, ["SIGKILL"]);
        await assert.rejects(fs.stat(path.join(h.root, "router.owner.json")), { code: "ENOENT" });
    }
});

test("owner still stops its child when metadata changes, but leaves the foreign record", async (t) => {
    const h = await harness(t), owner = await acquireLocalZenohRouter(h.options);
    const file = path.join(h.root, "router.owner.json"), record = JSON.parse(await fs.readFile(file));
    record.token = "11111111-1111-1111-1111-111111111111"; await fs.writeFile(file, JSON.stringify(record));
    await owner.close(); assert.deepEqual(h.kills, ["SIGKILL"]);
    assert.equal(JSON.parse(await fs.readFile(file)).token, record.token);
});

test("owner escalates POSIX shutdown and retains metadata if exit cannot be confirmed", async (t) => {
    const h = await harness(t, { platform: "linux", architecture: "x64" });
    const owner = await acquireLocalZenohRouter(h.options);
    h.child.kill = (signal) => { h.kills.push(signal); return false; };
    await assert.rejects(owner.close(), /retained/);
    assert.deepEqual(h.kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(JSON.parse(await fs.readFile(path.join(h.root, "router.owner.json"))).state, "stopping");
});

function installerFixture() {
    const files = { "zenohd.exe": new Uint8Array([1, 2, 3]), "zenoh_plugin_remote_api.dll": new Uint8Array([4, 5, 6]) };
    const zipped = Object.entries(files).map(([file, bytes]) => zipSync({ [file]: bytes }));
    const archives = Object.keys(files).map((file, i) => ({ file, name: `${i}.zip`, repository: "test/test", sha256: hash(zipped[i]) }));
    const pins = { routerVersion: "1.10.2", artifacts: { "win32-x64": { archives } } };
    return { files, zipped, pins, options: { platform: "win32", architecture: "x64", dependencies: { readPins: async () => pins, hostId: async () => HOST_ID, identity: async (pid) => ({ pid, startTime: "installer" }) },
        fetchArchive: async (url) => zipped[Number(url.match(/(\d)\.zip$/)[1])] } };
}

test("concurrent Windows installers verify both files and reuse the completed cache", async (t) => {
    const root = await rootFor(t), fixture = installerFixture(); let downloads = 0;
    const options = { ...fixture.options, fetchArchive: async (...args) => { downloads++; return fixture.options.fetchArchive(...args); } };
    const [a, b] = await Promise.all([installZenohRouter(root, options), installZenohRouter(root, options)]);
    assert.equal(a.directory, b.directory); assert.equal(downloads, 2);
    assert.deepEqual([...await fs.readFile(a.binary)], [1, 2, 3]); assert.deepEqual([...await fs.readFile(a.plugin)], [4, 5, 6]);
    await installZenohRouter(root, options); assert.equal(downloads, 2);
    await fs.unlink(a.binary); await installZenohRouter(root, options); assert.equal(downloads, 4);
    await fs.unlink(path.join(a.directory, "installed.json")); await installZenohRouter(root, options); assert.equal(downloads, 6);
    await fs.writeFile(a.plugin, "corrupt"); await fs.unlink(a.binary);
    await assert.rejects(installZenohRouter(root, options), /checksum changed/); assert.equal(downloads, 6);
});

test("runtime installer refuses checksum mismatch, malformed marker, and missing zip entries", async (t) => {
    const root = await rootFor(t), fixture = installerFixture();
    await assert.rejects(installZenohRouter(root, { ...fixture.options, fetchArchive: async () => new Uint8Array([0]) }), /checksum mismatch/);
    assert.deepEqual(await fs.readdir(root), []);
    const installed = await installZenohRouter(root, fixture.options);
    await fs.writeFile(path.join(installed.directory, "installed.json"), "bad");
    await assert.rejects(installZenohRouter(root, fixture.options), /marker is malformed/);
    const missing = zipSync({ "other.exe": new Uint8Array([1]) });
    const second = await rootFor(t);
    fixture.pins.artifacts["win32-x64"].archives[0].sha256 = hash(missing);
    await assert.rejects(installZenohRouter(second, { ...fixture.options, fetchArchive: async (url) => url.endsWith("0.zip") ? missing : fixture.zipped[1] }), /omits zenohd.exe/);
});

test("verified legacy installation migrates without network; cancellation publishes nothing", async (t) => {
    const legacy = await rootFor(t), root = await rootFor(t), fixture = installerFixture();
    const previous = await installZenohRouter(legacy, fixture.options);
    const installed = await installZenohRouter(root, { ...fixture.options, legacyRoot: legacy, fetchArchive: async () => assert.fail("download") });
    assert.deepEqual(await fs.readFile(installed.plugin), await fs.readFile(previous.plugin));
    const cancelled = await rootFor(t), controller = new AbortController();
    await assert.rejects(installZenohRouter(cancelled, { ...fixture.options, signal: controller.signal, fetchArchive: async (...args) => {
        controller.abort(); return fixture.options.fetchArchive(...args);
    } }));
    assert.deepEqual(await fs.readdir(cancelled), []);
});

test("malformed ownership is refused before a router starts", async (t) => {
    const h = await harness(t);
    const file = path.join(h.root, "router.owner.json");
    await fs.writeFile(file, "{");
    await assert.rejects(acquireLocalZenohRouter(h.options), /malformed/);
    await fs.writeFile(file, JSON.stringify({ kind: "cev-sim.zenoh-router-owner", version: 1, hostname: "local", hostId: "not-a-host" }));
    await assert.rejects(acquireLocalZenohRouter(h.options), /ambiguous/);
    assert.equal(h.spawns, 0); assert.deepEqual(h.signals, []);
});

test("installer replaces a legacy hostname lock and another machine's live pid", { timeout: 5000 }, async (t) => {
    const root = await rootFor(t), fixture = installerFixture();
    const directory = path.join(root, "1.10.2-win32-x64");
    const file = `${directory}.install-owner.json`;
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ kind: "cev-sim.zenoh-router-owner", version: 1, token: "44444444-4444-4444-4444-444444444444",
        hostname: "MacBookPro.localdomain", parent: { pid: process.pid, startTime: "installer" }, state: "installing" }));
    await installZenohRouter(root, fixture.options);
    await fs.writeFile(file, JSON.stringify({ kind: "cev-sim.zenoh-router-owner", version: 1, token: "55555555-5555-5555-5555-555555555555",
        hostname: "other.local", hostId: OTHER_HOST_ID, parent: { pid: process.pid, startTime: "installer" }, state: "installing" }));
    await installZenohRouter(root, fixture.options);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("host identity comes from the platform machine id", async () => {
    const uuid = "ABCDEF12-3456-7890-ABCD-EF1234567890";
    assert.equal(await localZenohHostId({ platform: "darwin", execute: async (file, args) => {
        assert.equal(file, "/usr/sbin/ioreg"); assert.deepEqual(args, ["-rd1", "-c", "IOPlatformExpertDevice"]);
        return { stdout: `"IOPlatformUUID" = "${uuid}"\n` };
    } }), uuid.toLowerCase());
    assert.equal(await localZenohHostId({ platform: "linux", readFile: async (file) => {
        assert.equal(file, "/etc/machine-id"); return "0123456789abcdef0123456789abcdef\n";
    } }), "0123456789abcdef0123456789abcdef");
    await assert.rejects(localZenohHostId({ platform: "linux", readFile: async () => "nope" }), /machine id/);
    assert.equal(await localZenohHostId({ platform: "win32", execute: async (file, args) => {
        assert.ok(file.endsWith("powershell.exe")); assert.match(args.at(-1), /MachineGuid/); return { stdout: `${uuid}\r\n` };
    } }), uuid.toLowerCase());
});

test("process image is the router executable and a missing process is empty", async () => {
    const binary = "/home/user/.cache/cev-sim/zenoh/router/1.10.2-linux-x64/zenoh-bridge-remote-api";
    assert.equal(await zenohProcessImage(4, { platform: "linux", readlink: async (file) => {
        assert.equal(file, "/proc/4/exe"); return binary;
    } }), binary);
    assert.equal(await zenohProcessImage(4, { platform: "linux", readlink: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), null);
    assert.equal(await zenohProcessImage(4, { platform: "linux", readlink: async () => `${binary} (deleted)` }), null);
    assert.equal(await zenohProcessImage(4, { platform: "darwin", execute: async (file, args) => {
        assert.equal(file, "/bin/ps"); assert.deepEqual(args, ["-ww", "-p", "4", "-o", "command="]);
        return { stdout: `/Users/Jane Doe/.cache/cev-sim/zenoh/router/app --config /tmp/router.json5\n` };
    } }), "/Users/Jane Doe/.cache/cev-sim/zenoh/router/app");
    assert.equal(await zenohProcessImage(4, { platform: "darwin", execute: async () => ({ stdout: "" }) }), null);
    assert.equal(await zenohProcessImage(4, { platform: "win32", execute: async (file, args) => {
        assert.ok(file.endsWith("powershell.exe")); assert.match(args.at(-1), /ProcessId=4/); assert.equal(args.at(-1).includes("4;"), false);
        return { stdout: "C:\\Users\\Jane\\.cache\\cev-sim\\zenoh\\router\\zenohd.exe\r\n" };
    } }), "C:\\Users\\Jane\\.cache\\cev-sim\\zenoh\\router\\zenohd.exe");
    await assert.rejects(zenohProcessImage("4;Remove-Item", { platform: "win32", execute: async () => assert.fail("signaled") }), /Invalid/);
});

test("process birth identity is platform specific and PowerShell receives only a validated PID", async () => {
    const stat = `123 (test process) ${[...Array(19).fill("0"), "456"].join(" ")}`;
    assert.deepEqual(await zenohProcessIdentity(123, { platform: "linux", readFile: async (file) => file.endsWith("stat") ? stat : "boot\n" }), { pid: 123, startTime: "boot:456" });
    assert.equal(await zenohProcessIdentity(123, { platform: "linux", readFile: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } }), null);
    const execute = async (file, args, options) => { assert.ok(file.endsWith("powershell.exe")); assert.ok(args.at(-1).includes("ProcessId=123")); assert.equal(options.windowsHide, true); return { stdout: "123456789\r\n" }; };
    assert.deepEqual(await zenohProcessIdentity(123, { platform: "win32", execute }), { pid: 123, startTime: "123456789" });
    assert.equal(await zenohProcessIdentity(123, { platform: "win32", execute: async () => ({ stdout: "" }) }), null);
    await assert.rejects(zenohProcessIdentity("123;Remove-Item", { platform: "win32", execute }), /Invalid/);
    await assert.rejects(zenohProcessIdentity(123, { platform: "win32", execute: async () => { throw new Error("CIM denied"); } }), /denied/);
    assert.deepEqual(await zenohProcessIdentity(123, { platform: "darwin", execute: async (_, __, options) => {
        assert.equal(options.env.TZ, "UTC"); return { stdout: "Sun Nov 15 10:00:00 2026\n" };
    } }), { pid: 123, startTime: "Sun Nov 15 10:00:00 2026" });
});

test("Windows directory syncing is skipped while exclusive file publication stays intact", async (t) => {
    await fsyncDir("/does/not/exist", undefined, "win32");
    await assert.rejects(fsyncDir("/does/not/exist", { dirFsync: () => { throw new Error("fault"); } }, "win32"), /fault/);
    const root = await rootFor(t), file = path.join(root, "exclusive.json");
    const results = await Promise.all([writeExclusiveFile(file, "first"), writeExclusiveFile(file, "second")]);
    assert.equal(results.filter((result) => !result.existed).length, 1);
    assert.ok(["first", "second"].includes(await fs.readFile(file, "utf8")));
});
