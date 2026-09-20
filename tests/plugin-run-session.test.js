import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPluginPackage } from "../app/plugin/PluginPackage.js";
import { PluginRunSession } from "../app/plugin/PluginRunSession.js";
import { ScriptManager } from "../app/scripting/ScriptManager.js";
import { createLoadedScript } from "../app/scripting/ScriptRuntime.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { canonicalStringify, createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { measuredStateProfileRef, routeSafetyProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { namedTensor, tensorMap } from "../app/simulation/headless/TensorProtocol.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { createStateSensorBackendSelection } from "../app/simulation/sensors/StateSensorBackend.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { HeadlessSession } from "../server/headless/HeadlessSession.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
    rehashRunBundle,
} from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

function effectPluginResource() {
    const document = {
        kind: "cev-sim.plugin",
        api: 1,
        id: "acme.effects",
        version: "1.0.0",
        engines: { cevSim: ">=0.1.0 <0.2.0" },
        entry: { runtime: "runtime/index.js" },
        capabilities: ["signals.write.mission"],
        units: [{
            type: "acme.effects.SampleBlock",
            ports: { inputs: {}, outputs: { result: "float64" } },
            settings: [{ target: "state", key: "fail", valueType: "boolean", default: false }],
            defaults: { fail: false },
            catalog: {
                name: "Sample",
                category: "testing",
                keywords: ["sample"],
                placeable: true,
                deprecated: false,
                requiresSignals: false,
            },
        }],
        systems: [],
        editor: { assets: [] },
    };
    const runtime = `
export default {
    register(api) {
        class SampleBlock extends api.UnitBlock {
            register() { this.registerOutput("result", "float64"); }
            valid() { return true; }
            execute() {
                const value = this.manager.random();
                this.manager.writeMission("sample", value);
                if (this.state.fail) throw new Error("requested failure");
                return new api.BlockOutput().set("result", value);
            }
        }
        api.contributeUnit({ type: "acme.effects.SampleBlock", blockClass: SampleBlock });
    }
};
`;
    return createPluginPackage({
        "plugin.json": JSON.stringify(document),
        "runtime/index.js": runtime,
    });
}

async function harness(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-run-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const moduleSource = new NodePluginModuleSource({ pluginStore: store });
    return { root, store, moduleSource };
}

function compileSinglePluginUnit(session, type, state = {}) {
    const manager = new ScriptManager({
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "authoring:test",
    });
    const UnitClass = session.registry.get(type);
    const unit = new UnitClass("plugin-unit");
    manager.addUnit(unit);
    unit.hydrateState(state);
    manager.setHead(unit.uuid);
    const artifact = manager.compile("plugin-program");
    manager.dispose();
    return artifact;
}

