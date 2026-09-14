import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import * as objectCommands from "../app/3d/editor/commands/objectCommands.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import { createBuiltinObjectTypeRegistry } from "../app/3d/editor/objects/builtinObjectTypes.js";
import { deriveObjectGraph, OBJECT_ISSUE_CODES } from "../app/3d/editor/objects/objectGraph.js";
import { defineObjectType } from "../app/3d/editor/objects/ObjectTypeRegistry.js";
import {
    createEditorPresentationRegistry,
    MENU_OPTION_IDS,
    SECTION_IDS,
} from "../app/3d/editor/presentation/EditorPresentationRegistry.js";
import { buildHierarchyTree } from "../app/3d/editor/presentation/hierarchyModel.js";
import { SceneProjector } from "../app/3d/editor/projection/SceneProjector.js";
import { entityIdForObject } from "../app/3d/editor/selection/selectionIds.js";
import { createLidarGeometryResource } from "../app/simulation/lidar/LidarGeometry.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { environmentEditorBaselineCases, readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";
import { createTestMarkerType, TestMarkerOptions, TEST_MARKER_TYPE_ID } from "./helpers/testMarkerType.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

async function javascriptFilesUnder(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) files.push(...await javascriptFilesUnder(child));
        else if (/\.[cm]?js$/.test(entry.name)) files.push(child);
    }
    return files;
}

function metricWorldFixture() {
    const definition = createEmptyAssetDefinition({ modelUseHash: "a".repeat(64), name: "Body" });
    const proxy = {
        id: "proxy",
        kind: "box",
        enabled: true,
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [2, 2, 2],
    };
    definition.collisionProxies.push(proxy);
    definition.lidarProxies.push({ ...structuredClone(proxy), semantic: "unknown" });
    const compiled = compileAssetDefinition(definition, {
        sourceGeometries: { source: { 0: { vertices: [[-1, 0, -1], [1, 0, -1], [0, 2, 0]], triangles: [[0, 1, 2]] } } },
    });
    return {
        environmentId: "metric-world",
        templateId: "blank",
        document: {
            environmentId: "metric-world",
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
            objects: [{
                id: "crate",
                typeId: "asset-instance",
                typeVersion: 2,
                name: "Crate",
                parentId: null,
                order: 0,
                components: {
                    tags: [], locked: false, editorHidden: false,
                    asset: { assetId: "crate", revision: 1, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, overrides: {} },
                },
            }],
            assetMetrics: { version: 1, definitions: [{ assetId: "crate", revision: 1, metricHash: compiled.metricHash, collision: compiled.metric.collision, lidar: compiled.metric.lidar }] },
        },
    };
}

async function yardWithMarkerRegistry() {
    const objectRegistry = createBuiltinObjectTypeRegistry();
    objectRegistry.register(createTestMarkerType());
    const yard = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(yard.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document, registry: objectRegistry });
    const presentation = createEditorPresentationRegistry({ objectRegistry });
    const registry = new EnvironmentRegistry();
    const projector = new SceneProjector({
        data: { simulation: () => ({ render() {} }) },
        scene: {},
        document,
        registry,
        runtime: { objectRegistry },
    }).attach();
    return { objectRegistry, yard, document, service, presentation, registry, projector };
}

