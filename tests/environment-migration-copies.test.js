import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { assetMetricDefinitionFromRevision } from "../app/editor-assets/AssetMetricSnapshot.js";
import { createGeoFrame } from "../app/geography/GeoFrame.js";
import { hasEditorSourceContract } from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createAssetStore, makeNamedMaterialGlb, publishAsset } from "./helpers/visual-assets.js";

const FRAME = createGeoFrame({ origin: { lat: 42.443, lng: -76.502, height: 0 } });
const MODEL_GEOMETRY = { 0: { vertices: [[-1, 0, -1], [1, 0, -1], [0, 2, 0]], triangles: [[0, 1, 2]] } };

async function restoreCopy(service, environmentId, envelope) {
    const filePath = service._environmentPath(environmentId);
    await fs.writeFile(filePath, `${JSON.stringify(envelope.manifest, null, 2)}\n`);
    service._fileStore(filePath, null).invalidate();
    return service.getEnvironment(environmentId);
}

test("ED-09 the first geoFrame write keeps a write-once pre-editor-source copy that restores the prior document", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed09-source-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });
    assert.equal(hasEditorSourceContract(created.document), false);
    const originalWorld = createWorldResource(created);

    const upgraded = await service.putEnvironment("yard", {
        manifest: { ...created, document: { ...created.document, geoFrame: FRAME } },
        expectedRevision: created.revision,
        supportedEditorSourceVersions: [1],
    });
    assert.equal(hasEditorSourceContract(upgraded.document), true);

    const copyPath = path.join(dir, "environment-migrations", "yard.pre-editor-source-v1.json");
    const copyBytes = await fs.readFile(copyPath, "utf8");
    const copy = JSON.parse(copyBytes);
    assert.equal(copy.kind, "cev-sim.environment-pre-editor-source");
    assert.equal(copy.version, 1);
    assert.equal(copy.environmentId, "yard");
    assert.equal(copy.revision, created.revision);
    assert.equal(hasEditorSourceContract(copy.manifest.document), false);

    const liveBeforeUnawareWrite = await service.getEnvironment("yard");
    await assert.rejects(() => service.putEnvironment("yard", {
        manifest: liveBeforeUnawareWrite,
        expectedRevision: liveBeforeUnawareWrite.revision,
    }), (error) => error.code === "ENVIRONMENT_EDITOR_SOURCE_DOWNGRADE");
    assert.deepEqual(await service.getEnvironment("yard"), liveBeforeUnawareWrite);
    assert.equal(await fs.readFile(copyPath, "utf8"), copyBytes, "an unaware writer cannot replace the live source document or its copy");

    const renamed = await service.putEnvironment("yard", {
        manifest: { ...upgraded, name: "North Yard" },
        expectedRevision: upgraded.revision,
        supportedEditorSourceVersions: [1],
    });
    assert.equal(renamed.name, "North Yard");
    assert.deepEqual(JSON.parse(await fs.readFile(copyPath, "utf8")), copy);

    const restarted = new StorageService(dir);
    const afterRestart = await restarted.getEnvironment("yard");
    await restarted.putEnvironment("yard", {
        manifest: { ...afterRestart, name: "Restarted yard" },
        expectedRevision: afterRestart.revision,
        supportedEditorSourceVersions: [1],
    });
    assert.equal(await fs.readFile(copyPath, "utf8"), copyBytes, "restart and later saves preserve the exact backup bytes");

    const restored = await restoreCopy(service, "yard", copy);
    assert.equal(restored.name, created.name);
    assert.equal(restored.revision, created.revision);
    assert.equal(hasEditorSourceContract(restored.document), false);
    assert.equal(restored.document.geoFrame, undefined);
    assert.deepEqual(createWorldResource(restored), originalWorld);
});