test("PLG-02 sessions compile transitive locks and commit effects and RNG atomically", async (t) => {
    const { store, moduleSource } = await harness(t);
    const resource = effectPluginResource();
    await store.putPackage(resource);
    const selected = [{
        pluginId: "acme.effects",
        version: "1.0.0",
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        capabilities: ["signals.write.mission"],
    }];
    const session = await new PluginRunSession({ moduleSource, plugins: selected })
        .prepareDefinitions([resource]);
    const signalStore = new SignalStore();
    session.bindServices({ signalStore, world: { hash: "world" } });

    const success = compileSinglePluginUnit(session, "acme.effects.SampleBlock", { fail: false });
    assert.deepEqual(success.pluginRequirements, [{
        pluginId: "acme.effects",
        version: "1.0.0",
        runtimeHash: resource.runtimeHash,
        types: ["acme.effects.SampleBlock"],
    }]);

    const outerManager = new ScriptManager({
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "authoring:nested",
    });
    const CompiledProgramClass = session.registry.get("CompiledProgramUnitBlock");
    const imported = new CompiledProgramClass("nested-plugin-program");
    imported.hydrateState({ compiledProgram: success });
    outerManager.addUnit(imported);
    outerManager.setHead(imported.uuid);
    const nested = outerManager.compile("nested-plugin-program");
    assert.deepEqual(nested.pluginRequirements, success.pluginRequirements);
    outerManager.dispose();

    const nestedLoaded = createLoadedScript(nested, {
        signalStore,
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "binding:nested",
    });
    assert.equal(nestedLoaded.runResult().status, "success");
    assert.equal(typeof signalStore.read("mission.plugins.acme_d_effects.sample").value, "number");
    nestedLoaded.dispose();

    const first = createLoadedScript(success, {
        signalStore,
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "binding:success",
    });
    const firstValue = first.runResult().result.get("result");
    assert.equal(signalStore.read("mission.plugins.acme_d_effects.sample").value, firstValue);
    first.dispose();

    session.reset({ resetSeed: "repeatable", signalStore });
    const second = createLoadedScript(success, {
        signalStore,
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "binding:success",
    });
    const secondValue = second.runResult().result.get("result");
    second.dispose();
    session.reset({ resetSeed: "repeatable", signalStore });
    const replay = createLoadedScript(success, {
        signalStore,
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "binding:success",
    });
    assert.equal(replay.runResult().result.get("result"), secondValue);
    replay.dispose();

    session.reset({ resetSeed: "failure", signalStore });
    const failure = compileSinglePluginUnit(session, "acme.effects.SampleBlock", { fail: true });
    const failing = createLoadedScript(failure, {
        signalStore,
        blockRegistry: session.registry,
        pluginHost: session.host,
        pluginSession: session,
        scopeId: "binding:failure",
    });
    const result = failing.runResult();
    assert.equal(result.status, "failure");
    assert.equal(result.e.code, "PLUGIN_EXECUTION");
    assert.equal(result.e.scopeId, "binding:failure");
    assert.equal(result.e.unitId, "plugin-unit");
    assert.equal(result.e.requiresReset, true);
    assert.equal(signalStore.read("mission.plugins.acme_d_effects.sample").exists, false);
    assert.deepEqual(session.getDeterministicState().rngStreams, {});
    failing.dispose();
    session.dispose();
});

test("PLG-02 resolution freezes package closure while UI-only edits preserve semantic identity", async (t) => {
    const { root } = await harness(t);
    const service = new StorageService(root);
    const original = await pluginFixtureResource();
    const uiEdit = await pluginFixtureResource({ fixture: "acme.example-ui-edit" });
    assert.equal(original.runtimeHash, uiEdit.runtimeHash);
    assert.notEqual(original.packageHash, uiEdit.packageHash);
    await service.plugins.putPackage(original);
    await service.plugins.putPackage(uiEdit);

    const authoringSession = await new PluginRunSession({
        moduleSource: new NodePluginModuleSource({ pluginStore: service.plugins }),
        plugins: [{
            pluginId: "acme.example",
            version: "1.0.0",
            packageHash: original.packageHash,
            runtimeHash: original.runtimeHash,
            capabilities: [],
        }],
    }).prepareDefinitions([original]);
    const NumberClass = authoringSession.registry.get("NumberUnitClass");
    const ScaleClass = authoringSession.registry.get("acme.example.ScaleBlock");
    const manager = new ScriptManager({
        blockRegistry: authoringSession.registry,
        pluginHost: authoringSession.host,
        pluginSession: authoringSession,
    });
    const number = new NumberClass("number");
    const scale = new ScaleClass("scale");
    manager.addUnit(number);
    manager.addUnit(scale);
    manager.storeData(number.uuid, 3);
    manager.connectUnits(number.uuid, "number", scale.uuid, "value");
    manager.setHead(scale.uuid);
    const artifact = manager.compile("scale");
    manager.dispose();
    authoringSession.dispose();
    await service.putScript({ id: "plugin-scale", name: "Plugin scale", latestValidArtifact: artifact });

    const base = createDefaultRunManifest({
        id: "plugin-run",
        scripts: { enabled: true, artifacts: [{ scriptId: "plugin-scale" }] },
    });
    const resolveWith = (resource) => service.resolveRunManifest(base.id, {
        ...base,
        plugins: {
            enabled: true,
            artifacts: [{ pluginId: "acme.example", expectedHash: resource.packageHash, capabilities: [] }],
        },
    });
    const before = await resolveWith(original);
    const after = await resolveWith(uiEdit);
    assert.deepEqual(before.identityProfile, { id: "world-bound-plugins", version: 1 });
    assert.equal(before.plugins[0].runtimeHash, original.runtimeHash);
    assert.equal(before.pluginPackages[0].packageHash, original.packageHash);
    assert.notEqual(before.resolvedHash, after.resolvedHash);
    assert.equal(before.simulationSemanticHash, after.simulationSemanticHash);
    verifyRunBundle({
        kind: "cev-sim.run-bundle",
        version: 1,
        manifest: before.manifest,
        resolved: before,
        resolvedHash: before.resolvedHash,
        simulationSemanticHash: before.simulationSemanticHash,
    });
});