test("ED-09 a registered overlay type is created, inspected, projected, and undone without production edits", async () => {
    const { yard, document, service, presentation, registry } = await yardWithMarkerRegistry();
    const loaded = {
        environmentId: yard.environmentId ?? "yard",
        schemaVersion: 4,
        document: document.toManifest(),
    };
    const beforeHash = createWorldResource(loaded).hash;

    const created = service.run("createObject", {
        typeId: TEST_MARKER_TYPE_ID,
        input: { label: "start", radius: 2.5 },
        name: "Start marker",
    });
    assert.equal(created.ok, true, JSON.stringify(created.issues));
    const objectId = created.result.objectId;
    const record = document.getObject(objectId);
    assert.equal(record.typeId, TEST_MARKER_TYPE_ID);
    assert.deepEqual(record.components.marker, { label: "start", radius: 2.5 });

    const tree = buildHierarchyTree(document.objects, { presentation });
    assert.ok(tree.some((node) => node.id === objectId));
    const sections = presentation.forRecord(record).getInspectorSections({ record, document });
    assert.deepEqual(sections.map((section) => section.id), [SECTION_IDS.OBJECT, SECTION_IDS.OPTIONS]);
    assert.equal(sections[1].kind, "options");
    assert.equal(sections[1].values.radius, 2.5);

    const patched = service.run("setObjectOptions", { objectId, patch: { radius: 3 } });
    assert.equal(patched.ok, true, JSON.stringify(patched.issues));
    assert.equal(document.getObject(objectId).components.marker.radius, 3);

    const beforeReject = structuredClone(document.snapshot());
    const rejected = service.run("setObjectOptions", { objectId, patch: { radius: 50 } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.issues[0].code, "option.range");
    assert.deepEqual(document.snapshot(), beforeReject);

    const entity = registry.getEntity(`overlay-metric:${objectId}`);
    assert.ok(entity);
    assert.equal(entity.kind, "overlay-metric");
    assert.equal(entity.editorOnly, true);
    assert.deepEqual(entity.record, { shape: "sphere", radius: 3 });

    const withMarker = {
        environmentId: yard.environmentId ?? "yard",
        schemaVersion: 4,
        document: document.toManifest(),
    };
    assert.equal(createWorldResource(withMarker).hash, beforeHash);

    const grouped = service.run("groupObjects", { objectIds: [objectId], name: "Markers" });
    assert.equal(grouped.ok, true, JSON.stringify(grouped.issues));
    const groupId = grouped.result.groupId;
    assert.equal(service.run("reparentObjects", { objectIds: [objectId], parentId: null }).ok, true);
    assert.equal(document.getObject(objectId).parentId, null);

    const duplicated = service.run("duplicateObjects", { objectIds: [objectId] });
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated.issues));
    const copyId = duplicated.result.rootIds[0];
    assert.equal(document.getObject(copyId).typeId, TEST_MARKER_TYPE_ID);
    assert.deepEqual(document.getObject(copyId).components.marker, { label: "start", radius: 3 });

    assert.equal(service.run("deleteObjects", { objectIds: [copyId] }).ok, true);
    assert.equal(document.getObject(copyId), null);
    assert.equal(registry.getEntity(`overlay-metric:${copyId}`), null);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.getObject(copyId).typeId, TEST_MARKER_TYPE_ID);

    assert.equal(service.run("deleteObjects", { objectIds: [groupId] }).ok, true);

    const missing = service.run("createObject", { typeId: "vendor.thing", input: { name: "Thing" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.issues[0].code, OBJECT_ISSUE_CODES.TYPE_UNSUPPORTED);
    assert.equal(document.objects.some((entry) => entry.typeId === "vendor.thing"), false);

    for (const root of [new URL("../app/", import.meta.url), new URL("../server/", import.meta.url)]) {
        for (const file of await javascriptFilesUnder(root)) {
            assert.equal(/test\.marker|tests\/helpers\/testMarkerType/.test(await readFile(file, "utf8")), false, `${file.pathname} must not register or import test.marker`);
        }
    }
});

