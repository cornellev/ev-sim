import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { CHANGE_SCALARS, applyChangeSet, diffSnapshots } from "../app/3d/editor/document/ChangeSet.js";
import { COMMAND_ISSUE_CODES, PLAN_STEP_OPS, createEnvironmentCommandService, objectCommands } from "../app/3d/editor/commands/index.js";
import {
    OPTIONS_ISSUE_CODES,
    REQUIRED_TYPE_METHODS,
    ObjectOptions,
    defineObjectType,
    deltaFromTranslation,
    deriveObjectGraph,
    field,
    objectTypeRegistry,
    planObjectOptions,
    readObjectOptionValue,
    validateFieldConstraints,
} from "../app/3d/editor/objects/index.js";
import { readObjectFieldValues } from "../app/3d/editor/presentation/EditorPresentationRegistry.js";
import { DEFAULT_ENVIRONMENT_SKY_CONFIG } from "../app/3d/skybox/EnvironmentSkyConfig.js";
import { createEditorHarness } from "./helpers/editorRuntimeHarness.js";
import { readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

async function yardService() {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document });
    return { manifest, document, service, bus: service.bus };
}

function values(document, id, sky = null) {
    return readObjectFieldValues(document.getObject(id), document, { sky }).values;
}

test("ED-03 planOptions is part of the type contract and defaults to a read-only rejection", () => {
    assert.ok(REQUIRED_TYPE_METHODS.includes("planOptions"));
    class PlainOptions extends ObjectOptions {
        getDefaults() { return { label: "x" }; }
        getFields() { return [field({ path: ["label"], label: "Label", control: "text" })]; }
        normalize(value = {}) { return { label: String(value?.label ?? "x") }; }
        validate(value) { return validateFieldConstraints(this.getFields(), value); }
    }
    const type = defineObjectType({
        typeId: "test.plain",
        version: 1,
        label: "Plain",
        catalog: { label: "Plain", kind: "plain", layer: "props" },
        legacy: null,
        options: new PlainOptions(),
    });
    const plan = type.planOptions({ id: "p", typeId: "test.plain" }, { label: "y" }, {});
    assert.deepEqual(plan.steps, []);
    assert.equal(plan.issues[0].code, OPTIONS_ISSUE_CODES.UNSUPPORTED);
    assert.equal(plan.issues[0].objectId, "p");
    for (const op of ["set-edge-options", "set-building-record", "set-feature-record", "set-earth-source", "set-sky"]) {
        assert.ok(PLAN_STEP_OPS.includes(op), op);
    }
    assert.ok(CHANGE_SCALARS.includes("sky"));
});

test("ED-03 road option edits patch the edge, mark roads authored, and undo/redo restore byte-identical snapshots", async () => {
    const { document, service, bus } = await yardService();
    const before = JSON.stringify(document.snapshot());
    document.roadsAuthored = false;

    const result = service.run("setObjectOptions", { objectId: "e0", patch: [{ path: ["width"], value: 9 }, { path: ["laneCount"], value: 4 }] });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(result.result.paths, ["width", "laneCount"]);
    assert.equal(document.getEdge("e0").width, 9);
    assert.equal(document.getEdge("e0").laneCount, 4);
    assert.equal(document.roadsAuthored, true);
    assert.equal(values(document, "e0").width, 9);
    assert.deepEqual(Object.keys(result.changeSet.domains), ["roads.edges"]);
    assert.deepEqual(Object.keys(result.changeSet.scalars), ["roadsAuthored"]);

    // Object-shaped patches and direction handling.
    const oneWay = service.run("setObjectOptions", { objectId: "e0", patch: { bidirectional: false, direction: -1 } });
    assert.equal(oneWay.ok, true, JSON.stringify(oneWay.issues));
    assert.equal(document.getEdge("e0").bidirectional, false);
    assert.equal(document.getEdge("e0").direction, -1);
    const twoWay = service.run("setObjectOptions", { objectId: "e0", patch: { bidirectional: true } });
    assert.equal(twoWay.ok, true);
    assert.equal(document.getEdge("e0").bidirectional, true);
    assert.equal(document.getEdge("e0").direction, undefined);

    const after = JSON.stringify(document.snapshot());
    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(JSON.stringify({ ...document.snapshot(), roadsAuthored: true }), before);
    assert.equal(bus.redo().ok, true);
    assert.equal(bus.redo().ok, true);
    assert.equal(bus.redo().ok, true);
    assert.equal(JSON.stringify(document.snapshot()), after);
});

