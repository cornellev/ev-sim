#!/usr/bin/env node

import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

function options(argv) {
    const result = {
        url: "http://127.0.0.1:3100",
        manifest: null,
        manifestFile: null,
        durationMs: 30_000,
        warmupMs: 5_000,
        output: null,
        headed: false,
        forceInline: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        if (name === "--headed") result.headed = true;
        else if (name === "--force-inline") result.forceInline = true;
        else if (name === "--url") result.url = argv[++index];
        else if (name === "--manifest") result.manifest = argv[++index];
        else if (name === "--manifest-file") result.manifestFile = argv[++index];
        else if (name === "--duration-ms") result.durationMs = Number(argv[++index]);
        else if (name === "--warmup-ms") result.warmupMs = Number(argv[++index]);
        else if (name === "--output") result.output = argv[++index];
        else throw new Error(`Unknown option ${name}.`);
    }
    return result;
}

function cameraWorkload(resolved) {
    const cameras = (resolved?.manifest?.sensorRig?.sensors ?? [])
        .filter((sensor) => sensor.enabled !== false && sensor.type === "camera");
    if (cameras.length !== 1) return null;
    const camera = cameras[0];
    const products = camera.calibration?.products ?? {};
    const exactProducts = ["rgb", "depth", "semantic", "instance"].every((name) => products[name] === true);
    const zeroLatency = Number(camera.latency?.fixedNs ?? 0) === 0
        && Number(camera.latency?.jitterNs ?? 0) === 0;
    const provider = resolved?.renderScene?.description?.provider;
    if (Number(resolved.manifest.clock?.stepNs) !== 16_666_667
        || Number(camera.rateHz) !== 30
        || Number(camera.calibration?.width) !== 320
        || Number(camera.calibration?.height) !== 180
        || !zeroLatency
        || !exactProducts
        || provider?.id !== "pbr-mesh"
        || Number(provider.version) !== 1) {
        return null;
    }
    return {
        fixedStepHz: 60,
        stepNs: resolved.manifest.clock.stepNs,
        cameraId: camera.id,
        cameraRateHz: camera.rateHz,
        width: camera.calibration.width,
        height: camera.calibration.height,
        latencyNs: 0,
        products: ["rgb", "depth", "semantic", "instance"],
        renderProvider: { id: provider.id, version: provider.version },
    };
}

async function resolveCandidate(page, requestedId, manifestOverride = null) {
    return page.evaluate(async ({ requestedId: requested, override }) => {
        if (override) {
            const id = String(override.id || requested || "browser-performance-benchmark");
            const candidate = await fetch(`/api/storage/run-manifests/${encodeURIComponent(id)}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ manifest: { ...override, id } }),
            });
            if (!candidate.ok) throw new Error(`Could not resolve benchmark manifest (${candidate.status}).`);
            return [await candidate.json()];
        }
        const response = await fetch("/api/storage/run-manifests");
        if (!response.ok) throw new Error(`Could not list run manifests (${response.status}).`);
        const catalog = await response.json();
        const ids = requested
            ? [requested]
            : (catalog.items ?? catalog.manifests ?? catalog ?? []).map((entry) => entry.id);
        const resolved = [];
        for (const id of ids) {
            const candidate = await fetch(`/api/storage/run-manifests/${encodeURIComponent(id)}/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            });
            if (candidate.ok) resolved.push(await candidate.json());
        }
        return resolved;
    }, { requestedId, override: manifestOverride });
}

async function main() {
    const config = options(process.argv.slice(2));
    const manifestOverride = config.manifestFile
        ? JSON.parse(await fs.readFile(config.manifestFile, "utf8"))
        : null;
    const browser = await chromium.launch({
        headless: !config.headed,
        args: ["--enable-precise-memory-info"],
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        page.on("pageerror", (error) => process.stderr.write(`[browser] ${error.stack || error.message}\n`));
        page.on("console", (message) => {
            if (message.type() === "error") process.stderr.write(`[browser console] ${message.text()}\n`);
        });
        await page.goto(`${config.url.replace(/\/$/, "")}/?browserPerformance=1`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => globalThis.__cevSimBenchmarkRuntime, null, { timeout: 60_000 });
        const candidates = await resolveCandidate(page, config.manifest, manifestOverride);
        const selected = candidates.map((resolved) => ({ resolved, workload: cameraWorkload(resolved) }))
            .find((entry) => entry.workload);
        if (!selected) {
            throw new Error(
                "No run manifest matches the 60 Hz / one 320x180 30 Hz zero-latency PBR camera workload. "
                + "Create that manifest or pass its id with --manifest.",
            );
        }
        await page.evaluate(async ({ resolved, workload, warmupMs, forceInline }) => {
            await globalThis.__cevSimBenchmarkRuntime.prepare(resolved, { forceInline });
            globalThis.__cevSimBrowserPerformance.start({ workload, warmupMs });
            await globalThis.__cevSimBenchmarkRuntime.play();
        }, {
            resolved: selected.resolved,
            workload: selected.workload,
            warmupMs: config.warmupMs,
            forceInline: config.forceInline,
        });
        await page.waitForTimeout(config.warmupMs + config.durationMs);
        const result = await page.evaluate(async () => {
            await globalThis.__cevSimBenchmarkRuntime.pause();
            const runtime = globalThis.__cevSimBenchmarkRuntime.snapshot();
            const report = globalThis.__cevSimBrowserPerformance.stop();
            return { ...report, runtime };
        });
        const json = `${JSON.stringify(result, null, 2)}\n`;
        if (config.output) await fs.writeFile(config.output, json);
        else process.stdout.write(json);
        if (!result.passed) process.exitCode = 1;
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