test("ED-09 the first asset-metrics write keeps a write-once pre-asset-metrics copy that restores the prior document", async (t) => {
    const fixture = await createAssetStore();
    t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
    const service = new StorageService(fixture.dir);
    await service.visualAssets.initialize();
    const source = await publishAsset(service.visualAssets, makeNamedMaterialGlb("factory-red"), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    const definition = createEmptyAssetDefinition({ modelUseHash: source.useHash, name: "Body" });
    const compiled = compileAssetDefinition(definition, { sourceGeometries: { source: MODEL_GEOMETRY } });
    const published = await service.editorAssets.publishRevision({
        assetId: "compiled-crate",
        name: "Compiled crate",
        publicationId: "ed09-metrics",
        expectedAssetRevision: 0,
        modelUseHash: source.useHash,
        definition,
        metric: compiled.metric,
        metricHash: compiled.metricHash,
        appearance: compiled.materials,
    }, 0);
    assert.equal(published.revision.version, 2);

    const created = await service.createEnvironment({ id: "metrics-yard", name: "Metrics" });
    assert.equal(created.document.assetMetrics, undefined);
    const originalWorld = createWorldResource(created);
    const metric = assetMetricDefinitionFromRevision("compiled-crate", published.revision);
    const withMetrics = {
        ...created,
        document: {
            ...created.document,
            objects: [
                ...created.document.objects,
                {
                    id: "crate-instance",
                    typeId: "asset-instance",
                    typeVersion: 2,
                    name: "Crate",
                    parentId: null,
                    order: 1,
                    components: {
                        tags: [],
                        locked: false,
                        editorHidden: false,
                        asset: {
                            assetId: "compiled-crate",
                            revision: published.revision.revision,
                            position: { x: 0, y: 0, z: 0 },
                            rotationY: 0,
                            scale: { x: 1, y: 1, z: 1 },
                            overrides: {},
                        },
                    },
                },
            ],
            assetMetrics: { version: 1, definitions: [metric] },
            geoFrame: FRAME,
        },
    };
    const upgraded = await service.putEnvironment("metrics-yard", {
        manifest: withMetrics,
        expectedRevision: created.revision,
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    assert.ok(upgraded.document.assetMetrics);
    assert.equal(hasEditorSourceContract(upgraded.document), true);

    const copyPath = path.join(fixture.dir, "environment-migrations", "metrics-yard.pre-asset-metrics-v1.json");
    const copy = JSON.parse(await fs.readFile(copyPath, "utf8"));
    assert.equal(copy.kind, "cev-sim.environment-pre-asset-metrics");
    assert.equal(copy.version, 1);
    assert.equal(copy.environmentId, "metrics-yard");
    assert.equal(copy.revision, created.revision);
    assert.equal(copy.manifest.document.assetMetrics, undefined);
    const sourceCopyPath = path.join(fixture.dir, "environment-migrations", "metrics-yard.pre-editor-source-v1.json");
    const sourceCopy = JSON.parse(await fs.readFile(sourceCopyPath, "utf8"));
    assert.equal(sourceCopy.kind, "cev-sim.environment-pre-editor-source");
    assert.deepEqual(sourceCopy.manifest, copy.manifest, "simultaneous source and metric adoption retain the same original manifest");

    const liveBeforeUnawareWrite = await service.getEnvironment("metrics-yard");
    await assert.rejects(() => service.putEnvironment("metrics-yard", {
        manifest: liveBeforeUnawareWrite,
        expectedRevision: liveBeforeUnawareWrite.revision,
        supportedEditorSourceVersions: [1],
    }), (error) => error.code === "ENVIRONMENT_ASSET_METRICS_DOWNGRADE");
    assert.deepEqual(await service.getEnvironment("metrics-yard"), liveBeforeUnawareWrite);
    assert.deepEqual(JSON.parse(await fs.readFile(copyPath, "utf8")), copy);
    assert.deepEqual(JSON.parse(await fs.readFile(sourceCopyPath, "utf8")), sourceCopy);

    const renamed = await service.putEnvironment("metrics-yard", {
        manifest: { ...upgraded, name: "Named metrics" },
        expectedRevision: upgraded.revision,
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    assert.equal(renamed.name, "Named metrics");
    assert.deepEqual(JSON.parse(await fs.readFile(copyPath, "utf8")), copy);

    const restored = await restoreCopy(service, "metrics-yard", copy);
    assert.equal(restored.name, created.name);
    assert.equal(restored.revision, created.revision);
    assert.equal(restored.document.assetMetrics, undefined);
    assert.equal(restored.document.objects.some((record) => record.typeId === "asset-instance"), false);
    assert.deepEqual(createWorldResource(restored), originalWorld);
});

test("ED-09 a failed migration-copy write aborts the live environment replacement", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed09-copy-failure-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });
    const before = await service.getEnvironment("yard");
    service._retainPreEditorSourceCopy = async () => {
        throw new Error("migration backup unavailable");
    };
    await assert.rejects(() => service.putEnvironment("yard", {
        manifest: { ...created, document: { ...created.document, geoFrame: FRAME } },
        expectedRevision: created.revision,
        supportedEditorSourceVersions: [1],
    }), /migration backup unavailable/);
    assert.deepEqual(await service.getEnvironment("yard"), before);
    await assert.rejects(() => fs.access(path.join(dir, "environment-migrations", "yard.pre-editor-source-v1.json")));
});

test("ED-09 a stale guarded migration write creates no recovery copy", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed09-stale-copy-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });
    await assert.rejects(() => service.putEnvironment("yard", {
        manifest: { ...created, document: { ...created.document, geoFrame: FRAME } },
        expectedRevision: created.revision - 1,
        supportedEditorSourceVersions: [1],
    }), (error) => error.code === "ENVIRONMENT_REVISION_CONFLICT");
    assert.equal(hasEditorSourceContract((await service.getEnvironment("yard")).document), false);
    await assert.rejects(() => fs.access(path.join(dir, "environment-migrations", "yard.pre-editor-source-v1.json")));
});

test("ED-09 concurrent guarded source upgrades retain one original copy and commit one revision", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed09-concurrent-copy-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const created = await service.createEnvironment({ id: "yard", name: "Yard" });
    const writes = ["North", "South"].map((name) => service.putEnvironment("yard", {
        manifest: {
            ...created,
            name,
            document: { ...created.document, geoFrame: FRAME },
        },
        expectedRevision: created.revision,
        supportedEditorSourceVersions: [1],
    }));
    const results = await Promise.allSettled(writes);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "ENVIRONMENT_REVISION_CONFLICT");

    const live = await service.getEnvironment("yard");
    assert.equal(live.revision, created.revision + 1);
    assert.equal(hasEditorSourceContract(live.document), true);
    const copy = JSON.parse(await fs.readFile(path.join(
        dir,
        "environment-migrations",
        "yard.pre-editor-source-v1.json",
    ), "utf8"));
    assert.equal(copy.revision, created.revision);
    assert.deepEqual(copy.manifest, created);
});
