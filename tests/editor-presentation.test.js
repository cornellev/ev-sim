import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService, objectCommands } from "../app/3d/editor/commands/index.js";
import {
    EditorPresentationRegistry,
    MENU_OPTION_IDS,
    SECTION_IDS,
    createDefaultPresentation,
    createEditorPresentationRegistry,
    editorPresentationRegistry,
    readObjectFieldValues,
} from "../app/3d/editor/presentation/EditorPresentationRegistry.js";
import {
    buildHierarchyTree,
    collectHierarchyIds,
    filterHierarchyTree,
    flattenHierarchyTree,
    hierarchyRangeIds,
    planHierarchyDrop,
} from "../app/3d/editor/presentation/hierarchyModel.js";
import {
    ObjectOptions,
    createBuiltinObjectTypeRegistry,
    defineObjectType,
    deriveObjectGraph,
    field,
    validateFieldConstraints,
} from "../app/3d/editor/objects/index.js";
import { readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

async function yardService() {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document });
    return { document, service, bus: service.bus };
}

class MarkerOptions extends ObjectOptions {
    getDefaults() { return { label: "marker", radius: 1 }; }
    getFields() { return MARKER_FIELDS; }
    normalize(value = {}) { return { label: String(value?.label ?? "marker"), radius: Number.isFinite(value?.radius) ? value.radius : 1 }; }
    validate(value = {}) { return validateFieldConstraints(MARKER_FIELDS, value); }
    fromLegacy(_legacy, context = {}) { return this.normalize(context.record?.components?.marker ?? {}); }
}
const MARKER_FIELDS = Object.freeze([
    field({ path: ["label"], label: "Marker label", control: "text", group: "Marker" }),
    field({ path: ["radius"], label: "Radius", control: "number", units: "m", min: 0.1, group: "Marker" }),
]);

function createMarkerType() {
    return defineObjectType({
        typeId: "test.marker",
        version: 1,
        label: "Marker",
        catalog: { label: "Marker", kind: "marker", layer: "props" },
        legacy: null,
        options: new MarkerOptions(),
        components: Object.freeze(["marker"]),
        capabilities: { selectable: true, transformable: false, deletable: true, groupable: true, hasOptions: true },
    });
}

