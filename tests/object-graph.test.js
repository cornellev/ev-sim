import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    OBJECT_ISSUE_CODES,
    OBJECT_SUPPORT,
    createBuiltinObjectTypeRegistry,
    deriveObjectGraph,
    describeObjectSupport,
    legacyIndex,
    objectTypeRegistry,
    planObjectTransform,
    readObjectTransform,
    reconcileObjectGraph,
    sortObjectRecords,
    validateObjectGraph,
    validateObjectRecords,
} from "../app/3d/editor/objects/index.js";
import {
    IDENTITY_DELTA,
    TRANSFORM_ISSUE_CODES,
    applyDeltaToFrame,
    applyDeltaToPoint,
    composeDeltas,
    decomposeDelta,
    deltaBetweenFrames,
    deltaFromScale,
    deltaFromTranslation,
    deltaFromYaw,
    invertDelta,
    isIdentityDelta,
    normalizeDelta,
} from "../app/3d/editor/objects/transformDelta.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { readEnvironmentEditorFixture } from "./helpers/environmentEditorBaseline.js";

const SKY = { sky: null };

test("ED-01 deriveObjectGraph covers every feature, building, edge, junction node, skybox, and tile with shared ids", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const records = deriveObjectGraph(manifest.document);
    assert.deepEqual(records.map((record) => `${record.typeId}:${record.id}`), [
        "skybox:skybox",
        "road:e0", "road:e1", "road:e2", "road:e3",
        "intersection:n1", "intersection:n2",
        "building:building-0",
        "builtin-prop:feature-barrel", "builtin-prop:feature-cone", "builtin-prop:feature-one-way",
        "builtin-prop:feature-stop", "builtin-prop:feature-tire",
    ]);
    assert.deepEqual(records.map((record) => record.order), records.map((_, index) => index));
    assert.equal(records.find((record) => record.id === "feature-stop").name, "Stop Sign");
    assert.ok(records.every((record) => record.parentId === null && record.typeVersion === 1));
    assert.deepEqual(records[0].components, { tags: [], locked: false, editorHidden: false });
    // Endpoint nodes are road handles, not objects.
    assert.equal(records.some((record) => record.id === "n0"), false);

    const withEarth = await readEnvironmentEditorFixture("all-props.v3.json");
    const earthRecords = deriveObjectGraph(withEarth.document);
    assert.deepEqual(earthRecords.slice(0, 2).map((record) => record.id), ["skybox", "tile"]);
    assert.deepEqual(validateObjectGraph({ ...withEarth.document, objects: earthRecords }, objectTypeRegistry, SKY), { ok: true, issues: [] });
});

test("ED-01 derived transform bindings read legacy placement without mutating it", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const snapshot = structuredClone(manifest.document);
    const records = deriveObjectGraph(snapshot);
    const byId = new Map(records.map((record) => [record.id, record]));
    assert.deepEqual(readObjectTransform(byId.get("feature-tire"), snapshot), { position: { x: 5, y: 0, z: 30 }, rotationY: 1.5 });
    assert.deepEqual(readObjectTransform(byId.get("n2"), snapshot), { position: { x: 40, y: 0, z: 40 }, rotationY: 0 });
    assert.deepEqual(readObjectTransform(byId.get("building-0"), snapshot), { position: { x: 14, y: 0, z: 14 }, rotationY: 0 });
    const road = readObjectTransform(byId.get("e0"), snapshot);
    assert.deepEqual(road.position, { x: 20, y: 0, z: 0 });
    assert.equal(Math.abs(road.rotationY), 0);
    assert.equal(readObjectTransform(byId.get("skybox"), snapshot), null);
    assert.equal(readObjectTransform({ id: "x", typeId: "vendor.thing" }, snapshot), null);
    assert.deepEqual(snapshot, manifest.document);
});

