import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPluginPackage, verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { createPluginSensorsResource } from "../app/plugin/PluginSensorIdentity.js";
import { HeadlessEpisode } from "../app/simulation/headless/HeadlessEpisode.js";
import { measuredPerceptionProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { unpackTensor } from "../app/simulation/headless/TensorProtocol.js";
import {
    decodeNativeSensorPacket,
    encodeNativeSensorPacket,
} from "../app/simulation/sensors/NativeSensorPacket.js";
import { createCpuLidarBackendSelection } from "../app/simulation/sensors/CpuLidarBackend.js";
import { planSensorAdmission } from "../app/simulation/sensors/SensorAdmission.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { ManagedHeadlessSession } from "../server/headless/ManagedHeadlessSession.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { hostDescriptorFromConfig } from "../server/sensor-transports/SensorTransportConfig.js";
import {
    createHeadlessImu,
    createPluginPortableHeadlessBundle,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";
import {
    fixturePcapBindings,
    fixturePcapHostConfig,
} from "./helpers/sensorTransportFixtures.js";

const fixtureRoot = new URL("./fixtures/plugins/test.range-image-fixture/", import.meta.url);
const FIXTURE_TYPE = "test.range-image-fixture.synthetic-3x4";

async function fixtureResource({ mutateDocument = null, mutateRuntime = null, extraFiles = {} } = {}) {
    const [document, runtime, ui] = await Promise.all([
        fs.readFile(new URL("plugin.json", fixtureRoot), "utf8"),
        fs.readFile(new URL("runtime/index.js", fixtureRoot), "utf8"),
        fs.readFile(new URL("ui/index.js", fixtureRoot), "utf8"),
    ]);
    const parsed = JSON.parse(document);
    mutateDocument?.(parsed);
    const runtimeSource = mutateRuntime ? mutateRuntime(runtime) : runtime;
    const files = {
        "plugin.json": JSON.stringify(parsed),
        "runtime/index.js": runtimeSource,
        ...extraFiles,
    };
    if (parsed.entry?.ui && files[parsed.entry.ui] === undefined) files[parsed.entry.ui] = ui;
    return createPluginPackage(files);
}

function fixtureSensor(overrides = {}) {
    return {
        id: "fixture",
        type: FIXTURE_TYPE,
        enabled: true,
        parentId: "ego",
        pose: {
            position: { x: 0, y: 0, z: 0.5 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        },
        rateHz: 60,
        phaseNs: 0,
        calibration: {
            parameters: { measurementScale: 1, statusEvery: 2 },
            products: { points: true, packets: true },
        },
        outputs: { pointCloudTopicId: "front-lidar-points" },
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: {
            model: "gaussian",
            bias: 0,
            standardDeviation: 0,
            dropoutProbability: 0,
            pointDropoutProbability: 0,
        },
        maxQueueFrames: 8,
        maxQueueBytes: 1024 * 1024,
        ...overrides,
    };
}

async function fixtureBundle(resource = null, sensorOverrides = {}) {
    const selectedResource = resource ?? await fixtureResource();
    const bundle = await createPluginPortableHeadlessBundle(selectedResource, {
        sensors: [createHeadlessImu(), fixtureSensor(sensorOverrides)],
        triggers: [{
            id: "finish",
            name: "Finish",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 4 },
            actions: [{ kind: "finish" }],
        }],
    });
    return { resource: selectedResource, bundle };
}

async function fixtureEpisode(bundle, t) {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-sensor-runtime-"));
    t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
    return new HeadlessEpisode({
        pluginModuleSource: new NodePluginModuleSource({ runtimeRoot }),
    });
}

test("PLG-05 rejects invalid grants and explicit layouts while preserving legacy package omission", async () => {
    const legacyDocument = {
        kind: "cev-sim.plugin",
        api: 1,
        id: "test.legacy",
        version: "1.0.0",
        engines: { cevSim: ">=0.1.0 <0.2.0" },
        entry: { runtime: "runtime/index.js" },
        capabilities: [],
        units: [],
        systems: [],
    };
    const legacy = verifyPluginPackage(createPluginPackage({
        "plugin.json": JSON.stringify(legacyDocument),
        "runtime/index.js": "export default { register() {} };",
    }));
    assert.equal(Object.hasOwn(legacy.document, "sensorTypes"), false);

    await assert.rejects(
        () => fixtureResource({ mutateDocument(document) { document.capabilities = []; } }),
        /require capability "sensors\.sample\.range-image"/,
    );
    await assert.rejects(
        () => fixtureResource({ mutateDocument(document) {
            document.sensorTypes[0].defaults.scanLayout.channels[1].id = 10;
        } }),
        /duplicate id 10/,
    );
    await assert.rejects(
        () => fixtureResource({ mutateDocument(document) {
            document.sensorTypes[0].products[0].rosType = "custom/PointCloud";
        } }),
        /sensor_msgs\/PointCloud2/,
    );
});

test("PLG-05 rejects invalid factories, capture shapes, backends, and package closures", async (t) => {
    const missingLifecycle = await fixtureResource({
        mutateRuntime: (source) => source.replace("finalize() {", "finish() {"),
    });
    const missingBundle = (await fixtureBundle(missingLifecycle)).bundle;
    const missingEpisode = await fixtureEpisode(missingBundle, t);
    await assert.rejects(() => missingEpisode.prepare(missingBundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    }), /missing finalize\(\)/);
    await missingEpisode.disposeAsync();

    const invalidShape = await fixtureResource({
        mutateRuntime: (source) => source.replace(
            "observation: sampling.buildObservation(buffer)",
            "observation: { dtype: 'float32', shape: [1, 1, 2], value: new Float32Array(2) }",
        ),
    });
    const shapeBundle = (await fixtureBundle(invalidShape)).bundle;
    const shapeEpisode = await fixtureEpisode(shapeBundle, t);
    await shapeEpisode.prepare(shapeBundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    });
    shapeEpisode.reset();
    await assert.rejects(() => shapeEpisode.stepAsync([0, 0]), (error) => (
        error.code === "PLUGIN_EXECUTION"
        && error.hook === "captureAt"
        && error.unitId === "fixture"
        && error.requiresReset === true
    ));
    await shapeEpisode.disposeAsync();

    const { bundle } = await fixtureBundle();
    const wrongBackend = structuredClone(bundle);
    wrongBackend.resolved.backendSelections = wrongBackend.resolved.backendSelections.map((entry) => (
        Number(entry.kind) === 3 ? createCpuLidarBackendSelection() : entry
    ));
    assert.throws(() => verifyRunBundle(rehashRunBundle(wrongBackend)), /require.*version 2/i);

    const corruptClosure = structuredClone(bundle);
    const runtimeFile = corruptClosure.resolved.pluginPackages[0].files
        .find((entry) => entry.path === "runtime/index.js");
    runtimeFile.sha256 = "0".repeat(64);
    assert.throws(() => verifyRunBundle(rehashRunBundle(corruptClosure)), /byte verification/i);
});