test("ED-02 the presentation registry falls back to capability-driven defaults and merges registrations", async () => {
    const { document, bus } = await yardService();
    const registry = createEditorPresentationRegistry();
    const record = document.getObject("feature-cone");
    const fallback = registry.get("builtin-prop");
    assert.equal(fallback.supported, true);
    assert.equal(fallback.label, "Prop");
    assert.equal(fallback.icon, null);
    const ctx = { record, records: [record], document, bus, selection: null, commands: objectCommands, beginRename: () => {}, focus: () => {} };
    const options = fallback.getMenuOptions(ctx);
    assert.deepEqual(options.map((option) => option.id), [
        MENU_OPTION_IDS.RENAME, MENU_OPTION_IDS.FRAME, MENU_OPTION_IDS.DUPLICATE, MENU_OPTION_IDS.GROUP,
        MENU_OPTION_IDS.HIDE, MENU_OPTION_IDS.LOCK, MENU_OPTION_IDS.DELETE,
    ]);
    assert.equal(options.find((option) => option.id === MENU_OPTION_IDS.DELETE).disabled, false);
    // Running a menu option dispatches through the bus.
    const hide = options.find((option) => option.id === MENU_OPTION_IDS.HIDE).run();
    assert.equal(hide.ok, true);
    assert.equal(document.getObject("feature-cone").components.editorHidden, true);
    const shown = fallback.getMenuOptions({ ...ctx, record: document.getObject("feature-cone"), records: [document.getObject("feature-cone")] });
    assert.ok(shown.some((option) => option.id === MENU_OPTION_IDS.SHOW));
    bus.undo();

    const skybox = registry.get("skybox").getMenuOptions({ ...ctx, record: document.getObject("skybox"), records: [document.getObject("skybox")] });
    assert.equal(skybox.find((option) => option.id === MENU_OPTION_IDS.DELETE).disabled, true, "skybox is not deletable");
    assert.equal(skybox.find((option) => option.id === MENU_OPTION_IDS.GROUP).disabled, true);

    const sections = fallback.getInspectorSections({ record, document, sky: null });
    assert.deepEqual(sections.map((section) => section.id), [SECTION_IDS.OBJECT, SECTION_IDS.TRANSFORM, SECTION_IDS.OPTIONS]);
    assert.deepEqual(sections[1].transform.position, { x: 60, y: 0, z: 44 });
    assert.equal(sections[1].editable, false);
    assert.equal(sections[2].fields.some((entry) => entry.path[0] === "assetId"), true);
    assert.equal(sections[2].values.assetId, "cone");
    const { fields, values } = readObjectFieldValues(document.getObject("e0"), document);
    assert.equal(values.width, 7);
    assert.ok(fields.length > 0);

    // Registering merges: custom icon and extra menu option on top of the defaults.
    const icon = { name: "custom-icon" };
    const registered = registry.register("building", {
        icon,
        getMenuOptions: (context, defaults) => [...defaults, { id: "bake", label: "Bake", run: () => "baked" }],
        getInspectorSections: (context, defaults) => [{ id: "custom", title: "Custom", kind: "custom" }, ...defaults],
    });
    assert.equal(registered.icon, icon);
    assert.equal(registry.has("building"), true);
    const buildingRecord = document.getObject("building-0");
    const buildingOptions = registry.forRecord(buildingRecord).getMenuOptions({ ...ctx, record: buildingRecord, records: [buildingRecord] });
    assert.equal(buildingOptions.at(-1).id, "bake");
    assert.equal(registry.forRecord(buildingRecord).getInspectorSections({ record: buildingRecord, document })[0].id, "custom");
    assert.deepEqual(registry.list().map((entry) => entry.typeId), ["building"]);
    let notified = 0;
    registry.subscribe(() => { notified += 1; });
    registry.unregister("building");
    assert.equal(notified, 2);
    assert.equal(registry.has("building"), false);
    assert.throws(() => registry.register(""), /typeId/);
    assert.ok(editorPresentationRegistry instanceof EditorPresentationRegistry);
    assert.equal(createDefaultPresentation("vendor.thing").supported, false);
    const unsupported = registry.get("vendor.thing").getInspectorSections({ record: { id: "v", typeId: "vendor.thing", typeVersion: 3 }, document });
    assert.deepEqual(unsupported.map((section) => section.id), [SECTION_IDS.OBJECT, SECTION_IDS.UNSUPPORTED]);
});

test("ED-02 the hierarchy model orders siblings, nests groups, inherits hidden state, filters, and flattens", async () => {
    const { document, service } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["feature-cone", "feature-barrel"], name: "Pair" }).result.groupId;
    service.run("setObjectsHidden", { objectIds: [groupId], hidden: true });
    service.run("setObjectsLocked", { objectIds: ["feature-tire"], locked: true });
    const tree = buildHierarchyTree(document.objects);
    const roots = tree.map((node) => node.id);
    assert.equal(roots[0], "skybox");
    assert.ok(roots.includes(groupId));
    assert.equal(roots.includes("feature-cone"), false);
    const group = tree.find((node) => node.id === groupId);
    assert.equal(group.isGroup, true);
    assert.equal(group.ownHidden, true);
    assert.deepEqual(group.children.map((child) => [child.id, child.depth, child.hidden, child.ownHidden]), [["feature-cone", 1, true, false], ["feature-barrel", 1, true, false]]);
    assert.equal(tree.find((node) => node.id === "feature-tire").locked, true);
    assert.equal(group.typeLabel, "Group");
    assert.equal(group.supported, true);

    const rows = flattenHierarchyTree(tree);
    assert.equal(rows.length, collectHierarchyIds(tree).length);
    assert.equal(rows.find((row) => row.id === groupId).expanded, true);
    const collapsedRows = flattenHierarchyTree(tree, { expanded: new Set() });
    assert.equal(collapsedRows.some((row) => row.id === "feature-cone"), false);
    assert.equal(collapsedRows.find((row) => row.id === groupId).hasChildren, true);

    const filtered = filterHierarchyTree(tree, "barrel");
    assert.deepEqual(collectHierarchyIds(filtered), [groupId, "feature-barrel"], "ancestors of matches stay visible");
    assert.deepEqual(collectHierarchyIds(filterHierarchyTree(tree, "ROAD")).slice(0, 2), ["e0", "e1"]);
    assert.equal(filterHierarchyTree(tree, "").length, tree.length);
    assert.deepEqual(hierarchyRangeIds(rows, "e0", "e2"), ["e0", "e1", "e2"]);
    assert.deepEqual(hierarchyRangeIds(rows, "e2", "e0"), ["e0", "e1", "e2"]);
    assert.deepEqual(hierarchyRangeIds(rows, "missing", "e0"), ["e0"]);
});

