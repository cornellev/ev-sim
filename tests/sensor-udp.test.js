import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { admitUdpTransportBindings, planSensorAdmission } from "../app/simulation/sensors/SensorAdmission.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { ManagedHeadlessSession } from "../server/headless/ManagedHeadlessSession.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import { HostPacketTransportHub } from "../server/sensor-transports/HostPacketTransportHub.js";
import {
    hostDescriptorFromConfig,
    resolveSensorTransportHostConfig,
} from "../server/sensor-transports/SensorTransportConfig.js";
import {
    UdpTransportRuntime,
    createFakeMonotonicClock,
} from "../server/sensor-transports/UdpTransportRuntime.js";
import { UdpTransportSidecarOwner } from "../server/sensor-transports/UdpTransportSidecarOwner.js";
import { measuredPerceptionProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { sortBackendSelections } from "../app/physics/PhysicsBackend.js";
import { createStateSensorBackendSelection } from "../app/simulation/sensors/StateSensorBackend.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import { loadHeadlessGrpcSchema } from "../server/headless/GrpcSchema.js";
import { namedTensor, tensorMap } from "../app/simulation/headless/TensorProtocol.js";
import {
    createPluginPcapHeadlessBundle,
    pluginSensorFixtureResource,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";
import {
    fixtureCombinedBindings,
    fixtureCombinedHostConfig,
    fixturePcapBindings,
    fixturePcapHostConfig,
    fixtureUdpBindings,
    fixtureUdpHostConfig,
    parseClassicPcapIndependently,
} from "./helpers/sensorTransportFixtures.js";

const cliPath = path.resolve("bin/cev-sim.js");
const workerPath = fileURLToPath(new URL("../server/headless/HeadlessWorker.js", import.meta.url));
const sidecarPath = fileURLToPath(new URL("../server/sensor-transports/UdpTransportSidecar.js", import.meta.url));
const runtimePath = fileURLToPath(new URL("../server/sensor-transports/UdpTransportRuntime.js", import.meta.url));

async function temporaryRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-udp-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function packet(bytes, extras = {}) {
    return {
        productId: extras.productId ?? "packets",
        streamId: extras.streamId ?? "data",
        packetIndex: extras.packetIndex ?? 0,
        offsetNs: extras.offsetNs ?? 0,
        payload: bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes),
    };
}

function listenUdp(t, address = "127.0.0.1") {
    const socket = dgram.createSocket("udp4");
    const received = [];
    socket.on("message", (msg) => {
        received.push(Uint8Array.from(msg));
    });
    const ready = new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address, port: 0, exclusive: true }, () => resolve(socket.address().port));
    });
    t.after(() => new Promise((resolve) => socket.close(resolve)));
    return ready.then((port) => ({ socket, port, received }));
}

function createFakeSocketFactory(sent) {
    let nextPort = 40000;
    return () => {
        const socket = new EventEmitter();
        socket.bind = (options) => {
            socket.address = () => ({ address: options.address, port: options.port || nextPort++ });
            queueMicrotask(() => socket.emit("listening"));
            return socket;
        };
        socket.send = (payload, port, address, callback) => {
            const bytes = payload instanceof Uint8Array ? Uint8Array.from(payload) : Uint8Array.from(payload);
            sent.push({ payload: bytes, port, address });
            queueMicrotask(() => callback(null, bytes.byteLength));
        };
        socket.close = () => {};
        socket.off = socket.removeListener.bind(socket);
        return socket;
    };
}

function liveUdpHost({ dataPort, statusPort, sourcePort, pacing } = {}) {
    return fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 16_777_216,
            endpoints: [
                {
                    id: "helios-data",
                    mtu: 1500,
                    source: { address: "127.0.0.1", port: sourcePort },
                    destination: { address: "127.0.0.1", port: dataPort },
                    pacing: pacing ?? { mode: "burst" },
                },
                {
                    id: "helios-status",
                    mtu: 1500,
                    source: { address: "127.0.0.1", port: sourcePort },
                    destination: { address: "127.0.0.1", port: statusPort },
                    pacing: pacing ?? { mode: "burst" },
                },
            ],
        },
    });
}

async function sourcePort(t) {
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    t.after(() => {});
    return port;
}

function episode(environmentIndex, bundleId, bundle) {
    return {
        environmentIndex,
        environmentId: `environment-${environmentIndex}`,
        runBundleId: bundleId,
        resetSeed: String(100 + environmentIndex),
        actionRepeat: 1,
        maxEpisodeSteps: "0",
        observationProfile: measuredPerceptionProfileRef(),
        backendSelections: sortBackendSelections([
            ...bundle.resolved.backendSelections,
            createStateSensorBackendSelection(),
        ]),
    };
}

