#!/usr/bin/env node

import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runGpuPreflight } from "../server/headless/GpuPreflight.js";
import { readSupervisorConfig } from "../server/headless/SupervisorConfig.js";
import { parseOptions, processProvenance, run, writeReport } from "./lib/headless-release-support.mjs";

async function optionalFile(file) {
    try { return (await fs.readFile(file, "utf8")).replaceAll("\0", "").trim(); }
    catch (error) { if (error.code === "ENOENT" || error.code === "EACCES") return null; throw error; }
}

async function executable(name) {
    for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
        if (!directory) continue;
        const candidate = path.join(directory, name);
        try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Continue. */ }
    }
    return null;
}

async function commandVersion(command, args) {
    if (!command) return { available: false, output: null };
    try {
        const result = await run(command, args);
        return {
            available: result.code === 0,
            output: `${result.stdout}${result.stderr}`.trim().slice(0, 16_384),
            exitCode: result.code,
        };
    } catch (error) {
        return { available: false, output: error.message, exitCode: null };
    }
}

async function gpuDeviceNodes() {
    const candidates = [];
    for (const directory of ["/dev", "/dev/dri"]) {
        try {
            for (const entry of await fs.readdir(directory)) {
                if (directory === "/dev" && !/^(?:nvhost|nvidia)/.test(entry)) continue;
                if (directory === "/dev/dri" && !/^(?:card|renderD)/.test(entry)) continue;
                candidates.push(path.join(directory, entry));
            }
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
        }
    }
    return Promise.all(candidates.sort().map(async (device) => {
        const stat = await fs.stat(device);
        const access = async (mode) => fs.access(device, mode).then(() => true, () => false);
        return {
            path: device,
            characterDevice: stat.isCharacterDevice(),
            mode: (stat.mode & 0o7777).toString(8).padStart(4, "0"),
            uid: stat.uid,
            gid: stat.gid,
            readable: await access(constants.R_OK),
            writable: await access(constants.W_OK),
        };
    }));
}

async function main() {
    const options = parseOptions(process.argv.slice(2), {
        role: process.platform === "linux" && process.arch === "arm64" ? "jetson-arm64" : `${process.platform}-${process.arch}`,
        config: null,
        output: null,
        requireGpu: false,
    });
    const chromium = await Promise.any([
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ].map(async (name) => {
        const found = await executable(name);
        if (!found) throw new Error("not found");
        return found;
    })).catch(() => null);
    const vulkan = await executable("vulkaninfo");
    const egl = await executable("eglinfo");
    const nvidiaSmi = await executable("nvidia-smi");
    const nvpmodel = await executable("nvpmodel");
    const dpkgQuery = await executable("dpkg-query");
    const id = await executable("id");
    const python = await executable("python3");
    let configuration = null;
    let gpuPreflight = { available: false, reason: "No supervisor config was supplied." };
    if (options.config) {
        configuration = await readSupervisorConfig(options.config);
        gpuPreflight = await runGpuPreflight(configuration.renderer || {});
    }
    const checks = {
        supportedPlatform: ["darwin", "linux"].includes(process.platform),
        supportedArchitecture: ["x64", "arm64"].includes(process.arch),
        nonRoot: typeof process.getuid !== "function" || process.getuid() !== 0,
        gpuRequirement: !options.requireGpu || gpuPreflight.available === true,
    };
    const report = {
        kind: "cev-sim.headless.host-validation",
        version: 1,
        createdAt: new Date().toISOString(),
        role: options.role,
        provenance: processProvenance(),
        operatingSystem: {
            release: os.release(),
            totalMemoryBytes: os.totalmem(),
            osRelease: await optionalFile("/etc/os-release"),
        },
        jetson: {
            model: await optionalFile("/proc/device-tree/model"),
            l4tRelease: await optionalFile("/etc/nv_tegra_release"),
            jetpack: await commandVersion(dpkgQuery, ["-W", "-f=${Version}", "nvidia-jetpack"]),
            powerMode: await commandVersion(nvpmodel, ["-q"]),
        },
        execution: {
            uid: typeof process.getuid === "function" ? process.getuid() : null,
            gid: typeof process.getgid === "function" ? process.getgid() : null,
            groups: typeof process.getgroups === "function" ? process.getgroups() : [],
            groupNames: await commandVersion(id, ["-Gn"]),
        },
        runtimes: {
            node: process.version,
            python: await commandVersion(python, ["--version"]),
            chromium: await commandVersion(configuration?.renderer?.chromiumExecutable || chromium, ["--version"]),
        },
        graphics: {
            deviceNodes: await gpuDeviceNodes(),
            vulkan: await commandVersion(vulkan, ["--summary"]),
            egl: await commandVersion(egl, ["-B"]),
            nvidia: await commandVersion(nvidiaSmi, ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"]),
        },
        sandbox: configuration ? {
            disabled: configuration.renderer?.disableSandbox === true,
            launchArgs: configuration.renderer?.launchArgs || [],
        } : null,
        gpuPreflight,
        checks,
        passed: Object.values(checks).every(Boolean),
    };
    await writeReport(report, options.output);
    if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