test("PLG-02 selected units execute through the managed headless kernel and replay after reset", async (t) => {
    const { root } = await harness(t);
    const service = new StorageService(root);
    const resource = effectPluginResource();
    await service.plugins.putPackage(resource);
    const moduleSource = new NodePluginModuleSource({ pluginStore: service.plugins });
    const selected = [{
        pluginId: "acme.effects",
        version: "1.0.0",
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        capabilities: ["signals.write.mission"],
    }];
    const authoring = await new PluginRunSession({ moduleSource, plugins: selected })
        .prepareDefinitions([resource]);
    const artifact = compileSinglePluginUnit(authoring, "acme.effects.SampleBlock", { fail: false });
    authoring.dispose();
    await service.putScript({ id: "effect-script", name: "Effect script", latestValidArtifact: artifact });
    const manifest = createDefaultRunManifest({
        id: "plugin-headless",
        sensorRig: { sensors: [createHeadlessImu()] },
        plugins: {
            enabled: true,
            artifacts: [{
                pluginId: "acme.effects",
                expectedHash: resource.packageHash,
                capabilities: ["signals.write.mission"],
            }],
        },
        scripts: {
            enabled: true,
            artifacts: [{ scriptId: "effect-script" }],
            embeddedBindings: [{
                id: "effect-fixed-update",
                name: "Effect fixed update",
                enabled: true,
                scope: "selected",
                folderId: null,
                scriptId: "effect-script",
                trigger: { kind: "fixed-update", everyN: 1 },
                inputs: [],
                outputs: [],
            }],
        },
    });
    const resolved = await service.resolveRunManifest(manifest.id, manifest);
    const runtime = createHeadlessRuntimeContext({ pluginModuleSource: moduleSource });
    const kernel = new SimulationKernel(runtime.context);
    await kernel.prepare(resolved, {
        episode: {
            backendSelections: [...resolved.backendSelections, createStateSensorBackendSelection()],
        },
    });
    kernel.advanceStep();
    const signalPath = "mission.plugins.acme_d_effects.sample";
    const first = runtime.signalStore.read(signalPath).value;
    assert.equal(typeof first, "number");
    assert.equal(kernel.getCanonicalState().plugins.units.length, 1);
    kernel.reset({ resetSeed: manifest.seed });
    kernel.advanceStep();
    assert.equal(runtime.signalStore.read(signalPath).value, first);
    await kernel.disposeAsync();

    let bundle = await createPortableHeadlessBundle();
    bundle.resolved.identityProfile = { id: "world-bound-plugins", version: 1 };
    bundle.resolved.manifest.plugins = structuredClone(resolved.manifest.plugins);
    bundle.resolved.manifest.scripts = structuredClone(resolved.manifest.scripts);
    bundle.resolved.plugins = structuredClone(resolved.plugins);
    bundle.resolved.pluginPackages = structuredClone(resolved.pluginPackages);
    bundle.resolved.scripts = structuredClone(resolved.scripts);
    bundle.resolved.bindings = structuredClone(resolved.bindings);
    bundle.resolved.dependencyHashes.plugins = structuredClone(resolved.dependencyHashes.plugins);
    bundle.resolved.dependencyHashes.scripts = structuredClone(resolved.dependencyHashes.scripts);
    bundle.resolved.dependencyHashes.bindings = resolved.dependencyHashes.bindings;
    bundle = rehashRunBundle(bundle);
    verifyRunBundle(bundle);
    const supervisor = new HeadlessSupervisor({
        socket: path.join(root, "plugin-supervisor.sock"),
        inlineObservations: true,
    });
    t.after(() => supervisor.close());
    const bundleId = "plugin-bundle";
    const episode = {
        environmentIndex: 0,
        environmentId: "plugin-environment",
        runBundleId: bundleId,
        resetSeed: manifest.seed,
        actionRepeat: 1,
        maxEpisodeSteps: "0",
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef(),
        backendSelections: [...bundle.resolved.backendSelections, createStateSensorBackendSelection()],
    };
    const created = await supervisor.createBatch({
        clientProtocol: { major: 1, minor: 4 },
        runBundles: [{
            bundleId,
            resolvedHash: bundle.resolvedHash,
            simulationSemanticHash: bundle.simulationSemanticHash,
            canonicalJson: Buffer.from(canonicalStringify(bundle)),
        }],
        episodes: [episode],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "plugin-supervisor-artifacts") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const reset = await supervisor.resetBatch({ batchId: created.batch.batchId, episodes: [episode] });
    assert.equal(reset.results[0].error.code, 0, reset.results[0].error.message);
    const stepped = await supervisor.stepBatch({
        batchId: created.batch.batchId,
        actions: [{
            environmentIndex: 0,
            action: tensorMap([namedTensor("action", "float32", [2], [0, 0])]),
        }],
    });
    assert.equal(stepped.results[0].error.code, 0, stepped.results[0].error.message);
    const closed = await supervisor.closeBatch({ batchId: created.batch.batchId });
    assert.equal(closed.error.code, 0, closed.error.message);
});

test("PLG-02 headless execution failures abort artifacts and require reset with structured details", async () => {
    const session = new HeadlessSession();
    let aborted = false;
    session.state = "ready";
    session.artifactSink = { abort: async () => { aborted = true; } };
    session.episode = {
        stepAsync: async () => {
            throw Object.assign(new Error("plugin failed"), {
                code: "PLUGIN_EXECUTION",
                pluginId: "acme.effects",
                contributionId: "acme.effects.SampleBlock",
                scopeId: "binding:failure",
                unitId: "plugin-unit",
                hook: "execute",
            });
        },
    };
    await assert.rejects(session.stepAsync([0, 0]), (error) => {
        assert.equal(error.requiresReset, true);
        assert.equal(error.details.pluginCode, "PLUGIN_EXECUTION");
        assert.equal(error.details.pluginId, "acme.effects");
        assert.equal(error.details.unitId, "plugin-unit");
        assert.equal(error.details.hook, "execute");
        return true;
    });
    assert.equal(aborted, true);
    assert.equal(session.artifactSink, null);
    assert.equal(session.state, "prepared");
});

test("PLG-03 system execution failures propagate hook and contribution identity", async () => {
    const session = new HeadlessSession();
    session.state = "ready";
    session.artifactSink = { abort: async () => {} };
    session.episode = {
        stepAsync: async () => {
            throw Object.assign(new Error("system failed"), {
                code: "PLUGIN_EXECUTION",
                pluginId: "acme.systems",
                contributionId: "acme.systems.Late",
                hook: "onStep",
                requiresReset: true,
            });
        },
    };
    await assert.rejects(session.stepAsync([0, 0]), (error) => {
        assert.equal(error.details.contributionId, "acme.systems.Late");
        assert.equal(error.details.hook, "onStep");
        assert.equal(error.requiresReset, true);
        return true;
    });
});