function bundleEnvelope(bundleId, bundle) {
    return {
        bundleId,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        canonicalJson: Buffer.from(canonicalStringify(bundle)),
    };
}

function zeroAction(environmentIndex) {
    return {
        environmentIndex,
        action: tensorMap([namedTensor("action", "float32", [2], [0, 0])]),
    };
}

function clientCall(client, method, request) {
    return new Promise((resolve, reject) => (
        client[method](request, (error, response) => error ? reject(error) : resolve(response))
    ));
}

async function waitForScheduled(clock, count = 1) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (clock.pendingCount >= count) return;
        await Promise.resolve();
    }
    throw new Error(`expected ${count} scheduled UDP timer(s), found ${clock.pendingCount}`);
}

async function collectImports(entryUrl, visited = new Set()) {
    const href = String(entryUrl);
    if (visited.has(href) || href.includes("/node_modules/")) return visited;
    visited.add(href);
    if (!href.startsWith("file:") || !href.endsWith(".js")) return visited;
    const source = await fs.readFile(fileURLToPath(href), "utf8");
    const matches = [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)];
    for (const match of matches) {
        const specifier = match[1];
        if (specifier.startsWith("node:") || specifier.startsWith("fs") || !specifier.startsWith(".")) continue;
        await collectImports(new URL(specifier, href), visited);
    }
    return visited;
}

function runCli(args, { input = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cliPath, args, { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
        if (input !== null) child.stdin.end(input);
        else child.stdin.end();
    });
}

async function waitFor(predicate, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

test("UDP host config rejects malformed, multicast, broadcast, duplicate-bind, and missing-budget documents", () => {
    const valid = fixtureUdpHostConfig();
    const resolved = resolveSensorTransportHostConfig(valid);
    assert.equal(resolved.udp.endpoints[0].pacing.mode, "burst");
    assert.equal(resolved.udp.endpoints[0].mtu, 1500);
    assert.deepEqual(hostDescriptorFromConfig(resolved).endpoints.map((entry) => entry.adapter), ["udp", "udp"]);

    assert.throws(() => resolveSensorTransportHostConfig({
        kind: "cev-sim.sensor-transport-host-config",
        version: 1,
    }), /at least one of pcap or udp/);
    assert.throws(() => resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [{
                id: "bad",
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "224.0.0.1", port: 2 },
            }],
        },
    })), /unicast literal/);
    assert.throws(() => resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [{
                id: "bad",
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "255.255.255.255", port: 2 },
            }],
        },
    })), /unicast literal/);
    assert.throws(() => resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [
                {
                    id: "a",
                    source: { address: "0.0.0.0", port: 5000 },
                    destination: { address: "127.0.0.1", port: 1 },
                },
                {
                    id: "b",
                    source: { address: "127.0.0.1", port: 5000 },
                    destination: { address: "127.0.0.1", port: 2 },
                },
            ],
        },
    })), /overlapping exclusive binds/);
    assert.throws(() => resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [{
                id: "late",
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "127.0.0.1", port: 2 },
                pacing: { mode: "packet-offset" },
            }],
        },
    })), /latenessBudgetNs is required/);
    assert.throws(() => resolveSensorTransportHostConfig(fixtureCombinedHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [{
                id: "camera-data",
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "127.0.0.1", port: 2 },
            }],
        },
    })), /duplicate id/);
    const pcapOnly = resolveSensorTransportHostConfig(fixturePcapHostConfig());
    assert.equal(pcapOnly.udp, undefined);
});

