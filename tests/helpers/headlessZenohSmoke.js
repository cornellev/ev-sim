import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { externalBundle } from "./headlessZenoh.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, label) {
    const deadline = Date.now() + 10000;
    while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(10); }
}
export async function routerEndpoint() {
    const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return `tcp/127.0.0.1:${port}`;
}
export function launch(executable, args) {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    exited.catch(() => {});
    let output = "", stderr = "";
    const records = [];
    child.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.length > 65536 || records.length > 10000) child.kill("SIGKILL");
        let index;
        while ((index = output.indexOf("\n")) >= 0) {
            const line = output.slice(0, index); output = output.slice(index + 1);
            try { records.push(JSON.parse(line)); } catch { /* Router diagnostics use text. */ }
        }
    });
    child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8192); });
    async function close() {
        if (child.exitCode != null || child.signalCode != null) return exited;
        child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try { return await exited; } finally { clearTimeout(timer); }
    }
    return { child, records, exited, close, error: () => stderr };
}
export function launchController(addon, configPath, bundlePath) {
    return launch(process.execPath, ["--experimental-default-type=module", fileURLToPath(new URL("./zenohExternalController.js", import.meta.url)), path.resolve(addon), configPath, bundlePath]);
}

export async function runZenohCliSmoke({ executable, addon, root, supervised = false, interrupt = false }) {
    const endpoint = await routerEndpoint();
    const router = launch(process.env.CEV_SIM_ZENOHD || "zenohd", ["--listen", endpoint, "--no-multicast-scouting"]);
    let controller, cli;
    try {
        await sleep(200);
        const configPath = path.join(root, "zenoh.json"), bundlePath = path.join(root, "run.json");
        const config = { kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: [endpoint], shm: { mode: "disabled" } };
        await writeFile(configPath, JSON.stringify(config)); await writeFile(bundlePath, JSON.stringify(await externalBundle({ maxSteps: interrupt ? null : 160 })));
        controller = launchController(addon, configPath, bundlePath);
        await until(() => controller.records.some((r) => r.kind === "connected"), "controller connection");
        const args = ["run", "--bundle", bundlePath, "--output", path.join(root, "result"), "--controller-mode", "external-realtime"];
        if (supervised) {
            const hostPath = path.join(root, "supervisor.json");
            await writeFile(hostPath, JSON.stringify({ kind: "cev-sim.headless-supervisor-config", version: 1, zenohTransport: config })); args.push("--config", hostPath);
        } else args.push("--zenoh-transport-config", configPath);
        cli = launch(executable, args);
        await until(() => {
            if (cli.child.exitCode != null || cli.child.signalCode != null) throw new Error(`CLI exited before readiness: ${cli.error()}`);
            return cli.records.some((r) => r.kind === "cev-sim.headless.external-ready");
        }, "CLI readiness");
        controller.child.stdin.write(`${JSON.stringify(cli.records.find((r) => r.kind === "cev-sim.headless.external-ready").descriptor)}\n`);
        await until(() => controller.records.some((r) => r.kind === "wheel" && r.speed > 0.1), "external vehicle motion");
        if (interrupt) cli.child.kill("SIGINT");
        const exit = await Promise.race([cli.exited, sleep(10000).then(() => { throw new Error("CLI completion timed out."); })]);
        const result = cli.records.find((r) => r.kind === "cev-sim.headless.result")?.result;
        if (exit.code !== (interrupt ? 130 : 0) || !result || result.controllerMode !== "external-realtime" || result.interruptedBySignal !== interrupt) throw new Error(`External CLI failed: ${JSON.stringify(exit)} ${cli.error()}`);
        return { result, maxMeasuredSpeed: Math.max(...controller.records.filter((r) => r.kind === "wheel").map((r) => r.speed)) };
    } finally { await cli?.close(); await controller?.close(); await router.close(); }
}
