#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { installZenohRouter } from "./lib/zenoh-artifacts.mjs";
const [installation] = process.argv.slice(2);
if (!installation) throw new Error("Provide the simulator installation directory.");
const root = path.join(path.resolve(installation), ".onboarding");
const { binary } = await installZenohRouter(path.join(root, "router"));
const files = {
    "router.json5": { mode: "router", listen: { endpoints: ["tcp/127.0.0.1:7447"] }, scouting: { multicast: { enabled: false }, gossip: { enabled: false } }, transport: { shared_memory: { enabled: true } } },
    "browser.json": { kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://127.0.0.1:10000" },
    "supervisor.json": { kind: "cev-sim.headless-supervisor-config", version: 1, zenohTransport: { kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: ["tcp/127.0.0.1:7447"], shm: { mode: "preferred" } } },
};
for (const [name, value] of Object.entries(files)) {
    try { await fs.writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
}
console.log(`Router: ${binary} -c ${path.join(root, "router.json5")} --ws-port 127.0.0.1:10000`);
console.log(`CEV_SIM_ZENOH_BROWSER_CONFIG=${path.join(root, "browser.json")}`);
console.log(`CEV_SIM_HEADLESS_SUPERVISOR_CONFIG=${path.join(root, "supervisor.json")}`);
const environment = path.join(path.resolve(installation), ".env.local");
let existing = "";
try { existing = await fs.readFile(environment, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const settings = { CEV_SIM_ZENOH_BROWSER_CONFIG: path.join(root, "browser.json"), CEV_SIM_HEADLESS_SUPERVISOR_CONFIG: path.join(root, "supervisor.json") };
const additions = Object.entries(settings).filter(([key]) => !existing.split("\n").some((line) => line.startsWith(`${key}=`))).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
if (additions.length) await fs.appendFile(environment, `\n${additions.join("\n")}\n`, { mode: 0o600 });
console.log("Import and review examples/interfaces/onboarding-lease.v2.json before starting the Rust launcher.");