test("PLG-06a verifies packet transports structurally and admits them only on a capable host", async () => {
    const { resource, bundle } = await fixtureBundle();
    const verified = verifyPluginPackage(resource);
    const registry = createSensorDefinitionRegistry([verified]);
    const admission = planSensorAdmission({
        manifest: bundle.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: bundle.resolved.backendSelections,
    });
    assert.equal(admission.sensors.find((entry) => entry.sensor.id === "fixture")?.kind, "plugin-range-image");
    assert.deepEqual(admission.observations[0].shape, [3, 4, 2]);
    assert.equal(admission.sensors.find((entry) => entry.sensor.id === "fixture").products[0].signal, "pointCloud");
    assert.deepEqual(createPluginSensorsResource(admission), bundle.resolved.pluginSensors);
    assert.equal(verifyRunBundle(bundle).resolved, bundle.resolved);

    const withPcap = structuredClone(bundle);
    withPcap.resolved.manifest.sensorTransports = fixturePcapBindings();
    const resealed = rehashRunBundle(withPcap);
    assert.equal(verifyRunBundle(resealed).resolvedHash, resealed.resolvedHash);
    assert.equal(resealed.simulationSemanticHash, bundle.simulationSemanticHash);
    assert.notEqual(resealed.resolvedHash, bundle.resolvedHash);
    assert.notEqual(resealed.resolved.definitionHash, bundle.resolved.definitionHash);

    assert.throws(() => planSensorAdmission({
        manifest: resealed.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: resealed.resolved.backendSelections,
        execution: true,
        host: { adapters: [], endpoints: [] },
    }), /adapter "pcap" is unavailable/);

    const host = hostDescriptorFromConfig(fixturePcapHostConfig());
    const admitted = planSensorAdmission({
        manifest: resealed.resolved.manifest,
        sensorRegistry: registry,
        backendSelections: resealed.resolved.backendSelections,
        execution: true,
        host,
    });
    assert.equal(admitted.transportBindings.length, 2);

    const undersized = hostDescriptorFromConfig(fixturePcapHostConfig({
        pcap: {
            artifacts: [{ id: "sensors", fileName: "sensors.pcap" }],
            endpoints: [{
                id: "camera-data",
                artifactId: "sensors",
                mtu: 576,
                ethernet: { sourceMac: "02:00:00:00:00:01", destinationMac: "02:00:00:00:00:02" },
                ipv4: { sourceAddress: "192.0.2.1", destinationAddress: "192.0.2.2", ttl: 64 },
                udp: { sourcePort: 5000, destinationPort: 5001 },
            }],
        },
    }));
    const hugeResource = await fixtureResource({
        mutateDocument(document) {
            document.sensorTypes[0].products[1].streams[0].maxPayloadBytes = 2000;
        },
    });
    const hugeBundle = (await fixtureBundle(hugeResource)).bundle;
    hugeBundle.resolved.manifest.sensorTransports = {
        kind: "cev-sim.sensor-transports",
        version: 1,
        bindings: [fixturePcapBindings().bindings[0]],
    };
    const hugeSealed = rehashRunBundle(hugeBundle);
    assert.throws(() => planSensorAdmission({
        manifest: hugeSealed.resolved.manifest,
        sensorRegistry: createSensorDefinitionRegistry([verifyPluginPackage(hugeResource)]),
        backendSelections: hugeSealed.resolved.backendSelections,
        execution: true,
        host: undersized,
    }), /exceeds endpoint/);
});