test("supervisor admission rejects missing UDP endpoints, undersized MTU, and incompatible pacing", () => {
    const bindings = fixtureUdpBindings().bindings;
    assert.throws(() => admitUdpTransportBindings(bindings, {
        endpoints: [],
        clock: { pacing: "realtime", speed: 1 },
        maxQueueBytes: 1024,
        udpMaxQueueBytes: 2048,
    }), (error) => error.code === "UNSUPPORTED_CAPABILITY");

    const undersized = resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: [{
                id: "helios-data",
                mtu: 576,
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "127.0.0.1", port: 2 },
            }, {
                id: "helios-status",
                mtu: 1500,
                source: { address: "0.0.0.0", port: 1 },
                destination: { address: "127.0.0.1", port: 3 },
            }],
        },
    }));
    const large = [{
        ...bindings[0],
        stream: { maxPayloadBytes: 2000 },
    }];
    assert.throws(() => admitUdpTransportBindings(large, {
        endpoints: undersized.udp.endpoints,
        clock: { pacing: "realtime", speed: 1 },
    }), /exceeds endpoint/);

    const offset = resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: fixtureUdpHostConfig().udp.endpoints.map((entry) => ({
                ...entry,
                pacing: { mode: "packet-offset", latenessBudgetNs: 1_000 },
            })),
        },
    }));
    assert.throws(() => admitUdpTransportBindings(bindings, {
        endpoints: offset.udp.endpoints,
        clock: { pacing: "unbounded", speed: 1 },
    }), /realtime clock at speed 1/);
    assert.throws(() => admitUdpTransportBindings(bindings, {
        endpoints: offset.udp.endpoints,
        clock: { pacing: "realtime", speed: 2 },
    }), /realtime clock at speed 1/);
    const admitted = admitUdpTransportBindings(bindings, {
        endpoints: offset.udp.endpoints,
        clock: { pacing: "realtime", speed: 1 },
        maxQueueBytes: 100,
        udpMaxQueueBytes: 50,
    });
    assert.equal(admitted.maxQueueBytes, 50);
});

test("PCAP hub fans identical payload copies to an injected UDP delegate", async (t) => {
    const root = await temporaryRoot(t);
    const udpBatches = [];
    const hub = new HostPacketTransportHub({
        udpDelegate: {
            configure() {},
            queuedBytes: 0,
            enqueueBatch(batch) { udpBatches.push(batch); },
            endDeliveryStep() {},
            async drain() {},
            async beginEpisode() {},
            async beginGeneration() { return { generation: 1 }; },
            attachArtifactRoot() {},
            async finalize() {
                return { generation: 1, packetCount: udpBatches.length };
            },
            async abort() {},
        },
    });
    hub.configure({
        bindings: fixtureCombinedBindings().bindings,
        hostConfig: fixtureCombinedHostConfig(),
        stepNs: 1_000,
    });
    await hub.attachArtifactRoot(root);
    await hub.activateGeneration();
    const payload = Uint8Array.from([9, 8, 7]);
    hub.enqueueBatch({
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        captureTimeNs: 1,
        scheduledDeliveryTimeNs: 1,
        deliveryTimeNs: 1,
        packets: [packet(payload)],
    });
    hub.endDeliveryStep({ step: 1 });
    const evidence = await hub.finalize();
    assert.equal(udpBatches.length, 1);
    assert.deepEqual([...udpBatches[0].packets[0].payload], [9, 8, 7]);
    const records = parseClassicPcapIndependently(await fs.readFile(path.join(root, "sensors.pcap")));
    assert.deepEqual([...records[0].payload], [9, 8, 7]);
    assert.equal(evidence.udp.packetCount, 1);
    assert.ok(evidence.bindings.some((entry) => entry.adapter === "udp"));
});

test("UDP runtime loopback recovers datagram boundaries, routing, and per-stream order", async (t) => {
    const data = await listenUdp(t);
    const status = await listenUdp(t);
    const src = await sourcePort(t);
    const runtime = new UdpTransportRuntime();
    t.after(() => runtime.shutdown());
    const host = liveUdpHost({ dataPort: data.port, statusPort: status.port, sourcePort: src });
    const resolved = resolveSensorTransportHostConfig(host);
    await runtime.prepareEnvironment({
        environmentKey: "env-0",
        endpoints: resolved.udp.endpoints,
        bindings: fixtureUdpBindings().bindings,
        maxQueueBytes: 64_000,
        stepNs: 1_000,
    });
    await runtime.beginGeneration({ environmentKey: "env-0", generation: 1 });
    await runtime.submitBatch({
        environmentKey: "env-0",
        generation: 1,
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        captureTimeNs: 1,
        scheduledDeliveryTimeNs: 1,
        deliveryTimeNs: 1,
        packets: [
            packet([1, 2, 3], { streamId: "status", packetIndex: 1, offsetNs: 10 }),
            packet([9, 8, 7, 6], { streamId: "data", packetIndex: 0, offsetNs: 0 }),
        ],
    });
    await waitFor(() => data.received.length === 1 && status.received.length === 1);
    assert.deepEqual([...data.received[0]], [9, 8, 7, 6]);
    assert.deepEqual([...status.received[0]], [1, 2, 3]);
});

