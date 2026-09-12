import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    ENVIRONMENT_SCHEMA_VERSION,
    applyEnvironmentVisualReferences,
    environmentRevisionOf,
    presentStoredEnvironment,
    serializeEnvironmentManifestV3,
} from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import {
    assertVisualLayer,
    canonicalExactStringify,
    hashVisualLayer,
    normalizeVisualLayer,
} from "../app/simulation/visual/VisualLayer.js";
import { StorageService } from "../server/storage/StorageService.js";
import { ENVIRONMENT_REVISION_CONFLICT, ENVIRONMENT_UNGUARDED_WRITE } from "../server/storage/StorageErrors.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";

async function tempService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-env-v3-"));
    return { dir, service: new StorageService(dir) };
}

function v2Document(id = "yard") {
    return {
        environmentId: id,
        name: "Yard",
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
                nodes: [
                    { id: "n0", x: 0, z: 0 },
                    { id: "n1", x: 10, z: 0 },
                ],
                edges: [{ id: "e0", startNodeId: "n0", endNodeId: "n1", bidirectional: true, width: 4, laneCount: 1 }],
            },
            buildings: [{
                buildingId: "building-0",
                footprint: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }],
                height: 8,
            }],
            features: [],
            earth: null,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
        },
    };
}

function layerFor(worldHash) {
    return normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: worldHash,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets: [{
            sha256: "a".repeat(64),
            mediaType: "model/gltf-binary",
            sizeBytes: 16,
            role: "mesh",
        }],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
}

function boundLayerFor(worldHash) {
    const mesh = "a".repeat(64);
    return normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: worldHash,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets: [{ sha256: mesh, mediaType: "model/gltf-binary", sizeBytes: 16, role: "mesh" }],
        materials: [],
        chunks: [{ id: "chunk-0", instanceIds: ["building-0"], dependencyUris: [`sha256:${mesh}`] }],
        instances: [{
            id: "building-0",
            assetUri: `sha256:${mesh}`,
            lodLevels: [`sha256:${mesh}`],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            chunkIds: ["chunk-0"],
            materialIds: [],
        }],
        bindings: [{ id: "binding-0", instanceId: "building-0", truthEntityId: "missing-building" }],
        appearanceDependencies: [],
    });
}

test("v2 environments load as revision 0 and guarded saves produce revision 1 on the default (v4) writer", async () => {
    const { dir, service } = await tempService();
    try {
        await fs.mkdir(path.join(dir, "environments"), { recursive: true });
        await fs.writeFile(path.join(dir, "environments", "yard.json"), JSON.stringify(v2Document(), null, 2));
        const loaded = await service.getEnvironment("yard");
        assert.equal(loaded.schemaVersion, 2);
        assert.equal(environmentRevisionOf(loaded), 0);
        assert.equal(Object.hasOwn(loaded, "revision"), false);
        assert.equal(Object.hasOwn(loaded, "visualLayer"), false);

        const saved = await service.putEnvironment("yard", {
            manifest: loaded,
            expectedRevision: 0,
        });
        assert.equal(saved.schemaVersion, 4, "ED-02: guarded saves write schema v4 by default");
        assert.equal(ENVIRONMENT_SCHEMA_VERSION, 3, "the browser still declares v3; the downgrade guard keys on the objects array");
        assert.equal(saved.revision, 1);
        assert.equal(saved.visualLayer, null);
        assert.equal(saved.evidence, null);
        assert.equal("clientRevision" in saved, false);

        const onDisk = JSON.parse(await fs.readFile(path.join(dir, "environments", "yard.json"), "utf8"));
        assert.equal(onDisk.schemaVersion, 4);
        assert.equal(onDisk.revision, 1);
        assert.equal("clientRevision" in onDisk, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("null and populated visual references survive reload without changing world hashes", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const seeded = await service.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard"), visualLayer: null, evidence: null },
            expectedRevision: created.revision,
        });
        const beforeWorld = createWorldResource(seeded).hash;
        const descriptor = layerFor(beforeWorld);
        const digest = await service._visualLayerDescriptors.put(descriptor);
        const withRefs = await service.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: digest },
                evidence: { reportHash: "b".repeat(64) },
            },
            expectedRevision: seeded.revision,
        });
        const reloaded = await service.getEnvironment("yard");
        assert.deepEqual(reloaded.visualLayer, { descriptorHash: digest });
        assert.deepEqual(reloaded.evidence, { reportHash: "b".repeat(64) });
        assert.equal(createWorldResource(reloaded).hash, beforeWorld);
        assert.equal(createWorldResource({ ...reloaded, revision: 99, visualLayer: null, evidence: null }).hash, beforeWorld);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("unknown schema versions and malformed hashes are rejected", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        // Schema v4 is readable and writable since ED-01; 9 stays unknown.
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: { ...created, schemaVersion: 9 },
                expectedRevision: created.revision,
            }),
            /Unsupported environment schema version/,
        );
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: { ...created, visualLayer: { descriptorHash: "ABC".repeat(10) + "abcd" } },
                expectedRevision: created.revision,
            }),
            /lowercase SHA-256/,
        );
        assert.throws(
            () => presentStoredEnvironment({ environmentId: "yard", schemaVersion: 9 }, "yard"),
            /Unsupported environment schema version/,
        );
        assert.equal(environmentRevisionOf({ schemaVersion: 2 }), 0);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("EnvironmentLoader copies visual references without materializing measured resources", () => {
    const environment = {
        environmentId: "yard",
        name: "Yard",
        revision: 0,
        visualLayer: null,
        evidence: null,
        registry: { listEntities() { return [{ id: "building-0" }]; } },
    };
    const digest = "c".repeat(64);
    applyEnvironmentVisualReferences(environment, {
        revision: 4,
        visualLayer: { descriptorHash: digest },
        evidence: { reportHash: "d".repeat(64) },
    });
    assert.equal(environment.revision, 4);
    assert.deepEqual(environment.visualLayer, { descriptorHash: digest });
    assert.deepEqual(environment.evidence, { reportHash: "d".repeat(64) });
    assert.equal(environment.registry.listEntities().length, 1);
});