test("PLG-05 identity binds runtime sensor behavior and excludes UI, transport, and queue policy", async () => {
    const baseResource = await fixtureResource();
    const base = (await fixtureBundle(baseResource)).bundle;
    const uiResource = await fixtureResource({
        mutateDocument(document) {
            document.entry.ui = "ui/index.js";
            document.editor = { assets: [] };
        },
        extraFiles: { "ui/index.js": "export default function SensorView() { return null; }" },
    });
    assert.equal(uiResource.runtimeHash, baseResource.runtimeHash);
    assert.notEqual(uiResource.packageHash, baseResource.packageHash);
    const uiOnly = (await fixtureBundle(uiResource)).bundle;
    assert.equal(uiOnly.simulationSemanticHash, base.simulationSemanticHash);
    assert.equal(uiOnly.resolved.pluginSensors.hash, base.resolved.pluginSensors.hash);
    assert.notEqual(uiOnly.resolvedHash, base.resolvedHash);

    const operational = structuredClone(base);
    const sensor = operational.resolved.manifest.sensorRig.sensors.find((entry) => entry.id === "fixture");
    sensor.maxQueueFrames = 31;
    sensor.maxQueueBytes = 2 * 1024 * 1024;
    operational.resolved.manifest.sensorTransports = {
        kind: "cev-sim.sensor-transports",
        version: 1,
        bindings: [{
            sensorId: "fixture",
            productId: "packets",
            streamId: "status",
            adapter: "udp",
            endpointId: "operator-endpoint",
        }],
    };
    const operationalResealed = rehashRunBundle(operational);
    assert.equal(operationalResealed.simulationSemanticHash, base.simulationSemanticHash);
    assert.equal(operationalResealed.resolved.pluginSensors.hash, base.resolved.pluginSensors.hash);
    assert.notEqual(operationalResealed.resolvedHash, base.resolvedHash);
    assert.notEqual(operationalResealed.resolved.definitionHash, base.resolved.definitionHash);

    const changed = (await fixtureBundle(baseResource, {
        calibration: {
            parameters: { measurementScale: 1.5, statusEvery: 2 },
            products: { points: true, packets: true },
        },
    })).bundle;
    assert.notEqual(changed.simulationSemanticHash, base.simulationSemanticHash);
    assert.notEqual(changed.resolved.pluginSensors.hash, base.resolved.pluginSensors.hash);
});

