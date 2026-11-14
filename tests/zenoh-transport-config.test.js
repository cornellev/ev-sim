import assert from "node:assert/strict";
import test from "node:test";
import { resolveZenohTransportHostConfig, validateZenohTransportAdmission, estimateZenohImagePublicationBytes } from "../server/sensor-transports/ZenohTransportConfig.js";
import { planProtobufRouteAdmission } from "../app/interfaces/ProtobufRunBinding.js";
import { applyMapping } from "../app/interfaces/ProtobufMapping.js";
import { encodeMessage } from "../app/interfaces/ProtobufSchema.js";
import { imageRun, zenohHostConfig } from "./helpers/zenohFixtures.js";

test("Zenoh host config has explicit bounded operational defaults", () => {
    const config = resolveZenohTransportHostConfig(zenohHostConfig());
    assert.equal(config.shm.poolBytes, 64 * 1024 * 1024);
    assert.equal(config.shm.thresholdBytes, 65536);
    assert.equal(config.queue.maxBytes, 16 * 1024 * 1024);
    assert.equal(resolveZenohTransportHostConfig(null), null);
    for (const override of [{ connect: [] }, { connect: ["udp/127.0.0.1:7447"] }, { connect: ["tcp/x:65536"] },
        { queue: { maxEntries: "256" } }, { shm: { mode: "automatic" } }, { shm: { poolBytes: 1 } }, { timeout: 1 }]) {
        assert.throws(() => resolveZenohTransportHostConfig({ ...zenohHostConfig(), ...override }), /bounded|SHM|TCP|unknown|mode/);
    }
});

test("image admission counts nested envelopes, duplicate data and numeric overhead", () => {
    const run = imageRun({ fields: [{ to: "image", from: "value" }, { to: "duplicate", from: "value.data" }, { to: "time", from: "metadata.simTimeNs" }] });
    const entry = planProtobufRouteAdmission({ manifest: run.manifest, interfaceResource: run.protobufInterface, resolvedRun: run }).routes[0];
    const bound = estimateZenohImagePublicationBytes(entry, { width: 128, height: 128, pixelFormat: "rgba8" });
    const mapped = applyMapping(entry.compiled, { value: { data: new Uint8Array(128 * 128 * 4), width: 128, height: 128, pixelFormat: "rgba8", strideBytes: 512 }, metadata: { simTimeNs: 99 } });
    assert.ok(bound >= encodeMessage(entry.messageType, mapped).byteLength);
    assert.ok(bound > 2 * 128 * 128 * 4);
    const admission = validateZenohTransportAdmission({ resolvedRun: run, config: zenohHostConfig() });
    assert.equal(admission.routesById.get("image").key, "sim/image-run/image");
    assert.equal(admission.imagePayloadBounds.get("image"), bound);
});

test("oversized images and exact-limit raw images fail before allocation", () => {
    for (const [width, height] of [[3840, 2160], [2048, 2048]]) assert.throws(() => validateZenohTransportAdmission({ resolvedRun: imageRun({ width, height }), config: zenohHostConfig() }), /Image route/);
    const metadataOnly = imageRun({ width: 3840, height: 2160, fields: [{ to: "image.width", from: "value.width" }] });
    assert.ok(validateZenohTransportAdmission({ resolvedRun: metadataOnly, config: zenohHostConfig() }).imagePayloadBounds.get("image") < 32);
    const aliases = imageRun({ width: 3840, height: 2160,
        derived: [{ id: "frame", from: "value" }, { id: "pixels", from: "derived.frame.data" }],
        fields: [{ to: "duplicate", from: "derived.pixels" }] });
    assert.throws(() => validateZenohTransportAdmission({ resolvedRun: aliases, config: zenohHostConfig() }), /Image route/);
});

test("aggregate SHM, queue and required negotiated capabilities are admitted explicitly", () => {
    const run = imageRun();
    const before = JSON.stringify(run);
    assert.throws(() => validateZenohTransportAdmission({ resolvedRun: run, config: zenohHostConfig(), resourceLimits: { maxSharedMemoryBytesPerEnvironment: 64 * 1024 * 1024 } }), /SHM reservations/);
    assert.throws(() => validateZenohTransportAdmission({ resolvedRun: run, config: zenohHostConfig(), resourceLimits: { maxQueueBytes: 1024 } }), /Image route/);
    for (const limit of [0, -1, NaN, "1024"]) assert.throws(() => validateZenohTransportAdmission({ resolvedRun: run, config: zenohHostConfig(), resourceLimits: { maxQueueBytes: limit } }), /bounded integer/);
    const config = { ...zenohHostConfig(), shm: { mode: "required" } };
    assert.throws(() => validateZenohTransportAdmission({ resolvedRun: run, config, capabilities: { available: true, zenohVersion: "1.10.2", shmProviderAvailable: true, transports: [{ shm: false }] } }), /Required SHM/);
    const admitted = validateZenohTransportAdmission({ resolvedRun: run, config, capabilities: { available: true, zenohVersion: "1.10.2", shmProviderAvailable: true, transports: [{ shm: true }] } });
    assert.equal(admitted.reservedSharedMemoryBytes, 68 * 1024 * 1024);
    assert.equal(JSON.stringify(run), before);
});