test("ED-03 invalid, read-only, unknown, and locked option edits reject atomically with field paths", async () => {
    const { document, service, bus } = await yardService();
    const before = JSON.stringify(document.snapshot());
    const historyBefore = bus.snapshot().historyLength;

    const range = service.run("setObjectOptions", { objectId: "e0", patch: [{ path: ["laneCount"], value: 0 }] });
    assert.equal(range.ok, false);
    assert.equal(range.issues[0].code, "option.range");
    assert.deepEqual(range.issues[0].path, ["laneCount"]);
    assert.equal(range.issues[0].objectId, "e0");

    const type = service.run("setObjectOptions", { objectId: "building-0", patch: [{ path: ["height"], value: -1 }] });
    assert.equal(type.ok, false);
    assert.equal(type.issues[0].code, "option.range");
    assert.deepEqual(type.issues[0].path, ["height"]);

    const enumMiss = service.run("setObjectOptions", { objectId: "feature-cone", patch: [{ path: ["assetId"], value: "spaceship" }] });
    assert.equal(enumMiss.ok, false);
    assert.equal(enumMiss.issues[0].code, "option.enum");
    assert.deepEqual(enumMiss.issues[0].path, ["assetId"]);

    const readOnly = service.run("setObjectOptions", { objectId: "n2", patch: [{ path: ["x"], value: 99 }] });
    assert.equal(readOnly.ok, false);
    assert.equal(readOnly.issues[0].code, OPTIONS_ISSUE_CODES.READ_ONLY);
    assert.deepEqual(readOnly.issues[0].path, ["x"]);

    const unknown = service.run("setObjectOptions", { objectId: "e1", patch: [{ path: ["color"], value: "red" }] });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.issues[0].code, OPTIONS_ISSUE_CODES.UNKNOWN_PATH);
    assert.deepEqual(unknown.issues[0].path, ["color"]);

    const empty = service.run("setObjectOptions", { objectId: "e1", patch: {} });
    assert.equal(empty.ok, false);
    assert.equal(empty.issues[0].code, COMMAND_ISSUE_CODES.ARGUMENT_INVALID);

    const missing = service.run("setObjectOptions", { objectId: "nope", patch: [{ path: ["width"], value: 3 }] });
    assert.equal(missing.issues[0].code, COMMAND_ISSUE_CODES.OBJECT_MISSING);

    assert.equal(service.run("setObjectsLocked", { objectIds: ["e1"], locked: true }).ok, true);
    const locked = service.run("setObjectOptions", { objectId: "e1", patch: [{ path: ["width"], value: 3 }] });
    assert.equal(locked.ok, false);
    assert.equal(locked.issues[0].code, COMMAND_ISSUE_CODES.OBJECT_LOCKED);
    assert.equal(bus.undo().ok, true);

    assert.equal(JSON.stringify(document.snapshot()), before);
    assert.equal(bus.snapshot().historyLength, historyBefore);
});

test("ED-03 intersection elevation edits move the junction node vertically and keep XZ", async () => {
    const { document, service, bus } = await yardService();
    const result = service.run("setObjectOptions", { objectId: "n2", patch: { y: 2.5 } });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const node = document.getNode("n2");
    assert.deepEqual([node.x, node.y, node.z], [40, 2.5, 40]);
    assert.equal(values(document, "n2").y, 2.5);
    assert.equal(bus.undo().ok, true);
    assert.equal(document.getNode("n2").y, 0);
});

test("ED-03 building option edits update height and texture without touching the footprint", async () => {
    const { document, service } = await yardService();
    const footprint = JSON.stringify(document.getBuilding("building-0").footprint);
    const result = service.run("setObjectOptions", { objectId: "building-0", patch: { height: 12.5, textureId: 3 } });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const building = document.getBuilding("building-0");
    assert.equal(building.height, 12.5);
    assert.equal(building.textureId, 3);
    assert.equal(JSON.stringify(building.footprint), footprint);
    assert.equal(document.buildingsAuthored, true);
    assert.equal(values(document, "building-0").height, 12.5);
});

