import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeZenohBrowserConfig } from "../../app/client/ZenohBrowserConfig.js";
import { resolveZenohTransportHostConfig } from "../sensor-transports/ZenohTransportConfig.js";
import { fsyncDir, fsyncFile, openRegularFile, writeExclusiveFile } from "../storage/visual-assets/atomicFs.js";

const exec = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWNER_KIND = "cev-sim.zenoh-router-owner";
const ACQUIRE_MS = 150000;
const READY_MS = 10000;
const STOP_MS = 5000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => Object.assign(new Error(message), { code: "ZENOH_ROUTER_ERROR" });

export function localZenohEndpoints(env = process.env) {
    const value = env.CEV_SIM_ZENOH_TCP_PORT ?? "7447";
    if (!/^[1-9]\d{0,4}$/.test(String(value)) || Number(value) > 65535 || Number(value) === 10000) {
        throw fail("CEV_SIM_ZENOH_TCP_PORT must be a decimal port from 1 to 65535, excluding remote-API port 10000.");
    }
    return { tcp: `tcp/127.0.0.1:${Number(value)}`, websocket: "ws://127.0.0.1:10000/", wsAddress: "127.0.0.1:10000" };
}

export function localZenohCacheRoot(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
    return platform === "win32" ? path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "cev-sim", "zenoh")
        : path.join(home, ".cache", "cev-sim", "zenoh");
}

export function withLocalZenohTransportDefaults(config, env = process.env) {
    const supplied = config ?? { kind: "cev-sim.zenoh-transport-host-config", version: 1 };
    return resolveZenohTransportHostConfig(supplied.connect === undefined ? { ...supplied, connect: [localZenohEndpoints(env).tcp] } : supplied);
}

export function localZenohBrowserConfig(env = process.env) {
    return normalizeZenohBrowserConfig({ kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: localZenohEndpoints(env).websocket });
}

export async function readZenohRouterPins() {
    return JSON.parse(await fs.readFile(new URL("../../native/zenoh-transport/router-artifacts.json", import.meta.url), "utf8"));
}

const HOST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_LINUX = /^[0-9a-f]{32}$/;
const normalizeHostId = (value) => {
    if (typeof value !== "string") return null;
    const id = value.trim().toLowerCase();
    return HOST_UUID.test(id) || HOST_LINUX.test(id) ? id : null;
};
const powershellExe = () => path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const commandExecutable = (command) => {
    const trimmed = command.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("\"")) {
        const end = trimmed.indexOf("\"", 1);
        return end > 1 ? trimmed.slice(1, end) : null;
    }
    const flags = trimmed.indexOf(" --");
    return (flags > 0 ? trimmed.slice(0, flags) : trimmed).trim() || null;
};

export async function localZenohHostId({ platform = process.platform, readFile = fs.readFile, execute = exec, signal } = {}) {
    if (platform === "linux") {
        const id = normalizeHostId(await readFile("/etc/machine-id", "utf8"));
        if (!id) throw fail("Cannot read the Linux machine id.");
        return id;
    }
    if (platform === "darwin") {
        const result = await execute("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5000, maxBuffer: 1024 * 1024, signal });
        const id = normalizeHostId(result.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]);
        if (!id) throw fail("Cannot read the macOS platform UUID.");
        return id;
    }
    if (platform === "win32") {
        const command = "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid";
        const result = await execute(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 5000, maxBuffer: 16384, windowsHide: true, signal });
        const id = normalizeHostId(result.stdout);
        if (!id) throw fail("Cannot read the Windows machine GUID.");
        return id;
    }
    throw fail(`Local Zenoh host identity is unavailable on ${platform}.`);
}