test("fake-clock packet-offset covers targets, equal-offset order, pause, lateness, reset, and cancel", async () => {
    const sent = [];
    const clock = createFakeMonotonicClock(0n);
    const runtime = new UdpTransportRuntime({
        socketFactory: createFakeSocketFactory(sent),
        nowNs: () => clock.nowNs(),
        schedule: (delayNs, callback) => clock.schedule(delayNs, callback),
    });
    const host = resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 10_000,
            endpoints: [{
                id: "helios-data",
                source: { address: "127.0.0.1", port: 1 },
                destination: { address: "127.0.0.1", port: 2 },
                pacing: { mode: "packet-offset", latenessBudgetNs: 5_000_000 },
            }, {
                id: "helios-status",
                source: { address: "127.0.0.1", port: 1 },
                destination: { address: "127.0.0.1", port: 3 },
                pacing: { mode: "packet-offset", latenessBudgetNs: 5_000_000 },
            }],
        },
    }));
    await runtime.prepareEnvironment({
        environmentKey: "clock",
        endpoints: host.udp.endpoints,
        bindings: fixtureUdpBindings().bindings,
        maxQueueBytes: 10_000,
        stepNs: 1_000_000,
    });
    await runtime.beginGeneration({ environmentKey: "clock", generation: 1 });
    const first = runtime.submitBatch({
        environmentKey: "clock",
        generation: 1,
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 2,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        packets: [
            packet([2], { streamId: "status", packetIndex: 0, offsetNs: 0 }),
            packet([1], { streamId: "data", packetIndex: 0, offsetNs: 0 }),
        ],
    });
    await waitForScheduled(clock);
    clock.pause();
    await clock.advance(2_000_000n);
    assert.equal(sent.length, 0);
    clock.resume();
    await clock.flush();
    await first;
    assert.deepEqual(sent.map((entry) => [...entry.payload]), [[1], [2]]);

    const late = runtime.submitBatch({
        environmentKey: "clock",
        generation: 1,
        sensorId: "fixture",
        sampleIndex: 1,
        actualDeliveryStep: 3,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        packets: [packet([3], { offsetNs: 0 })],
    });
    await waitForScheduled(clock);
    await clock.advance(20_000_000n);
    await assert.rejects(late, (error) => error.code === "RESOURCE_LIMIT");

    await runtime.beginGeneration({ environmentKey: "clock", generation: 2 });
    const waiting = runtime.submitBatch({
        environmentKey: "clock",
        generation: 2,
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 8,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        packets: [packet([4], { offsetNs: 0 })],
    });
    await waitForScheduled(clock);
    await runtime.cancelGeneration({ environmentKey: "clock", generation: 2 });
    await assert.rejects(waiting);
    assert.equal(clock.pendingCount, 0);
    await runtime.shutdown();
});

test("burst stress covers bounded memory, atomic overflow, large batches, generations, cancel, and drain", async () => {
    const sent = [];
    const runtime = new UdpTransportRuntime({ socketFactory: createFakeSocketFactory(sent) });
    const host = resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 64,
            endpoints: [{
                id: "helios-data",
                source: { address: "127.0.0.1", port: 11 },
                destination: { address: "127.0.0.1", port: 12 },
            }, {
                id: "helios-status",
                source: { address: "127.0.0.1", port: 11 },
                destination: { address: "127.0.0.1", port: 13 },
            }],
        },
    }));
    await runtime.prepareEnvironment({
        environmentKey: "burst",
        endpoints: host.udp.endpoints,
        bindings: fixtureUdpBindings().bindings,
        maxQueueBytes: 64,
        stepNs: 1,
    });
    await runtime.beginGeneration({ environmentKey: "burst", generation: 1 });
    await assert.rejects(runtime.submitBatch({
        environmentKey: "burst",
        generation: 1,
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        packets: [packet(new Uint8Array(80))],
    }), (error) => error.code === "RESOURCE_LIMIT");
    assert.equal(sent.length, 0);

    const many = Array.from({ length: 8 }, (_, index) => packet(Uint8Array.from([index]), {
        packetIndex: index,
        offsetNs: index,
    }));
    await runtime.submitBatch({
        environmentKey: "burst",
        generation: 1,
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        captureTimeNs: 0,
        scheduledDeliveryTimeNs: 0,
        deliveryTimeNs: 0,
        packets: many,
    });
    assert.equal(sent.length, 8);
    for (let generation = 2; generation <= 64; generation += 1) {
        await runtime.beginGeneration({ environmentKey: "burst", generation });
        await runtime.finalizeGeneration({ environmentKey: "burst", generation });
    }
    await runtime.beginGeneration({ environmentKey: "burst", generation: 65 });
    await runtime.cancelGeneration({ environmentKey: "burst", generation: 65 });
    await runtime.shutdown();
});