test("ED-02 transform deltas compose, invert, and decompose without Three", () => {
    const near = (left, right, message) => assert.ok(Math.abs(left - right) < 1e-9, message ?? `${left} ≈ ${right}`);
    const translate = deltaFromTranslation({ x: 1, y: 2, z: 3 });
    const yaw = deltaFromYaw(Math.PI / 2, { x: 10, z: 0 });
    const scale = deltaFromScale(2, { x: 0, y: 0, z: 0 });
    assert.deepEqual(applyDeltaToPoint(translate, { x: 0, y: 0, z: 0 }), { x: 1, y: 2, z: 3 });
    const turned = applyDeltaToPoint(yaw, { x: 11, y: 0, z: 0 });
    near(turned.x, 10);
    near(turned.z, -1, "yaw follows the Three.js Y-rotation convention");
    assert.deepEqual(applyDeltaToPoint(scale, { x: 1, y: 1, z: 1 }), { x: 2, y: 2, z: 2 });
    const composed = composeDeltas(translate, yaw);
    const stepwise = applyDeltaToPoint(translate, applyDeltaToPoint(yaw, { x: 11, y: 0, z: 0 }));
    const direct = applyDeltaToPoint(composed, { x: 11, y: 0, z: 0 });
    near(direct.x, stepwise.x);
    near(direct.z, stepwise.z);
    assert.equal(isIdentityDelta(composeDeltas(composed, invertDelta(composed))), true);
    assert.equal(isIdentityDelta(IDENTITY_DELTA), true);
    const parts = decomposeDelta(composeDeltas(translate, composeDeltas(yaw, scale)));
    near(parts.rotationY, Math.PI / 2);
    assert.equal(parts.yawOnly, true);
    assert.equal(parts.uniformScale, true);
    near(parts.scale.x, 2);
    const tilted = decomposeDelta(normalizeDelta([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]));
    assert.equal(tilted.yawOnly, false);
    assert.equal(decomposeDelta(deltaFromScale({ x: 1, y: 2, z: 1 })).uniformScale, false);
    assert.throws(() => normalizeDelta([1, 2, 3]), /16-element/);
    assert.throws(() => invertDelta(deltaFromScale(0)), /singular/);
    // Frames: composing a delta into a frame and measuring the delta between frames round-trips.
    const frame = { position: { x: 3, y: 0, z: 4 }, rotationY: 0.7, scale: 2 };
    const next = applyDeltaToFrame(deltaFromYaw(0.3, { x: 1, z: 1 }), frame);
    near(next.rotationY, 1);
    near(next.scale, 2);
    const between = decomposeDelta(deltaBetweenFrames(frame, next));
    near(between.rotationY, 0.3);
    assert.equal(between.uniformScale, true);
    assert.equal(isIdentityDelta(deltaBetweenFrames(frame, frame)), true);
});