test("PLG-05 native packet envelopes preserve opaque payload bytes and authenticate metadata", () => {
    const payload = Uint8Array.from([0, 255, 17, 34, 51]);
    const encoded = encodeNativeSensorPacket({
        productId: "packets",
        streamId: "data",
        packetIndex: 2,
        offsetNs: 50,
        payload,
    }, {
        sensorId: "fixture",
        sampleIndex: 3,
        captureTimeNs: 100,
        scheduledDeliveryTimeNs: 200,
        deliveryTimeNs: 200,
        actualDeliveryStep: 4,
    });
    const decoded = decodeNativeSensorPacket(encoded.bytes);
    assert.deepEqual(decoded.payload, payload);
    assert.equal(decoded.description.sensorId, "fixture");
    assert.equal(decoded.description.payloadLength, payload.byteLength);
    const corrupt = new Uint8Array(encoded.bytes);
    corrupt[corrupt.length - 1] ^= 1;
    assert.throws(() => decodeNativeSensorPacket(corrupt), /does not match/);
});

test("PLG-05 async hooks and atomic queue overflow are structured reset-required failures", async (t) => {
    const asyncResource = await fixtureResource({
        mutateRuntime: (source) => source.replace("captureAt({", "async captureAt({"),
    });
    const asyncBundle = (await fixtureBundle(asyncResource)).bundle;
    const asyncEpisode = await fixtureEpisode(asyncBundle, t);
    await asyncEpisode.prepare(asyncBundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    });
    asyncEpisode.reset();
    await assert.rejects(() => asyncEpisode.stepAsync([0, 0]), (error) => (
        error.code === "PLUGIN_ASYNC_HOOK"
        && error.hook === "captureAt"
        && error.unitId === "fixture"
        && error.requiresReset === true
        && error.infrastructureFailure === true
    ));
    await asyncEpisode.disposeAsync();

    const overflowResource = await fixtureResource({
        mutateDocument(document) {
            document.sensorTypes[0].products[1].streams[0].maxPayloadBytes = 900;
        },
        mutateRuntime: (source) => source.replace(
            "payload: packet(1, this.sequence, captureTimeNs, buffer[0]),",
            "payload: new Uint8Array(900),",
        ),
    });
    const overflowBundle = (await fixtureBundle(overflowResource, { maxQueueBytes: 1024 })).bundle;
    const overflowEpisode = await fixtureEpisode(overflowBundle, t);
    await overflowEpisode.prepare(overflowBundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    });
    overflowEpisode.reset();
    await assert.rejects(() => overflowEpisode.stepAsync([0, 0]), (error) => (
        error.code === "PLUGIN_RESOURCE"
        && error.hook === "enqueue"
        && error.unitId === "fixture"
        && error.requiresReset === true
        && error.infrastructureFailure === true
    ));
    assert.equal(overflowEpisode.runtime.signalStore.has("devices.fixture.pointCloud"), false);
    assert.equal(overflowEpisode.runtime.signalStore.has("devices.fixture.packets.packets.data"), false);
    await overflowEpisode.disposeAsync();
});