test("direct runner and --sensor-transport-config reject UDP; HeadlessWorker cannot import sockets", async (t) => {
    const bundle = await createPluginPcapHeadlessBundle({
        sensorTransports: fixtureUdpBindings(),
    });
    const hostConfig = fixtureUdpHostConfig();
    const root = await temporaryRoot(t);
    await assert.rejects(() => new HeadlessRunner({ hostConfig }).run(bundle, {
        episodeSpec: { actionRepeat: 1, observationProfile: measuredPerceptionProfileRef() },
        actions: [{ policyStep: 1, action: [0, 0] }],
        artifactPolicy: { profile: "evaluation" },
        outputUri: path.join(root, "direct-udp"),
    }), (error) => error.code === "UNSUPPORTED_CAPABILITY");

    const bundlePath = path.join(root, "bundle.json");
    const hostPath = path.join(root, "host.json");
    await fs.writeFile(bundlePath, canonicalStringify(bundle));
    await fs.writeFile(hostPath, `${JSON.stringify(hostConfig, null, 2)}\n`);
    const cli = await runCli([
        "run", "--bundle", bundlePath, "--output", path.join(root, "cli-udp"),
        "--artifact-profile", "evaluation", "--sensor-transport-config", hostPath,
    ], { input: `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n` });
    assert.notEqual(cli.code, 0);
    assert.match(`${cli.stderr}${cli.stdout}`, /UNSUPPORTED_CAPABILITY|supervisor/);

    const graph = await collectImports(pathToFileURL(workerPath));
    const hrefs = [...graph];
    assert.equal(hrefs.some((href) => href.includes("UdpTransportSidecar.js")), false);
    assert.equal(hrefs.some((href) => href.includes("UdpTransportRuntime.js")), false);
    const workerSource = await fs.readFile(workerPath, "utf8");
    assert.doesNotMatch(workerSource, /node:dgram/);
    const simulationRoot = fileURLToPath(new URL("../app/simulation/", import.meta.url));
    const pluginRoot = fileURLToPath(new URL("../app/plugin/", import.meta.url));
    for (const rootDir of [simulationRoot, pluginRoot]) {
        const entries = await fs.readdir(rootDir, { recursive: true });
        for (const name of entries.filter((entry) => String(entry).endsWith(".js"))) {
            const source = await fs.readFile(path.join(rootDir, name), "utf8");
            assert.doesNotMatch(source, /node:dgram|UdpTransportSidecar|UdpTransportRuntime/, name);
        }
    }
    assert.equal(createRequire(import.meta.url).resolve("../server/sensor-transports/UdpTransportRuntime.js"), runtimePath);
    assert.equal(path.basename(sidecarPath), "UdpTransportSidecar.js");
});