test("ED-02 transform bindings plan document steps per type and reject unsupported deltas atomically", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const snapshot = structuredClone(manifest.document);
    const index = legacyIndex(snapshot);
    const records = new Map(deriveObjectGraph(snapshot).map((record) => [record.id, record]));
    const plan = (record, delta, context) => planObjectTransform(record, index, objectTypeRegistry, delta, context);
    const codes = (result) => result.issues.map((entry) => entry.code);
    const translate = deltaFromTranslation({ x: 1, y: 5, z: -2 });

    // Props: yaw + planar translation; Y translation ignored; scale rejected.
    const tire = plan(records.get("feature-tire"), composeDeltas(translate, deltaFromYaw(0.5, { x: 5, z: 30 })));
    assert.deepEqual(tire.issues, []);
    assert.equal(tire.steps.length, 1);
    assert.equal(tire.steps[0].op, "set-feature-transform");
    assert.equal(tire.steps[0].featureId, "feature-tire");
    assert.ok(Math.abs(tire.steps[0].x - 6) < 1e-9 && Math.abs(tire.steps[0].z - 28) < 1e-9);
    assert.ok(Math.abs(tire.steps[0].rotationY - 2) < 1e-9);
    assert.deepEqual(codes(plan(records.get("feature-tire"), deltaFromScale(2))), [TRANSFORM_ISSUE_CODES.SCALE_UNSUPPORTED]);
    const tiltedDelta = normalizeDelta([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(codes(plan(records.get("feature-tire"), tiltedDelta)), [TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED]);

    // Buildings: footprint through the delta, height follows Y scale, pitch rejected.
    const building = plan(records.get("building-0"), deltaFromScale(2, { x: 14, y: 0, z: 14 }));
    assert.deepEqual(building.issues, []);
    assert.deepEqual(building.steps[0], {
        op: "set-building-footprint",
        buildingId: "building-0",
        footprint: [{ x: 6, y: 0, z: 6 }, { x: 22, y: 0, z: 6 }, { x: 22, y: 0, z: 22 }, { x: 6, y: 0, z: 22 }],
        height: 16,
    });
    assert.deepEqual(codes(plan(records.get("building-0"), tiltedDelta)), [TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED]);

    // Roads move both endpoints; intersections move their node; any delta is a valid point map.
    const road = plan(records.get("e1"), translate);
    assert.deepEqual(road.issues, []);
    assert.deepEqual(road.steps, [
        { op: "move-node", nodeId: "n1", position: { x: 41, y: 5, z: -2 } },
        { op: "move-node", nodeId: "n2", position: { x: 41, y: 5, z: 38 } },
    ]);
    assert.deepEqual(plan(records.get("n2"), deltaFromScale(2)).steps, [
        { op: "move-node", nodeId: "n2", position: { x: 80, y: 0, z: 80 } },
    ]);

    // Groups compose the delta into their pivot frame; non-uniform scale rejected.
    const group = { id: "g", typeId: "group", typeVersion: 1, name: "G", parentId: null, order: 0, components: { transform: { position: { x: 1, y: 0, z: 1 }, rotationY: 0, scale: 1 } } };
    const grouped = plan(group, deltaFromYaw(Math.PI / 2, { x: 0, z: 0 }));
    assert.deepEqual(grouped.issues, []);
    assert.equal(grouped.steps[0].op, "set-object-component");
    assert.equal(grouped.steps[0].key, "transform");
    assert.ok(Math.abs(grouped.steps[0].value.rotationY - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(grouped.steps[0].value.position.x - 1) < 1e-9 && Math.abs(grouped.steps[0].value.position.z + 1) < 1e-9);
    assert.deepEqual(codes(plan(group, deltaFromScale({ x: 1, y: 1, z: 2 }))), [TRANSFORM_ISSUE_CODES.NON_UNIFORM_SCALE]);

    // Not transformable: skybox, unknown types, asset instances, missing legacy.
    assert.deepEqual(codes(plan(records.get("skybox"), translate)), [TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE]);
    assert.deepEqual(codes(plan({ id: "x", typeId: "vendor.thing" }, translate)), [TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE]);
    assert.deepEqual(codes(plan({ id: "ai", typeId: "asset-instance", components: { asset: { assetId: "a" } } }, translate)), [TRANSFORM_ISSUE_CODES.NOT_TRANSFORMABLE]);
    assert.deepEqual(codes(plan({ id: "ghost", typeId: "builtin-prop" }, translate)), [TRANSFORM_ISSUE_CODES.MISSING]);
    // Planning never mutates.
    assert.deepEqual(snapshot, manifest.document);
    // Capabilities agree with bindings.
    for (const typeId of ["road", "intersection", "building", "builtin-prop", "group"]) {
        assert.equal(objectTypeRegistry.get(typeId).capabilities.transformable, true, typeId);
    }
    for (const typeId of ["skybox", "tile", "asset-instance"]) {
        assert.equal(objectTypeRegistry.get(typeId).capabilities.transformable, false, typeId);
    }
});

test("ED-01 reconcileObjectGraph adds overlays for uncovered legacy records and drops orphans", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const existing = [
        { id: "group-a", typeId: "group", name: "A", order: 0, components: { tags: ["keep"] } },
        { id: "feature-cone", typeId: "builtin-prop", name: "Renamed cone", parentId: "group-a", order: 0, components: { locked: true } },
        { id: "ghost", typeId: "builtin-prop", order: 1 },
        { id: "tile", typeId: "tile", order: 2 },
        { id: "vendor-1", typeId: "vendor.thing", typeVersion: 7, order: 3, components: { opaque: { nested: [1] } } },
    ];
    const result = reconcileObjectGraph(manifest.document, existing, objectTypeRegistry, SKY);
    assert.deepEqual(result.orphaned, ["ghost", "tile"]);
    assert.equal(result.added.length, 12);
    assert.ok(result.added.includes("skybox"));
    assert.ok(!result.added.includes("feature-cone"));
    const byId = new Map(result.records.map((record) => [record.id, record]));
    assert.equal(byId.get("feature-cone").name, "Renamed cone");
    assert.equal(byId.get("feature-cone").parentId, "group-a");
    assert.equal(byId.get("feature-cone").components.locked, true);
    assert.deepEqual(byId.get("group-a").components.tags, ["keep"]);
    assert.deepEqual(byId.get("vendor-1").components, { tags: [], locked: false, editorHidden: false, opaque: { nested: [1] } });
    assert.equal(byId.get("vendor-1").typeVersion, 7);
    assert.ok(result.added.every((id) => byId.get(id).order > 3), "added records append after existing orders");
    assert.deepEqual(result.records, sortObjectRecords(result.records));
    const validation = validateObjectGraph({ ...manifest.document, objects: result.records }, objectTypeRegistry, SKY);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues.map((entry) => entry.code), [OBJECT_ISSUE_CODES.TYPE_UNSUPPORTED]);
    // Reconciling an already complete graph is a no-op.
    const again = reconcileObjectGraph(manifest.document, result.records, objectTypeRegistry, SKY);
    assert.deepEqual(again, { records: result.records, added: [], orphaned: [] });
});

