import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPluginPackage, verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import {
    PluginRunSession,
    PLG03_RUNTIME_CAPABILITIES,
} from "../app/plugin/PluginRunSession.js";
import { PLUGIN_ERROR_CODES } from "../app/plugin/PluginErrors.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { createStateSensorBackendSelection } from "../app/simulation/sensors/StateSensorBackend.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createHeadlessImu } from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-systems-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const moduleSource = new NodePluginModuleSource({ pluginStore: store });
    return { root, store, moduleSource };
}

function selectionFrom(resource, capabilities = []) {
    const document = verifyPluginPackage(resource).document;
    return {
        pluginId: document.id,
        version: document.version,
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        capabilities,
    };
}

async function sessionFor(t, fixtures, { capabilitiesById = {}, resourceOrder } = {}) {
    const { store, moduleSource } = await harness(t);
    const resources = [];
    for (const fixture of fixtures) {
        const resource = await pluginFixtureResource({ fixture });
        await store.putPackage(resource);
        resources.push(resource);
    }
    const ordered = resourceOrder ? resourceOrder.map((id) => resources.find((resource) => (
        verifyPluginPackage(resource).document.id === id
    ))) : resources;
    const plugins = ordered.map((resource) => {
        const document = verifyPluginPackage(resource).document;
        return selectionFrom(resource, capabilitiesById[document.id] ?? []);
    });
    const session = await new PluginRunSession({
        moduleSource,
        plugins,
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions(ordered);
    t.after(() => session.dispose());
    return { session, resources: ordered, signalStore: new SignalStore() };
}

test("system dispatch order is independent of package enumeration order", async (t) => {
    const first = await sessionFor(t, ["acme.systems", "acme.systems-b"], {
        resourceOrder: ["acme.systems", "acme.systems-b"],
    });
    const second = await sessionFor(t, ["acme.systems", "acme.systems-b"], {
        resourceOrder: ["acme.systems-b", "acme.systems"],
    });
    first.session.bindServices({ signalStore: first.signalStore });
    second.session.bindServices({ signalStore: second.signalStore });
    first.session.prepareInstances();
    second.session.prepareInstances();
    first.session.dispatchSystems(0.016, { step: 1, timeNs: 16_000_000 });
    second.session.dispatchSystems(0.016, { step: 1, timeNs: 16_000_000 });
    const ids = (state) => state.systems.map((entry) => entry.systemId);
    assert.deepEqual(ids(first.session.getDeterministicState()), [
        "acme.systems.Early",
        "acme.systems-b.Mid",
        "acme.systems.Late",
    ]);
    assert.deepEqual(ids(first.session.getDeterministicState()), ids(second.session.getDeterministicState()));
    assert.deepEqual(first.session.getDeterministicState().systems.map((entry) => entry.state.count), [1, 1, 1]);
});

test("system reset replay matches a fresh runtime and restores a failed later hook", async (t) => {
    const { store, moduleSource } = await harness(t);
    const document = {
        kind: "cev-sim.plugin",
        api: 1,
        id: "acme.rollback",
        version: "1.0.0",
        engines: { cevSim: ">=0.1.0 <0.2.0" },
        entry: { runtime: "runtime/index.js" },
        capabilities: ["signals.write.mission"],
        units: [],
        systems: [
            { id: "acme.rollback.First", phase: "scripts", priority: 0, stateVersion: 1 },
            { id: "acme.rollback.Second", phase: "scripts", priority: 1, stateVersion: 1 },
        ],
    };
    const runtime = `
export default {
    register(api) {
        const make = (id, fail) => () => ({
            count: 0,
            prepare() {},
            reset() { this.count = 0; },
            onStep(context) {
                this.count += 1;
                context.writeMission(id, this.count);
                if (fail) throw new Error("requested failure");
            },
            getDeterministicState() { return { count: this.count }; },
            hydrateDeterministicState(state = {}) { this.count = Number(state.count) || 0; },
            finalize() {},
            dispose() {},
        });
        api.contributeSystem({ id: "acme.rollback.First", create: make("first", false) });
        api.contributeSystem({ id: "acme.rollback.Second", create: make("second", true) });
    },
};
`;
    const resource = createPluginPackage({
        "plugin.json": JSON.stringify(document),
        "runtime/index.js": runtime,
    });
    await store.putPackage(resource);
    const selected = [selectionFrom(resource, ["signals.write.mission"])];
    const signalStore = new SignalStore();
    const session = await new PluginRunSession({
        moduleSource,
        plugins: selected,
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions([resource]);
    session.bindServices({ signalStore });
    session.prepareInstances();
    assert.throws(() => session.dispatchSystems(0.016, { step: 1, timeNs: 1 }), (error) => (
        error.code === PLUGIN_ERROR_CODES.EXECUTION && error.contributionId === "acme.rollback.Second"
    ));
    assert.equal(signalStore.read("mission.plugins.acme_d_rollback.first").value, 1);
    assert.equal(signalStore.read("mission.plugins.acme_d_rollback.second").exists, false);
    assert.equal(session.getDeterministicState().systems[1].state.count, 0);
    assert.equal(session.mode, "failed");
    session.reset({ resetSeed: "repeatable", signalStore });
    const replayStore = new SignalStore();
    const replay = await new PluginRunSession({
        moduleSource,
        plugins: selected,
        availableCapabilities: PLG03_RUNTIME_CAPABILITIES,
    }).prepareDefinitions([resource]);
    replay.bindServices({ signalStore: replayStore });
    replay.prepareInstances();
    replay.reset({ resetSeed: "repeatable", signalStore: replayStore });
    assert.deepEqual(
        session.getDeterministicState().systems.map((entry) => entry.state),
        replay.getDeterministicState().systems.map((entry) => entry.state),
    );
    session.dispose();
    replay.dispose();
});

test("promise-returning and invalid system state hooks fail the run", async (t) => {
    const asyncSession = await sessionFor(t, ["acme.hooks-async"]);
    asyncSession.session.bindServices({ signalStore: asyncSession.signalStore });
    asyncSession.session.prepareInstances();
    assert.throws(
        () => asyncSession.session.dispatchSystems(0.016, { step: 1, timeNs: 1 }),
        (error) => error.code === PLUGIN_ERROR_CODES.ASYNC_HOOK,
    );

    const invalid = await sessionFor(t, ["acme.hooks-invalid"]);
    invalid.session.bindServices({ signalStore: invalid.signalStore });
    assert.throws(
        () => invalid.session.prepareInstances(),
        (error) => error.code === PLUGIN_ERROR_CODES.ASYNC_HOOK || error.code === PLUGIN_ERROR_CODES.STATE_INVALID,
    );
});

test("reset and dispose cycles keep bounded system instances and closed facades", async (t) => {
    const { session, signalStore } = await sessionFor(t, ["acme.systems"]);
    session.bindServices({ signalStore });
    session.prepareInstances();
    const count = session.dispatcher.instances.length;
    for (let index = 0; index < 50; index += 1) {
        session.reset({ resetSeed: String(index), signalStore });
        session.dispatchSystems(0.016, { step: index + 1, timeNs: index + 1 });
    }
    assert.equal(session.dispatcher.instances.length, count);
    assert.equal(session.topics.subscriptions.length, 0);
    const facade = session._systemFacade(session.dispatcher.instances[0]);
    session.dispose();
    assert.equal(session.dispatcher.instances.length, 0);
    assert.throws(() => facade.getContext(), (error) => error.code === PLUGIN_ERROR_CODES.STATE_INVALID);
});

test("kernel scripts phase runs systems and reset-only overlays without changing worldHash", async (t) => {
    const { root } = await harness(t);
    const service = new StorageService(root);
    const systems = await pluginFixtureResource({ fixture: "acme.systems" });
    const overlay = await pluginFixtureResource({ fixture: "acme.overlay" });
    await service.plugins.putPackage(systems);
    await service.plugins.putPackage(overlay);
    const moduleSource = new NodePluginModuleSource({ pluginStore: service.plugins });
    const manifest = createDefaultRunManifest({
        id: "plugin-systems-kernel",
        sensorRig: { sensors: [createHeadlessImu()] },
        controls: { targetVehicleId: "ego", authority: "reference" },
        plugins: {
            enabled: true,
            artifacts: [
                { pluginId: "acme.systems", expectedHash: systems.packageHash, capabilities: [] },
                { pluginId: "acme.overlay", expectedHash: overlay.packageHash, capabilities: ["overlay.spawn"] },
            ],
        },
    });
    const resolved = await service.resolveRunManifest(manifest.id, manifest);
    const runtime = createHeadlessRuntimeContext({ pluginModuleSource: moduleSource });
    const kernel = new SimulationKernel(runtime.context);
    t.after(() => kernel.disposeAsync());
    await kernel.prepare(resolved, {
        episode: {
            backendSelections: [...resolved.backendSelections, createStateSensorBackendSelection()],
        },
    });
    const worldHash = resolved.world.hash;
    assert.equal(kernel.context.episodeOverlay.size, 1);
    assert.match(kernel.context.episodeOverlay.list()[0].id, /^episode:plugin:acme.overlay:/);
    assert.equal(kernel.getCanonicalState().environment.worldHash, worldHash);
    kernel.advanceStep();
    assert.equal(kernel.lastStepPhases.includes("scripts"), true);
    assert.equal(kernel.lastStepPhases.includes("controls"), true);
    const first = kernel.getCanonicalState().plugins;
    assert.deepEqual(first.systems.map((entry) => entry.systemId), [
        "acme.overlay.Spawner",
        "acme.systems.Early",
        "acme.systems.Late",
    ]);
    assert.deepEqual(first.systems.map((entry) => entry.state.count ?? 0), [0, 1, 1]);
    assert.equal(first.overlayRecords.length, 1);
    kernel.reset({ resetSeed: manifest.seed });
    assert.equal(kernel.context.episodeOverlay.size, 1);
    kernel.advanceStep();
    const replay = kernel.getCanonicalState().plugins;
    assert.deepEqual(replay.systems.map((entry) => entry.state.count ?? 0), [0, 1, 1]);
    assert.equal(kernel.getCanonicalState().environment.worldHash, worldHash);
});