test("two writes with the same revision yield one commit and one 409", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const outcomes = await Promise.allSettled([
            service.putEnvironment("yard", { manifest: { ...created, name: "A" }, expectedRevision: 1 }),
            service.putEnvironment("yard", { manifest: { ...created, name: "B" }, expectedRevision: 1 }),
        ]);
        assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
        const rejected = outcomes.find((entry) => entry.status === "rejected");
        assert.equal(rejected.reason.code, ENVIRONMENT_REVISION_CONFLICT);
        assert.equal(rejected.reason.statusCode, 409);
        assert.equal(rejected.reason.currentRevision, 2);
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.revision, 2);
        assert.equal(stored.name === "A" || stored.name === "B", true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("stale rename, delete, and id-change fail without mutation", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        await service.putEnvironment("yard", { manifest: { ...created, name: "Newer" }, expectedRevision: 1 });
        await assert.rejects(
            () => service.renameEnvironment("yard", { name: "Nope", expectedRevision: 1 }),
            (error) => error.code === ENVIRONMENT_REVISION_CONFLICT && error.currentRevision === 2,
        );
        await assert.rejects(
            () => service.deleteEnvironment("yard", 1),
            (error) => error.code === ENVIRONMENT_REVISION_CONFLICT,
        );
        await assert.rejects(
            () => service.changeEnvironmentId("yard", { id: "moved-yard", expectedRevision: 1 }),
            (error) => error.code === ENVIRONMENT_REVISION_CONFLICT,
        );
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.name, "Newer");
        assert.equal(stored.environmentId, "yard");
        assert.equal(await service.getEnvironment("moved-yard"), null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("legacy unguarded writes are rejected explicitly", async () => {
    const { dir, service } = await tempService();
    try {
        await service.createEnvironment({ id: "yard", name: "Yard" });
        await assert.rejects(
            () => service.putEnvironment("yard", { environmentId: "yard", name: "Legacy", schemaVersion: 2 }),
            (error) => error.code === ENVIRONMENT_UNGUARDED_WRITE && error.statusCode === 400,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("disk failure does not advance persisted state or cache revision", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const filePath = service._environmentPath("yard");
        await fs.rm(filePath);
        await fs.mkdir(filePath);
        await assert.rejects(
            () => service.putEnvironment("yard", { manifest: { ...created, name: "Failed" }, expectedRevision: 1 }),
        );
        await fs.rm(filePath, { recursive: true, force: true });
        service._fileStore(filePath, null).invalidate();
        const stored = await service.getEnvironment("yard");
        assert.equal(stored, null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("display rename retains descriptor and evidence when the world hash is unchanged", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const seeded = await service.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard") },
            expectedRevision: created.revision,
        });
        const worldHash = createWorldResource(seeded).hash;
        const digest = await service._visualLayerDescriptors.put(layerFor(worldHash));
        const referenced = await service.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: digest },
                evidence: { reportHash: "e".repeat(64) },
            },
            expectedRevision: seeded.revision,
        });
        const renamed = await service.renameEnvironment("yard", {
            name: "North Yard",
            expectedRevision: referenced.revision,
        });
        assert.equal(renamed.name, "North Yard");
        assert.deepEqual(renamed.visualLayer, referenced.visualLayer);
        assert.deepEqual(renamed.evidence, referenced.evidence);
        assert.equal(createWorldResource(renamed).hash, worldHash);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("duplicate and id change rebind descriptors, reuse asset digests, and clear evidence", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const seeded = await service.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard") },
            expectedRevision: created.revision,
        });
        const sourceWorld = createWorldResource(seeded);
        const descriptor = layerFor(sourceWorld.hash);
        const sourceDigest = await service._visualLayerDescriptors.put(descriptor);
        const referenced = await service.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: sourceDigest },
                evidence: { reportHash: "e".repeat(64) },
            },
            expectedRevision: seeded.revision,
        });

        const duplicated = await service.duplicateEnvironment("yard", {
            id: "yard-copy",
            name: "Yard Copy",
            expectedRevision: referenced.revision,
        });
        assert.notEqual(duplicated.visualLayer.descriptorHash, sourceDigest);
        assert.equal(duplicated.evidence, null);
        const copyDescriptor = await service._visualLayerDescriptors.get(duplicated.visualLayer.descriptorHash);
        assert.equal(copyDescriptor.sourceWorldHash, createWorldResource(duplicated).hash);
        assert.notEqual(copyDescriptor.sourceWorldHash, sourceWorld.hash);
        assert.deepEqual(copyDescriptor.assets, descriptor.assets);
        assertVisualLayer(copyDescriptor);
        assert.equal(hashVisualLayer(copyDescriptor), duplicated.visualLayer.descriptorHash);

        const moved = await service.changeEnvironmentId("yard-copy", {
            id: "yard-moved",
            expectedRevision: duplicated.revision,
        });
        assert.notEqual(moved.visualLayer.descriptorHash, duplicated.visualLayer.descriptorHash);
        assert.equal(moved.evidence, null);
        assert.equal(await service.getEnvironment("yard-copy"), null);
        const movedDescriptor = await service._visualLayerDescriptors.get(moved.visualLayer.descriptorHash);
        assert.equal(movedDescriptor.sourceWorldHash, createWorldResource(moved).hash);
        assert.deepEqual(movedDescriptor.assets.map((entry) => entry.sha256), descriptor.assets.map((entry) => entry.sha256));
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("conflicting import rebinds when the descriptor is local and fails when it is missing", async () => {
    const source = await tempService();
    const target = await tempService();
    try {
        const created = await source.service.createEnvironment({ id: "yard", name: "Source Yard" });
        const seeded = await source.service.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard") },
            expectedRevision: created.revision,
        });
        const digest = await source.service._visualLayerDescriptors.put(layerFor(createWorldResource(seeded).hash));
        const referenced = await source.service.putEnvironment("yard", {
            manifest: { ...seeded, visualLayer: { descriptorHash: digest } },
            expectedRevision: seeded.revision,
        });
        await source.service.createRunManifest(createDefaultRunManifest({
            id: "portable",
            environment: { id: "yard", expectedHash: null },
        }));
        const bundle = await source.service.exportRunManifest("portable");
        bundle.resolved.environment.manifest = referenced;

        await target.service.createEnvironment({ id: "yard", name: "Different Yard" });
        await assert.rejects(() => target.service.importRunBundle(bundle), /missing/);

        await target.service._visualLayerDescriptors.put(await source.service._visualLayerDescriptors.get(digest));
        const imported = await target.service.importRunBundle(bundle);
        assert.match(imported.environment.id, /^yard-[a-f0-9]{8}$/);
        const importedEnv = await target.service.getEnvironment(imported.environment.id);
        assert.notEqual(importedEnv.visualLayer.descriptorHash, digest);
        assert.equal(importedEnv.evidence, null);
        const rebound = await target.service._visualLayerDescriptors.get(importedEnv.visualLayer.descriptorHash);
        assert.equal(rebound.sourceWorldHash, createWorldResource(importedEnv).hash);
    } finally {
        await fs.rm(source.dir, { recursive: true, force: true });
        await fs.rm(target.dir, { recursive: true, force: true });
    }
});