test("ED-09 overlay metrics stay outside registry persistence, world descriptions, and LiDAR resources", async () => {
    for (const entry of [...await environmentEditorBaselineCases(), { id: "asset-metric-v3", manifest: metricWorldFixture() }]) {
        const beforeWorld = createWorldResource(entry.manifest);
        const beforeLidar = createLidarGeometryResource(beforeWorld);
        const marker = {
            id: `marker-${entry.id}`,
            typeId: TEST_MARKER_TYPE_ID,
            typeVersion: 1,
            name: "Audit marker",
            parentId: null,
            order: 999,
            components: { tags: [], locked: false, editorHidden: false, marker: { label: "audit", radius: 4 } },
        };
        const withMarker = structuredClone(entry.manifest);
        withMarker.document = { ...(withMarker.document ?? {}), objects: [...(withMarker.document?.objects ?? []), marker] };
        const afterWorld = createWorldResource(withMarker);
        assert.deepEqual(afterWorld, beforeWorld, `${entry.id} world resource changed`);
        assert.deepEqual(createLidarGeometryResource(afterWorld), beforeLidar, `${entry.id} LiDAR resource changed`);
    }

    const chunkAssignments = [];
    const persistenceEvents = [];
    const registry = new EnvironmentRegistry({ chunkManager: { assignEntity(entity) { chunkAssignments.push(entity.id); return null; } } });
    registry.subscribe((_snapshot, event) => persistenceEvents.push(event.affectsPersistence));
    const objectRegistry = createBuiltinObjectTypeRegistry();
    objectRegistry.register(createTestMarkerType());
    objectRegistry.register(createTestMarkerType({ typeId: "test.null-metric", compileMetric: () => null }));
    const document = EnvironmentDocument.fromManifest({ environmentId: "overlay-reload", roads: { nodes: [], edges: [] }, buildings: [], features: [], objectGraphVersion: 1, objects: [] });
    const service = createEnvironmentCommandService({ document, registry: objectRegistry });
    assert.equal(service.run("createObject", { typeId: TEST_MARKER_TYPE_ID, id: "persisted-marker", input: { radius: 2 } }).ok, true);
    const projector = new SceneProjector({ data: { simulation: () => ({ render() {} }) }, scene: {}, document, registry, runtime: { objectRegistry } }).attach();

    assert.equal(registry.getEntity("overlay-metric:persisted-marker"), null, "attach alone ignores full-load notifications");
    projector.syncOverlayMetrics();
    const projected = registry.getEntity("overlay-metric:persisted-marker");
    assert.equal(projected.editorOnly, true);
    assert.equal(projected.kind, "overlay-metric");
    assert.equal(entityIdForObject(document.getObject("persisted-marker"), registry), null);
    assert.equal(Object.hasOwn(registry.toManifest().objects, "overlay-metric:persisted-marker"), false);
    assert.deepEqual(chunkAssignments, [], "editor-only metrics never enter chunk assignment");
    assert.equal(persistenceEvents.at(-1), false);

    assert.equal(service.run("createObject", { typeId: "test.null-metric", id: "no-metric" }).ok, true);
    assert.equal(registry.getEntity("overlay-metric:no-metric"), null);
    projector.applyChanges({ domains: { objects: { before: new Map(), after: new Map([["persisted-marker", { ...document.getObject("persisted-marker"), typeId: "road" }]]) } } });
    assert.equal(registry.getEntity("overlay-metric:persisted-marker"), null, "legacy-backed replacement removes the stale overlay entity");
    projector.syncOverlayMetrics();
    assert.ok(registry.getEntity("overlay-metric:persisted-marker"));
    projector.dispose();
    assert.equal(registry.getEntity("overlay-metric:persisted-marker"), null);
    assert.equal(registry.getEntity("overlay-metric:no-metric"), null);
});

