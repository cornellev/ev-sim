import assert from "node:assert/strict";
import test from "node:test";

import {
    CATALOG_DRAG_MIME,
    PLACEMENT_DRAG_MIME,
    canAcceptCatalogDrop,
    catalogDropDestination,
    folderSubtreeIds,
    parseCatalogDragPayload,
} from "../app/3d/overlay/workspace/assetCatalogDrop.js";

const folders = [
    { id: "props", name: "Props", parentId: null },
    { id: "bins", name: "Bins", parentId: "props" },
    { id: "yard", name: "Yard", parentId: null },
];

test("catalogDropDestination accepts Unfiled and real folders only", () => {
    assert.equal(catalogDropDestination({ id: "all" }), null);
    assert.equal(catalogDropDestination({ id: "built-ins" }), null);
    assert.equal(catalogDropDestination(null), null);
    assert.equal(catalogDropDestination({}), null);
    assert.deepEqual(catalogDropDestination({ id: "root" }), { folderId: null, parentId: null });
    assert.deepEqual(catalogDropDestination({ id: "props" }), { folderId: "props", parentId: "props" });
});

test("parseCatalogDragPayload reads asset and folder catalog transfers", () => {
    assert.equal(parseCatalogDragPayload(""), null);
    assert.equal(parseCatalogDragPayload("{"), null);
    assert.equal(parseCatalogDragPayload(JSON.stringify({ kind: "scene", id: "x" })), null);
    assert.deepEqual(parseCatalogDragPayload(JSON.stringify({ kind: "asset", id: "crate", folderId: "props" })), {
        kind: "asset", id: "crate", folderId: "props", parentId: null,
    });
    assert.deepEqual(parseCatalogDragPayload(JSON.stringify({ kind: "folder", id: "bins", parentId: "props" })), {
        kind: "folder", id: "bins", folderId: null, parentId: "props",
    });
    assert.equal(CATALOG_DRAG_MIME, "application/x-cev-editor-catalog");
    assert.equal(PLACEMENT_DRAG_MIME, "application/x-cev-editor-asset");
});

test("canAcceptCatalogDrop rejects virtual targets, no-ops, self, and descendants", () => {
    const unfiledAsset = { kind: "asset", id: "crate", folderId: null };
    assert.equal(canAcceptCatalogDrop(unfiledAsset, { id: "all" }, folders), false);
    assert.equal(canAcceptCatalogDrop(unfiledAsset, { id: "built-ins" }, folders), false);
    assert.equal(canAcceptCatalogDrop(unfiledAsset, { id: "root" }, folders), false);
    assert.equal(canAcceptCatalogDrop(unfiledAsset, { id: "props" }, folders), true);
    assert.equal(canAcceptCatalogDrop({ kind: "asset", id: "crate", folderId: "props" }, { id: "props" }, folders), false);
    assert.equal(canAcceptCatalogDrop({ kind: "asset", id: "crate", folderId: "props" }, { id: "root" }, folders), true);

    const propsFolder = { kind: "folder", id: "props", parentId: null };
    assert.equal(canAcceptCatalogDrop(propsFolder, { id: "root" }, folders), false);
    assert.equal(canAcceptCatalogDrop(propsFolder, { id: "props" }, folders), false);
    assert.equal(canAcceptCatalogDrop(propsFolder, { id: "bins" }, folders), false);
    assert.equal(canAcceptCatalogDrop({ kind: "folder", id: "bins", parentId: "props" }, { id: "root" }, folders), true);
    assert.equal(canAcceptCatalogDrop({ kind: "folder", id: "bins", parentId: "props" }, { id: "props" }, folders), false);
    assert.equal(canAcceptCatalogDrop({ kind: "folder", id: "bins", parentId: "props" }, { id: "yard" }, folders), true);
    const propsTree = folderSubtreeIds(folders, "props");
    assert.equal(propsTree.has("props"), true);
    assert.equal(propsTree.has("bins"), true);
    assert.equal(propsTree.has("yard"), false);
});