test("ED-02 drop planning maps drag targets to reparent arguments and rejects cycles before commit", async () => {
    const { document, service } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["feature-cone"], name: "G" }).result.groupId;
    const objects = document.objects;
    const inside = planHierarchyDrop({ objects, draggedIds: ["feature-tire"], targetId: groupId, position: "inside" });
    assert.deepEqual(inside, { ok: true, parentId: groupId, index: null, objectIds: ["feature-tire"] });
    const before = planHierarchyDrop({ objects, draggedIds: ["feature-tire"], targetId: "e1", position: "before" });
    assert.equal(before.ok, true);
    assert.equal(before.parentId, null);
    const rootRows = buildHierarchyTree(objects).map((node) => node.id).filter((id) => id !== "feature-tire");
    assert.equal(before.index, rootRows.indexOf("e1"));
    const after = planHierarchyDrop({ objects, draggedIds: ["feature-tire"], targetId: "e1", position: "after" });
    assert.equal(after.index, rootRows.indexOf("e1") + 1);
    assert.deepEqual(planHierarchyDrop({ objects, draggedIds: ["feature-tire"], targetId: "e1", position: "inside" }).ok, false);
    assert.equal(planHierarchyDrop({ objects, draggedIds: [groupId], targetId: groupId, position: "inside" }).ok, false);
    assert.equal(planHierarchyDrop({ objects, draggedIds: [groupId, "feature-cone"], targetId: "feature-cone", position: "before" }).ok, false, "dropping a group into its own subtree is rejected");
    assert.equal(planHierarchyDrop({ objects, draggedIds: [], targetId: null }).ok, false);
    assert.equal(planHierarchyDrop({ objects, draggedIds: ["feature-tire"], targetId: "ghost" }).ok, false);
    const toRoot = planHierarchyDrop({ objects, draggedIds: ["feature-cone"], targetId: null });
    assert.deepEqual(toRoot, { ok: true, parentId: null, index: null, objectIds: ["feature-cone"] });
    // The plan feeds the command exactly.
    const moved = service.run("reparentObjects", { objectIds: after.objectIds, parentId: after.parentId, index: after.index });
    assert.equal(moved.ok, true);
    const rootsAfter = buildHierarchyTree(document.objects).map((node) => node.id);
    assert.equal(rootsAfter.indexOf("feature-tire"), rootsAfter.indexOf("e1") + 1);
});

