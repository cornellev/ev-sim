import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "../app/3d/editor/EditorState.js";
import { AssetRepository } from "../app/3d/editor/assets/AssetRepository.js";

test("ED-06 preview tabs replace one unpinned tab, preserve pinned tabs, and stay out of persistence", () => {
    const editor = new EditorState();
    const first = editor.openAssetTab({ id: "oak", revision: 1, name: "Oak" });
    const second = editor.openAssetTab({ id: "car", revision: 2, name: "Car" });
    assert.notEqual(first, second);
    assert.deepEqual(editor.snapshot().workspace.assetTabs.map((tab) => tab.assetId), ["car"]);
    editor.pinAssetTab(second);
    editor.openAssetTab({ id: "lamp", revision: 1, name: "Lamp" });
    assert.deepEqual(editor.snapshot().workspace.assetTabs.map((tab) => [tab.assetId, tab.pinned]), [["car", true], ["lamp", false]]);
    editor.setWorkspaceTab("scene");
    assert.equal(editor.snapshot().workspace.activeTabId, "scene");
    assert.equal(editor.persistedSnapshot().workspace, undefined);
    editor.closeAssetTab(second);
    assert.deepEqual(editor.snapshot().workspace.assetTabs.map((tab) => tab.assetId), ["lamp"]);
});

test("ED-06 repository reports catalog revision changes once", async () => {
    const revisions = [];
    const requests = [];
    const repository = new AssetRepository({
        fetch: async (_url, options) => {
            requests.push(options);
            return new Response(JSON.stringify({ catalogRevision: 7, assets: [], folders: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        visualAssets: {},
    });
    repository.subscribe((revision) => revisions.push(revision));
    await repository.list();
    await repository.list();
    assert.deepEqual(revisions, [7]);
    assert.deepEqual(requests.map((request) => request.cache), ["no-store", "no-store"]);
});
