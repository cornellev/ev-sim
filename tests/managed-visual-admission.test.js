import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    hashVisualEvaluationInput,
    hashVisualThresholdProfile,
    serializeVisualCorrespondenceReport,
} from "../app/validation/VisualCorrespondence.js";
import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/Route.js";
import { createRunSensor } from "../app/3d/devices/SensorTypeRegistry.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { normalizePbrRenderRecipe, normalizePbrRunEvidence } from "../app/simulation/render/PbrRenderScene.js";
import { normalizeVisualLayer, sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { HeadlessExperimentService } from "../server/headless/HeadlessExperimentService.js";
import {
    MANAGED_BASELINE_ROOT_KIND,
    MANAGED_RESULT_ROOT_KIND,
    ManagedVisualAssetAdmission,
    managedBaselineRootOwner,
    managedResultRootOwner,
} from "../server/headless/ManagedVisualAssetAdmission.js";
import { StorageService } from "../server/storage/StorageService.js";
import { LogService } from "../server/logging/LogService.js";
import {
    makeTriangleGlb,
    ownedGrant,
    publishAsset,
    writeRegistry,
} from "./helpers/visual-assets.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

const correspondenceFixture = JSON.parse(await fs.readFile(
    new URL("./fixtures/visual-layer/correspondence.synthetic.v1.json", import.meta.url),
    "utf8",
));

function trustedEvidenceContext(pbr) {
    const profile = structuredClone(correspondenceFixture.profile);
    profile.purpose = "production";
    const profileHash = hashVisualThresholdProfile(profile);
    const input = structuredClone(correspondenceFixture.input);
    input.worldHash = pbr.renderScene.description.worldHash;
    input.visualLayerHash = pbr.renderScene.description.visualLayerHash;
    input.renderSceneHash = pbr.renderScene.hash;
    input.provider = {
        ...input.provider,
        id: pbr.renderScene.description.provider.id,
        version: pbr.renderScene.description.provider.version,
    };
    input.assets = pbr.evidence.visualAssets.uses.map((entry) => ({
        ...entry.use.asset,
        useHash: entry.useHash,
    })).sort((left, right) => `${left.sha256}:${left.useHash}`.localeCompare(`${right.sha256}:${right.useHash}`));
    input.assetClosureHash = pbr.renderScene.description.assetClosureHash;
    input.captureRecipeHash = pbr.renderScene.description.recipeHash;
    if (pbr.calibration?.hash) input.calibrationBundleHash = pbr.calibration.hash;
    if (pbr.manifest?.seed !== undefined) input.seed = Number(pbr.manifest.seed);
    input.policies.thresholdProfile.hash = profileHash;
    const inputHash = hashVisualEvaluationInput(input);
    const report = structuredClone(correspondenceFixture.report);
    report.thresholdProfile.hash = profileHash;
    report.evaluationInputHash = inputHash;
    const reportBytes = new TextEncoder().encode(serializeVisualCorrespondenceReport(report));
    const reportHash = sha256ExactBytes(reportBytes);
    const trust = {
        locallyValidated: true,
        validatorEligible: true,
        reportHash,
        evaluationInputHash: inputHash,
        thresholdProfileHash: profileHash,
        validatorId: report.validator.id,
        validatorVersion: report.validator.version,
        validatorBuildHash: report.validator.buildHash,
    };
    return {
        reportHash,
        context: {
            reportBytes,
            reportSha256: reportHash,
            expectedInput: input,
            approvedProfiles: new Map([[profileHash, profile]]),
            trustedLocalValidations: new Map([[reportHash, trust]]),
            capabilityDecision: { available: true },
        },
    };
}

function managedEnvironment(id) {
    return {
        environmentId: id,
        name: "Managed visual yard",
        schemaVersion: 2,
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: false,
        document: {
            environmentId: id,
            chunkSize: 20,
            roads: {
                nodes: [{ id: "start", x: 0, z: 0 }, { id: "finish", x: 10, z: 0 }],
                edges: [{ id: "road", startNodeId: "start", endNodeId: "finish", bidirectional: true, width: 4, laneCount: 1 }],
            },
            buildings: [],
            features: [],
            earth: null,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
        },
    };
}

async function managedPbrFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-managed-pbr-queue-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir, { recursive: true });
    const registryPath = await writeRegistry(dataDir, [ownedGrant("owned-test")]);
    const storage = new StorageService(dataDir, { visualAssets: { registryPath } });
    const logs = new LogService(path.join(root, "logs"));
    const created = await storage.createEnvironment({ id: "managed-yard", name: "Managed visual yard", templateId: "blank" });
    let environment = await storage.putEnvironment("managed-yard", {
        manifest: { ...created, ...managedEnvironment("managed-yard") },
        expectedRevision: created.revision,
    });
    const world = createWorldResource(environment);
    const actor = await publishAsset(storage.visualAssets, makeTriangleGlb(), {
        mediaType: "model/gltf-binary",
        role: "actor",
        sourceIds: ["owned-test"],
    });
    const descriptor = normalizeVisualLayer({
        sourceWorldHash: world.hash,
        assets: [],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
    const layer = await storage.publishVisualLayer({ descriptor, assetUses: [] });
    environment = await storage.putEnvironment("managed-yard", {
        manifest: {
            ...environment,
            visualLayer: { descriptorHash: layer.descriptorHash, accessHash: layer.accessHash },
            evidence: { reportHash: "e".repeat(64) },
        },
        expectedRevision: environment.revision,
    });
    const route = verifyRoute(environment, {
        id: "managed-route",
        actorId: "ego",
        controller: { kind: "route-follower", activation: { kind: "start" } },
        waypoints: [
            { id: "start", position: { x: 0, y: 0, z: 0 } },
            { id: "finish", position: { x: 10, y: 0, z: 0 } },
        ],
    });
    assert.equal(route.ok, true, route.error);
    const scenario = await storage.createScenario(createDefaultScenario({
        id: "managed-pbr-scenario",
        environment: { id: environment.environmentId, expectedHash: null },
        actors: [{ id: "ego", name: "Ego", role: "ego", vehicleId: "big-car" }],
        routes: [{
            id: "managed-route",
            actorId: "ego",
            initialSpeedMps: 0,
            controller: { kind: "route-follower", activation: { kind: "start" } },
            waypoints: route.waypoints,
            verification: route.verification,
        }],
        triggers: [{
            id: "finish-step",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 3 },
            actions: [{ kind: "finish" }],
        }],
        completion: { conditions: [] },
        expectedOutcomes: [{ id: "safe", kind: "no-collisions" }],
    }));
    const manifest = createDefaultRunManifest({
        id: "managed-pbr-manifest",
        seed: "7",
        environment: { id: environment.environmentId, expectedHash: null },
        scenario: {
            id: scenario.id,
            expectedHash: scenario.definitionHash,
            egoVehicleId: "big-car",
            sensorBindings: {},
            parameterValues: {},
        },
        controls: { authority: "reference" },
        sensorRig: {
            sensors: [createRunSensor("camera", {
                id: "managed-camera",
                parentId: "ego",
                render: {
                    provider: { id: "pbr-mesh", version: 1 },
                    productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
                },
            })],
            syncGroups: [],
        },
        clock: { pacing: "unbounded", maxSteps: 10 },
        logging: { policy: "disabled", profileId: "simulation-run-full-sensors" },
    });
    manifest.renderRecipe = normalizePbrRenderRecipe({
        actors: [{
            actorId: "ego",
            mode: "visual-asset",
            asset: { asset: actor.use.asset, useHash: actor.useHash },
        }],
    });
    await storage.createRunManifest(manifest);
    const suite = await storage.createExperimentSuite(createDefaultExperimentSuite({
        id: "managed-pbr-suite",
        scenarioIds: [scenario.id],
        manifestIds: [manifest.id],
        seeds: [7],
        metrics: [{ id: "passed", source: { kind: "builtin", metric: "passed" } }],
    }));
    const initial = await storage.resolveRunManifest(manifest.id);
    const trusted = trustedEvidenceContext(initial);
    const latest = await storage.getEnvironment(environment.environmentId);
    await storage.putEnvironment(environment.environmentId, {
        manifest: { ...latest, evidence: { reportHash: trusted.reportHash } },
        expectedRevision: latest.revision,
    });
    let validation = await storage.validateExperimentSuite(suite.id);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    let finalResolved = (await storage.resolveExperimentCase(suite.id, {
        case: validation.matrix.cases[0],
    })).resolvedRun;
    const finalTrusted = trustedEvidenceContext(finalResolved);
    if (finalTrusted.reportHash !== trusted.reportHash) {
        const currentEnvironment = await storage.getEnvironment(environment.environmentId);
        await storage.putEnvironment(environment.environmentId, {
            manifest: { ...currentEnvironment, evidence: { reportHash: finalTrusted.reportHash } },
            expectedRevision: currentEnvironment.revision,
        });
        validation = await storage.validateExperimentSuite(suite.id);
        assert.equal(validation.ok, true, JSON.stringify(validation.issues));
        finalResolved = (await storage.resolveExperimentCase(suite.id, {
            case: validation.matrix.cases[0],
        })).resolvedRun;
    }
    assert.equal(finalResolved.evidence.correspondence.reportHash, finalTrusted.reportHash);
    return { root, dataDir, storage, logs, suite, actor, trusted: finalTrusted, finalResolved };
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-managed-visual-admission-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await writeRegistry(dataDir, [ownedGrant("owned-test")]);
    const storage = new StorageService(dataDir);
    const bytes = makeTriangleGlb();
    const published = await publishAsset(storage.visualAssets, bytes, {
        mediaType: "model/gltf-binary",
        role: "actor",
        sourceIds: ["owned-test"],
    });
    const pbr = resolvedPbrRun({
        actorSha256: published.use.asset.sha256,
        actorSizeBytes: published.use.asset.sizeBytes,
    });
    assert.equal(pbr.actorUseHash, published.useHash);
    const trusted = trustedEvidenceContext(pbr);
    const evidence = normalizePbrRunEvidence({
        ...pbr.evidence,
        correspondence: { reportHash: trusted.reportHash, status: "unverified-reference" },
    });
    const bundle = { resolved: { renderScene: pbr.renderScene, evidence } };
    return { root, dataDir, storage, bytes, published, pbr, trusted, bundle };
}

