import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlRuntime } from "../app/autonomy/ControlRuntime.js";
import { PLUGIN_ERROR_CODES } from "../app/plugin/PluginErrors.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import {
    PluginRunSession,
    PLG03_RUNTIME_CAPABILITIES,
    pluginRuntimeCapabilitiesForRun,
} from "../app/plugin/PluginRunSession.js";
import { PLUGIN_TOPIC_QUEUE_LIMIT } from "../app/plugin/PluginTopicRuntime.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { EpisodeOverlay } from "../app/simulation/episode/EpisodeOverlay.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-capabilities-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const moduleSource = new NodePluginModuleSource({ pluginStore: store });
    return { store, moduleSource };
}

function selectionFrom(resource, capabilities) {
    const document = verifyPluginPackage(resource).document;
    return {
        pluginId: document.id,
        version: document.version,
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        capabilities,
    };
}

async function loadSession(t, fixture, capabilities) {
    const { store, moduleSource } = await harness(t);
    const resource = await pluginFixtureResource({ fixture });
    await store.putPackage(resource);
    const session = await new PluginRunSession({
        moduleSource,
        plugins: [selectionFrom(resource, capabilities)],
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions([resource]);
    t.after(() => session.dispose());
    return { session, resource, signalStore: new SignalStore() };
}

function pluginTopics() {
    return [
        {
            id: "plugin-in",
            contractId: "plugin-in",
            name: "plugin-in",
            direction: "input",
            type: "std_msgs/Float64",
            schema: { type: "std_msgs/Float64" },
            producer: "simulator",
            authority: "reference",
            routeDownstream: true,
        },
        {
            id: "plugin-out",
            contractId: "plugin-out",
            name: "plugin-out",
            direction: "output",
            type: "std_msgs/Float64",
            schema: { type: "std_msgs/Float64" },
            producer: "simulator",
            authority: "reference",
        },
        {
            id: "controls-command",
            contractId: "controls-command",
            name: "/controls/command",
            direction: "input",
            type: "sensor_fusion_msgs/StampedAckermannDrive",
            schema: { type: "sensor_fusion_msgs/StampedAckermannDrive" },
            producer: "candidate",
            authority: "candidate",
            stage: "controls",
        },
    ];
}

test("negative grants fail for expanded PLG-03 capabilities", async (t) => {
    await assert.rejects(
        () => loadSession(t, "acme.controls", []),
        (error) => error.code === PLUGIN_ERROR_CODES.CAPABILITY,
    );
    await assert.rejects(
        () => loadSession(t, "acme.topics", []),
        (error) => error.code === PLUGIN_ERROR_CODES.CAPABILITY,
    );
    await assert.rejects(
        () => loadSession(t, "acme.overlay", []),
        (error) => error.code === PLUGIN_ERROR_CODES.CAPABILITY,
    );
});

test("headless GPU backends do not honor overlay.spawn", async (t) => {
    const available = pluginRuntimeCapabilitiesForRun({
        backendSelections: [{ kind: 4 }],
    }, { renderTarget: "headless" });
    assert.equal(available.includes("overlay.spawn"), false);
    const { store, moduleSource } = await harness(t);
    const resource = await pluginFixtureResource({ fixture: "acme.overlay" });
    await store.putPackage(resource);
    const session = new PluginRunSession({
        moduleSource,
        plugins: [selectionFrom(resource, ["overlay.spawn"])],
        availableCapabilities: available,
    });
    await assert.rejects(session.prepareDefinitions([resource]), (error) => error.code === PLUGIN_ERROR_CODES.CAPABILITY);
    session.dispose();
    assert.equal(pluginRuntimeCapabilitiesForRun({
        backendSelections: [{ kind: 4 }],
    }, { renderTarget: "browser" }).includes("overlay.spawn"), true);
});

test("reset-only overlay spawn materializes plugin-owned records and rejects tick spawn", async (t) => {
    const { session, signalStore } = await loadSession(t, "acme.overlay", ["overlay.spawn"]);
    const overlay = new EpisodeOverlay();
    session.bindServices({ signalStore, episodeOverlay: overlay });
    session.prepareInstances();
    session.beginResetWindow({ resetSeed: "1", signalStore });
    assert.equal(overlay.size, 1);
    assert.match(overlay.list()[0].id, /^episode:plugin:acme.overlay:/);
    assert.equal(overlay.list()[0].assetId, "barrel");
    session.endResetWindow();
    const worldHashBefore = "untouched";
    session.dispatcher.instances[0].instance.spawnDuringStep = true;
    assert.throws(
        () => session.dispatchSystems(0.016, { step: 1, timeNs: 1 }),
        (error) => error.code === PLUGIN_ERROR_CODES.STATE_INVALID,
    );
    assert.equal(overlay.size, 1);
    assert.equal(worldHashBefore, "untouched");
    overlay.upsert({ id: "taken", assetId: "barrel", scriptId: "plugin:acme.other" });
    const token = session.beginEvaluation();
    session.mode = "resetting";
    session.journal.stage({
        kind: "overlay-spawn",
        pluginId: "acme.overlay",
        id: "taken",
        assetId: "barrel",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    });
    assert.throws(() => session.commitEvaluation(token), (error) => error.code === PLUGIN_ERROR_CODES.STATE_INVALID);
});

test("reference commands use REP-103 steering and remain overwritable by a later scenario command", async (t) => {
    const { session, signalStore } = await loadSession(t, "acme.controls", ["controls.reference"]);
    const controlRuntime = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "reference",
            referenceShadow: true,
            watchdogNs: 1e9,
            stalePolicy: "stop",
            actuatorOverrides: { maxSpeed: 10, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100, responseDelayNs: 0 },
        },
    });
    controlRuntime.configure({
        controls: controlRuntime.controls,
        vehicleLimits: { ego: { maxSpeed: 10, maxSteeringAngle: 0.6, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 } },
    });
    session.bindServices({ signalStore, controlRuntime });
    session.prepareInstances();
    session.dispatchSystems(0.05, { step: 1, timeNs: 1 });
    controlRuntime.submitSiSpeedSteer("ego", {
        speedMps: 4,
        steeringRadRep103: -0.05,
        producer: "reference",
        source: "scenario",
        captureTimeNs: 1,
    });
    const applied = controlRuntime.step({ step: 1, timeNs: 1, dt: 0.05 });
    assert.equal(applied.get("ego").command.speedMps, 4);
    assert.equal(applied.get("ego").command.steeringRadRep103, -0.05);

    const shadowed = new ControlRuntime({
        controls: {
            targetVehicleId: "ego",
            authority: "candidate",
            referenceShadow: true,
            watchdogNs: 1e9,
            stalePolicy: "stop",
            actuatorOverrides: { maxSpeed: 10, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100, responseDelayNs: 0 },
        },
    });
    shadowed.configure({
        controls: shadowed.controls,
        vehicleLimits: { ego: { maxSpeed: 10, maxSteeringAngle: 0.6, maxAcceleration: 100, maxDeceleration: 100, maxSteeringRate: 100 } },
    });
    const { session: shadowSession, signalStore: shadowStore } = await loadSession(t, "acme.controls", ["controls.reference"]);
    shadowSession.bindServices({ signalStore: shadowStore, controlRuntime: shadowed });
    shadowSession.prepareInstances();
    shadowSession.dispatchSystems(0.05, { step: 1, timeNs: 1 });
    const shadowApplied = shadowed.step({ step: 1, timeNs: 1, dt: 0.05 });
    assert.equal(shadowApplied.get("ego").passthrough, true);
    const snap = shadowed.getSnapshot("ego", { applyTimeNs: 1 });
    assert.equal(snap.referenceShadow.speedMps, 1.5);
    assert.equal(snap.referenceShadow.steeringRad, 0.2);
});