test("supervised UDP recovers loopback bytes, matches PCAP payloads, and publishes evidence", { timeout: 60_000 }, async (t) => {
    const data = await listenUdp(t);
    const status = await listenUdp(t);
    const src = await sourcePort(t);
    const root = await temporaryRoot(t);
    const udpHost = liveUdpHost({ dataPort: data.port, statusPort: status.port, sourcePort: src });
    const hostConfig = fixtureCombinedHostConfig({
        udp: udpHost.udp,
    });
    const bundle = await createPluginPcapHeadlessBundle({
        sensorTransports: fixtureCombinedBindings(),
    });
    const socket = path.join(root, "supervisor.sock");
    const running = await startHeadlessSupervisor({ socket, packetTransports: hostConfig });
    t.after(() => running.close());
    const { grpc, service } = loadHeadlessGrpcSchema();
    const client = new service(`unix:${socket}`, grpc.credentials.createInsecure());
    t.after(() => client.close());
    const capabilities = await clientCall(client, "getCapabilities", { clientProtocol: { major: 1, minor: 4 } });
    const diagnostic = JSON.parse(Buffer.from(capabilities.diagnosticJson).toString("utf8"));
    assert.deepEqual(capabilities.transports, ["unix", "tcp-insecure", "grpc+unix+shared-memory-v1"]);
    assert.ok(diagnostic.packetTransports.udp.endpointIds.includes("helios-data"));

    const bundleId = "plugin-udp";
    const spec = episode(0, bundleId, bundle);
    const created = await clientCall(client, "createBatch", {
        clientProtocol: { major: 1, minor: 4 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes: [spec],
        artifactPolicy: { profile: 1, outputUri: path.join(root, "grpc-udp") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const batchId = created.batch.batchId;
    assert.equal((await clientCall(client, "resetBatch", { batchId, episodes: [spec] })).error.code, 0);
    for (const _ of [1, 2, 3, 4]) {
        const stepped = await clientCall(client, "stepBatch", { batchId, actions: [zeroAction(0)] });
        assert.equal(stepped.error.code, 0, stepped.error.message);
        if (stepped.results[0].terminated) break;
    }
    const finalized = await clientCall(client, "finalizeBatch", { batchId, environmentIndices: [0] });
    assert.equal(finalized.results[0].passed, true);
    await waitFor(() => data.received.length > 0);
    const listed = await fs.readdir(path.join(root, "grpc-udp"), { recursive: true });
    const pcapName = listed.find((name) => String(name).endsWith("sensors.pcap"));
    const evidenceName = listed.find((name) => String(name).endsWith("sensor-transport-evidence.json"));
    const timingName = listed.find((name) => String(name).endsWith("sensor-udp-timing.ndjson"));
    assert.ok(pcapName && evidenceName && timingName);
    const records = parseClassicPcapIndependently(await fs.readFile(path.join(root, "grpc-udp", pcapName)));
    const pcapData = records.filter((entry) => entry.sourcePort === 5000).map((entry) => Buffer.from(entry.payload));
    const receivedData = data.received.map((entry) => Buffer.from(entry));
    assert.deepEqual(receivedData, pcapData);
    const evidence = JSON.parse(await fs.readFile(path.join(root, "grpc-udp", evidenceName), "utf8"));
    assert.equal(evidence.kind, "cev-sim.sensor-transport-evidence");
    assert.ok(evidence.udp.generation >= 1);
    assert.ok(evidence.udp.packetCount > 0);
    const timing = (await fs.readFile(path.join(root, "grpc-udp", timingName), "utf8")).trim().split("\n");
    assert.match(timing[0], /sensor-udp-timing/);
    await clientCall(client, "closeBatch", { batchId });
});

test("missing UDP endpoint and packet-offset clock fail before readiness; sidecar crash requires reset", { timeout: 60_000 }, async (t) => {
    const root = await temporaryRoot(t);
    const bundle = await createPluginPcapHeadlessBundle({
        sensorTransports: fixtureUdpBindings(),
    });
    const missing = await startHeadlessSupervisor({
        socket: path.join(root, "missing.sock"),
        packetTransports: fixturePcapHostConfig(),
    });
    t.after(() => missing.close());
    const { service } = loadHeadlessGrpcSchema();
    const missingClient = new service(`unix:${path.join(root, "missing.sock")}`, loadHeadlessGrpcSchema().grpc.credentials.createInsecure());
    t.after(() => missingClient.close());
    const missingCreated = await clientCall(missingClient, "createBatch", {
        clientProtocol: { major: 1, minor: 4 },
        runBundles: [bundleEnvelope("missing", bundle)],
        episodes: [episode(0, "missing", bundle)],
        artifactPolicy: { profile: 1, outputUri: path.join(root, "missing-out") },
    });
    assert.equal(missingCreated.error.code, 6, missingCreated.error.message);

    const offsetHost = fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 1024,
            endpoints: fixtureUdpHostConfig().udp.endpoints.map((entry) => ({
                ...entry,
                pacing: { mode: "packet-offset", latenessBudgetNs: 1_000 },
            })),
        },
    });
    const unbounded = structuredClone(bundle);
    unbounded.resolved.manifest.clock.pacing = "unbounded";
    const resealed = rehashRunBundle(unbounded);
    const offsetSupervisor = await startHeadlessSupervisor({
        socket: path.join(root, "offset.sock"),
        packetTransports: offsetHost,
    });
    t.after(() => offsetSupervisor.close());
    const offsetClient = new service(`unix:${path.join(root, "offset.sock")}`, loadHeadlessGrpcSchema().grpc.credentials.createInsecure());
    t.after(() => offsetClient.close());
    const offsetCreated = await clientCall(offsetClient, "createBatch", {
        clientProtocol: { major: 1, minor: 4 },
        runBundles: [bundleEnvelope("offset", resealed)],
        episodes: [episode(0, "offset", resealed)],
        artifactPolicy: { profile: 1, outputUri: path.join(root, "offset-out") },
    });
    assert.equal(offsetCreated.error.code, 6, offsetCreated.error.message);

    const data = await listenUdp(t);
    const status = await listenUdp(t);
    const src = await sourcePort(t);
    const liveHost = liveUdpHost({ dataPort: data.port, statusPort: status.port, sourcePort: src });
    const crashing = await startHeadlessSupervisor({
        socket: path.join(root, "crash.sock"),
        packetTransports: liveHost,
        killGraceMs: 250,
        shutdownGraceMs: 250,
    });
    t.after(() => crashing.close());
    const crashClient = new service(`unix:${path.join(root, "crash.sock")}`, loadHeadlessGrpcSchema().grpc.credentials.createInsecure());
    t.after(() => crashClient.close());
    const created = await clientCall(crashClient, "createBatch", {
        clientProtocol: { major: 1, minor: 4 },
        runBundles: [bundleEnvelope("crash", bundle)],
        episodes: [episode(0, "crash", bundle)],
        artifactPolicy: { profile: 1, outputUri: path.join(root, "crash-out") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const pid = crashing.supervisor.udpSidecarOwner.pid;
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await waitFor(async () => {
        const health = await clientCall(crashClient, "health", { includeEnvironments: true });
        return health.environments[0]?.requiresReset === true;
    });
    await waitFor(() => {
        try {
            process.kill(pid, 0);
            return false;
        } catch {
            return true;
        }
    });
    const afterPid = crashing.supervisor.udpSidecarOwner.pid;
    assert.equal(crashing.supervisor.udpSidecarOwner.started, false);
    assert.ok(afterPid === pid || crashing.supervisor.udpSidecarOwner.child == null);
});

test("run --config UDP succeeds and endpoint/pacing changes preserve semantic hashes", { timeout: 60_000 }, async (t) => {
    const data = await listenUdp(t);
    const status = await listenUdp(t);
    const src = await sourcePort(t);
    const root = await temporaryRoot(t);
    const bundle = await createPluginPcapHeadlessBundle({
        sensorTransports: fixtureUdpBindings(),
    });
    const host = liveUdpHost({ dataPort: data.port, statusPort: status.port, sourcePort: src });
    const bundlePath = path.join(root, "bundle.json");
    const configPath = path.join(root, "supervisor.json");
    const actionsPath = path.join(root, "actions.jsonl");
    await fs.writeFile(bundlePath, canonicalStringify(bundle));
    await fs.writeFile(configPath, `${JSON.stringify({
        kind: "cev-sim.headless-supervisor-config",
        version: 1,
        preset: "safety",
        renderer: {},
        packetTransports: host,
    }, null, 2)}\n`);
    await fs.writeFile(actionsPath, [1, 2, 3, 4].map((policyStep) => JSON.stringify({ policyStep, action: [0, 0] })).join("\n") + "\n");
    const episodePath = path.join(root, "episode.json");
    await fs.writeFile(episodePath, JSON.stringify({
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    }));
    const run = await runCli([
        "run", "--bundle", bundlePath, "--episode", episodePath, "--actions", actionsPath,
        "--output", path.join(root, "config-udp"), "--artifact-profile", "evaluation",
        "--config", configPath,
    ]);
    assert.equal(run.code, 0, run.stderr);
    await waitFor(() => data.received.length > 0);

    const resource = await pluginSensorFixtureResource();
    const registry = createSensorDefinitionRegistry([verifyPluginPackage(resource)]);
    const base = await createPluginPcapHeadlessBundle();
    const withUdp = structuredClone(base);
    withUdp.resolved.manifest.sensorTransports = fixtureUdpBindings();
    const resealed = rehashRunBundle(withUdp);
    assert.equal(resealed.simulationSemanticHash, base.simulationSemanticHash);
    assert.notEqual(resealed.resolvedHash, base.resolvedHash);
    const hostA = hostDescriptorFromConfig(fixtureUdpHostConfig());
    const hostB = hostDescriptorFromConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 99,
            endpoints: fixtureUdpHostConfig().udp.endpoints.map((entry) => ({
                ...entry,
                destination: { address: "10.0.0.8", port: entry.destination.port },
                pacing: { mode: "packet-offset", latenessBudgetNs: 12 },
            })),
        },
    }));
    const admittedA = planSensorAdmission({
        manifest: resealed.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: resealed.resolved.backendSelections,
        execution: true,
        host: hostA,
    });
    const admittedB = planSensorAdmission({
        manifest: resealed.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: resealed.resolved.backendSelections,
        execution: true,
        host: hostB,
    });
    assert.equal(admittedA.transportBindings.length, 2);
    assert.equal(admittedB.transportBindings.length, 2);
});

