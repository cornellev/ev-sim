import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import express from "express";

import {
    BrowserPacketRelaySink,
    decodeRelayFrame,
    encodeRelayFrame,
} from "../app/simulation/sensors/BrowserPacketRelaySink.js";
import { packetPayloadDigest } from "../app/simulation/sensors/NativeSensorPacket.js";
import { planSensorAdmission } from "../app/simulation/sensors/SensorAdmission.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createBrowserPacketRouter } from "../server/routes/browserPacketRouter.js";
import { BrowserPacketRelay } from "../server/sensor-transports/BrowserPacketRelay.js";
import { resolveSensorTransportHostConfig } from "../server/sensor-transports/SensorTransportConfig.js";
import { createPluginPcapHeadlessBundle, pluginSensorFixtureResource } from "./helpers/headlessRunnerBundle.js";
import {
    fixtureCombinedHostConfig,
    fixtureUdpBindings,
    fixtureUdpHostConfig,
} from "./helpers/sensorTransportFixtures.js";

function payload(size, seed) {
    return Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) & 0xff);
}

function packet(streamId, packetIndex, bytes) {
    return { productId: "packets", streamId, packetIndex, offsetNs: packetIndex * 1000, payload: bytes, payloadDigest: packetPayloadDigest(bytes) };
}

function heliosBatch(sampleIndex = 0) {
    const packets = Array.from({ length: 150 }, (_, index) => packet("msop", index, payload(1248, index)));
    packets.push(packet("difop", 0, payload(1248, 255)));
    return {
        sensorId: "helios",
        sampleIndex,
        actualDeliveryStep: 6,
        captureTimeNs: 100_000_000n,
        scheduledDeliveryTimeNs: 100_000_000,
        deliveryTimeNs: 100_000_000,
        packets,
    };
}

const heliosBindings = [
    { sensorId: "helios", productId: "packets", streamId: "msop", adapter: "udp", endpointId: "helios-msop" },
    { sensorId: "helios", productId: "packets", streamId: "difop", adapter: "udp", endpointId: "helios-difop" },
];

async function freeUdpPort() {
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve) => socket.bind({ address: "127.0.0.1", port: 0 }, resolve));
    const { port } = socket.address();
    await new Promise((resolve) => socket.close(resolve));
    return port;
}

async function listenUdp(t) {
    const socket = dgram.createSocket("udp4");
    const received = [];
    socket.on("message", (message) => received.push(Uint8Array.from(message)));
    await new Promise((resolve) => socket.bind({ address: "127.0.0.1", port: 0 }, resolve));
    t.after(() => socket.close());
    return { port: socket.address().port, received };
}

function heliosHostConfig({ sourcePort, msopPort, difopPort, pacing = { mode: "burst" } }) {
    return resolveSensorTransportHostConfig({
        kind: "cev-sim.sensor-transport-host-config",
        version: 1,
        udp: {
            maxQueueBytesPerEnvironment: 16_777_216,
            endpoints: [
                { id: "helios-msop", mtu: 1500, source: { address: "127.0.0.1", port: sourcePort }, destination: { address: "127.0.0.1", port: msopPort }, pacing },
                { id: "helios-difop", mtu: 1500, source: { address: "127.0.0.1", port: sourcePort }, destination: { address: "127.0.0.1", port: difopPort }, pacing },
            ],
        },
    });
}

