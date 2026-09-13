import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    collectAssetInstanceReferences,
    normalizeEditorAssetCatalog,
    normalizeEditorAssetRevision,
    validateAssetInstanceComponent,
    validateEditorAssetCatalog,
    validateEditorAssetRevision,
} from "../app/editor-assets/EditorAssetContract.js";
import { objectTypeRegistry, validateObjectGraph } from "../app/3d/editor/objects/index.js";

const USE_HASH = "a".repeat(64);
const NOW = "2026-09-12T12:00:00.000Z";

test("ED-06 editor asset catalog and immutable revision records normalize and validate", () => {
    const catalog = normalizeEditorAssetCatalog({
        revision: 3,
        folders: [{ id: "yard", name: "Yard", parentId: null }],
        assets: [{
            id: "crate", name: "Crate", folderId: "yard", tags: ["cargo", "cargo"], archived: false,
            latestRevision: 1, thumbnails: { 1: { useHash: USE_HASH, rendererVersion: 1 } },
            createdAt: NOW, updatedAt: NOW,
        }],
    });
    assert.deepEqual(validateEditorAssetCatalog(catalog), []);
    assert.deepEqual(normalizeEditorAssetCatalog(structuredClone(catalog)), catalog);

    const revision = normalizeEditorAssetRevision({
        assetId: "crate", revision: 1, publicationId: "publish-1", modelUseHash: USE_HASH, createdAt: NOW,
    });
    assert.deepEqual(validateEditorAssetRevision(revision), []);
    assert.deepEqual(normalizeEditorAssetRevision(structuredClone(revision)), revision);
});

test("ED-06 validators reject folder cycles, malformed revisions, transforms, and overrides", () => {
    const catalog = normalizeEditorAssetCatalog({
        folders: [{ id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }],
    });
    assert.ok(validateEditorAssetCatalog(catalog).some((entry) => entry.code === "editor-asset.folder.cycle"));
    assert.ok(validateEditorAssetRevision({}).length > 0);
    const issues = validateAssetInstanceComponent({
        assetId: "crate", revision: 0,
        position: { x: Number.NaN, y: 0, z: 0 }, rotationY: Infinity,
        scale: { x: 1, y: 0, z: -1 }, overrides: { material: "red" },
    });
    assert.deepEqual(new Set(issues.map((entry) => entry.code)), new Set([
        "editor-asset.instance.revision",
        "editor-asset.instance.finite",
        "editor-asset.instance.scale",
        "editor-asset.instance.overrides",
    ]));
});

test("ED-06 object validation sees malformed raw asset values before normalization", () => {
    const document = {
        objectGraphVersion: 1,
        roads: { nodes: [], edges: [] }, buildings: [], features: [], objects: [{
            id: "asset-1", typeId: "asset-instance", typeVersion: 1, name: "Crate", parentId: null, order: 0,
            components: {
                tags: [], locked: false, editorHidden: false,
                asset: { assetId: "crate", revision: 0, position: { x: "bad", y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 } },
            },
        }],
    };
    const result = validateObjectGraph(document, objectTypeRegistry, {});
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.optionCode === "editor-asset.instance.revision"));
    assert.ok(result.issues.some((entry) => entry.optionCode === "editor-asset.instance.finite"));
});

test("ED-06 reference extraction returns stable pinned references", () => {
    assert.deepEqual(collectAssetInstanceReferences({ objects: [
        { id: "z", typeId: "group", components: {} },
        { id: "b", typeId: "asset-instance", components: { asset: { assetId: "cone", revision: 3 } } },
        { id: "a", typeId: "asset-instance", components: { asset: { assetId: "crate", revision: 1 } } },
    ] }), [
        { objectId: "a", assetId: "crate", revision: 1 },
        { objectId: "b", assetId: "cone", revision: 3 },
    ]);
});

test("ED-06/ED-07 contract modules import without browser globals", () => {
    const source = [
        "for (const key of ['window','document','navigator']) Object.defineProperty(globalThis, key, { get() { throw new Error(key + ' accessed'); }, configurable: true });",
        "await import('./app/editor-assets/EditorAssetContract.js');",
        "await import('./app/editor-assets/AssetDefinition.js');",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--experimental-default-type=module", "--input-type=module", "--eval", source], {
        cwd: new URL("../", import.meta.url), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
});