export async function zenohProcessIdentity(pid, { platform = process.platform, readFile = fs.readFile, execute = exec, signal } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw fail("Invalid router process identity.");
    try {
        let startTime;
        if (platform === "linux") {
            const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
            const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
            if (!/^\d+$/.test(ticks)) throw fail("Cannot read Linux process birth identity.");
            startTime = `${boot.trim()}:${ticks}`;
        } else if (platform === "darwin") {
            const result = await execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5000, maxBuffer: 16384, signal });
            startTime = result.stdout.trim();
            if (!startTime) return null;
        } else if (platform === "win32") {
            const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if($p){$p.CreationDate.ToUniversalTime().Ticks.ToString()}`;
            const result = await execute(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 5000, maxBuffer: 16384, windowsHide: true, signal });
            startTime = result.stdout.trim();
            if (!startTime) return null;
            if (!/^\d+$/.test(startTime)) throw fail("Cannot read Windows process birth identity.");
        } else throw fail(`Local Zenoh process ownership is unavailable on ${platform}.`);
        return { pid, startTime };
    } catch (error) {
        if (error.code === "ENOENT" && platform === "linux") return null;
        if (platform === "darwin" && error.code === 1 && !error.stdout?.trim()) return null;
        throw error;
    }
}

/** Executable path for an orphan check. A missing process is null; this never signals it. */
export async function zenohProcessImage(pid, { platform = process.platform, readlink = fs.readlink, execute = exec, signal } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw fail("Invalid router process identity.");
    try {
        let image;
        if (platform === "linux") {
            image = await readlink(`/proc/${pid}/exe`);
            if (image.endsWith(" (deleted)")) return null;
        } else if (platform === "darwin") {
            const result = await execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 5000, maxBuffer: 1024 * 1024, signal });
            image = commandExecutable(result.stdout);
            if (!image) return null;
        } else if (platform === "win32") {
            const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).ExecutablePath`;
            const result = await execute(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 5000, maxBuffer: 16384, windowsHide: true, signal });
            image = result.stdout.trim();
            if (!image) return null;
        } else throw fail(`Local Zenoh process ownership is unavailable on ${platform}.`);
        return image;
    } catch (error) {
        if (error.code === "ENOENT" && platform === "linux") return null;
        if (platform === "darwin" && error.code === 1 && !error.stdout?.trim()) return null;
        throw error;
    }
}

