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
    readObjectTransform,
    reconcileObjectGraph,
    sortObjectRecords,
    validateObjectGraph,
    validateObjectRecords,
} from "../app/3d/editor/objects/index.js";
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
