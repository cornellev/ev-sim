import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    COMMAND_ISSUE_CODES,
    CommandBus,
    createEnvironmentCommandService,
    legacyCommands,
    objectCommands,
} from "../app/3d/editor/commands/index.js";
import { SelectionStore } from "../app/3d/editor/selection/SelectionStore.js";
import {
    entityIdForObject,
    entityIdForSub,
    objectIdForEntity,
    subForEntity,
    typeIdForEntityKind,
} from "../app/3d/editor/selection/selectionIds.js";
import {
    OBJECT_ISSUE_CODES,
    TRANSFORM_ISSUE_CODES,
    deltaFromTranslation,
    deltaFromYaw,
    deriveObjectGraph,
    reconcileObjectGraph,
    objectTypeRegistry,
} from "../app/3d/editor/objects/index.js";
import { readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test.beforeEach(() => {
    resetDocumentIdCounter();
});

async function yardService({ withOverlay = true, selection = null } = {}) {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    if (withOverlay) document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const service = createEnvironmentCommandService({ document, selection });
    return { manifest, document, service, bus: service.bus };
}

function listFiles(directory) {
    const entries = [];
    for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) entries.push(...listFiles(full));
        else if (full.endsWith(".js")) entries.push(full);
    }
    return entries;
}

test("ED-02 commands/ and selection/ never import React, DOM, scene adapters, or the runtime registry", () => {
    const files = [
        ...listFiles(path.join(ROOT, "app/3d/editor/commands")),
        ...listFiles(path.join(ROOT, "app/3d/editor/selection")),
    ];
    assert.ok(files.length >= 10);
    const forbidden = [
        /from\s+["'](react|next|node:)/,
        /\b(window|navigator|requestAnimationFrame|WebGL)\b/,
        /\bdocument\.(getElementById|createElement|body|querySelector)/,
        /EnvironmentRegistry\.js/,
        /document\/adapters\//,
        /\/city\/(?!buildingIds\.js)/,
        /\/earth\//,
        /\/overlay\//,
        /\/map\//,
        /\/tools\//,
        /\/projection\//,
    ];
    for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const pattern of forbidden) {
            assert.equal(pattern.test(source), false, `${path.relative(ROOT, file)} matches ${pattern}`);
        }
    }
});