function executableInRouterCache(executable, cacheRoot) {
    if (typeof executable !== "string" || executable.length === 0) return false;
    const fold = process.platform === "win32" ? (value) => path.resolve(value).toLowerCase() : (value) => path.resolve(value);
    const relative = path.relative(fold(path.join(cacheRoot, "router")), fold(executable));
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function signalRouterProcess(pid, name) {
    try { process.kill(pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function readRegular(file, limit = 16384) {
    const opened = await openRegularFile(file);
    if (!opened) return null;
    try {
        if (opened.stat.size > limit) throw fail(`Router file is too large: ${file}`);
        return await opened.handle.readFile();
    } finally { await opened.handle.close(); }
}

async function readOwner(file) {
    const bytes = await readRegular(file);
    if (!bytes) return null;
    let record;
    try { record = JSON.parse(bytes); } catch { throw fail(`Router ownership is malformed; inspect ${file}.`); }
    const identity = (value) => value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startTime === "string" && value.startTime.length > 0;
    const hostId = record.hostId == null ? null : normalizeHostId(record.hostId);
    if (record.kind !== OWNER_KIND || record.version !== 1 || typeof record.token !== "string" || !/^[a-f0-9-]{36}$/.test(record.token)
        || typeof record.hostname !== "string" || record.hostname.length === 0 || (record.hostId != null && !hostId)
        || !identity(record.parent) || (record.child != null && !identity(record.child))
        || !["installing", "starting", "ready", "failed", "stopping"].includes(record.state)) throw fail(`Router ownership is ambiguous; inspect ${file}.`);
    if (hostId) record.hostId = hostId;
    if (record.state !== "installing" && (!/^tcp\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(record.tcp)
        || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/$/.test(record.websocket)
        || Number(record.tcp.split(":").at(-1)) > 65535 || Number(new URL(record.websocket).port) > 65535)) {
        throw fail(`Router ownership endpoints are ambiguous; inspect ${file}.`);
    }
    return record;
}

async function matches(identity, lookup) {
    if (!identity) return false;
    const actual = await lookup(identity.pid);
    return actual?.startTime === identity.startTime;
}

async function removeOwned(file, token) {
    if ((await readOwner(file))?.token !== token) return false;
    await fs.unlink(file);
    await fsyncDir(path.dirname(file));
    return true;
}

async function recoverOwner(file, observed, safe) {
    const recovery = `${file}.recovery`;
    try { await fs.mkdir(recovery, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") return false; throw error; }
    try {
        const current = await readOwner(file);
        if (current?.token !== observed.token || !await safe(current)) return false;
        return await removeOwned(file, current.token);
    } finally { await fs.rmdir(recovery); }
}

async function writeOwner(file, record) {
    if ((await readOwner(file))?.token !== record.token) throw fail("Router ownership changed while this process was running.");
    const temporary = `${file}.${record.token}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
        await fsyncFile(temporary);
        await fs.rename(temporary, file);
        await fsyncDir(path.dirname(file));
    } finally { await fs.rm(temporary, { force: true }); }
}

async function createOwner(file, record) {
    try { return !(await writeExclusiveFile(file, JSON.stringify(record))).existed; }
    catch (error) {
        await removeOwned(file, record.token).catch(() => {});
        throw error;
    }
}

async function installationLock(file, signal, lookup, deadline, hostId) {
    const parent = await lookup(process.pid);
    if (!parent) throw fail("Cannot identify the router installer process.");
    const record = { kind: OWNER_KIND, version: 1, token: randomUUID(), hostname: os.hostname(), hostId, parent, state: "installing" };
    const foreign = (current) => current.hostId != null && current.hostId !== hostId;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (await createOwner(file, record)) return () => removeOwned(file, record.token);
        const previous = await readOwner(file);
        if (previous && (foreign(previous) || !await matches(previous.parent, lookup))) {
            await recoverOwner(file, previous, async (current) => foreign(current) || !await matches(current.parent, lookup));
        }
        await delay(100, undefined, { signal });
    }
    throw fail("Timed out waiting for the router installer owner.");
}

/** Checksum-pinned runtime installation; dependencies are test seams, not host settings. */
export async function installZenohRouter(root, { platform = process.platform, architecture = process.arch, fetchArchive, signal, legacyRoot, dependencies = {} } = {}) {
    const pair = await (dependencies.readPins ?? readZenohRouterPins)();
    const record = pair.artifacts[`${platform}-${architecture}`];
    if (!record) throw fail(`Zenoh router is unavailable for ${platform}-${architecture}.`);
    const archives = record.archives ?? [{ repository: "eclipse-zenoh/zenoh-ts", name: record.name, sha256: record.sha256, file: "zenoh-bridge-remote-api" }];
    const files = archives.map((archive) => archive.file);
    const directory = path.join(path.resolve(root), `${pair.routerVersion}-${platform}-${architecture}`);
    const result = { binary: path.join(directory, files[0]), directory, version: pair.routerVersion, plugin: platform === "win32" ? path.join(directory, files[1]) : null };
    const archiveHashes = archives.map((archive) => archive.sha256);
    const readInstalled = async (from) => {
        const bytes = await readRegular(path.join(from, "installed.json"));
        if (!bytes) return null;
        let installed;
        try { installed = JSON.parse(bytes); } catch { throw fail("Installed router marker is malformed."); }
        if (installed.formatVersion !== undefined && installed.formatVersion !== 2) throw fail("Installed router marker version is unsupported.");
        const hashes = installed.formatVersion === 2 ? installed.archiveSha256s : [installed.archiveSha256];
        const expected = installed.formatVersion === 2 ? installed.files : { [files[0]]: installed.binarySha256 };
        if (installed.version !== pair.routerVersion || JSON.stringify(hashes) !== JSON.stringify(archiveHashes)
            || !expected || files.some((file) => !/^[a-f0-9]{64}$/.test(expected[file]))) throw fail("Installed router checksum identity changed.");
        const contents = {};
        let missing = false;
        for (const file of files) {
            const bytes = await readRegular(path.join(from, file), 128 * 1024 * 1024);
            if (!bytes) { missing = true; continue; }
            if (sha256(bytes) !== expected[file]) throw fail("Installed router checksum changed.");
            contents[file] = bytes;
        }
        return missing ? null : contents;
    };
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const hostId = normalizeHostId(await (dependencies.hostId ?? localZenohHostId)({ signal }));
    if (!hostId) throw fail("Cannot identify the local machine.");
    const unlock = await installationLock(`${directory}.install-owner.json`, signal,
        dependencies.identity ?? zenohProcessIdentity, Date.now() + ACQUIRE_MS, hostId);
    try {
        if (await readInstalled(directory)) return result;
        let contents = legacyRoot ? await readInstalled(path.join(path.resolve(legacyRoot), path.basename(directory))) : null;
        if (!contents) {
            const { unzipSync } = await import("fflate");
            const downloads = new AbortController();
            let downloaded;
            try { downloaded = await Promise.all(archives.map(async (archive) => {
                const url = `https://github.com/${archive.repository}/releases/download/${pair.routerVersion}/${archive.name}`;
                const requestSignal = AbortSignal.any([downloads.signal, ...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
                const bytes = fetchArchive ? await fetchArchive(url, requestSignal) : await (async () => {
                    const response = await fetch(url, { signal: requestSignal });
                    if (!response.ok) throw fail(`Router download failed: ${response.status}`);
                    return new Uint8Array(await response.arrayBuffer());
                })();
                signal?.throwIfAborted();
                if (sha256(bytes) !== archive.sha256) throw fail("Router archive checksum mismatch.");
                const contents = unzipSync(bytes, { filter: (entry) => entry.name === archive.file })[archive.file];
                if (!contents?.length) throw fail(`Router archive omits ${archive.file}.`);
                return [archive.file, contents];
            })); } finally { downloads.abort(); }
            contents = Object.fromEntries(downloaded);
        }
        signal?.throwIfAborted();
        const staging = await fs.mkdtemp(`${directory}.tmp-`);
        let incomplete = null;
        try {
            for (const [file, bytes] of Object.entries(contents)) {
                await fs.writeFile(path.join(staging, file), bytes, { mode: 0o755 });
                await fsyncFile(path.join(staging, file));
            }
            await fs.writeFile(path.join(staging, "installed.json"), `${JSON.stringify({ formatVersion: 2, version: pair.routerVersion,
                archiveSha256s: archiveHashes, files: Object.fromEntries(files.map((file) => [file, sha256(contents[file])])) })}\n`, { mode: 0o600 });
            await fsyncFile(path.join(staging, "installed.json"));
            await fsyncDir(staging);
            try {
                const entries = await fs.readdir(directory);
                if (entries.some((entry) => ![...files, "installed.json"].includes(entry))) throw fail("Incomplete router cache contains unexpected files; refusing replacement.");
                incomplete = `${directory}.incomplete-${randomUUID()}`;
                await fs.rename(directory, incomplete);
            } catch (error) { if (error.code !== "ENOENT") throw error; }
            try { await fs.rename(staging, directory); }
            catch (error) { if (incomplete) { await fs.rename(incomplete, directory); incomplete = null; } throw error; }
            await fsyncDir(root);
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
            if (incomplete) await fs.rm(incomplete, { recursive: true, force: true });
        }
        return result;
    } finally { await unlock(); }
}

function tcpListening(host, port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(500);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("timeout", () => { socket.destroy(); reject(fail(`Cannot determine ownership of ${host}:${port}.`)); });
        socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(error); });
    });
}