test("ED-02 a test-only object type appears in the hierarchy and inspector by registration alone", async () => {
    const objectRegistry = createBuiltinObjectTypeRegistry();
    objectRegistry.register(createMarkerType());
    const presentation = createEditorPresentationRegistry({ objectRegistry });
    const icon = { name: "marker-icon" };
    presentation.register("test.marker", {
        icon,
        getInspectorSections: (ctx, defaults) => [...defaults, { id: "marker-preview", title: "Marker", kind: "custom", radius: ctx.record.components.marker.radius }],
    });
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document, registry: objectRegistry });
    const groupId = service.run("groupObjects", { objectIds: ["feature-cone"], name: "Course" }).result.groupId;
    const added = service.bus.execute({
        id: "add-marker",
        label: "Add marker",
        run(ctx) {
            ctx.document.objects.push({ id: "marker-1", typeId: "test.marker", typeVersion: 1, name: "Start marker", parentId: groupId, order: 5, components: { marker: { label: "start", radius: 2.5 } } });
            return { ok: true, issues: [], result: {} };
        },
    });
    assert.equal(added.ok, true, JSON.stringify(added.issues));

    const tree = buildHierarchyTree(document.objects, { presentation });
    const group = tree.find((node) => node.id === groupId);
    const marker = group.children.find((node) => node.id === "marker-1");
    assert.ok(marker, "the marker nests under its group without hierarchy code changes");
    assert.equal(marker.icon, icon);
    assert.equal(marker.supported, true);
    assert.equal(marker.typeLabel, "Marker");
    assert.deepEqual(group.children.map((node) => node.id), ["feature-cone", "marker-1"]);

    const sections = presentation.forRecord(marker.record).getInspectorSections({ record: marker.record, document });
    assert.deepEqual(sections.map((section) => section.id), [SECTION_IDS.OBJECT, SECTION_IDS.OPTIONS, "marker-preview"]);
    assert.equal(sections[1].values.radius, 2.5);
    assert.equal(sections[2].radius, 2.5);
    const options = presentation.forRecord(marker.record).getMenuOptions({ record: marker.record, records: [marker.record], commands: objectCommands, bus: service.bus });
    assert.ok(options.some((option) => option.id === MENU_OPTION_IDS.DELETE && option.disabled === false));
    // The marker participates in the shared commands (reparent, delete, undo) like any other type.
    assert.equal(service.run("reparentObjects", { objectIds: ["marker-1"], parentId: null }).ok, true);
    assert.equal(buildHierarchyTree(document.objects, { presentation }).some((node) => node.id === "marker-1"), true);
    assert.equal(service.run("deleteObjects", { objectIds: ["marker-1"] }).ok, true);
    assert.equal(document.getObject("marker-1"), null);
    service.bus.undo();
    assert.equal(document.getObject("marker-1").name, "Start marker");
    // Unregistered vendor types render through the default presentation as unsupported.
    const vendor = buildHierarchyTree([{ id: "v", typeId: "vendor.thing", name: "Thing", parentId: null, order: 0, components: {} }], { presentation });
    assert.equal(vendor[0].supported, false);
    assert.equal(vendor[0].icon, null);
});

test("ED-03 built-in section providers add turn rules, road endpoints, and the sky runtime block without inspector changes", async () => {
    const { BUILTIN_SECTION_PROVIDERS, SECTION_KINDS } = await import("../app/3d/editor/presentation/builtinSections.js");
    const { document } = await yardService();
    const registry = createEditorPresentationRegistry();
    for (const [typeId, getInspectorSections] of Object.entries(BUILTIN_SECTION_PROVIDERS)) registry.register(typeId, { getInspectorSections });

    const junction = registry.forRecord(document.getObject("n2")).getInspectorSections({ record: document.getObject("n2"), document });
    const turnRules = junction.find((section) => section.kind === SECTION_KINDS.TURN_RULES);
    assert.ok(turnRules, "junctions get the allowed-movements matrix");
    assert.equal(turnRules.connectedRoads, 3);
    assert.deepEqual(turnRules.movements.incident.map((edge) => edge.id), ["e1", "e2", "e3"]);
    assert.ok(turnRules.movements.cells.length > 0);

    const road = registry.forRecord(document.getObject("e1")).getInspectorSections({ record: document.getObject("e1"), document });
    const endpoints = road.find((section) => section.kind === SECTION_KINDS.ROAD_ENDPOINTS);
    assert.deepEqual(endpoints.start, { id: "n1", y: 0, junction: true });
    assert.deepEqual(endpoints.end, { id: "n2", y: 0, junction: true });
    assert.equal(road[0].id, SECTION_IDS.OBJECT, "defaults come first");

    const sky = registry.forRecord(document.getObject("skybox")).getInspectorSections({ record: document.getObject("skybox"), document, sky: { mode: "image" } });
    assert.equal(sky.at(-1).kind, SECTION_KINDS.SKY_PREVIEW);
    const options = sky.find((section) => section.kind === "options");
    assert.ok(options.fields.every((descriptor) => descriptor.path[0] !== "takram"), "image mode hides atmosphere fields");
    const takram = registry.forRecord(document.getObject("skybox")).getInspectorSections({ record: document.getObject("skybox"), document, sky: { mode: "takram" } });
    assert.ok(takram.find((section) => section.kind === "options").fields.every((descriptor) => descriptor.path[0] !== "image"));
    const values = readObjectFieldValues(document.getObject("skybox"), document, { sky: { mode: "takram" } });
    assert.ok(values.allFields.length > values.fields.length, "allFields keeps the full descriptor list");
});