test("ED-02 execute records one change set per command and undo/redo restore byte-identical snapshots", async () => {
    const { document, service, bus } = await yardService();
    const snapshots = [document.snapshot()];
    const steps = [
        ["addFeature", { type: "cone", x: 1, z: 2, name: "Cone A" }],
        ["addBuilding", { cornerA: { x: 100, z: 100 }, cornerB: { x: 110, z: 108 }, height: 6 }],
        ["addRoad", { points: [{ x: 200, z: 0 }, { x: 240, z: 0 }, { x: 240, z: 40 }] }],
        ["setTurnRule", { nodeId: "n2", fromEdgeId: "e1", toEdgeId: "e2", allowed: false }],
        ["setEarthSource", { source: { anchor: { lat: 42, lng: -76 }, bounds: { north: 1, south: 0, east: 1, west: 0 } } }],
        ["renameObject", { objectId: "feature-cone", name: "Front cone" }],
        ["updateRoadEdge", { edgeId: "e0", patch: { width: 9 } }],
    ];
    for (const [name, args] of steps) {
        const result = service.run(name, args);
        assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.issues)}`);
        assert.ok(result.changeSet, `${name} produced a change set`);
        snapshots.push(document.snapshot());
    }
    assert.equal(bus.history.length, steps.length);
    assert.equal(document.getObject(document.features.at(-1).id) === null, false, "added features gain records");
    assert.equal(document.objects.filter((record) => record.typeId === "road").length, 6, "added road edges gain records");
    assert.equal(document.objects.filter((record) => record.typeId === "intersection").length, 3, "the new bend became a junction record");

    for (let index = steps.length; index > 0; index -= 1) {
        assert.equal(bus.undo().ok, true);
        assert.deepEqual(document.snapshot(), snapshots[index - 1], `undo ${index}`);
    }
    assert.equal(bus.undo().ok, false);
    assert.deepEqual(bus.undo().issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.NOTHING_TO_UNDO]);
    for (let index = 1; index <= steps.length; index += 1) {
        assert.equal(bus.redo().ok, true);
        assert.deepEqual(document.snapshot(), snapshots[index], `redo ${index}`);
    }
    assert.equal(bus.redo().ok, false);
    // A new command after undo clears the redo stack.
    bus.undo();
    assert.equal(bus.canRedo, true);
    service.run("renameObject", { objectId: "feature-tire", name: "Spare" });
    assert.equal(bus.canRedo, false);
});

test("ED-02 failed commands leave the document byte-identical and return structured issues", async () => {
    const { document, service, bus } = await yardService();
    const before = document.snapshot();
    const unknown = service.run("addFeature", { type: "lamp", x: 0, z: 0 });
    assert.equal(unknown.ok, false);
    assert.deepEqual(unknown.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.ARGUMENT_INVALID]);
    const cycle = service.run("reparentObjects", { objectIds: ["feature-cone"], parentId: "feature-cone" });
    assert.deepEqual(cycle.issues.map((issue) => issue.code), [OBJECT_ISSUE_CODES.PARENT_NOT_GROUP]);
    const missing = service.run("deleteObjects", { objectIds: ["ghost"] });
    assert.deepEqual(missing.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.OBJECT_MISSING]);
    const notDeletable = service.run("deleteObjects", { objectIds: ["skybox"] });
    assert.deepEqual(notDeletable.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.NOT_DELETABLE]);
    const thrown = bus.execute({ id: "boom", label: "Boom", run() { throw new Error("kaboom"); } });
    assert.deepEqual(thrown.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.MUTATION_FAILED]);
    // A command that mutates then reports failure is rolled back too.
    const partial = bus.execute({
        id: "partial",
        label: "Partial",
        run(ctx) {
            ctx.document.features.pop();
            return { ok: false, issues: [], error: "changed my mind" };
        },
    });
    assert.equal(partial.ok, false);
    // A command whose result violates the object graph is rolled back.
    const invalidGraph = bus.execute({
        id: "bad-graph",
        label: "Bad graph",
        run(ctx) {
            ctx.document.objects.push({ id: "dup", typeId: "group", parentId: "dup", order: 0, components: {} });
            return { ok: true, issues: [], result: {} };
        },
    });
    assert.equal(invalidGraph.ok, false);
    assert.ok(invalidGraph.issues.some((issue) => issue.code === OBJECT_ISSUE_CODES.PARENT_SELF));
    assert.deepEqual(document.snapshot(), before);
    assert.equal(bus.history.length, 0);
    assert.throws(() => service.run("nope", {}), /Unknown command/);
    assert.throws(() => bus.execute({}), /run\(context\)/);
});

test("ED-02 bus.transaction groups commands into one history entry and aborts atomically", async () => {
    const { document, service, bus } = await yardService();
    const before = document.snapshot();
    const grouped = service.transaction("Place two cones", (run) => {
        run("addFeature", { type: "cone", x: 0, z: 0 });
        run("addFeature", { type: "cone", x: 1, z: 1 });
        return "both";
    });
    assert.equal(grouped.ok, true);
    assert.equal(grouped.result, "both");
    assert.equal(bus.history.length, 1);
    assert.equal(bus.snapshot().history[0], "Place two cones");
    assert.equal(document.features.length, 7);

    const aborted = service.transaction("Cone then lamp", (run) => {
        run("addFeature", { type: "cone", x: 2, z: 2 });
        run("addFeature", { type: "lamp", x: 3, z: 3 });
    });
    assert.equal(aborted.ok, false);
    assert.deepEqual(aborted.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.ARGUMENT_INVALID]);
    assert.equal(document.features.length, 7, "the first command of the aborted transaction was rolled back");
    assert.equal(bus.history.length, 1);
    bus.undo();
    assert.deepEqual(document.snapshot(), before);
});

test("ED-02 history is bounded", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    const bus = new CommandBus({ document, historyLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
        assert.equal(bus.execute(legacyCommands.addFeature({ type: "cone", x: index, z: 0 })).ok, true);
    }
    assert.equal(bus.history.length, 3);
    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, true);
    assert.equal(bus.undo().ok, false);
    assert.equal(document.features.length, 7, "only the last three adds were undoable");
});

test("ED-02 gestures are idempotent, transient until commit, and cancel restores without history", async () => {
    const { document, service, bus } = await yardService();
    const pristine = document.snapshot();
    const events = [];
    document.subscribe((snapshot, event) => events.push(event));
    const busEvents = [];
    bus.subscribe((snapshot) => busEvents.push(snapshot.activeGesture?.id ?? null));

    const versionAtStart = document.version;
    const begun = bus.beginGesture({ objectIds: ["feature-cone", "e1"], label: "Drag" });
    assert.equal(begun.ok, true);
    assert.deepEqual([...begun.closure.nodeIds].sort(), ["n1", "n2"]);
    assert.equal(bus.activeGesture.id, begun.gestureId);
    assert.equal(busEvents.at(-1), begun.gestureId);

    const frame1 = bus.updateGesture(begun.gestureId, deltaFromTranslation({ x: 10, z: 0 }));
    assert.equal(frame1.ok, true);
    assert.equal(document.getFeature("feature-cone").x, 70);
    assert.equal(document.getNode("n2").x, 50);
    const frame2 = bus.updateGesture(begun.gestureId, deltaFromTranslation({ x: 3, z: 4 }));
    assert.equal(frame2.ok, true);
    assert.equal(document.getFeature("feature-cone").x, 63, "frames are cumulative from the pristine capture, not additive");
    assert.deepEqual([document.getNode("n2").x, document.getNode("n2").z], [43, 44]);
    assert.deepEqual([document.getNode("n1").x, document.getNode("n1").z], [43, 4]);
    assert.deepEqual([document.getNode("n0").x, document.getNode("n0").z], [0, 0], "nodes outside the closure do not move");
    assert.ok(events.slice(1).every((event) => event.transient === true && event.source === "gesture"));
    assert.equal(frame2.changeSet.domains.features.after.get("feature-cone").x, 63);
    assert.equal(frame2.changeSet.domains.features.before.get("feature-cone").x, 70, "frame change sets are relative to the last projected frame");
    assert.equal(document.version, versionAtStart + 2, "each frame notifies once");

    // Frames that return to the pristine state still notify the projector of the move back.
    const frame3 = bus.updateGesture(begun.gestureId, deltaFromTranslation({ x: 0, z: 0 }));
    assert.equal(frame3.ok, true);
    assert.equal(frame3.changeSet.domains.features.after.get("feature-cone").x, 60);
    const noop = bus.commitGesture(begun.gestureId);
    assert.equal(noop.ok, true);
    assert.equal(noop.changeSet, null);
    assert.equal(bus.history.length, 0, "no-op drags never enter history");
    assert.deepEqual(document.snapshot(), pristine);

    // A real drag commits exactly one non-transient change set equal to the one-shot command.
    const second = bus.beginGesture({ objectIds: ["feature-cone", "e1"], label: "Drag" });
    bus.updateGesture(second.gestureId, deltaFromTranslation({ x: 10, z: 0 }));
    bus.updateGesture(second.gestureId, deltaFromTranslation({ x: 3, z: 4 }));
    const committed = bus.commitGesture(second.gestureId);
    assert.equal(committed.ok, true);
    assert.equal(committed.changeSet.meta.transient, false);
    assert.equal(committed.changeSet.meta.label, "Drag");
    assert.equal(bus.history.length, 1);
    assert.equal(events.at(-1).transient, false);
    assert.equal(events.at(-1).source, "gesture");
    const dragged = document.snapshot();
    bus.undo();
    assert.deepEqual(document.snapshot(), pristine);
    const oneShot = service.run("transformObjects", { objectIds: ["feature-cone", "e1"], delta: deltaFromTranslation({ x: 3, z: 4 }) });
    assert.equal(oneShot.ok, true);
    assert.deepEqual(document.snapshot(), dragged, "a gesture equals the one-shot transform");
    bus.undo();

    // Cancel restores the capture, notifies once with source "cancel", and never enters history.
    const third = bus.beginGesture({ objectIds: ["feature-cone"] });
    bus.updateGesture(third.gestureId, deltaFromTranslation({ x: 100 }));
    const eventCount = events.length;
    const cancelled = bus.cancelGesture(third.gestureId);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.changeSet.domains.features.after.get("feature-cone").x, 60);
    assert.equal(events.length, eventCount + 1);
    assert.equal(events.at(-1).source, "cancel");
    assert.equal(events.at(-1).transient, false);
    assert.deepEqual(document.snapshot(), pristine);
    assert.equal(bus.history.length, 0);
    assert.equal(bus.activeGesture, null);

    // Executing a command while a gesture is active cancels the gesture first.
    const fourth = bus.beginGesture({ objectIds: ["feature-cone"] });
    bus.updateGesture(fourth.gestureId, deltaFromTranslation({ x: 100 }));
    service.run("renameObject", { objectId: "feature-cone", name: "Renamed" });
    assert.equal(document.getFeature("feature-cone").x, 60);
    assert.equal(bus.activeGesture, null);
    assert.equal(bus.history.length, 1);
    assert.equal(bus.updateGesture(fourth.gestureId, deltaFromTranslation({ x: 1 })).issues[0].code, COMMAND_ISSUE_CODES.GESTURE_INACTIVE);
    assert.equal(bus.commitGesture("nope").ok, false);
});

test("ED-02 gestures reject unsupported deltas per frame and never commit a rejected frame", async () => {
    const { document, bus } = await yardService();
    const pristine = document.snapshot();
    const gesture = bus.beginGesture({ objectIds: ["feature-cone"] });
    assert.equal(bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 5 })).ok, true);
    const rejected = bus.updateGesture(gesture.gestureId, { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.SCALE_UNSUPPORTED]);
    assert.equal(document.getFeature("feature-cone").x, 60, "a rejected frame restores the pristine capture");
    assert.equal(rejected.changeSet.domains.features.after.get("feature-cone").x, 60, "the projector is told to move back");
    const commit = bus.commitGesture(gesture.gestureId);
    assert.equal(commit.ok, false);
    assert.deepEqual(commit.issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.GESTURE_UNSUPPORTED]);
    assert.deepEqual(document.snapshot(), pristine);
    assert.equal(bus.history.length, 0);

    // Locked and non-transformable roots refuse to start.
    bus.execute(objectCommands.setObjectsLocked({ objectIds: ["feature-tire"], locked: true }));
    const locked = bus.beginGesture({ objectIds: ["feature-tire"] });
    assert.equal(locked.ok, false);
    assert.deepEqual(locked.issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.LOCKED]);
    const skybox = bus.beginGesture({ objectIds: ["skybox"] });
    assert.deepEqual(skybox.issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE]);
    assert.deepEqual(bus.beginGesture({ objectIds: [] }).issues.map((issue) => issue.code), [COMMAND_ISSUE_CODES.SELECTION_EMPTY]);
    assert.deepEqual(bus.beginGesture({ objectIds: ["ghost"] }).issues.map((issue) => issue.code), [TRANSFORM_ISSUE_CODES.MISSING]);
});

test("ED-02 sub-object gestures move a road endpoint without a record and yaw props about the pivot", async () => {
    const { document, bus } = await yardService();
    const gesture = bus.beginGesture({ objectIds: ["e0"], sub: { kind: "road-node", id: "n0" }, label: "Drag endpoint" });
    assert.equal(gesture.ok, true);
    // With the edge as primary the whole edge moves; the sub node is included exactly once.
    bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 0, z: 7 }));
    assert.equal(document.getNode("n0").z, 7);
    assert.equal(document.getNode("n1").z, 7);
    bus.cancelGesture(gesture.gestureId);

    // A sub-only gesture (no transformable root) moves just that node.
    const endpoint = bus.beginGesture({ objectIds: [], sub: { kind: "road-node", id: "n0" } });
    assert.equal(endpoint.ok, true);
    bus.updateGesture(endpoint.gestureId, deltaFromTranslation({ x: -5, z: 0 }));
    assert.deepEqual([document.getNode("n0").x, document.getNode("n1").x], [-5, 40]);
    const committed = bus.commitGesture(endpoint.gestureId);
    assert.deepEqual([...committed.changeSet.domains["roads.nodes"].after.keys()], ["n0"]);

    const yaw = bus.beginGesture({ objectIds: ["feature-stop"] });
    bus.updateGesture(yaw.gestureId, deltaFromYaw(Math.PI / 2, { x: 22, z: 3 }));
    const stop = document.getFeature("feature-stop");
    assert.ok(Math.abs(stop.x - 22) < 1e-9 && Math.abs(stop.z - 3) < 1e-9, "yaw about its own position keeps the prop in place");
    assert.ok(Math.abs(stop.rotationY - Math.PI / 2) < 1e-9);
    assert.equal(stop.dir, 1, "legacy facing quadrant is left as-is");
    bus.commitGesture(yaw.gestureId);
});

test("ED-02 a bus over a document without an overlay makes the overlay live on the first command", async () => {
    const { document, service, bus } = await yardService({ withOverlay: false });
    assert.deepEqual(document.objects, []);
    const result = service.run("addFeature", { type: "cone", x: 1, z: 1 });
    assert.equal(result.ok, true);
    assert.equal(document.objects.length, 14);
    const { added, orphaned } = reconcileObjectGraph(document.snapshot(), document.objects, objectTypeRegistry, { sky: null });
    assert.deepEqual({ added, orphaned }, { added: [], orphaned: [] }, "save-time reconcile is a no-op after a command");
    bus.undo();
    assert.deepEqual(document.objects, []);
    bus.reset();
    assert.equal(bus.canUndo, false);
    assert.equal(bus.canRedo, false);
});

test("ED-02 SelectionStore tracks ids, primary, sub-selection, modes, pruning, and suppression", () => {
    let now = 0;
    const selection = new SelectionStore({ now: () => now });
    const seen = [];
    selection.subscribe((snapshot) => seen.push(snapshot.ids.join(",")));
    assert.equal(seen.length, 1);
    selection.select("a");
    selection.select(["b", "c"], { mode: "add" });
    assert.deepEqual(selection.snapshot(), { ids: ["a", "b", "c"], primary: "c", sub: null, version: 2, count: 3 });
    selection.select("b", { mode: "toggle" });
    assert.deepEqual(selection.ids, ["a", "c"]);
    assert.equal(selection.primary, "c");
    selection.select("b", { mode: "toggle" });
    assert.equal(selection.primary, "b");
    selection.select("a", { mode: "remove" });
    assert.deepEqual(selection.ids, ["c", "b"]);
    selection.setPrimary("c");
    assert.equal(selection.primary, "c");
    selection.setPrimary("zzz");
    assert.equal(selection.primary, "c", "primary must be selected");
    selection.setSub({ kind: "road-node", id: "n0" });
    assert.deepEqual(selection.sub, { kind: "road-node", id: "n0" });
    selection.select("c");
    assert.equal(selection.sub, null, "replace clears the sub-selection");
    selection.select(["c", "d"], { mode: "add", sub: { kind: "road-node", id: "n1" } });
    assert.equal(selection.sub.id, "n1");
    const versionBefore = selection.version;
    selection.select(["c", "d"], { mode: "add" });
    assert.equal(selection.version, versionBefore, "no-op selections do not notify");
    selection.prune(new Set(["d"]));
    assert.deepEqual(selection.ids, ["d"]);
    assert.equal(selection.primary, "d");
    selection.prune([]);
    assert.deepEqual(selection.snapshot().ids, []);
    assert.equal(selection.sub, null);
    selection.suppress(300);
    assert.equal(selection.isSuppressed(), true);
    now = 301;
    assert.equal(selection.isSuppressed(), false);
    assert.throws(() => selection.select("a", { mode: "nope" }), /Unknown selection mode/);
    assert.equal(seen.length > 3, true);
});

test("ED-02 the bus prunes the shared selection after deletes and undo", async () => {
    const selection = new SelectionStore();
    const { service, bus } = await yardService({ selection });
    selection.select(["feature-cone", "e0", "skybox"]);
    const deleted = service.run("deleteObjects", { objectIds: ["feature-cone", "e0"] });
    assert.equal(deleted.ok, true);
    assert.deepEqual(selection.ids, ["skybox"]);
    selection.select(["skybox", "feature-tire"]);
    bus.undo();
    assert.deepEqual(selection.ids, ["skybox", "feature-tire"], "restored ids stay selected; nothing is added back");
    selection.select("n1");
    service.run("removeRoad", { edgeId: "e0" });
    assert.deepEqual(selection.ids, [], "the demoted junction n1 lost its record and left the selection");
});

test("ED-02 selectionIds maps object ids to registry entity ids and back", () => {
    assert.equal(entityIdForObject({ id: "e0", typeId: "road" }), "road:e0");
    assert.equal(entityIdForObject({ id: "n2", typeId: "intersection" }), "intersection:n2");
    assert.equal(entityIdForObject({ id: "b0", typeId: "building" }), "building:b0");
    assert.equal(entityIdForObject({ id: "g", typeId: "group" }), null);
    assert.equal(entityIdForObject({ id: "skybox", typeId: "skybox" }), null);
    const registry = {
        listEntities: () => [{ id: "fusion:abc", sourceId: "feature-cone", layer: "props" }, { id: "building:b0", sourceId: "b0", layer: "buildings" }],
        getEntity: (id) => ({ id, resolved: true }),
    };
    assert.deepEqual(entityIdForObject({ id: "feature-cone", typeId: "builtin-prop" }, registry), "fusion:abc");
    assert.equal(entityIdForObject({ id: "feature-cone", typeId: "builtin-prop" }), null);
    assert.equal(entityIdForSub({ kind: "road-node", id: "n0" }), "road-node:n0");
    assert.equal(entityIdForSub(null), null);
    assert.equal(objectIdForEntity({ id: "fusion:abc", sourceId: "feature-cone", kind: "cone", layer: "props" }), "feature-cone");
    assert.equal(objectIdForEntity({ id: "road:e0", kind: "road" }), "e0");
    assert.equal(objectIdForEntity({ id: "road-node:n0", sourceId: "n0", kind: "road-node" }), null);
    assert.deepEqual(subForEntity({ id: "road-node:n0", sourceId: "n0", kind: "road-node" }), { kind: "road-node", id: "n0" });
    assert.equal(subForEntity({ id: "road:e0", kind: "road" }), null);
    assert.equal(typeIdForEntityKind("road"), "road");
    assert.equal(typeIdForEntityKind("cone", "props"), "builtin-prop");
    assert.equal(typeIdForEntityKind("road-node"), null);
});
