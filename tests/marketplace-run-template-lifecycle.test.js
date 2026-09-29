import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { createDefaultScenario, normalizeScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createScriptDocument } from "../app/scripting/EditorDocument.js";
import { normalizeBinding } from "../app/scripting/bindings/BindingDocument.js";
import { VISUAL_SCRIPT_KIND } from "../app/scripting/runtime/Artifact.js";
import { computeResolvedRunHash, createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { createRunTemplatePackageLifecycleAdapter } from "../server/marketplace/ArtifactAdapters.js";
import { MARKETPLACE_ARTIFACTS } from "../server/marketplace/MarketplaceContract.js";
import { exportRunTemplatePackage } from "../server/marketplace/RunTemplatePackage.js";
import { MarketplaceReceiptStore } from "../server/marketplace/client/MarketplaceReceiptStore.js";
import { StorageService } from "../server/storage/StorageService.js";

test("MKT-11 lifecycle publishes the frozen run manifest last and replays exactly", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-template-lifecycle-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = new StorageService(path.join(root, "source"));
    const environment = await source.createEnvironment({ id: "source-yard", name: "Source Yard", supportedEditorSourceVersions: [1] });
    const vehicle = await source.createVehicleManifest({
        ...createDefaultVehicleManifest({ id: "template-rover", name: "Template Rover" }),
        model: { ...createDefaultVehicleManifest().model, asset: "rover.glb" },
    });
    await source.putVehicleAsset(vehicle.id, "rover.glb", Buffer.from("template-rover-model"));
    const baseManifest = createDefaultRunManifest();
    const manifest = await source.createRunManifest(createDefaultRunManifest({
        id: "editable-run",
        environment: { id: environment.environmentId, expectedHash: null },
        initialState: {
            ...baseManifest.initialState,
            vehicles: baseManifest.initialState.vehicles.map((entry) => ({ ...entry, type: vehicle.id })),
        },
        scripts: { enabled: true, artifacts: [], bindingIds: [], embeddedBindings: [], bindingSource: "embedded" },
    }));
    const archivePath = path.join(root, "template.tar");
    const exported = await exportRunTemplatePackage({ storageService: source, manifestId: manifest.id, expectedRevision: manifest.revision });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;
    const archive = await fs.readFile(archivePath);
    const handle = {
        path: archivePath,
        mediaType: MARKETPLACE_ARTIFACTS["run-template"].mediaType,
        sha256: createHash("sha256").update(archive).digest("hex"),
        sizeBytes: archive.length,
    };

    const target = new StorageService(path.join(root, "target"));
    const receiptStore = await MarketplaceReceiptStore.open(path.join(root, "target"));
    const adapter = createRunTemplatePackageLifecycleAdapter({
        storageService: target,
        pluginStore: target.plugins,
        editorAssetStore: target.editorAssets,
        visualAssetStore: target.visualAssets,
        receiptStore,
    });
    const release = {
        itemId: "editable-run",
        releaseVersion: "1.0.0",
        contentKind: "run-template",
        artifact: { mediaType: handle.mediaType, sha256: handle.sha256, sizeBytes: handle.sizeBytes },
        embeddedPlugins: [],
    };
    const context = {
        workDirectory: path.join(root, "work"),
        source: {
            registryId: "11111111-1111-4111-8111-111111111111",
            sourceId: "22222222-2222-4222-8222-222222222222",
        },
    };
    const inspection = await adapter.inspect(handle, context);
    adapter.validate(inspection, release);
    const plan = await adapter.plan({ release, artifactHandle: handle, context });
    assert.equal(plan.operations.at(-1).kind, "publish-run-manifest");
    for (const operation of plan.operations) await adapter.commit({ operation, adapterPlan: plan, context });
    const imported = await target.getRunManifest(plan.destination.manifestId);
    assert.equal(imported.scripts.bindingSource, "embedded");
    assert.deepEqual(imported.scripts.embeddedBindings, []);
    assert.deepEqual(imported.scripts.bindingIds, []);
    const vehicleMapping = plan.mappings.find((entry) => entry.resourceKind === "vehicle");
    assert.deepEqual(await target.readVehicleAsset(vehicleMapping.localId, "rover.glb"), Buffer.from("template-rover-model"));
    assert.ok(plan.operations.findIndex((entry) => entry.kind === "publish-vehicle-asset")
        < plan.operations.findIndex((entry) => entry.kind === "publish-vehicle"));
    for (const operation of plan.operations) await adapter.recover({ operation, adapterPlan: plan, context });
    assert.equal((await target.getRunManifest(plan.destination.manifestId)).revision, imported.revision);
});