test("ED-01 object-graph cases matrix", async (t) => {
    const fixture = await readEnvironmentEditorFixture("object-graph-cases.v1.json");
    assert.equal(fixture.kind, "cev-sim.environment-editor.object-graph-cases");
    const covered = new Set();
    for (const entry of fixture.cases) {
        await t.test(entry.id, () => {
            const document = fixture.documents[entry.document];
            const omit = new Set([...(entry.replace ?? []), ...(entry.omit ?? [])]);
            const base = entry.extend ? fixture.yardComplete.filter((record) => !omit.has(record.id)) : [];
            const snapshot = {
                ...document,
                ...(entry.objectGraphVersion !== undefined ? { objectGraphVersion: entry.objectGraphVersion } : {}),
                objects: [...base, ...entry.objects],
            };
            const result = validateObjectGraph(snapshot, objectTypeRegistry, SKY);
            const codes = [...new Set(result.issues.map((issue) => issue.code))].sort();
            assert.deepEqual({ ok: result.ok, codes }, entry.expect, JSON.stringify(result.issues, null, 2));
            for (const issue of result.issues) {
                assert.ok(Array.isArray(issue.path) && issue.path[0] === "objects" || issue.path[0] === "objectGraphVersion");
                assert.ok(["error", "warning"].includes(issue.severity));
                assert.equal(typeof issue.message, "string");
            }
            codes.forEach((code) => covered.add(code));
        });
    }
    const allCodes = Object.values(OBJECT_ISSUE_CODES).filter((code) => code !== OBJECT_ISSUE_CODES.TILE_MULTIPLE);
    assert.deepEqual([...covered].sort(), allCodes.sort());
});