async function probeEndpoints(endpoints, handshake = false) {
    const tcpPort = Number(endpoints.tcp.slice(endpoints.tcp.lastIndexOf(":") + 1));
    const ws = new URL(endpoints.websocket);
    const [tcp, websocket] = await Promise.all([tcpListening("127.0.0.1", tcpPort), tcpListening(ws.hostname, Number(ws.port))]);
    if (!handshake || !websocket) return { tcp, websocket };
    const open = await new Promise((resolve) => {
        const socket = new WebSocket(endpoints.websocket);
        let settled = false;
        const done = (value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); socket.close(); resolve(value);
        };
        const timer = setTimeout(() => done(false), 500);
        socket.addEventListener("open", () => done(true), { once: true });
        socket.addEventListener("error", () => done(false), { once: true });
        socket.addEventListener("close", () => done(false), { once: true });
    });
    return { tcp, websocket: open };
}

export function zenohRouterLaunch(installed, endpoints, platform = process.platform) {
    const config = { mode: "router", listen: { endpoints: [endpoints.tcp] }, scouting: { multicast: { enabled: false }, gossip: { enabled: false } },
        transport: { shared_memory: { enabled: platform !== "win32" } } };
    if (installed.plugin) {
        config.plugins_loading = { enabled: true, search_dirs: [] };
        config.plugins = { remote_api: { __path__: installed.plugin, __required__: true, websocket_port: endpoints.wsAddress } };
    }
    return { config, args: installed.plugin ? [] : ["--ws-port", endpoints.wsAddress, "--cfg", 'mode:"router"'] };
}