test("in-process managed sessions reject UDP host configuration", () => {
    assert.throws(
        () => new ManagedHeadlessSession({ hostConfig: fixtureUdpHostConfig() }),
        (error) => error.code === "UNSUPPORTED_CAPABILITY",
    );
});

test("PCAP-only evidence omits the udp section", async (t) => {
    const root = await temporaryRoot(t);
    const hub = new HostPacketTransportHub();
    hub.configure({
        bindings: fixturePcapBindings().bindings,
        hostConfig: fixturePcapHostConfig(),
        stepNs: 1,
    });
    await hub.attachArtifactRoot(root);
    hub.enqueueBatch({
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        packets: [packet([1])],
    });
    hub.endDeliveryStep({ step: 1 });
    const evidence = await hub.finalize();
    assert.equal(Object.hasOwn(evidence, "udp"), false);
    const written = JSON.parse(await fs.readFile(path.join(root, "sensor-transport-evidence.json"), "utf8"));
    assert.equal(Object.hasOwn(written, "udp"), false);
});

test("sidecar owner delivers a Helios-sized scan above the IPC high-water mark", async (t) => {
    const data = await listenUdp(t);
    data.socket.setRecvBufferSize(1024 * 1024);
    const src = await sourcePort(t);
    const owner = new UdpTransportSidecarOwner({ shutdownGraceMs: 500, killGraceMs: 500 });
    t.after(() => owner.close());
    const host = resolveSensorTransportHostConfig(fixtureUdpHostConfig({
        udp: {
            maxQueueBytesPerEnvironment: 16_777_216,
            endpoints: [{
                id: "helios-data",
                mtu: 1500,
                source: { address: "127.0.0.1", port: src },
                destination: { address: "127.0.0.1", port: data.port },
                pacing: { mode: "burst" },
            }],
        },
    }));
    const packetCount = 150;
    const packetBytes = 1248;
    await owner.prepareEnvironment({
        environmentKey: "helios-scan",
        endpoints: host.udp.endpoints,
        bindings: [{
            sensorId: "helios32",
            productId: "packets",
            streamId: "msop",
            adapter: "udp",
            endpointId: "helios-data",
        }],
        maxQueueBytes: 16_777_216,
        stepNs: 10_000_000,
    });
    await owner.beginGeneration({ environmentKey: "helios-scan", generation: 1 });
    const packets = Array.from({ length: packetCount }, (_, packetIndex) => {
        const payload = new Uint8Array(packetBytes);
        payload[0] = packetIndex & 0xff;
        payload[1] = (packetIndex >> 8) & 0xff;
        return {
            productId: "packets",
            streamId: "msop",
            packetIndex,
            offsetNs: packetIndex,
            payload,
        };
    });
    const result = await owner.submitBatch({
        environmentKey: "helios-scan",
        generation: 1,
        sensorId: "helios32",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        captureTimeNs: 1,
        scheduledDeliveryTimeNs: 1,
        deliveryTimeNs: 1,
        packets,
    });
    assert.equal(result.accepted, packetCount);
    assert.equal(result.payloadBytes, packetCount * packetBytes);
    await waitFor(() => data.received.length === packetCount);
    const byIndex = new Map(data.received.map((payload) => [payload[0] | (payload[1] << 8), payload]));
    assert.equal(byIndex.size, packetCount);
    for (let index = 0; index < packetCount; index += 1) {
        const payload = byIndex.get(index);
        assert.equal(payload?.byteLength, packetBytes);
        assert.equal(payload[0], index & 0xff);
        assert.equal(payload[1], (index >> 8) & 0xff);
    }
});