test("VIS-15b managed PBR admission is closed by default and binds trusted evidence to frozen assets", async (t) => {
    const current = await fixture(t);
    const unavailable = new ManagedVisualAssetAdmission(current.storage);
    await assert.rejects(
        () => unavailable.validateBundle(current.bundle, "queue-admission"),
        /unavailable until VIS-16b/,
    );

    const admission = new ManagedVisualAssetAdmission(current.storage, {
        evidenceContextProvider: async () => current.trusted.context,
    });
    const acquired = await admission.acquireQueueRoot("managed-pbr", [current.bundle]);
    assert.equal(acquired.root.ownerKind, MANAGED_RESULT_ROOT_KIND);
    assert.deepEqual(acquired.cases[0].useHashes, [current.published.useHash]);

    const execution = await admission.openExecution({
        resultId: "managed-pbr",
        caseIndex: 0,
        bundle: current.bundle,
    });
    const opened = await execution.reader.open(current.published.use.asset.sha256);
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), current.bytes);
    await opened.release();
    await execution.close();
    assert.equal(current.storage.visualAssets._pins.pins[execution.pin.handle], undefined);
    assert.ok(await current.storage.visualAssets.getRoot(managedResultRootOwner("managed-pbr")));

    const staleContext = structuredClone(current.trusted.context);
    staleContext.expectedInput.renderSceneHash = "f".repeat(64);
    const stale = new ManagedVisualAssetAdmission(current.storage, {
        evidenceContextProvider: async () => staleContext,
    });
    await assert.rejects(
        () => stale.openExecution({ resultId: "managed-pbr", caseIndex: 1, bundle: current.bundle }),
        /renderSceneHash.*frozen run bundle/,
    );

    await writeRegistry(current.dataDir, [ownedGrant("owned-test", { status: "revoked" })]);
    await assert.rejects(
        () => admission.openExecution({ resultId: "managed-pbr", caseIndex: 2, bundle: current.bundle }),
        /revoked|rights|denied/i,
    );
    await writeRegistry(current.dataDir, [ownedGrant("owned-test")]);
    await admission.rollbackQueueRoot("managed-pbr");
    assert.equal(await current.storage.visualAssets.getRoot(managedResultRootOwner("managed-pbr")), null);
});

