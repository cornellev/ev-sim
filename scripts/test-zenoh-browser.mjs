import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { unzipSync } from "fflate";
import WebSocket from "ws";

const pair = JSON.parse(await readFile(new URL("../tests/fixtures/protobuf/zenoh-browser-compatibility.json", import.meta.url)));
const artifact = pair.artifacts[`${process.platform}-${process.arch}`];
if (!artifact) throw new Error("Browser compatibility gate requires Linux x64 or macOS ARM64.");
const directory = await mkdtemp(path.join(tmpdir(), "cev-zenoh-browser-"));
let binary = process.env.CEV_SIM_ZENOH_BROWSER_TEST_BINARY;
if (!binary) {
    const response = await fetch(`https://github.com/eclipse-zenoh/zenoh-ts/releases/download/${pair.routerVersion}/${artifact.name}`);
    if (!response.ok) throw new Error(`Router download failed: ${response.status}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== artifact.sha256) throw new Error("Router archive checksum mismatch.");
    const files = unzipSync(archive);
    binary = path.join(directory, "zenoh-bridge-remote-api");
    await writeFile(binary, files["zenoh-bridge-remote-api"]);
    await chmod(binary, 0o755);
}
const config = path.join(directory, "browser.json");
const routerConfig = path.join(directory, "router.json5");
await writeFile(config, JSON.stringify({ kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://127.0.0.1:10005" }));
await writeFile(routerConfig, JSON.stringify({ listen: { endpoints: [] }, scouting: { multicast: { enabled: false }, gossip: { enabled: false } } }));
await mkdir(path.join(directory, "storage"));
function startRouter() { return spawn(binary, ["--config", routerConfig, "--ws-port", "127.0.0.1:10005"], { stdio: "ignore" }); }
let router = startRouter();
async function ready() {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (router.exitCode !== null) throw new Error(`Router exited ${router.exitCode}`);
        const connected = await new Promise((resolve) => { const socket = new WebSocket("ws://127.0.0.1:10005"); const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 200);
            socket.on("open", () => { clearTimeout(timer); socket.close(); resolve(true); }); socket.on("error", () => { clearTimeout(timer); resolve(false); }); });
        if (connected) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Router did not open its remote API.");
}
// Tests request a real router restart through this small local control server.
const { createServer } = await import("node:http");
const control = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/restart") { response.writeHead(404).end(); return; }
    try {
        const old = router;
        await new Promise((resolve) => { old.once("exit", resolve); old.kill(); });
        await new Promise((resolve) => setTimeout(resolve, 4500));
        router = startRouter(); await ready(); response.writeHead(200).end("restarted");
    } catch (error) { response.writeHead(500).end(error.message); }
});
try {
    await ready(); await new Promise((resolve) => control.listen(10006, "127.0.0.1", resolve));
    const tests = spawn("npx", ["playwright", "test", "tests/ui/zenoh-browser.spec.js", "tests/ui/protobuf-interface.spec.js"], {
        stdio: "inherit", env: { ...process.env, CEV_SIM_ZENOH_BROWSER_CONFIG: config, CEV_SIM_ZENOH_BROWSER_GATE: "1", CEV_SIM_DATA_DIR: path.join(directory, "storage") },
    });
    const code = await new Promise((resolve) => tests.on("exit", resolve)); process.exitCode = code ?? 1;
} finally { router.kill(); control.close(); }