test("ED-03 prop option edits change the asset id (type and matching tags), placement, and facing", async () => {
    const { document, service, bus } = await yardService();
    const result = service.run("setObjectOptions", { objectId: "feature-cone", patch: { assetId: "barrel", x: 61, rotationY: 0.5, dir: 2 } });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const feature = document.getFeature("feature-cone");
    assert.equal(feature.type, "barrel");
    assert.deepEqual(feature.tags, ["barrel"]);
    assert.equal(feature.x, 61);
    assert.equal(feature.rotationY, 0.5);
    assert.equal(feature.dir, 2);
    assert.equal(document.featuresAuthored, true);
    assert.equal(values(document, "feature-cone").assetId, "barrel");

    // Tags that were not exactly the old type are preserved.
    const sign = service.run("setObjectOptions", { objectId: "feature-stop", patch: { assetId: "one-way-sign" } });
    assert.equal(sign.ok, true);
    assert.deepEqual(document.getFeature("feature-stop").tags, ["sign"]);

    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(document.getFeature("feature-cone").type, "cone");
    assert.deepEqual(document.getFeature("feature-cone").tags, ["cone"]);
});

test("ED-03 group frame edits route through the transform planner so descendants move exactly once", async () => {
    const { document, service } = await yardService();
    const groupId = service.run("groupObjects", { objectIds: ["feature-cone", "feature-barrel"], name: "Pair" }).result.groupId;
    const frame = document.getObject(groupId).components.transform;
    const cone = { ...document.getFeature("feature-cone") };
    const barrel = { ...document.getFeature("feature-barrel") };

    const result = service.run("setObjectOptions", {
        objectId: groupId,
        patch: [{ path: ["position"], value: { x: frame.position.x + 10, y: 0, z: frame.position.z - 5 } }],
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const moved = document.getObject(groupId).components.transform;
    assert.ok(Math.abs(moved.position.x - (frame.position.x + 10)) < 1e-9);
    assert.ok(Math.abs(moved.position.z - (frame.position.z - 5)) < 1e-9);
    assert.ok(Math.abs(document.getFeature("feature-cone").x - (cone.x + 10)) < 1e-9);
    assert.ok(Math.abs(document.getFeature("feature-cone").z - (cone.z - 5)) < 1e-9);
    assert.ok(Math.abs(document.getFeature("feature-barrel").x - (barrel.x + 10)) < 1e-9);

    // Same outcome as an equivalent transformObjects call on a fresh service.
    const twin = await yardService();
    const twinGroup = twin.service.run("groupObjects", { objectIds: ["feature-cone", "feature-barrel"], name: "Pair" }).result.groupId;
    assert.equal(twin.service.run("transformObjects", { objectIds: [twinGroup], delta: deltaFromTranslation({ x: 10, z: -5 }) }).ok, true);
    const strip = (snapshot) => JSON.stringify({ ...snapshot, objects: snapshot.objects.map((record) => ({ ...record, id: record.typeId === "group" ? "group" : record.id, parentId: record.parentId ? "group" : null })) });
    assert.equal(strip(document.snapshot()), strip(twin.document.snapshot()));

    const scaled = service.run("setObjectOptions", { objectId: groupId, patch: { scale: 0 } });
    assert.equal(scaled.ok, false);
    assert.equal(scaled.issues[0].code, "option.range");
});

test("ED-03 tile bounds edits patch the Earth source and degenerate bounds reject atomically", async () => {
    const { document, service } = await yardService();
    const source = { anchor: { lat: 42.44, lng: -76.5 }, bounds: { north: 42.45, south: 42.43, east: -76.49, west: -76.51 }, tileProvider: "google-photorealistic", roadProvider: "overpass", importedLayerIds: [], importedAt: null };
    assert.equal(service.run("setEarthSource", { source }).ok, true);
    assert.ok(document.getObject("tile"), "the live overlay gains a tile record");
    const before = JSON.stringify(document.snapshot());

    const readOnly = service.run("setObjectOptions", { objectId: "tile", patch: { anchor: { lat: 1 } } });
    assert.equal(readOnly.ok, false);
    assert.equal(readOnly.issues[0].code, OPTIONS_ISSUE_CODES.READ_ONLY);

    const degenerate = service.run("setObjectOptions", { objectId: "tile", patch: { bounds: { north: 42.42 } } });
    assert.equal(degenerate.ok, false);
    assert.equal(degenerate.issues[0].code, "option.range");
    assert.equal(JSON.stringify(document.snapshot()), before);

    const ok = service.run("setObjectOptions", { objectId: "tile", patch: { bounds: { north: 42.46 } } });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    assert.equal(document.earth.bounds.north, 42.46);
    assert.equal(document.earth.bounds.south, 42.43);
    assert.deepEqual(document.earth.anchor, source.anchor);
    assert.deepEqual(Object.keys(ok.changeSet.scalars), ["earth"]);
});

test("ED-03 setObjectsOptions applies one patch to many records atomically", async () => {
    const { document, service } = await yardService();
    const before = JSON.stringify(document.snapshot());

    const mixed = service.run("setObjectsOptions", { objectIds: ["feature-cone", "e0"], patch: { rotationY: 1 } });
    assert.equal(mixed.ok, false);
    assert.equal(mixed.issues[0].code, OPTIONS_ISSUE_CODES.UNKNOWN_PATH);
    assert.equal(mixed.issues[0].objectId, "e0");
    assert.equal(JSON.stringify(document.snapshot()), before, "the first record is rolled back");

    const ok = service.run("setObjectsOptions", { objectIds: ["feature-cone", "feature-barrel"], patch: { rotationY: 1 } });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    assert.deepEqual(ok.result.objectIds, ["feature-cone", "feature-barrel"]);
    assert.equal(document.getFeature("feature-cone").rotationY, 1);
    assert.equal(document.getFeature("feature-barrel").rotationY, 1);
    assert.equal(service.bus.snapshot().historyLength, 1);

    const empty = service.run("setObjectsOptions", { objectIds: [], patch: { rotationY: 1 } });
    assert.equal(empty.issues[0].code, COMMAND_ISSUE_CODES.SELECTION_EMPTY);
});

test("ED-03 the sky is a document scalar: snapshots carry it only once seeded and toManifest strips it", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    const pristine = JSON.stringify(document.snapshot());
    assert.equal("sky" in document.snapshot(), false, "v2 snapshots stay byte-identical");
    assert.equal(document.sky, null);

    document.setSky({ mode: "takram", takram: { timeOfDay: 6 } }, { notify: false });
    assert.equal(document.snapshot().sky.takram.timeOfDay, 6);
    assert.equal(document.snapshot().sky.image.localPreviewUrl, undefined, "manifest shape only");
    assert.equal("sky" in document.toManifest(), false);

    const before = document.snapshot();
    document.setSky({ mode: "image", image: { url: "assets/sky.exr", exposure: 2 } }, { notify: false });
    const changeSet = diffSnapshots(before, document.snapshot());
    assert.deepEqual(Object.keys(changeSet.scalars), ["sky"]);
    assert.equal(changeSet.scalars.sky.before.mode, "takram");
    assert.equal(changeSet.scalars.sky.after.mode, "image");
    applyChangeSet(document, changeSet, "before");
    assert.equal(document.sky.mode, "takram");
    applyChangeSet(document, changeSet, "after");
    assert.equal(document.sky.image.exposure, 2);

    // Restoring a snapshot without a sky key leaves the sky alone.
    document.restoreSnapshot(JSON.parse(pristine), { notify: false });
    assert.equal(document.sky.mode, "image");
    document.restoreSnapshot({ ...JSON.parse(pristine), sky: null }, { notify: false });
    assert.equal(document.sky, null);
    assert.equal(JSON.stringify(document.snapshot()), pristine);
});

test("ED-03 skybox option edits commit through the bus, mirror into the sky state, and undo restores both", async () => {
    const harness = await createEditorHarness();
    const { document, bus, environment } = harness;
    const skyState = environment.sky();
    assert.equal(document.sky.takram.timeOfDay, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.timeOfDay);
    assert.equal(bus.sky.takram.timeOfDay, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.timeOfDay);

    const fields = readObjectFieldValues(document.getObject("skybox"), document);
    assert.ok(fields.fields.every((descriptor) => descriptor.path[0] !== "image"), "takram mode hides image fields");
    assert.ok(fields.allFields.some((descriptor) => descriptor.path[0] === "image"));

    const result = bus.execute(objectCommands.setObjectOptions({ objectId: "skybox", patch: [{ path: ["takram", "timeOfDay"], value: 6 }, { path: ["takram", "cloudsEnabled"], value: false }] }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(Object.keys(result.changeSet.scalars), ["sky"]);
    assert.equal(document.sky.takram.timeOfDay, 6);
    assert.equal(document.sky.takram.cloudsEnabled, false);
    assert.equal(skyState.snapshot().takram.timeOfDay, 6, "the projector mirrors the scalar into the runtime state");
    assert.equal(skyState.snapshot().takram.cloudsEnabled, false);

    const outOfRange = bus.execute(objectCommands.setObjectOptions({ objectId: "skybox", patch: { takram: { timeOfDay: 30 } } }));
    assert.equal(outOfRange.ok, false);
    assert.equal(outOfRange.issues[0].code, "option.range");
    assert.deepEqual(outOfRange.issues[0].path, ["takram", "timeOfDay"]);
    assert.equal(document.sky.takram.timeOfDay, 6);

    const mode = bus.execute(objectCommands.setObjectOptions({ objectId: "skybox", patch: { mode: "image" } }));
    assert.equal(mode.ok, true, JSON.stringify(mode.issues));
    assert.equal(skyState.snapshot().mode, "image");
    assert.ok(readObjectFieldValues(document.getObject("skybox"), document).fields.every((descriptor) => descriptor.path[0] !== "takram"));

    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(document.sky.takram.timeOfDay, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.timeOfDay);
    assert.equal(document.sky.mode, "takram");
    assert.equal(skyState.snapshot().takram.timeOfDay, DEFAULT_ENVIRONMENT_SKY_CONFIG.takram.timeOfDay);
    assert.equal(skyState.snapshot().mode, "takram");
    assert.equal(bus.redo().ok, true);
    assert.equal(skyState.snapshot().takram.timeOfDay, 6);

    // Legacy direct writes to the state keep the document scalar current (no history entry).
    const history = bus.snapshot().historyLength;
    skyState.setTakramSettings({ cloudCoverage: 0.9 });
    assert.equal(document.sky.takram.cloudCoverage, 0.9);
    assert.equal(bus.snapshot().historyLength, history);
    assert.equal("sky" in environment.toManifest().document, false);
    assert.equal(environment.toManifest().sky.takram.cloudCoverage, 0.9);
    environment.dispose();
});

test("ED-03 prop asset and facing edits re-place the runtime feature; placement-only edits move it in place", async () => {
    const harness = await createEditorHarness();
    const { document, bus, runtime, registry } = harness;
    const placed = runtime.counters.placeFeature;
    const removed = runtime.counters.removeFeature;

    assert.equal(bus.execute(objectCommands.setObjectOptions({ objectId: "feature-cone", patch: { x: 61.5 } })).ok, true);
    assert.equal(runtime.counters.placeFeature, placed, "moving keeps the mesh");
    assert.equal(registry.getEntity("fusion:feature-cone").object3D.position.x, 61.5);

    assert.equal(bus.execute(objectCommands.setObjectOptions({ objectId: "feature-cone", patch: { assetId: "barrel" } })).ok, true);
    assert.equal(runtime.counters.placeFeature, placed + 1);
    assert.equal(runtime.counters.removeFeature, removed + 1);
    assert.deepEqual(registry.getEntity("fusion:feature-cone").tags, ["barrel"]);

    assert.equal(bus.execute(objectCommands.setObjectOptions({ objectId: "feature-cone", patch: { dir: 3 } })).ok, true);
    assert.equal(runtime.counters.placeFeature, placed + 2, "facing changes placement geometry");
    assert.equal(registry.getEntity("fusion:feature-cone").fusionObject.dir, 3);

    assert.equal(bus.undo().ok, true);
    assert.equal(document.getFeature("feature-cone").dir, 0);
    assert.equal(runtime.counters.placeFeature, placed + 3);
    harness.environment.dispose();
});

test("ED-03 readObjectOptionValue and planObjectOptions are pure over the legacy index", async () => {
    const { document } = await yardService();
    const index = document.index();
    const record = document.getObject("e2");
    const value = readObjectOptionValue(record, index, objectTypeRegistry);
    assert.deepEqual(value, { width: 4, laneCount: 1, shoulderWidth: 0, bidirectional: false, direction: 1 });
    const plan = planObjectOptions(record, index, objectTypeRegistry, { ...value, width: 5 });
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.steps[0].op, "set-edge-options");
    assert.equal(plan.steps[0].patch.width, 5);
    assert.equal(document.getEdge("e2").width, 4, "planning never mutates");
    const unregistered = planObjectOptions({ id: "x", typeId: "nope" }, index, objectTypeRegistry, {});
    assert.equal(unregistered.issues[0].code, OPTIONS_ISSUE_CODES.UNSUPPORTED);
});