test("VIS-15b recovery rejects legacy PBR sidecars and conservatively reconciles admission journals", async (t) => {
    const current = await fixture(t);
    const admission = new ManagedVisualAssetAdmission(current.storage, {
        evidenceContextProvider: async () => current.trusted.context,
    });
    const acquired = await admission.acquireQueueRoot("recovery-pbr", [current.bundle]);
    const caseMetadata = acquired.cases[0];
    await assert.rejects(
        () => admission.reconcileQueueRoot("recovery-pbr", {
            manifest: { version: 1, cases: [{}] },
            bundles: [current.bundle],
        }),
        /version-2/,
    );
    await admission.reconcileQueueRoot("recovery-pbr", {
        manifest: {
            version: 2,
            cases: [{
                visualUseHashes: caseMetadata.useHashes,
                assetClosureHash: caseMetadata.assetClosureHash,
                correspondenceReportHash: caseMetadata.correspondenceReportHash,
            }],
        },
        bundles: [current.bundle],
    });
    await admission.rollbackQueueRoot("recovery-pbr");

    await admission.acquireQueueRoot("orphan-pbr", [current.bundle]);
    const outcomes = await admission.reconcileOrphanJournals({ entries: [] });
    assert.ok(outcomes.some((entry) => entry.resultId === "orphan-pbr" && entry.action === "rolled-back"));
    assert.equal(await current.storage.visualAssets.getRoot(managedResultRootOwner("orphan-pbr")), null);
});