test("ED-01 validateObjectRecords validates a candidate change atomically without mutating the document", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const before = document.snapshot();
    const candidate = document.objects.map((record) => (
        record.id === "feature-cone" ? { ...record, parentId: "group-x" } : record
    ));
    candidate.push({ id: "group-x", typeId: "group", typeVersion: 1, name: "X", parentId: "group-x", order: 99, components: {} });
    const result = validateObjectRecords(candidate, legacyIndex(document.snapshot()), objectTypeRegistry, SKY);
    assert.equal(result.ok, false);
    // The self-parented group never terminates its ancestor chain, so its child reports a cycle too.
    assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [OBJECT_ISSUE_CODES.PARENT_CYCLE, OBJECT_ISSUE_CODES.PARENT_SELF]);
    assert.deepEqual(document.snapshot(), before);
    assert.equal(document.getObject("group-x"), null);

    const fixed = candidate.map((record) => (record.id === "group-x" ? { ...record, parentId: null } : record));
    const accepted = validateObjectRecords(fixed, legacyIndex(document.snapshot()), objectTypeRegistry, SKY);
    assert.deepEqual(accepted, { ok: true, issues: [] });
    document.replaceObjectGraph(fixed);
    assert.equal(document.getObject("feature-cone").parentId, "group-x");
});

test("ED-01 EnvironmentDocument snapshot omits objects when empty and round-trips them when present", async () => {
    const manifest = await readEnvironmentEditorFixture("legacy-v2.yard.json");
    const document = EnvironmentDocument.fromManifest(manifest.document);
    assert.deepEqual(document.objects, []);
    assert.equal(Object.hasOwn(document.snapshot(), "objects"), false);
    assert.equal(Object.hasOwn(document.snapshot(), "objectGraphVersion"), false);

    const records = deriveObjectGraph(document.snapshot());
    document.replaceObjectGraph(records);
    const snapshot = document.snapshot();
    assert.equal(snapshot.objectGraphVersion, 1);
    assert.deepEqual(snapshot.objects, records);
    assert.notEqual(snapshot.objects, document.objects);

    const restored = EnvironmentDocument.fromManifest(snapshot);
    assert.deepEqual(restored.snapshot(), snapshot);
    restored.restoreSnapshot(manifest.document);
    assert.deepEqual(restored.objects, []);
    let notified = 0;
    const unsubscribe = restored.subscribe(() => { notified += 1; });
    restored.replaceObjectGraph(records);
    unsubscribe();
    assert.equal(notified, 2);
    assert.equal(restored.getObject("feature-cone").typeId, "builtin-prop");
});

test("ED-01 the object graph never enters worldHash", async () => {
    for (const name of ["legacy-v2.yard.json", "legacy-v3.city-grid.json", "all-props.v3.json", "schema-v4.sample.json"]) {
        const manifest = await readEnvironmentEditorFixture(name);
        const stripped = { ...manifest, document: { ...manifest.document } };
        delete stripped.document.objects;
        delete stripped.document.objectGraphVersion;
        const withGraph = {
            ...manifest,
            schemaVersion: 4,
            document: { ...stripped.document, objectGraphVersion: 1, objects: deriveObjectGraph(stripped.document) },
        };
        assert.equal(createWorldResource(withGraph).hash, createWorldResource(stripped).hash, name);
    }
});

test("ED-01 unsupported types are described explicitly and never substituted", () => {
    const registry = createBuiltinObjectTypeRegistry();
    assert.equal(describeObjectSupport({ typeId: "group", typeVersion: 1 }, registry), OBJECT_SUPPORT.SUPPORTED);
    assert.equal(describeObjectSupport({ typeId: "group", typeVersion: 9 }, registry), OBJECT_SUPPORT.UNSUPPORTED_VERSION);
    assert.equal(describeObjectSupport({ typeId: "vendor.thing", typeVersion: 1 }, registry), OBJECT_SUPPORT.UNSUPPORTED_TYPE);
    assert.equal(describeObjectSupport({}, registry), OBJECT_SUPPORT.UNSUPPORTED_TYPE);
});
