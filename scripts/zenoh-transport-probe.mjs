#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ZenohNativeTransport } from "../server/sensor-transports/ZenohNativeTransport.js";
import { validateZenohTransportAdmission } from "../server/sensor-transports/ZenohTransportConfig.js";
import { ProtobufRouteRuntime } from "../app/interfaces/ProtobufRouteRuntime.js";
import { percentile } from "../server/headless/ReleaseReports.js";
import { imageRun } from "../tests/helpers/zenohFixtures.js";
import { REPOSITORY_ROOT, parseOptions, processProvenance, run, writeReport } from "./lib/headless-release-support.mjs";
import { verifyZenohArtifact } from "./lib/zenoh-artifacts.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) { const deadline = Date.now() + 10000; while (!check()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await pause(10); } }
async function peakRss(pid) {
    if (process.platform !== "linux") return null;
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    return Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024;
}
async function hardwareIdentity() {
    async function read(file) { try { return (await fs.readFile(file, "utf8")).replaceAll("\0", "").trim().slice(0, 1024); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
    return { deviceModel: await read("/proc/device-tree/model"), nvTegraRelease: await read("/etc/nv_tegra_release") };
}

async function main() {
    const options = parseOptions(process.argv.slice(2), { addon: null, consumer: path.join(REPOSITORY_ROOT, "native/zenoh-transport/target/debug/consumer"),
        router: process.env.CEV_SIM_ZENOHD || "zenohd", endpoint: null, output: null, frames: "120", width: "640", height: "480", role: `${process.platform}-${process.arch}` });
    const width = Number(options.width), height = Number(options.height), frames = Number(options.frames);
    if (![width, height, frames].every((n) => Number.isSafeInteger(n) && n > 0) || frames > 10000) throw new Error("Probe dimensions and frame count must be positive bounded integers.");
    if (!options.addon) throw new Error("--addon requires an explicit locally built or release native artifact.");
    const hardware = await hardwareIdentity();
    if (options.role.startsWith("jetson") && (process.platform !== "linux" || process.arch !== "arm64"
        || (!hardware.nvTegraRelease && !/jetson/i.test(hardware.deviceModel ?? "")))) throw new Error("A Jetson report requires a Linux ARM64 Tegra/Jetson host.");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zenoh-probe-"));
    const children = [], transports = [];
    function start(executable, args) {
        const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
        const records = [];
        let pending = "", stderr = "";
        const exited = once(child, "exit").catch((error) => { stderr = error.message; });
        child.stdout.on("data", (bytes) => {
            pending += bytes;
            if (pending.length > 65536) child.kill("SIGKILL");
            let end;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                try { records.push(JSON.parse(line)); } catch { /* Router logs are text. */ }
                if (records.length > 12000) child.kill("SIGKILL");
            }
        });
        child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8192); });
        const record = { child, records, exited, stderr: () => stderr };
        children.push(record); return record;
    }
    let report;
    try {
        let artifact = null;
        const source = path.resolve(options.addon);
        try {
            artifact = JSON.parse(await fs.readFile(`${source}.json`, "utf8"));
            await verifyZenohArtifact(path.dirname(source), artifact);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (process.platform === "linux" && !artifact) throw new Error("Linux acceptance reports require a verified release artifact and its .node.json record.");
        const binary = path.join(root, "transport.node"); await fs.copyFile(source, binary);
        const binding = createRequire(import.meta.url)(binary);
        let endpoint = options.endpoint;
        const routerVersion = await run(options.router, ["--version"]);
        let routerProcess = null;
        if (routerVersion.code || !routerVersion.stdout.includes("1.10.2")) throw new Error("The probe requires an explicit compatible Zenoh 1.10.2 router.");
        if (!endpoint) {
            const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
            const number = server.address().port; await new Promise((resolve) => server.close(resolve));
            endpoint = `tcp/127.0.0.1:${number}`;
            routerProcess = start(options.router, ["--listen", endpoint, "--no-multicast-scouting", "--cfg", "transport/shared_memory/enabled:true", "--cfg", "transport/shared_memory/transport_optimization/enabled:false"]);
            await pause(200);
        }
        const config = { kind: "cev-sim.zenoh-transport-host-config", version: 1, connect: [endpoint], shm: { mode: "required" } };
        const resolvedRun = imageRun({ width, height });
        const admission = validateZenohTransportAdmission({ resolvedRun, config });
        const transport = new ZenohNativeTransport({ config, admission, nativeBinding: binding }); transports.push(transport);
        await transport.openSession();
        const routes = new ProtobufRouteRuntime({ publicationPort: (packet) => transport.publish(packet) });
        routes.configure({ resolvedRun }); await transport.reset(routes.generation);
        const key = admission.routesById.get("image").key;
        const local = start(path.resolve(options.consumer), ["--connect", endpoint, "--key", key, "--hold", "1", "--shm", "true"]);
        const network = start(path.resolve(options.consumer), ["--connect", endpoint, "--key", key, "--hold", "0", "--shm", "false"]);
        await until(() => local.records.some((r) => r.kind === "ready") && network.records.some((r) => r.kind === "ready"), "consumer declarations");
        await pause(200);
        const latency = [], rss = [process.memoryUsage().rss];
        const value = { data: new Uint8Array(width * height * 4), width, height, pixelFormat: "rgba8", strideBytes: width * 4 };
        const started = performance.now();
        for (let frame = 0; frame < frames; frame++) {
            value.data.fill(frame % 256);
            const start = performance.now();
            assert.equal(routes.publishTopic({ topicId: "image", valueContract: { id: "cev.image", version: 1 }, value,
                metadata: { simTimeNs: frame * 16666667 } }).ok, true);
            latency.push(performance.now() - start);
            await until(() => local.records.filter((r) => r.kind === "sample").length > frame
                && network.records.filter((r) => r.kind === "sample").length > frame, "publication delivery");
            rss.push(process.memoryUsage().rss);
        }
        const elapsedMs = performance.now() - started;
        const localSamples = local.records.filter((r) => r.kind === "sample"), networkSamples = network.records.filter((r) => r.kind === "sample");
        assert.ok(localSamples.every((r) => r.shm && r.heldIntegrity));
        assert.ok(networkSamples.every((r) => !r.shm));
        assert.deepEqual(localSamples.map((r) => r.fingerprint), networkSamples.map((r) => r.fingerprint));
        const normal = transport.diagnostics();
        const processPeakRssBytes = { producer: await peakRss(process.pid), localConsumer: await peakRss(local.child.pid),
            networkConsumer: await peakRss(network.child.pid), router: routerProcess ? await peakRss(routerProcess.child.pid) : null };
        for (let frame = 0; frame < 100; frame++) transport.publish({ key, bytes: new Uint8Array(Math.max(65536, value.data.byteLength)), routeId: "image", generation: routes.generation });
        assert.ok(Number(transport.diagnostics().drops) > Number(normal.drops));
        local.child.stdin.write("release\n"); await until(() => local.records.some((r) => r.kind === "released"), "held reference release");
        const resetRss = [];
        for (let count = 0; count < 100; count++) { await transport.reset(routes.reset()); resetRss.push(process.memoryUsage().rss); }
        const afterReset = transport.diagnostics();
        assert.equal(afterReset.poolReservedBytes, 64 * 1024 * 1024); assert.equal(afterReset.queueBytes, 0);
        assert.ok(resetRss.at(-1) - resetRss[0] < 64 * 1024 * 1024, "Reset RSS grew by a whole SHM pool.");
        processPeakRssBytes.producer = await peakRss(process.pid);
        processPeakRssBytes.localConsumer = await peakRss(local.child.pid);
        processPeakRssBytes.networkConsumer = await peakRss(network.child.pid);
        if (routerProcess) processPeakRssBytes.router = await peakRss(routerProcess.child.pid);
        local.child.kill("SIGKILL"); await local.exited;
        const survivingFrames = network.records.filter((r) => r.kind === "sample").length;
        assert.equal(transport.publish({ key, bytes: new Uint8Array(65536), routeId: "image", generation: routes.generation }).ok, true);
        await until(() => network.records.filter((r) => r.kind === "sample").length > survivingFrames, "delivery after consumer crash");
        const crashKey = `${key}/producer-crash`;
        const retained = start(path.resolve(options.consumer), ["--connect", endpoint, "--key", crashKey, "--hold", "1", "--shm", "true"]);
        await until(() => retained.records.some((r) => r.kind === "ready"), "producer-crash consumer");
        const producerCode = `const { createRequire } = await import('node:module');
            const binding = createRequire(import.meta.url)(process.argv[1]);
            const session = binding.createSession(process.argv[2], () => {});
            await session.openSession();
            const keepAlive = setInterval(() => {}, 1000);
            setTimeout(() => { const result = session.publish(process.argv[3], new Uint8Array(65536).fill(58), 'crash', 0, true);
                if (!result.ok) { clearInterval(keepAlive); process.exit(1); } }, 200);`;
        const producer = start(process.execPath, ["--input-type=module", "--eval", producerCode, binary, JSON.stringify(transport.config), crashKey]);
        await until(() => retained.records.some((r) => r.kind === "sample"), "crash producer publication");
        assert.equal(retained.records.find((r) => r.kind === "sample").shm, true);
        producer.child.kill("SIGKILL"); await producer.exited;
        retained.child.stdin.write("check\n");
        await until(() => retained.records.some((r) => r.kind === "checked"), "integrity after producer crash");
        const checked = retained.records.find((r) => r.kind === "checked");
        assert.equal(checked.held, 1); assert.equal(checked.heldIntegrity, true);
        retained.child.stdin.write("release\n");
        await until(() => retained.records.some((r) => r.kind === "released"), "crash reference release");
        await transport.close(); const afterClose = transport.diagnostics();
        assert.equal(afterClose.poolReservedBytes, 0); assert.equal(afterClose.queueBytes, 0);
        for (const reader of [network, retained]) reader.child.stdin.end("close\n");
        await until(() => [network, retained].every((reader) => reader.child.exitCode === 0), "consumer SDK close");
        assert.ok([network, retained].every((reader) => reader.records.some((record) => record.kind === "closed")));
        report = { kind: "cev-sim.zenoh-transport-report", version: 1, createdAt: new Date().toISOString(), passed: true,
            role: options.role, provenance: processProvenance({ artifact, router: routerVersion.stdout.trim(), hardware }),
            captureSource: "synthetic-native-image", gpuReadbackMeasured: false, endToEndZeroCopy: false,
            image: { width, height, pixelFormat: "rgba8", maximumEncodedBytes: admission.imagePayloadBounds.get("image") },
            frames, throughputFramesPerSecond: frames * 1000 / elapsedMs, publicationLatencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99) },
            memory: { processPeakRssBytes, nodePeakRssBytes: Math.max(...rss, ...resetRss), resetStartRssBytes: resetRss[0], resetEndRssBytes: resetRss.at(-1) },
            checks: { localShm: true, mixedConsumerBytes: true, retainedIntegrity: true, exhaustion: true, repeatedResets: true, closeCleanup: true, consumerCleanup: true, consumerCrash: true, producerCrash: true },
            normal, afterReset, afterClose };
    } catch (error) {
        report = { kind: "cev-sim.zenoh-transport-report", version: 1, createdAt: new Date().toISOString(), passed: false,
            role: options.role, provenance: processProvenance(), reason: error.message, children: children.map((child) => ({ stderr: child.stderr() })) };
        process.exitCode = 1;
    } finally {
        for (const transport of transports) await transport.close().catch(() => {});
        for (const { child, exited } of children.reverse()) {
            if (child.exitCode != null || child.signalCode != null) continue;
            child.stdin.end("close\n");
            await Promise.race([exited, pause(100)]);
            if (child.exitCode != null || child.signalCode != null) continue;
            child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timer);
        }
        await fs.rm(root, { recursive: true, force: true });
    }
    await writeReport(report, options.output);
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