test("VIS-15b queued PBR execution retains exact sidecars and independent result and baseline roots", async (t) => {
    const current = await managedPbrFixture(t);
    let calls = 0;
    const supervisor = {
        async runManagedExperiment(request, options) {
            calls += 1;
            options.onStarted?.({ pid: 7000 + calls });
            return {
                outputDirectory: request.outputUri,
                artifacts: [],
                experimentMetrics: { passed: 1 },
                runResult: {
                    runId: "managed-pbr-run",
                    completed: true,
                    passed: true,
                    resolvedHash: request.bundle.resolvedHash,
                    simulationSemanticHash: request.bundle.simulationSemanticHash,
                    episodeHash: "a".repeat(64),
                    trajectoryHash: "b".repeat(64),
                    assertions: [],
                    outcomes: [{ id: "safe", passed: true }],
                },
            };
        },
        async close() {},
    };
    const service = new HeadlessExperimentService(current.storage, current.logs, {
        supervisor,
        evidenceContextProvider: async () => current.trusted.context,
        artifactRoot: path.join(current.root, "artifacts"),
    });
    const started = await service.enqueue({
        suiteId: current.suite.id,
        resultId: "queued-managed-pbr",
        artifactProfile: "disabled",
    });
    const result = await service.waitForCompletion(started.resultId);
    assert.equal(result.status, "completed", result.cases[0]?.failureReason);
    assert.equal(calls, 1);
    const sidecars = await current.storage.readHeadlessRunBundles(result.id);
    assert.equal(sidecars.manifest.version, 2);
    assert.equal(sidecars.manifest.cases[0].bundleBytesHash, sidecars.bundleRecords[0].bundleBytesHash);
    assert.deepEqual(sidecars.manifest.cases[0].visualUseHashes, [current.actor.useHash]);
    assert.equal(sidecars.manifest.cases[0].correspondenceReportHash, current.trusted.reportHash);
    assert.equal(Object.keys(current.storage.visualAssets._pins.pins).length, 0);
    const resultRoot = await current.storage.visualAssets.getRoot(managedResultRootOwner(result.id));
    assert.equal(resultRoot.ownerKind, MANAGED_RESULT_ROOT_KIND);

    const baseline = await current.storage.createExperimentBaseline({
        resultId: result.id,
        id: "managed-pbr-baseline",
        name: "Managed PBR baseline",
    });
    const baselineRoot = await current.storage.visualAssets.getRoot(managedBaselineRootOwner(baseline.id));
    assert.equal(baselineRoot.ownerKind, MANAGED_BASELINE_ROOT_KIND);
    await current.storage.deleteExperimentResult(result.id, result.revision);
    assert.equal(await current.storage.visualAssets.getRoot(managedResultRootOwner(result.id)), null);
    assert.ok(await current.storage.visualAssets.getRoot(managedBaselineRootOwner(baseline.id)));
    assert.equal(await current.storage.readHeadlessRunBundles(result.id), null);
    await current.storage.deleteExperimentBaseline(baseline.id);
    assert.equal(await current.storage.visualAssets.getRoot(managedBaselineRootOwner(baseline.id)), null);
    await service.close();
});