test("topic delivery is ordered, deferred, and overflow-fatal", async (t) => {
    const { session, signalStore } = await loadSession(t, "acme.topics", ["topics.subscribe", "topics.publish"]);
    const router = new TopicContractRouter({ topics: pluginTopics() }, { telemetry: signalStore });
    session.bindServices({ signalStore, topicRouter: router, clock: () => ({ step: 1, timeNs: 1 }) });
    session.prepareInstances();
    for (const value of [1, 2, 3]) {
        const routed = router.routeInbound({
            name: "plugin-in",
            typeStr: "std_msgs/Float64",
            value: { data: value },
        }, { applyStep: 1, applyTimeNs: 1 });
        assert.equal(routed.ok, true, routed.message);
    }
    session.deliverTopics({ step: 1, timeNs: 1 });
    assert.equal(session.getDeterministicState().systems[0].state.seen, 3);
    assert.equal(session.getDeterministicState().systems[0].state.last.data, 3);
    const produced = router.lastProducer.get("plugin-out");
    assert.equal(produced.value.data, 3);

    assert.throws(() => {
        for (let index = 0; index <= PLUGIN_TOPIC_QUEUE_LIMIT; index += 1) {
            const routed = router.routeInbound({
                name: "plugin-in",
                typeStr: "std_msgs/Float64",
                value: { data: index },
            }, { applyStep: 2, applyTimeNs: 2 });
            if (routed.ok !== true) throw routed;
        }
    }, (error) => error.code === PLUGIN_ERROR_CODES.RESOURCE);
});

test("control topics cannot be published by plugins", async (t) => {
    const { session, signalStore } = await loadSession(t, "acme.topics", ["topics.subscribe", "topics.publish"]);
    const router = new TopicContractRouter({ topics: pluginTopics() }, { telemetry: signalStore });
    session.bindServices({ signalStore, topicRouter: router });
    session.prepareInstances();
    const token = session.beginEvaluation();
    session.journal.stage({
        kind: "topic-publish",
        pluginId: "acme.topics",
        topicId: "controls-command",
        value: { data: 1 },
        typeStr: "sensor_fusion_msgs/StampedAckermannDrive",
    });
    assert.throws(
        () => session.commitEvaluation(token),
        (error) => error.code === PLUGIN_ERROR_CODES.UNAVAILABLE,
    );
});