test("sidecar owner close does not leave an orphan child", async () => {
    const owner = new UdpTransportSidecarOwner({ shutdownGraceMs: 500, killGraceMs: 500 });
    await owner.ensureStarted();
    const pid = owner.pid;
    assert.ok(pid);
    await owner.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("managed supervisor execution sends UDP datagrams", { timeout: 60_000 }, async (t) => {
    const data = await listenUdp(t);
    const status = await listenUdp(t);
    const src = await sourcePort(t);
    const root = await temporaryRoot(t);
    const host = liveUdpHost({ dataPort: data.port, statusPort: status.port, sourcePort: src });
    const bundle = await createPluginPcapHeadlessBundle({
        sensorTransports: fixtureUdpBindings(),
        bundleOptions: {},
    });
    const managedBundle = structuredClone(bundle);
    managedBundle.resolved.manifest.controls.authority = "reference";
    managedBundle.resolved.scenario.scenario.routes[0].controller = {
        kind: "route-follower",
        activation: { kind: "start" },
    };
    const resealed = rehashRunBundle(managedBundle);
    const supervisor = new HeadlessSupervisor({
        socket: path.join(root, "managed.sock"),
        packetTransports: host,
        shutdownGraceMs: 1_000,
        killGraceMs: 1_000,
    });
    t.after(() => supervisor.close());
    const result = await supervisor.runManagedExperiment({
        bundle: resealed,
        artifactPolicy: { profile: 1, outputUri: path.join(root, "managed-udp") },
    });
    assert.equal(result.runResult?.passed ?? result.passed, true);
    await waitFor(() => data.received.length > 0);
});