test("VIS-15b hardware managed PBR executes the actual queue and worker path", {
    skip: process.env.CEV_SIM_PBR_HARDWARE !== "1",
    timeout: 120_000,
}, async (t) => {
    const current = await managedPbrFixture(t);
    const configured = process.env.CEV_SIM_SUPERVISOR_CONFIG
        ? JSON.parse(await fs.readFile(process.env.CEV_SIM_SUPERVISOR_CONFIG, "utf8"))
        : {};
    const supervisorConfig = {
        ...configured,
        kind: "cev-sim.headless-supervisor-config",
        version: 1,
        renderer: {
            ...(configured.renderer || {}),
            chromiumExecutable: configured.renderer?.chromiumExecutable
                || process.env.CEV_SIM_CHROMIUM_EXECUTABLE,
            pbrEnabled: true,
            pbrTarget: configured.renderer?.pbrTarget || "local-development",
        },
    };
    const service = new HeadlessExperimentService(current.storage, current.logs, {
        supervisorConfig,
        evidenceContextProvider: async () => current.trusted.context,
        artifactRoot: path.join(current.root, "hardware-artifacts"),
    });
    let captureCount = 0;
    const pool = service.supervisor.rendererPool;
    const capture = pool.capturePbrGroup.bind(pool);
    pool.capturePbrGroup = async (...args) => {
        captureCount += 1;
        return capture(...args);
    };
    let cleanup = null;
    try {
        const started = await service.enqueue({
            suiteId: current.suite.id,
            resultId: "hardware-managed-pbr",
            artifactProfile: "disabled",
        });
        const result = await service.waitForCompletion(started.resultId);
        assert.equal(result.status, "completed", result.cases[0]?.failureReason);
        assert.ok(captureCount > 0);
        cleanup = pool.diagnostics();
        assert.equal(cleanup.preparedPbrEnvironments, 0);
        assert.equal(cleanup.busyContexts, 0);
        assert.equal(cleanup.queuedJobs, 0);
        assert.equal(cleanup.trackedGpuBytes, 0);
    } finally {
        await service.close();
        if (process.env.CEV_SIM_MANAGED_PBR_REPORT) {
            await fs.mkdir(path.dirname(process.env.CEV_SIM_MANAGED_PBR_REPORT), { recursive: true });
            await fs.writeFile(process.env.CEV_SIM_MANAGED_PBR_REPORT, `${JSON.stringify({
                kind: "cev-sim.managed-pbr-hardware-report",
                version: 1,
                captureCount,
                cleanup,
            }, null, 2)}\n`);
        }
    }
});