test("PLG-05 packet-only configuration emits no implicit perception tensor", async (t) => {
    const resource = await fixtureResource();
    const { bundle } = await fixtureBundle(resource, {
        calibration: {
            parameters: { measurementScale: 1, statusEvery: 2 },
            products: { points: false, packets: true },
        },
        outputs: {},
    });
    assert.equal(bundle.resolved.pluginSensors.description.sensors[0].observationDescriptor, null);
    const episode = await fixtureEpisode(bundle, t);
    await episode.prepare(bundle.resolved, { actionRepeat: 1 });
    episode.reset();
    const result = await episode.stepAsync([0, 0]);
    assert.equal(result.observation.entries.some((entry) => entry.name === "sensors/fixture/value"), false);
    assert.equal(episode.runtime.signalStore.has("devices.fixture.pointCloud"), false);
    assert.equal(episode.runtime.signalStore.has("devices.fixture.packets.packets.data"), true);
    await episode.disposeAsync();

    const perceptionEpisode = await fixtureEpisode(bundle, t);
    await assert.rejects(() => perceptionEpisode.prepare(bundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    }), /requires at least one measured RGB camera or measured LiDAR point-cloud product/);
    await perceptionEpisode.disposeAsync();
});

test("PLG-05 isolates simultaneous package versions and sensor instance state", async (t) => {
    const versionOne = await fixtureResource();
    const versionTwo = await fixtureResource({
        mutateDocument(document) { document.version = "2.0.0"; },
        mutateRuntime: (source) => source.replace(
            "this.sequence += 1;",
            "this.sequence += 1; // version-two runtime identity",
        ),
    });
    const [firstBundle, secondBundle] = await Promise.all([
        fixtureBundle(versionOne).then((entry) => entry.bundle),
        fixtureBundle(versionTwo).then((entry) => entry.bundle),
    ]);
    const first = await fixtureEpisode(firstBundle, t);
    const second = await fixtureEpisode(secondBundle, t);
    await Promise.all([
        first.prepare(firstBundle.resolved, { actionRepeat: 1 }),
        second.prepare(secondBundle.resolved, { actionRepeat: 1 }),
    ]);
    first.reset();
    second.reset();
    await Promise.all([first.stepAsync([0, 0]), second.stepAsync([0, 0])]);
    await first.stepAsync([0, 0]);
    const firstState = first.runtime.devices.plugin.getDeterministicState()[0].pluginSensor;
    const secondState = second.runtime.devices.plugin.getDeterministicState()[0].pluginSensor;
    assert.equal(firstState.state.sequence, 2);
    assert.equal(secondState.state.sequence, 1);
    assert.notEqual(firstState.runtimeHash, secondState.runtimeHash);
    first.reset();
    assert.equal(second.runtime.devices.plugin.getDeterministicState()[0].pluginSensor.state.sequence, 1);
    await Promise.all([first.disposeAsync(), second.disposeAsync()]);
});

