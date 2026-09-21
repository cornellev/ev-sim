import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HostPacketTransportHub } from "../server/sensor-transports/HostPacketTransportHub.js";
import { resolveSensorTransportHostConfig } from "../server/sensor-transports/SensorTransportConfig.js";
import {
    fixturePcapBindings,
    fixturePcapHostConfig,
    parseClassicPcapIndependently,
} from "./helpers/sensorTransportFixtures.js";

function packet(bytes, extras = {}) {
    return {
        productId: extras.productId ?? "packets",
        streamId: extras.streamId ?? "data",
        packetIndex: extras.packetIndex ?? 0,
        offsetNs: extras.offsetNs ?? 0,
        payload: Uint8Array.from(bytes),
    };
}

async function capture(t, {
    hostConfig = fixturePcapHostConfig(),
    bindings = fixturePcapBindings().bindings,
    stepNs = 20_000_000,
    maxQueueBytes = 0,
    batches = [],
} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-pcap-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const hub = new HostPacketTransportHub();
    hub.configure({
        bindings,
        hostConfig: resolveSensorTransportHostConfig(hostConfig),
        stepNs,
        maxQueueBytes,
    });
    await hub.attachArtifactRoot(root);
    for (const batch of batches) {
        hub.enqueueBatch(batch);
        hub.endDeliveryStep({ step: batch.actualDeliveryStep });
    }
    await hub.drain();
    const evidence = await hub.finalize();
    const bytes = new Uint8Array(await fs.readFile(path.join(root, "sensors.pcap")));
    return { bytes, evidence, records: parseClassicPcapIndependently(bytes) };
}

test("independent PCAP decoder validates framing, checksums, timestamps, and shared artifacts", async (t) => {
    const { records, evidence } = await capture(t, {
        batches: [
            {
                sensorId: "fixture",
                sampleIndex: 0,
                actualDeliveryStep: 2,
                packets: [
                    packet([1, 2, 3], { streamId: "status", packetIndex: 1, offsetNs: 1000 }),
                    packet([9, 8, 7, 6], { streamId: "data", packetIndex: 0, offsetNs: 0 }),
                ],
            },
            {
                sensorId: "fixture",
                sampleIndex: 1,
                actualDeliveryStep: 3,
                packets: [
                    packet([4, 5], { streamId: "data", packetIndex: 0, offsetNs: 0 }),
                ],
            },
        ],
    });
    assert.equal(records.length, 3);
    assert.equal(evidence.artifacts[0].recordCount, 3);
    assert.deepEqual([...records[0].payload], [9, 8, 7, 6]);
    assert.deepEqual([...records[1].payload], [1, 2, 3]);
    assert.equal(records[0].timestampUs, (2n * 20_000_000n) / 1000n);
    assert.equal(records[1].timestampUs, (2n * 20_000_000n + 1000n) / 1000n);
    assert.equal(records[0].sourcePort, 5000);
    assert.equal(records[1].sourcePort, 5002);
    assert.equal(records[0].identification, 0);
    assert.equal(records[1].identification, 1);
    assert.equal(records[2].identification, 2);
});

test("PCAP hub rejects queue overflow and UDP adapters", async (t) => {
    const hub = new HostPacketTransportHub();
    assert.throws(() => hub.configure({
        bindings: [{ ...fixturePcapBindings().bindings[0], adapter: "udp" }],
        hostConfig: fixturePcapHostConfig(),
        stepNs: 1,
    }), (error) => error.code === "UNSUPPORTED_CAPABILITY");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-pcap-overflow-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const overflowing = new HostPacketTransportHub();
    overflowing.configure({
        bindings: [fixturePcapBindings().bindings[0]],
        hostConfig: fixturePcapHostConfig(),
        stepNs: 1,
        maxQueueBytes: 40,
    });
    await overflowing.attachArtifactRoot(root);
    overflowing.enqueueBatch({
        sensorId: "fixture",
        sampleIndex: 0,
        actualDeliveryStep: 1,
        packets: [packet(new Uint8Array(64))],
    });
    assert.throws(() => overflowing.endDeliveryStep({ step: 1 }), (error) => error.code === "RESOURCE_LIMIT");
});