test("ED-09 createObject and generic duplicate reject unsupported capability intersections atomically", async () => {
    const objectRegistry = createBuiltinObjectTypeRegistry();
    objectRegistry.register(createTestMarkerType());
    objectRegistry.register(createTestMarkerType({
        typeId: "test.conditional",
        getCapabilities: (record) => ({ selectable: true, deletable: true, groupable: record?.components?.marker?.label === "allowed", hasOptions: true }),
    }));
    objectRegistry.register(createTestMarkerType({ typeId: "test.non-deletable", capabilities: { deletable: false } }));
    objectRegistry.register(createTestMarkerType({ typeId: "test.singleton", singleton: "only-one" }));
    objectRegistry.register(defineObjectType({
        typeId: "test.unavailable",
        version: 1,
        label: "Unavailable",
        catalog: { label: "Unavailable", kind: "marker", layer: "props" },
        legacy: null,
        options: new TestMarkerOptions(),
        components: ["marker"],
    }));
    const document = EnvironmentDocument.fromManifest({ environmentId: "create-audit", roads: { nodes: [], edges: [] }, buildings: [], features: [], objectGraphVersion: 1, objects: deriveObjectGraph({ roads: { nodes: [], edges: [] }, buildings: [], features: [] }) });
    const service = createEnvironmentCommandService({ document, registry: objectRegistry });
    const group = service.run("createObject", { typeId: "group", id: "markers", name: "Markers" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const blockedGroup = service.run("createObject", { typeId: "group", id: "blocked", name: "Blocked" });
    assert.equal(blockedGroup.ok, true, JSON.stringify(blockedGroup.issues));

    const rejectUnchanged = (result, before, historyLength, code) => {
        assert.equal(result.ok, false);
        assert.equal(result.changeSet, null);
        if (code) assert.equal(result.issues[0].code, code);
        assert.deepEqual(document.snapshot(), before);
        assert.equal(service.bus.history.length, historyLength);
    };
    for (const args of [
        {},
        { typeId: "vendor.thing" },
        { typeId: TEST_MARKER_TYPE_ID, id: "markers" },
        { typeId: TEST_MARKER_TYPE_ID, parentId: "missing" },
        { typeId: TEST_MARKER_TYPE_ID, parentId: "skybox" },
        { typeId: TEST_MARKER_TYPE_ID, input: { radius: 50 } },
        { typeId: "test.unavailable" },
        { typeId: "test.conditional", parentId: "markers", input: { label: "denied" } },
    ]) {
        const before = structuredClone(document.snapshot());
        const historyLength = service.bus.history.length;
        rejectUnchanged(service.run("createObject", args), before, historyLength);
    }
    const conditional = service.run("createObject", { typeId: "test.conditional", id: "conditional", parentId: "markers", input: { label: "allowed", radius: 2 } });
    assert.equal(conditional.ok, true, JSON.stringify(conditional.issues));
    assert.equal(document.getObject("conditional").parentId, "markers");
    assert.equal(service.run("createObject", { typeId: TEST_MARKER_TYPE_ID, id: "ordinary", input: { label: "original", radius: 3 } }).ok, true);
    assert.equal(service.run("createObject", { typeId: "test.non-deletable", id: "fixed", parentId: "blocked" }).ok, true);
    assert.equal(service.run("createObject", { typeId: "test.singleton", id: "singleton" }).ok, true);

    for (const ids of [["fixed"], ["singleton"], ["ordinary", "fixed"]]) {
        const before = structuredClone(document.snapshot());
        const historyLength = service.bus.history.length;
        rejectUnchanged(service.run("duplicateObjects", { objectIds: ids }), before, historyLength, "command.duplicate.unsupported");
    }

    const duplicated = service.run("duplicateObjects", { objectIds: ["ordinary"] });
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated.issues));
    assert.equal(service.bus.history.length > 0, true);
    const copy = document.getObject(duplicated.result.rootIds[0]);
    assert.equal(copy.typeVersion, document.getObject("ordinary").typeVersion);
    assert.deepEqual(copy.components, document.getObject("ordinary").components);
    assert.notEqual(copy.components, document.getObject("ordinary").components);
    const rootOrders = document.objects.filter((record) => record.parentId === null).map((record) => record.order).sort((a, b) => a - b);
    assert.deepEqual(rootOrders, rootOrders.map((_order, index) => index), "root order remains dense");

    const presentation = createEditorPresentationRegistry({ objectRegistry });
    for (const id of ["fixed", "singleton"]) {
        const record = document.getObject(id);
        const duplicate = presentation.forRecord(record).getMenuOptions({ record, records: [record], document, commands: objectCommands, bus: service.bus }).find((option) => option.id === MENU_OPTION_IDS.DUPLICATE);
        assert.equal(duplicate.disabled, true, `${id} duplicate menu agrees with the command`);
    }
    const blockedRecord = document.getObject("blocked");
    const blockedDuplicate = presentation.forRecord(blockedRecord).getMenuOptions({ record: blockedRecord, records: [blockedRecord], document, commands: objectCommands, bus: service.bus }).find((option) => option.id === MENU_OPTION_IDS.DUPLICATE);
    assert.equal(blockedDuplicate.disabled, true, "a supported group is disabled when its subtree contains an unsupported record");
    const beforeBlockedDuplicate = structuredClone(document.snapshot());
    rejectUnchanged(service.run("duplicateObjects", { objectIds: ["blocked"] }), beforeBlockedDuplicate, service.bus.history.length, "command.duplicate.unsupported");
    const duplicatedGroup = service.run("duplicateObjects", { objectIds: ["markers"] });
    assert.equal(duplicatedGroup.ok, true, JSON.stringify(duplicatedGroup.issues));
    const groupCopy = document.getObject(duplicatedGroup.result.rootIds[0]);
    assert.equal(groupCopy.typeId, "group");
    assert.ok(document.objects.some((record) => record.parentId === groupCopy.id && record.typeId === "test.conditional"));
});
