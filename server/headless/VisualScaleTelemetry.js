import { constants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

async function executable(name) {
    for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
        if (!directory) continue;
        const candidate = path.join(directory, name);
        try {
            await fs.access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // continue
        }
    }
    return null;
}

function runTimed(command, args, { timeoutMs = 2_500 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: error.message, timedOut: false });
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut: code == null });
        });
    });
}

async function optionalFile(file) {
    try {
        return (await fs.readFile(file, "utf8")).replaceAll("\0", "").trim();
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EACCES") return null;
        throw error;
    }
}

/**
 * Collect nvidia-smi / tegrastats / RSS telemetry for advertised visual-scale runs.
 * Full hardware mode must fail when no usable memory telemetry is available.
 */
export async function collectVisualScaleTelemetry({ requireGpu = false } = {}) {
    const rssBytes = process.memoryUsage().rss;
    const nvidiaSmi = await executable("nvidia-smi");
    const tegrastats = await executable("tegrastats");
    const nvidia = nvidiaSmi
        ? await runTimed(nvidiaSmi, [
            "--query-gpu=name,driver_version,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        : null;
    const tegra = tegrastats
        ? await runTimed(tegrastats, ["--interval", "200"], { timeoutMs: 1_800 })
        : null;
    const model = await optionalFile("/proc/device-tree/model");
    const l4t = await optionalFile("/etc/nv_tegra_release");
    const nvidiaOk = Boolean(nvidia?.stdout?.trim());
    const tegraOk = Boolean(tegra?.stdout?.trim());
    const available = nvidiaOk || tegraOk;
    if (requireGpu && !available) {
        throw new Error("Full hardware visual-scale mode requires usable GPU/unified-memory telemetry.");
    }
    return {
        available,
        rssBytes,
        model,
        sku: nvidia?.stdout?.split(",")[0]?.trim() ?? model,
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        l4t,
        jetpack: null,
        powerMode: null,
        chromium: process.env.CEV_SIM_CHROMIUM_EXECUTABLE ?? null,
        gpu: nvidia?.stdout?.trim() ?? null,
        driver: nvidia?.stdout?.split(",")[1]?.trim() ?? null,
        gpuMemory: nvidia?.stdout?.trim() ?? null,
        unified: tegra?.stdout?.trim()?.slice(0, 4_096) ?? null,
        nvidiaSmi: nvidiaOk,
        tegrastats: tegraOk,
    };
}