/** One parent owns the child. Attached handles never signal it. A later start may stop an orphan whose parent is gone and whose executable is the cache router. */
export async function acquireLocalZenohRouter({ env = process.env, browserConfig, zenohTransport, signal, repositoryRoot = REPOSITORY_ROOT,
    onLog = (line) => process.stderr.write(`[zenoh-router] ${line}\n`), dependencies = {} } = {}) {
    const skipped = (role) => ({ role, async close() {} });
    if (env.CEV_SIM_ZENOH_ROUTER === "off" || env.NODE_TEST_CONTEXT) return skipped("disabled");
    if (browserConfig === undefined && env.CEV_SIM_ZENOH_BROWSER_CONFIG) {
        browserConfig = await import("./ZenohBrowserConfig.js").then((module) => module.readZenohBrowserConfig(env));
    }
    const endpoints = dependencies.endpoints ?? localZenohEndpoints(env);
    if (browserConfig && normalizeZenohBrowserConfig(browserConfig).endpoint !== endpoints.websocket) return skipped("external");
    const host = zenohTransport == null ? null : resolveZenohTransportHostConfig(zenohTransport);
    if (host && (host.connect.length !== 1 || host.connect[0] !== endpoints.tcp)) return skipped("external");
    const root = dependencies.root ?? localZenohCacheRoot(env);
    const platform = dependencies.platform ?? process.platform;
    const lookup = dependencies.identity ?? ((pid) => zenohProcessIdentity(pid, { platform }));
    const probe = dependencies.probe ?? probeEndpoints;
    const pair = await (dependencies.readPins ?? readZenohRouterPins)();
    const artifact = pair.artifacts[`${platform}-${dependencies.architecture ?? process.arch}`];
    if (!artifact) throw fail(`Zenoh router is unavailable for ${platform}-${dependencies.architecture ?? process.arch}.`);
    const hashes = (artifact.archives ?? [artifact]).map((entry) => entry.sha256);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("Router cache must be a local directory, not a symlink.");
    const file = path.join(root, "router.owner.json");
    const parent = await lookup(process.pid);
    if (!parent) throw fail("Cannot identify the router parent process.");
    const acquisition = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(dependencies.acquireMs ?? ACQUIRE_MS)]);
    const hostId = normalizeHostId(await (dependencies.hostId ?? localZenohHostId)({ signal: acquisition }));
    if (!hostId) throw fail("Cannot identify the local machine.");
    const imageOf = dependencies.processImage ?? ((pid) => zenohProcessImage(pid, { platform, signal: acquisition }));
    const signalProcess = dependencies.signal ?? signalRouterProcess;
    const record = { kind: OWNER_KIND, version: 1, token: randomUUID(), hostname: os.hostname(), hostId, parent, child: null,
        state: "starting", tcp: endpoints.tcp, websocket: endpoints.websocket, artifact: { version: pair.routerVersion, hashes } };
    const foreignHost = (current) => current.hostId != null && current.hostId !== hostId;
    const portsFree = async (previous) => {
        const ports = await probe({ tcp: previous.tcp, websocket: previous.websocket });
        return !ports.tcp && !ports.websocket;
    };
    const safeRecovery = async (previous) => {
        if (foreignHost(previous)) return portsFree(previous);
        if (await matches(previous.parent, lookup) || await matches(previous.child, lookup)) return false;
        return portsFree(previous);
    };
    const waitDead = async (identity) => {
        const deadline = Date.now() + (dependencies.stopMs ?? STOP_MS);
        while (await matches(identity, lookup)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return false;
            await delay(Math.min(50, remaining), undefined, { signal: acquisition });
        }
        return true;
    };
    const reapChild = async (previous) => {
        const identity = previous.child;
        if (!await matches(identity, lookup)) return false;
        const executable = await imageOf(identity.pid);
        if (!executableInRouterCache(executable, root) || !await matches(identity, lookup)) return false;
        await signalProcess(identity.pid, platform === "win32" ? "SIGKILL" : "SIGTERM");
        if (await waitDead(identity)) return true;
        await signalProcess(identity.pid, "SIGKILL");
        if (await waitDead(identity)) return true;
        throw fail("Owned router did not exit; its ownership record has been retained.");
    };
    while (true) {
        acquisition.throwIfAborted();
        if (await createOwner(file, record)) break;
        const previous = await readOwner(file);
        if (!previous) continue;
        if (foreignHost(previous)) {
            if (!await safeRecovery(previous)) throw fail("Router ownership belongs to another machine and a listener remains; inspect it before restarting.");
            await recoverOwner(file, previous, safeRecovery);
        } else if (!await matches(previous.parent, lookup)) {
            if (await reapChild(previous)) await recoverOwner(file, previous, async (current) => current.token === previous.token && !await matches(current.child, lookup));
            else if (!await safeRecovery(previous)) throw fail("Router owner is absent but a child or listener remains; inspect the orphan before restarting.");
            else await recoverOwner(file, previous, safeRecovery);
        } else {
            if (previous.tcp !== endpoints.tcp || previous.websocket !== endpoints.websocket
                || JSON.stringify(previous.artifact) !== JSON.stringify(record.artifact)) throw fail("A live router owner has different endpoints or artifact pins.");
            if (["failed", "stopping"].includes(previous.state)) throw fail(`The local router owner is ${previous.state}; wait for it to exit before restarting.`);
            if (previous.state === "ready") {
                if (!await matches(previous.child, lookup)) throw fail("The local router child is absent; its live owner must exit before restarting.");
                const ports = await probe(endpoints, true);
                const current = await readOwner(file);
                if (ports.tcp && ports.websocket && current?.token === previous.token && current.state === "ready") {
                    onLog(`attached ${endpoints.tcp} ${endpoints.websocket}`);
                    return skipped("attached");
                }
            }
        }
        await delay(100, undefined, { signal: acquisition });
    }
    let child = null, exited = null, childFailure = null, childExited = false, closing = null;
    let writes = Promise.resolve();
    const update = () => {
        const snapshot = { ...record };
        writes = writes.then(() => writeOwner(file, snapshot));
        return writes;
    };
    const instance = path.join(root, "instances", record.token);
    const waitForExit = () => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), dependencies.stopMs ?? STOP_MS);
        exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    const close = () => closing ??= (async () => {
        let metadataError;
        if (child) {
            onLog("stopping");
            record.state = "stopping";
            await writes.catch(() => {});
            try { if ((await readOwner(file))?.token === record.token) await writeOwner(file, record); }
            catch (error) { metadataError = error; }
            if (!childExited) child.kill(platform === "win32" ? "SIGKILL" : "SIGTERM");
            if (!await waitForExit()) {
                child.kill("SIGKILL");
                if (!await waitForExit()) {
                    child.unref();
                    child.stdout?.destroy?.(); child.stderr?.destroy?.();
                    throw fail("Owned router did not exit; its ownership record has been retained.");
                }
            }
        }
        try { await removeOwned(file, record.token); }
        finally { await fs.rm(instance, { recursive: true, force: true }); }
        if (metadataError) throw metadataError;
    })();
    try {
        const ports = await probe(endpoints);
        if (ports.tcp || ports.websocket) throw fail("A foreign listener owns a local Zenoh port; use CEV_SIM_ZENOH_ROUTER=off for a manually managed router.");
        onLog("starting");
        const installed = await (dependencies.install ?? installZenohRouter)(path.join(root, "router"), {
            signal: acquisition, platform, architecture: dependencies.architecture ?? process.arch,
            legacyRoot: path.join(repositoryRoot, ".onboarding", "router"),
            dependencies: { hostId: async () => hostId, identity: lookup },
        });
        acquisition.throwIfAborted();
        const beforeSpawn = await probe(endpoints);
        if (beforeSpawn.tcp || beforeSpawn.websocket) throw fail("A foreign listener claimed a Zenoh port during installation.");
        const launch = zenohRouterLaunch(installed, endpoints, platform);
        await fs.mkdir(instance, { recursive: true, mode: 0o700 });
        record.config = path.join(instance, "router.json5");
        await fs.writeFile(record.config, JSON.stringify(launch.config), { mode: 0o600 });
        child = (dependencies.spawn ?? spawn)(installed.binary, ["--config", record.config, ...launch.args], {
            detached: true, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...env, RUST_LOG: "info" },
        });
        exited = new Promise((resolve) => {
            child.once("error", (error) => { childFailure = error; if (!child.pid) { childExited = true; resolve(); } });
            child.once("exit", (code, signal) => {
                childExited = true;
                childFailure = fail(`Router exited (${signal || code}).`);
                if (!closing) { record.state = "failed"; update().catch((error) => onLog(error.message)); onLog(childFailure.message); }
                resolve();
            });
        });
        for (const stream of [child.stdout, child.stderr]) {
            let pending = "";
            stream?.on("data", (bytes) => {
                pending = (pending + bytes.toString()).slice(-8192);
                let newline;
                while ((newline = pending.indexOf("\n")) >= 0) {
                    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
                    onLog(line);
                    if (/Unable to start TcpListener|Failed to start Zenoh runtime|Cannot load plugin|Failed to load.*plugin/i.test(line)) childFailure = fail(`Router startup failed: ${line}`);
                }
            });
        }
        record.child = await lookup(child.pid);
        if (!record.child || childFailure) throw childFailure ?? fail("Router child exited during startup.");
        await update();
        const deadline = Date.now() + (dependencies.readyMs ?? READY_MS);
        while (Date.now() < deadline) {
            acquisition.throwIfAborted();
            if (childFailure) throw childFailure;
            const ready = await probe(endpoints, true);
            if (ready.tcp && ready.websocket && await matches(record.child, lookup)) {
                if (childFailure) throw childFailure;
                record.state = "ready";
                await update();
                onLog(`ready ${endpoints.tcp} ${endpoints.websocket} owner`);
                return { role: "owner", close };
            }
            await delay(100, undefined, { signal: acquisition });
        }
        throw fail("Router did not become ready on both local endpoints.");
    } catch (error) {
        try { await close(); } catch (cleanup) { onLog(cleanup.message); }
        throw error;
    }
}