test("MKT-11 collision import rewrites every typed script reference and frozen binding", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-template-rewrites-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = new StorageService(path.join(root, "source"));
    const artifact = (name) => ({
        kind: VISUAL_SCRIPT_KIND,
        version: 3,
        name,
        Q: [],
        nodes: [],
        transitions: { success: [], failure: [] },
        reverseSuccess: {},
        interface: {
            inputs: [{ label: "gain", type: "float64" }],
            outputs: [{ label: "speed", type: "float64" }, { label: "steering", type: "float64" }],
        },
    });
    const child = createScriptDocument({
        id: "nested-child",
        latestValidArtifact: artifact("Nested child"),
        compileStatus: { valid: true, error: null, artifactUpdatedAt: "2026-09-29T00:00:00.000Z" },
    });
    const controller = createScriptDocument({
        id: "scenario-controller",
        graph: {
            head: "head-uuid",
            outputNodeConfig: null,
            nodes: [{ uuid: "nested", type: "LocalScriptProgramBlock", state: { sourceScriptId: child.id } }],
            connections: [],
        },
        latestValidArtifact: artifact("Scenario controller"),
        compileStatus: { valid: true, error: null, artifactUpdatedAt: "2026-09-29T00:00:00.000Z" },
    });
    await source.putScript(child);
    await source.putScript(controller);

    const environment = await source.getEnvironment("igvc");
    const edge = environment.document.roads.edges[0];
    const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
    const start = nodes.get(edge.startNodeId);
    const finish = nodes.get(edge.endNodeId);
    const route = verifyRoute(environment, {
        id: "ego-route",
        actorId: "ego",
        initialSpeedMps: 1,
        controller: {
            kind: "script",
            activation: { kind: "start" },
            scriptId: controller.id,
            outputs: [{ output: "speed", target: "speed" }, { output: "steering", target: "steering" }],
        },
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    assert.equal(route.ok, true);
    const scenario = await source.createScenario(normalizeScenario({
        ...createDefaultScenario({ id: "scripted-scenario" }),
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId: "ego",
            initialSpeedMps: 1,
            controller: {
                kind: "script",
                activation: { kind: "start" },
                scriptId: controller.id,
                outputs: [{ output: "speed", target: "speed" }, { output: "steering", target: "steering" }],
            },
            waypoints: route.waypoints,
            verification: route.verification,
        }],
        triggers: [{
            id: "run-child",
            name: "Run child",
            condition: { kind: "time", timeNs: 1 },
            actions: [{ kind: "run-script", scriptId: child.id, value: null }],
        }],
        completion: { conditions: [{ id: "script-done", name: "Script done", kind: "script", scriptId: controller.id }] },
        expectedOutcomes: [{ id: "child-outcome", name: "Child outcome", kind: "script", scriptId: child.id }],
        parameters: [{
            id: "child-gain",
            name: "Child gain",
            type: "float64",
            default: 1,
            target: { kind: "script-input", scriptId: child.id, input: "gain" },
        }],
    }));
    const binding = normalizeBinding({
        id: "frozen-controller",
        name: "Frozen controller",
        scope: "selected",
        scriptId: controller.id,
        trigger: { kind: "fixed-update", everyN: 1 },
    });
    const sourceManifest = await source.createRunManifest({
        ...createDefaultRunManifest({ id: "scripted-template" }),
        scenario: {
            id: scenario.id,
            expectedHash: scenario.definitionHash,
            egoVehicleId: "big-car",
            sensorBindings: {},
            parameterValues: {},
        },
        scripts: {
            enabled: true,
            artifacts: [{ scriptId: controller.id, expectedHash: computeResolvedRunHash(controller.latestValidArtifact) }],
            bindingIds: [],
            embeddedBindings: [binding],
            expectedBindingsHash: computeResolvedRunHash([binding]),
            bindingSource: "embedded",
        },
        parameters: [{
            id: "controller-gain",
            name: "Controller gain",
            type: "float64",
            default: 1,
            target: { kind: "script-input", scriptId: controller.id, input: "gain" },
        }],
    });
    const archivePath = path.join(root, "template.tar");
    const exported = await exportRunTemplatePackage({
        storageService: source,
        manifestId: sourceManifest.id,
        expectedRevision: sourceManifest.revision,
    });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;
    const archive = await fs.readFile(archivePath);
    const handle = {
        path: archivePath,
        mediaType: MARKETPLACE_ARTIFACTS["run-template"].mediaType,
        sha256: createHash("sha256").update(archive).digest("hex"),
        sizeBytes: archive.length,
    };

    const target = new StorageService(path.join(root, "target"));
    await target.putScript(createScriptDocument({ id: child.id, name: "Conflicting child" }));
    await target.putScript(createScriptDocument({ id: controller.id, name: "Conflicting controller" }));
    await target.createScenario(createDefaultScenario({ id: scenario.id, name: "Conflicting scenario" }));
    await target.createRunManifest(createDefaultRunManifest({ id: sourceManifest.id, name: "Conflicting run" }));
    await target.putBindings({
        kind: "cev-sim.script-bindings",
        version: 2,
        enabled: true,
        updatedAt: "2026-09-29T00:00:00.000Z",
        folders: [],
        bindings: [{ id: "unrelated-global", name: "Unrelated", scope: "global", scriptId: null }],
    });
    const receiptStore = await MarketplaceReceiptStore.open(path.join(root, "target"));
    const adapter = createRunTemplatePackageLifecycleAdapter({
        storageService: target,
        pluginStore: target.plugins,
        editorAssetStore: target.editorAssets,
        visualAssetStore: target.visualAssets,
        receiptStore,
    });
    const release = {
        itemId: "scripted-template",
        releaseVersion: "1.0.0",
        contentKind: "run-template",
        artifact: { mediaType: handle.mediaType, sha256: handle.sha256, sizeBytes: handle.sizeBytes },
        embeddedPlugins: [],
    };
    const context = {
        workDirectory: path.join(root, "work"),
        source: {
            registryId: "33333333-3333-4333-8333-333333333333",
            sourceId: "44444444-4444-4444-8444-444444444444",
        },
    };
    const plan = await adapter.plan({ release, artifactHandle: handle, context });
    for (const operation of plan.operations) await adapter.commit({ operation, adapterPlan: plan, context });

    const mapped = new Map(plan.mappings.map((entry) => [`${entry.resourceKind}:${entry.sourceId}`, entry.localId]));
    const localChild = mapped.get(`visual-script:${child.id}`);
    const localController = mapped.get(`visual-script:${controller.id}`);
    const localScenario = await target.getScenario(mapped.get(`scenario:${scenario.id}`));
    const localRun = await target.getRunManifest(mapped.get(`run-manifest:${sourceManifest.id}`));
    const localControllerDocument = await target.getScript(localController);
    assert.notEqual(localChild, child.id);
    assert.notEqual(localController, controller.id);
    assert.equal(localControllerDocument.graph.nodes[0].state.sourceScriptId, localChild);
    assert.equal(localScenario.routes[0].controller.scriptId, localController);
    assert.equal(localScenario.triggers[0].actions[0].scriptId, localChild);
    assert.equal(localScenario.completion.conditions[0].scriptId, localController);
    assert.equal(localScenario.expectedOutcomes[0].scriptId, localChild);
    assert.equal(localScenario.parameters[0].target.scriptId, localChild);
    assert.equal(localRun.scripts.artifacts[0].scriptId, localController);
    assert.equal(localRun.parameters[0].target.scriptId, localController);
    assert.equal(localRun.scripts.embeddedBindings[0].scriptId, localController);
    assert.equal(localRun.scripts.bindingSource, "embedded");
    assert.deepEqual(localRun.scripts.bindingIds, []);
    assert.equal(localRun.scripts.embeddedBindings.some((entry) => entry.id === "unrelated-global"), false);
});
