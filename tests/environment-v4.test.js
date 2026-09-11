import assert from "node:assert/strict";
import test from "node:test";

import {
    generateEnvironmentEditorBaseline,
    readEnvironmentEditorFixture,
} from "./helpers/environmentEditorBaseline.js";

test("ED-01 compatibility baseline: world, road-network, and lidar hashes are unchanged", async () => {
    const expected = await readEnvironmentEditorFixture("compatibility-baseline.v1.json");
    const actual = await generateEnvironmentEditorBaseline();
    assert.equal(actual.kind, expected.kind);
    assert.equal(actual.version, expected.version);
    assert.deepEqual(actual.placementCatalog, expected.placementCatalog);
    assert.deepEqual(actual.cases.map((entry) => entry.id), expected.cases.map((entry) => entry.id));
    for (const [index, entry] of actual.cases.entries()) {
        assert.deepEqual(entry, expected.cases[index], `baseline case ${entry.id} drifted`);
    }
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { addFeature, removeFeature } from "../app/3d/editor/document/documentMutations.js";
import { deriveObjectGraph, objectTypeRegistry, reconcileObjectGraph } from "../app/3d/editor/objects/index.js";
import {
    ENVIRONMENT_OBJECT_SCHEMA_VERSION,
    ENVIRONMENT_SCHEMA_VERSION,
    ENVIRONMENT_SUPPORTED_SCHEMA_VERSIONS,
    assertNoObjectGraphDowngrade,
    presentEnvironmentObjectGraph,
    presentStoredEnvironment,
    readSchemaVersion,
    resolveEnvironmentWriteSchemaVersion,
    serializeEnvironmentManifest,
    serializeEnvironmentManifestV3,
} from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { registerEnvironmentTools, loadDocument, saveDocument } from "../server/mcp/environmentTools.js";
import {
    ENVIRONMENT_OBJECT_GRAPH_INVALID,
    ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED,
    ENVIRONMENT_SCHEMA_DOWNGRADE,
} from "../server/storage/StorageErrors.js";
import { StorageService } from "../server/storage/StorageService.js";

async function tempService(options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-env-v4-"));
    return { dir, service: new StorageService(dir, options) };
}

async function seedFile(dir, id, manifest) {
    await fs.mkdir(path.join(dir, "environments"), { recursive: true });
    await fs.writeFile(path.join(dir, "environments", `${id}.json`), JSON.stringify(manifest, null, 2));
}

async function readDisk(dir, id) {
    return JSON.parse(await fs.readFile(path.join(dir, "environments", `${id}.json`), "utf8"));
}

function mcpTools(storage) {
    const tools = new Map();
    registerEnvironmentTools({ registerTool(name, _definition, handler) { tools.set(name, handler); } }, storage);
    return (name, args) => tools.get(name)(args).then((result) => ({ ...JSON.parse(result.content[0].text), isError: result.isError === true }));
}

test("ED-01 schema versions 2, 3, and 4 present; other versions are rejected on read and write", async () => {
    assert.deepEqual([...ENVIRONMENT_SUPPORTED_SCHEMA_VERSIONS], [2, 3, 4]);
    assert.equal(ENVIRONMENT_SCHEMA_VERSION, 3);
    assert.equal(ENVIRONMENT_OBJECT_SCHEMA_VERSION, 4);
    assert.equal(readSchemaVersion({}), 2);
    assert.equal(readSchemaVersion({ schemaVersion: 4 }), 4);
    assert.throws(() => readSchemaVersion({ schemaVersion: 5 }), /Unsupported environment schema version 5/);
    assert.throws(() => presentStoredEnvironment({ environmentId: "x", schemaVersion: 9 }, "x"), /Unsupported/);
    assert.throws(() => serializeEnvironmentManifest({ environmentId: "x", schemaVersion: 1 }, { environmentId: "x", revision: 1 }), /Unsupported/);

    const sample = await readEnvironmentEditorFixture("schema-v4.sample.json");
    const presented = presentStoredEnvironment(sample, sample.environmentId);
    assert.equal(presented.schemaVersion, 4);
    assert.equal(presented.revision, 5);
    assert.equal(presented.document.objects.length, sample.document.objects.length);
    assert.equal(presented.document.objects.find((entry) => entry.id === "vendor-thing-1").components.opaque.payload.length, 3);

    const legacy = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const presentedLegacy = presentStoredEnvironment(legacy, "yard");
    assert.equal(Object.hasOwn(presentedLegacy.document, "objects"), false, "v2 read views never inject the graph");
    assert.equal(presentEnvironmentObjectGraph(presentedLegacy).length, 13);
    assert.equal(presentEnvironmentObjectGraph(sample).length, sample.document.objects.length);
});

test("ED-01 write version resolution is sticky for v4 files and the downgrade guard keys on document.objects", () => {
    assert.equal(resolveEnvironmentWriteSchemaVersion(3, null), 3);
    assert.equal(resolveEnvironmentWriteSchemaVersion(4, null), 4);
    assert.equal(resolveEnvironmentWriteSchemaVersion(7, null), 3);
    assert.equal(resolveEnvironmentWriteSchemaVersion(3, { schemaVersion: 4 }), 4);
    assert.equal(resolveEnvironmentWriteSchemaVersion(4, { schemaVersion: 2 }), 4);

    const current = { environmentId: "yard", schemaVersion: 4, revision: 3, document: { objects: [{ id: "skybox", typeId: "skybox" }] } };
    assert.doesNotThrow(() => assertNoObjectGraphDowngrade({ name: "Renamed" }, current));
    assert.doesNotThrow(() => assertNoObjectGraphDowngrade({ schemaVersion: 3, document: { objects: [] } }, current));
    assert.doesNotThrow(() => assertNoObjectGraphDowngrade({ document: {} }, { ...current, schemaVersion: 3 }));
    assert.doesNotThrow(() => assertNoObjectGraphDowngrade({ document: {} }, { ...current, document: { objects: [] } }));
    assert.throws(
        () => assertNoObjectGraphDowngrade({ schemaVersion: 3, document: { features: [] } }, current, "yard"),
        (error) => error.code === ENVIRONMENT_SCHEMA_DOWNGRADE && error.statusCode === 409
            && error.storedSchemaVersion === 4 && error.incomingSchemaVersion === 3 && error.currentRevision === 3,
    );
});

test("ED-01 default writer keeps v3 on disk and strips a client-supplied object graph", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const legacy = await readEnvironmentEditorFixture("legacy-v2.yard.json");
        const document = { ...legacy.document, objectGraphVersion: 1, objects: deriveObjectGraph(legacy.document) };
        const saved = await service.putEnvironment("yard", {
            manifest: { ...created, ...legacy, schemaVersion: 3, document },
            expectedRevision: created.revision,
        });
        assert.equal(saved.schemaVersion, 3);
        assert.equal(Object.hasOwn(saved.document, "objects"), false);
        assert.equal(Object.hasOwn(saved.document, "objectGraphVersion"), false);
        const onDisk = await readDisk(dir, "yard");
        assert.equal(onDisk.schemaVersion, 3);
        assert.equal(Object.hasOwn(onDisk.document, "objects"), false);
        assert.equal(createWorldResource(onDisk).hash, createWorldResource({ ...legacy, document }).hash);
        assert.equal(serializeEnvironmentManifestV3(saved, { environmentId: "yard", revision: 9, current: saved }).schemaVersion, 3);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-01 flagged writer upgrades a v2 file to v4 with a derived graph, unchanged worldHash, and a write-once pre-v4 copy", async () => {
    const { dir, service } = await tempService({ environmentSchemaVersion: 4 });
    try {
        const legacy = await readEnvironmentEditorFixture("legacy-v2.yard.json");
        await seedFile(dir, "yard", legacy);
        const loaded = await service.getEnvironment("yard");
        assert.equal(loaded.schemaVersion, 2);
        assert.equal(Object.hasOwn(loaded.document, "objects"), false);
        const beforeHash = createWorldResource(loaded).hash;

        const saved = await service.putEnvironment("yard", { manifest: loaded, expectedRevision: 0 });
        assert.equal(saved.schemaVersion, 4);
        assert.equal(saved.revision, 1);
        assert.equal(saved.document.objectGraphVersion, 1);
        assert.equal(saved.document.objects.length, 13);
        assert.deepEqual(saved.document.objects.map((entry) => entry.typeId).filter((typeId) => typeId === "intersection").length, 2);
        assert.equal("clientRevision" in saved, false);
        assert.equal(createWorldResource(saved).hash, beforeHash);

        const onDisk = await readDisk(dir, "yard");
        assert.equal(onDisk.schemaVersion, 4);
        assert.equal(onDisk.document.objects.length, 13);

        const copyPath = path.join(dir, "environment-migrations", "yard.pre-v4.json");
        const copy = JSON.parse(await fs.readFile(copyPath, "utf8"));
        assert.equal(copy.kind, "cev-sim.environment-pre-migration");
        assert.equal(copy.fromSchemaVersion, 2);
        assert.equal(copy.toSchemaVersion, 4);
        assert.equal(copy.revision, 0);
        assert.equal(copy.manifest.schemaVersion, 2);
        assert.equal(copy.manifest.clientRevision, 7);

        // A later save does not replace the first copy, and the copy is invisible to the catalog.
        const renamed = await service.putEnvironment("yard", { manifest: { ...saved, name: "North Yard" }, expectedRevision: 1 });
        assert.equal(renamed.schemaVersion, 4);
        assert.deepEqual(JSON.parse(await fs.readFile(copyPath, "utf8")), copy);
        const catalog = await service.listEnvironments();
        assert.deepEqual(catalog.map((entry) => entry.id).sort(), ["igvc", "yard"]);
        assert.equal((await service.getEnvironment("yard")).name, "North Yard");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-01 flagged writer preserves incoming groups and unknown types and reconciles legacy mutations", async () => {
    const { dir, service } = await tempService({ environmentSchemaVersion: 4 });
    try {
        const sample = await readEnvironmentEditorFixture("schema-v4.sample.json");
        const created = await service.createEnvironment({ id: "sample", name: "Sample", templateId: "blank" });
        const saved = await service.putEnvironment("sample", {
            manifest: { ...created, ...sample, environmentId: "sample", document: { ...sample.document, environmentId: "sample" } },
            expectedRevision: created.revision,
        });
        assert.equal(saved.schemaVersion, 4);
        const byId = new Map(saved.document.objects.map((entry) => [entry.id, entry]));
        assert.equal(byId.get("group-course-a").typeId, "group");
        assert.equal(byId.get("prop-cone").parentId, "group-course-a");
        assert.equal(byId.get("prop-cone").name, "Entry cone");
        assert.deepEqual(byId.get("vendor-thing-1"), sample.document.objects.find((entry) => entry.id === "vendor-thing-1"));

        // A legacy-only mutation (new feature, removed feature) is reconciled on write.
        const document = EnvironmentDocument.fromManifest(saved.document);
        const added = addFeature(document, { type: "tire", x: 1, z: 1, tags: ["tire"] });
        assert.equal(added.ok, true);
        assert.equal(removeFeature(document, "prop-barrel").ok, true);
        const next = await service.putEnvironment("sample", {
            manifest: { ...saved, document: document.toManifest() },
            expectedRevision: saved.revision,
        });
        const nextIds = next.document.objects.map((entry) => entry.id);
        assert.ok(nextIds.includes(added.record.id));
        assert.ok(!nextIds.includes("prop-barrel"));
        assert.ok(nextIds.includes("group-course-a"));
        assert.ok(nextIds.includes("vendor-thing-1"));
        assert.equal(next.document.objects.find((entry) => entry.id === added.record.id).typeId, "builtin-prop");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-01 invalid graphs are rejected atomically with ENVIRONMENT_OBJECT_GRAPH_INVALID and structured issues", async () => {
    const { dir, service } = await tempService({ environmentSchemaVersion: 4 });
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const objects = [
            ...deriveObjectGraph(created.document),
            { id: "a", typeId: "group", typeVersion: 1, name: "A", parentId: "b", order: 10, components: {} },
            { id: "b", typeId: "group", typeVersion: 1, name: "B", parentId: "a", order: 11, components: {} },
        ];
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: { ...created, document: { ...created.document, objects } },
                expectedRevision: created.revision,
            }),
            (error) => {
                assert.equal(error.code, ENVIRONMENT_OBJECT_GRAPH_INVALID);
                assert.equal(error.statusCode, 400);
                assert.deepEqual([...new Set(error.issues.map((issue) => issue.code))], ["object.parent.cycle"]);
                assert.deepEqual(Object.keys(error.toJSON()).sort(), ["code", "error", "issues"]);
                return true;
            },
        );
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.revision, created.revision);
        // A flagged service creates v4 files directly; a rejected write leaves them untouched.
        assert.equal(stored.schemaVersion, 4);
        assert.deepEqual(stored.document.objects, created.document.objects);
        assert.equal(await fs.access(path.join(dir, "environment-migrations")).then(() => true, () => false), false, "no upgrade happened, so no pre-migration copy");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("ED-01 an old-client write without document.objects over a v4 file is rejected and v4 files stay v4 when the flag is off", async () => {
    const flagged = await tempService({ environmentSchemaVersion: 4 });
    try {
        const legacy = await readEnvironmentEditorFixture("legacy-v2.yard.json");
        await seedFile(flagged.dir, "yard", legacy);
        const upgraded = await flagged.service.putEnvironment("yard", { manifest: await flagged.service.getEnvironment("yard"), expectedRevision: 0 });
        assert.equal(upgraded.schemaVersion, 4);

        // Same data directory, flag cleared: reads still work and writes stay v4.
        const unflagged = new StorageService(flagged.dir);
        const loaded = await unflagged.getEnvironment("yard");
        assert.equal(loaded.schemaVersion, 4);
        assert.equal(loaded.document.objects.length, 13);

        const { objects: _dropped, objectGraphVersion: _version, ...oldClientDocument } = loaded.document;
        await assert.rejects(
            () => unflagged.putEnvironment("yard", {
                manifest: { ...loaded, schemaVersion: 3, document: oldClientDocument },
                expectedRevision: loaded.revision,
            }),
            (error) => error.code === ENVIRONMENT_SCHEMA_DOWNGRADE && error.statusCode === 409
                && error.currentRevision === loaded.revision && error.toJSON().storedSchemaVersion === 4,
        );
        assert.equal((await unflagged.getEnvironment("yard")).revision, loaded.revision);

        // Graph-aware clients still declare v3 in ED-01; they are accepted and the file stays v4.
        const graphAware = await unflagged.putEnvironment("yard", {
            manifest: { ...loaded, schemaVersion: 3, name: "Aware" },
            expectedRevision: loaded.revision,
        });
        assert.equal(graphAware.schemaVersion, 4);
        assert.equal(graphAware.document.objects.length, 13);

        // Rename-style writes that omit the document pass and keep the graph.
        const renamed = await unflagged.renameEnvironment("yard", { name: "Yard 2", expectedRevision: graphAware.revision });
        assert.equal(renamed.schemaVersion, 4);
        assert.equal((await readDisk(flagged.dir, "yard")).document.objects.length, 13);
    } finally {
        await fs.rm(flagged.dir, { recursive: true, force: true });
    }
});

test("ED-01 loader-style restore preserves objects from the stored document and reconciles new legacy records", async () => {
    const sample = await readEnvironmentEditorFixture("schema-v4.sample.json");
    const world = createWorldResource(sample);
    const description = world.description;
    // Mirror EnvironmentLoader.apply: geometry from the world description, overlay from the stored document.
    const restored = {
        environmentId: description.environmentId,
        roads: structuredClone(description.roads),
        buildings: description.buildings.map((building) => ({
            buildingId: building.id,
            footprint: structuredClone(building.footprint),
            height: building.height,
            textureId: building.textureId,
            tags: [...building.tags],
            meshName: building.meshName,
        })),
        features: [
            ...description.features.map((feature) => ({
                id: feature.id,
                type: feature.type,
                x: feature.transform.position.x,
                z: feature.transform.position.z,
                dir: feature.dir,
                rotationY: feature.rotationY,
                tags: [...feature.tags],
            })),
            { id: "prop-late", type: "cone", x: 9, z: 9, dir: 0, rotationY: 0, tags: ["cone"] },
        ],
        earth: sample.document.earth,
    };
    const graph = reconcileObjectGraph(restored, sample.document.objects, objectTypeRegistry, { sky: sample.sky });
    assert.deepEqual(graph.orphaned, []);
    assert.deepEqual(graph.added, ["prop-late"]);
    const document = new EnvironmentDocument();
    document.restoreSnapshot({ ...restored, objects: graph.records });
    assert.equal(document.getObject("group-course-a").typeId, "group");
    assert.equal(document.getObject("prop-cone").parentId, "group-course-a");
    assert.equal(document.getObject("vendor-thing-1").typeVersion, 3);
    assert.equal(document.getObject("prop-late").typeId, "builtin-prop");
    assert.equal(createWorldResource({ ...sample, document: document.snapshot() }).hash !== world.hash, true, "the new feature changes the world");
    assert.equal(createWorldResource({ ...sample, document: { ...document.snapshot(), features: restored.features.slice(0, -1) } }).hash, world.hash);
});

test("ED-01 MCP tools round-trip a v4 document, validate the graph, and list object types", async () => {
    const { dir, service } = await tempService({ environmentSchemaVersion: 4 });
    try {
        const call = mcpTools(service);
        await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        const added = await call("environment_add_object", { environmentId: "yard", type: "cone", x: 1, z: 2 });
        assert.equal(added.ok, true);
        const reloaded = await service.getEnvironment("yard");
        assert.equal(reloaded.schemaVersion, 4);
        assert.deepEqual(reloaded.document.objects.map((entry) => entry.typeId), ["skybox", "builtin-prop"]);
        assert.equal(reloaded.document.objects[1].id, added.feature.id);

        const unknown = await call("environment_add_object", { environmentId: "yard", type: "lamp", x: 0, z: 0 });
        assert.equal(unknown.isError, true);
        assert.equal(unknown.code, ENVIRONMENT_OBJECT_TYPE_UNSUPPORTED);
        assert.match(unknown.error, /Valid: stop-sign, one-way-sign, barrel, tire, cone/);

        const summary = await call("environment_get", { environmentId: "yard" });
        assert.deepEqual(summary.objectTypes.map((entry) => entry.typeId), ["asset-instance", "building", "builtin-prop", "group", "intersection", "road", "skybox", "tile"]);
        assert.equal(summary.objectTypes.find((entry) => entry.typeId === "builtin-prop").legacyDomain, "features");
        assert.ok(summary.placementCatalog.some((asset) => asset.id === "cone"));

        const validation = await call("environment_validate", { environmentId: "yard" });
        assert.equal(validation.ok, true);
        assert.equal(validation.objectGraphOk, true);
        assert.equal(validation.issueCount, 0);
        assert.equal(validation.conflictCount, 0);

        // Removing through MCP drops the orphaned overlay record.
        const removed = await call("environment_remove_object", { environmentId: "yard", featureId: added.feature.id });
        assert.equal(removed.ok, true);
        assert.deepEqual((await service.getEnvironment("yard")).document.objects.map((entry) => entry.id), ["skybox"]);

        // loadDocument/saveDocument keep unknown types intact.
        const { manifest, document } = await loadDocument(service, "yard");
        document.replaceObjectGraph([...document.objects, { id: "v", typeId: "vendor.thing", typeVersion: 2, order: 5, components: { opaque: 1 } }]);
        await saveDocument(service, "yard", manifest, document);
        const withVendor = await service.getEnvironment("yard");
        assert.equal(withVendor.document.objects.find((entry) => entry.id === "v").components.opaque, 1);
        const flagged = await call("environment_validate", { environmentId: "yard" });
        assert.equal(flagged.objectGraphOk, true);
        assert.deepEqual(flagged.issues.map((issue) => issue.code), ["object.type.unsupported"]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