test("invalid bindings and missing descriptors fail before environment mutation", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const seeded = await service.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard") },
            expectedRevision: created.revision,
        });
        const bad = boundLayerFor(createWorldResource(seeded).hash);
        const digest = await service._visualLayerDescriptors.put(bad);
        const referenced = await service.putEnvironment("yard", {
            manifest: { ...seeded, visualLayer: { descriptorHash: digest } },
            expectedRevision: seeded.revision,
        });
        await assert.rejects(
            () => service.duplicateEnvironment("yard", {
                id: "yard-copy",
                expectedRevision: referenced.revision,
            }),
            /missing truth entity/,
        );
        assert.equal(await service.getEnvironment("yard-copy"), null);
        assert.equal((await service.getEnvironment("yard")).revision, referenced.revision);

        const missing = await service.createEnvironment({ id: "field", name: "Field" });
        const dangling = await service.putEnvironment("field", {
            manifest: { ...missing, visualLayer: { descriptorHash: "f".repeat(64) } },
            expectedRevision: missing.revision,
        });
        await assert.rejects(
            () => service.duplicateEnvironment("field", {
                id: "field-copy",
                expectedRevision: dangling.revision,
            }),
            /missing/,
        );
        assert.equal(await service.getEnvironment("field-copy"), null);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("interrupted id-change journals leave the source intact or finish the move", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const journalDir = path.join(dir, "environment-transactions");
        await fs.mkdir(journalDir, { recursive: true });
        const prepared = serializeEnvironmentManifestV3({ ...created, environmentId: "yard-moved", name: "Moved" }, {
            environmentId: "yard-moved",
            revision: 1,
            current: created,
        });
        await fs.writeFile(path.join(journalDir, encodeURIComponent("yard") + "--" + encodeURIComponent("yard-moved") + ".json"), JSON.stringify({
            kind: "cev-sim.environment-id-change",
            version: 1,
            sourceId: "yard",
            destinationId: "yard-moved",
            descriptorHash: null,
            destinationManifest: prepared,
            phase: "prepared",
        }));
        const recovered = await service.getEnvironment("yard");
        assert.equal(recovered.environmentId, "yard");
        assert.equal(await service.getEnvironment("yard-moved"), null);

        const published = await service.createEnvironment({ id: "field", name: "Field" });
        await fs.writeFile(path.join(dir, "environments", "field-moved.json"), JSON.stringify({
            ...published,
            environmentId: "field-moved",
            revision: 1,
        }, null, 2));
        await fs.writeFile(path.join(journalDir, encodeURIComponent("field") + "--" + encodeURIComponent("field-moved") + ".json"), JSON.stringify({
            kind: "cev-sim.environment-id-change",
            version: 1,
            sourceId: "field",
            destinationId: "field-moved",
            descriptorHash: null,
            destinationManifest: { ...published, environmentId: "field-moved", revision: 1 },
            phase: "destination-published",
        }));
        assert.equal(await service.getEnvironment("field"), null);
        assert.equal((await service.getEnvironment("field-moved")).environmentId, "field-moved");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("catalog and MCP summaries include revision", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard" });
        const catalog = await service.listEnvironments();
        assert.equal(catalog.find((entry) => entry.id === "igvc").revision, 0);
        assert.equal(catalog.find((entry) => entry.id === "yard").revision, created.revision);
        // The explicit V3 alias still writes v3 for a v3 manifest; a stored v4 file stays v4 (sticky).
        const { objects: _objects, objectGraphVersion: _graphVersion, ...v3Document } = created.document;
        const serialized = serializeEnvironmentManifestV3({ ...created, schemaVersion: 3, document: v3Document }, { environmentId: "yard", revision: 2, current: null });
        assert.equal(serialized.schemaVersion, 3);
        assert.equal(serializeEnvironmentManifestV3(created, { environmentId: "yard", revision: 2, current: created }).schemaVersion, 4);
        assert.equal(canonicalExactStringify(layerFor("c".repeat(64))).includes("sourceWorldHash"), true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
