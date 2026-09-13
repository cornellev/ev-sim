import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { placeAssetInstance, updateAssetInstances } from "../app/3d/editor/commands/assetCommands.js";
import { duplicateObjects } from "../app/3d/editor/commands/objectCommands.js";
import { deltaFromTranslation, deltaFromYaw } from "../app/3d/editor/objects/transformDelta.js";

function assetRecord(id = "asset-1", overrides = {}) {
    return {
        id, typeId: "asset-instance", typeVersion: 1, name: "Crate", parentId: null, order: 0,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: {
                assetId: "crate", revision: 1,
                position: { x: 1, y: 2, z: 3 }, rotationY: 0,
                scale: { x: 1, y: 2, z: 3 }, overrides: {},
                ...overrides,
            },
        },
    };
}

test.beforeEach(() => resetDocumentIdCounter());

test("ED-06 placement, transform gestures, cancel, undo, redo, and duplication preserve object records", () => {
    const document = new EnvironmentDocument({ objects: [] });
    const service = createEnvironmentCommandService({ document });
    const placed = service.bus.execute(placeAssetInstance({ record: assetRecord() }));
    assert.equal(placed.ok, true, JSON.stringify(placed.issues));
    const initial = structuredClone(document.getObject("asset-1"));

    const gesture = service.bus.beginGesture({ objectIds: ["asset-1"] });
    assert.equal(gesture.ok, true);
    assert.deepEqual([...gesture.closure.objectIds], ["asset-1"]);
    assert.equal(service.bus.updateGesture(gesture.gestureId, deltaFromTranslation({ x: 5, z: -2 })).ok, true);
    assert.deepEqual(document.getObject("asset-1").components.asset.position, { x: 6, y: 2, z: 1 });
    service.bus.cancelGesture(gesture.gestureId);
    assert.deepEqual(document.getObject("asset-1"), initial);

    const rotated = service.bus.beginGesture({ objectIds: ["asset-1"] });
    service.bus.updateGesture(rotated.gestureId, deltaFromYaw(Math.PI / 2));
    assert.equal(service.bus.commitGesture(rotated.gestureId).ok, true);
    const final = structuredClone(document.getObject("asset-1"));
    assert.notDeepEqual(final, initial);
    service.bus.undo();
    assert.deepEqual(document.getObject("asset-1"), initial);
    service.bus.redo();
    assert.deepEqual(document.getObject("asset-1"), final);

    const duplicated = service.bus.execute(duplicateObjects({ objectIds: ["asset-1"] }));
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated.issues));
    const copy = document.getObject(duplicated.result.createdIds[0]);
    assert.match(copy.id, /^asset-/);
    assert.deepEqual(copy.components.asset, final.components.asset);
});

test("ED-06 revision updates are all-or-nothing for stale, mixed, and locked targets", () => {
    const document = new EnvironmentDocument({ objects: [assetRecord("a"), assetRecord("b")] });
    const service = createEnvironmentCommandService({ document });
    const changes = ["a", "b"].map((objectId) => {
        const beforeAsset = structuredClone(document.getObject(objectId).components.asset);
        return { objectId, beforeAsset, afterAsset: { ...structuredClone(beforeAsset), revision: 2 } };
    });
    const expectedDocumentVersion = document.version;
    document.getObject("b").components.locked = true;
    const before = document.snapshot();
    const locked = service.bus.execute(updateAssetInstances({ expectedDocumentVersion, targetRevision: 2, changes }));
    assert.equal(locked.ok, false);
    assert.deepEqual(document.snapshot(), before);

    document.getObject("b").components.locked = false;
    document.notify();
    const stale = service.bus.execute(updateAssetInstances({ expectedDocumentVersion, targetRevision: 2, changes }));
    assert.equal(stale.ok, false);
    assert.equal(stale.issues[0].code, "command.document.stale");
    assert.deepEqual(document.objects.filter((record) => record.typeId === "asset-instance").map((record) => record.components.asset.revision), [1, 1]);

    const freshChanges = ["a", "b"].map((objectId) => {
        const beforeAsset = structuredClone(document.getObject(objectId).components.asset);
        return { objectId, beforeAsset, afterAsset: { ...structuredClone(beforeAsset), revision: 2 } };
    });
    const updated = service.bus.execute(updateAssetInstances({ expectedDocumentVersion: document.version, targetRevision: 2, changes: freshChanges }));
    assert.equal(updated.ok, true, JSON.stringify(updated.issues));
    assert.deepEqual(updated.result.objectIds, ["a", "b"]);
    assert.deepEqual(document.objects.filter((record) => record.typeId === "asset-instance").map((record) => record.components.asset.revision), [2, 2]);
    service.bus.undo();
    assert.deepEqual(document.objects.filter((record) => record.typeId === "asset-instance").map((record) => record.components.asset.revision), [1, 1]);
});