test("PLG-05 runs a nonuniform 3x4 sensor through headless Gym observations, packets, and reset replay", async (t) => {
    const { bundle } = await fixtureBundle();
    const episode = await fixtureEpisode(bundle, t);
    const descriptor = await episode.prepare(bundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    });
    assert.ok(descriptor.observationSpace.dictionary.entries.some(
        (entry) => entry.key === "sensors/fixture/value" && entry.space.box.tensor.shape.join(",") === "3,4,2",
    ));
    const reset = episode.reset();
    const resetValue = reset.observation.entries.find((entry) => entry.name === "sensors/fixture/value");
    assert.deepEqual(resetValue.tensor.spec.shape, [3, 4, 2]);

    const firstStep = await episode.stepAsync([0, 0]);
    const firstValue = firstStep.observation.entries.find((entry) => entry.name === "sensors/fixture/value");
    const firstValidity = firstStep.observation.entries.find((entry) => entry.name === "sensors/fixture/validity");
    assert.equal(unpackTensor(firstValidity.tensor)[0], true);
    assert.equal(unpackTensor(firstValue.tensor).length, 24);
    const firstPointCloud = episode.runtime.signalStore.read("devices.fixture.pointCloud", { clone: true });
    const firstPacket = episode.runtime.signalStore.read("devices.fixture.packets.packets.data", { clone: true });
    assert.equal(firstPointCloud.exists, true);
    assert.equal(firstPacket.exists, true);
    assert.equal(decodeNativeSensorPacket(firstPacket.value).description.sampleIndex, 0);
    const firstState = episode.runtime.devices.plugin.getDeterministicState();

    episode.reset();
    const replayStep = await episode.stepAsync([0, 0]);
    const replayValue = replayStep.observation.entries.find((entry) => entry.name === "sensors/fixture/value");
    assert.deepEqual(unpackTensor(replayValue.tensor), unpackTensor(firstValue.tensor));
    assert.deepEqual(episode.runtime.devices.plugin.getDeterministicState(), firstState);
    await episode.disposeAsync();
    assert.equal(episode.runtime.devices.plugin.scene, null);
});

test("PLG-05 executes embedded sensor packages through direct runner and managed sessions", async (t) => {
    const { bundle } = await fixtureBundle();
    const episodeSpec = {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    };
    const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-sensor-paths-"));
    t.after(() => fs.rm(workRoot, { recursive: true, force: true }));
    const runner = new HeadlessRunner();
    const validation = await runner.validate(bundle, { episodeSpec });
    assert.ok(validation.observationSpace.dictionary.entries.some(
        (entry) => entry.key === "sensors/fixture/value",
    ));
    const direct = await runner.run(bundle, {
        episodeSpec,
        actions: [1, 2, 3, 4].map((policyStep) => ({ policyStep, action: [0, 0] })),
        artifactPolicy: { profile: "disabled" },
        outputUri: path.join(workRoot, "direct-output"),
    });
    assert.equal(direct.result.passed, true);

    const managedBundle = structuredClone(bundle);
    managedBundle.resolved.manifest.controls.authority = "reference";
    managedBundle.resolved.scenario.scenario.routes[0].controller = {
        kind: "route-follower",
        activation: { kind: "start" },
    };
    const resealed = rehashRunBundle(managedBundle);
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-sensor-managed-"));
    t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
    const managed = new ManagedHeadlessSession({
        pluginModuleSource: new NodePluginModuleSource({ runtimeRoot }),
    });
    try {
        await managed.prepare(resealed);
        const result = await managed.run({
            artifactPolicy: { profile: "disabled" },
            outputUri: path.join(workRoot, "managed-output"),
        });
        assert.equal(result.runResult.passed, true);
        assert.equal(managed.runtime.signalStore.has("devices.fixture.pointCloud"), true);
    } finally {
        await managed.close();
    }
});

test("PLG-05 plugin sensor lifecycle survives deterministic reset and hydration soak", async (t) => {
    const { bundle } = await fixtureBundle();
    const episode = await fixtureEpisode(bundle, t);
    await episode.prepare(bundle.resolved, {
        actionRepeat: 1,
        observationProfile: measuredPerceptionProfileRef(),
    });
    const device = episode.runtime.devices.plugin.devices[0];
    let expected = null;
    for (let cycle = 0; cycle < 32; cycle += 1) {
        episode.reset();
        await episode.stepAsync([0, 0]);
        const snapshot = device.getDeterministicState();
        assert.equal(snapshot.state.sequence, 1);
        if (cycle === 0) expected = snapshot;
        else assert.deepEqual(snapshot, expected);
        device.resetRunState({ resetSeed: episode.episodeSpec.resetSeed });
        device.hydrateDeterministicState(snapshot);
        assert.equal(device.getDeterministicState().state.sequence, 1);
    }
    await episode.disposeAsync();
    assert.equal(device.instance, null);
});