async function serveRelay(t, relay) {
    const app = express();
    app.use("/api/browser-packets", createBrowserPacketRouter(relay));
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    t.after(async () => {
        await relay.shutdown();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/api/browser-packets`;
}

async function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("relay frames round-trip batches, bigint timestamps, and exact payload bytes", () => {
    const batch = heliosBatch(3);
    const [decoded] = decodeRelayFrame(encodeRelayFrame([batch]));
    assert.equal(decoded.sensorId, "helios");
    assert.equal(decoded.captureTimeNs, "100000000");
    assert.equal(decoded.packets.length, 151);
    assert.deepEqual(decoded.packets[150].payload, batch.packets[150].payload);
    assert.equal(decoded.packets[42].payloadDigest, batch.packets[42].payloadDigest);
    const truncated = encodeRelayFrame([batch]).subarray(0, 4000);
    assert.throws(() => decodeRelayFrame(truncated), /truncated/);
    assert.throws(() => decodeRelayFrame(new Uint8Array(8)), /CEVR/);
});

test("relay advertises only UDP and refuses bindings it cannot send", async () => {
    assert.deepEqual(new BrowserPacketRelay().hostDescriptor().adapters, []);
    const combined = new BrowserPacketRelay({ hostConfig: resolveSensorTransportHostConfig(fixtureCombinedHostConfig()) });
    assert.deepEqual(combined.hostDescriptor().adapters, ["udp"]);
    assert.ok(combined.hostDescriptor().endpoints.every((entry) => entry.adapter === "udp"));

    await assert.rejects(new BrowserPacketRelay().open({ bindings: heliosBindings }), /no UDP host config/);
    const relay = new BrowserPacketRelay({ hostConfig: heliosHostConfig({ sourcePort: 1, msopPort: 2, difopPort: 3 }) });
    await assert.rejects(relay.open({ bindings: [{ ...heliosBindings[0], adapter: "pcap" }] }), /only sends UDP/);
    await assert.rejects(relay.open({ bindings: [{ ...heliosBindings[0], endpointId: "missing" }] }), /not configured/);
    await assert.rejects(relay.open({ bindings: [] }), /at least one/);
    const paced = new BrowserPacketRelay({
        hostConfig: heliosHostConfig({ sourcePort: 1, msopPort: 2, difopPort: 3, pacing: { mode: "packet-offset", latenessBudgetNs: 1 } }),
    });
    await assert.rejects(paced.open({ bindings: heliosBindings }), /burst pacing/);
});

test("admission accepts browser UDP only while the relay advertises it", async () => {
    const registry = createSensorDefinitionRegistry([verifyPluginPackage(await pluginSensorFixtureResource())]);
    const bundle = await createPluginPcapHeadlessBundle({ sensorTransports: fixtureUdpBindings() });
    const admit = (host) => planSensorAdmission({
        manifest: bundle.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: bundle.resolved.backendSelections,
        execution: true,
        host,
    });
    const configured = new BrowserPacketRelay({ hostConfig: resolveSensorTransportHostConfig(fixtureUdpHostConfig()) });
    assert.equal(admit(configured.hostDescriptor()).transportBindings.length, 2);
    assert.throws(() => admit(new BrowserPacketRelay().hostDescriptor()), /adapter "udp" is unavailable/);

    const sink = new BrowserPacketRelaySink({ fetchImpl: async () => { throw new Error("offline"); } });
    const context = createSimulationRuntimeContext({ sensorTransportHost: () => sink.hostDescriptor() });
    await sink.refreshHost();
    assert.throws(() => admit(context.devices.sensorTransportHost()), /adapter "udp" is unavailable/);
});

test("sink drops and counts batches while a post is in flight or after failure", async () => {
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
        if (url.endsWith("/sessions")) return Response.json({ sessionId: "s1" });
        if (init.method === "DELETE") return Response.json({ released: true });
        return new Promise((resolve) => posts.push(resolve));
    };
    const sink = new BrowserPacketRelaySink({ fetchImpl });
    sink.enqueueBatch(heliosBatch());
    assert.equal(sink.stats.droppedBatches, 1, "no session yet");
    await sink.configure({ bindings: heliosBindings });
    assert.equal(sink.stats.droppedBatches, 0);

    sink.enqueueBatch(heliosBatch(0));
    sink.endDeliveryStep();
    sink.enqueueBatch(heliosBatch(1));
    sink.endDeliveryStep();
    assert.equal(posts.length, 1);
    assert.equal(sink.stats.droppedBatches, 1, "second step dropped while first is in flight");
    posts[0](new Response(JSON.stringify({ accepted: 151 }), { status: 200 }));
    await sink.inFlight;
    assert.equal(sink.stats.sentBatches, 1);

    sink.enqueueBatch(heliosBatch(2));
    sink.endDeliveryStep();
    posts[1](Response.json({ error: "boom", code: "ARTIFACT_FAILURE" }, { status: 502 }));
    await sink.inFlight;
    assert.equal(sink.sessionId, null);
    assert.equal(sink.stats.lastError, "boom");
    sink.enqueueBatch(heliosBatch(3));
    sink.endDeliveryStep();
    assert.equal(sink.stats.droppedBatches, 3);
    assert.equal(posts.length, 2);
});

test("browser sink delivers one Helios scan as 150 MSOP and one DIFOP datagram", async (t) => {
    const msop = await listenUdp(t);
    const difop = await listenUdp(t);
    const relay = new BrowserPacketRelay({
        hostConfig: heliosHostConfig({ sourcePort: await freeUdpPort(), msopPort: msop.port, difopPort: difop.port }),
    });
    const baseUrl = await serveRelay(t, relay);
    const sink = new BrowserPacketRelaySink({ baseUrl });
    await sink.refreshHost();
    assert.deepEqual(sink.hostDescriptor().adapters, ["udp"]);
    await sink.configure({ bindings: heliosBindings, stepNs: 16_666_667 });

    const batch = heliosBatch();
    sink.enqueueBatch(batch);
    sink.endDeliveryStep();
    await sink.inFlight;
    await waitFor(() => msop.received.length === 150 && difop.received.length === 1);
    assert.equal(sink.stats.sentBatches, 1);
    assert.equal(sink.stats.droppedBatches, 0);
    assert.deepEqual(msop.received[0], batch.packets[0].payload);
    assert.deepEqual(msop.received[149], batch.packets[149].payload);
    assert.deepEqual(difop.received[0], batch.packets[150].payload);

    const tampered = heliosBatch();
    tampered.packets[0].payloadDigest = "0".repeat(64);
    const response = await fetch(`${baseUrl}/sessions/${sink.sessionId}/batches`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: encodeRelayFrame([tampered]),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /digest mismatch/);
    const stale = await fetch(`${baseUrl}/sessions/nope/batches`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: encodeRelayFrame([batch]),
    });
    assert.equal(stale.status, 404);

    await sink.close();
    assert.equal(relay.session, null);
});
