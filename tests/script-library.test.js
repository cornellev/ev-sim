import assert from "node:assert/strict";
import test from "node:test";

import {
    createArtifactOnlyDocument,
    createScriptDocument,
    normalizeScriptDocument
} from "../app/scripting/EditorDocument.js";
import {
    createScriptFolder,
    normalizeScriptFolders
} from "../app/scripting/ScriptLibrary.js";
import { VISUAL_SCRIPT_KIND, VISUAL_SCRIPT_VERSION } from "../app/scripting/runtime/Artifact.js";

test("script folders normalize names and discard duplicate ids", () => {
    const folders = normalizeScriptFolders([
        { id: " controls ", name: " Controls " },
        { id: "controls", name: "Duplicate" },
        { id: "planning", name: " Planning " }
    ]);

    assert.deepEqual(folders, [
        { id: "controls", name: "Controls" },
        { id: "planning", name: "Planning" }
    ]);
    assert.equal(createScriptFolder({ id: "new", name: "  " }).name, "Untitled folder");
});

test("script documents preserve optional folder assignments and migrate unfiled documents", () => {
    const filed = createScriptDocument({ id: "drive", folderId: " controls " });
    const legacy = normalizeScriptDocument({ ...filed, folderId: undefined });

    assert.equal(filed.folderId, "controls");
    assert.equal(normalizeScriptDocument(filed).folderId, "controls");
    assert.equal(legacy.folderId, null);

    const artifact = {
        kind: VISUAL_SCRIPT_KIND,
        version: VISUAL_SCRIPT_VERSION,
        name: "Compiled",
        nodes: [],
        connections: [],
        interface: { inputs: [], outputs: [] }
    };
    assert.equal(createArtifactOnlyDocument(artifact, { folderId: "compiled" }).folderId, "compiled");
});
