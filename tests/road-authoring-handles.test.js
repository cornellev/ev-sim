import assert from "node:assert/strict";
import test from "node:test";

import { PerceptionTruthIndex } from "../app/autonomy/PerceptionTruthIndex.js";
import { syncRoadsFromDocument } from "../app/3d/editor/document/adapters/RoadRuntimeAdapter.js";
import {
    ROAD_AUTHORING_HANDLE_KINDS,
    ROAD_AUTHORING_HANDLES_NAME,
} from "../app/3d/editor/projection/roadRuntimeEntities.js";
import { setRoadAuthoringHandlesVisible } from "../app/3d/runtimeVisibility.js";
import { createEditorHarness } from "./helpers/editorRuntimeHarness.js";

function handleMeshes(group) {
    return (group?.children ?? []).filter((child) => child.userData?.editorHelper === true);
}

test("road authoring handles parent under one group, skip perception, and hide when Simulation is active", async () => {
    const harness = await createEditorHarness({ fixture: "asymmetric-lanes.v2.json" });
    const group = harness.scene.getObjectByName(ROAD_AUTHORING_HANDLES_NAME);
    assert.ok(group, "handles share a RoadAuthoringHandles group");
    assert.equal(group.visible, true, "undefined authoringHelpersVisible stays visible for editor tests");

    const handles = handleMeshes(group);
    assert.ok(handles.length > 0, "v2 roads create node/knot/handle spheres");
    for (const handle of handles) {
        assert.equal(handle.parent, group);
        assert.equal(handle.userData.bakeIgnore, true);
        assert.equal(handle.userData.editorHelper, true);
        assert.equal(handle.userData.perceptionSourceId, undefined);
        assert.equal(handle.userData.skipEnvironmentSelection, undefined);
    }

    const kinds = new Set(harness.registry.listEntities().map((entity) => entity.kind));
    assert.ok(ROAD_AUTHORING_HANDLE_KINDS.some((kind) => kinds.has(kind)));

    const truth = new PerceptionTruthIndex();
    const snapshot = truth.refresh({ scene: harness.scene, environmentRegistry: harness.registry });
    assert.equal(snapshot.some((entity) => ROAD_AUTHORING_HANDLE_KINDS.includes(entity.kind)), false);

    setRoadAuthoringHandlesVisible(harness.data, false);
    assert.equal(harness.environment.authoringHelpersVisible, false);
    assert.equal(group.visible, false);

    syncRoadsFromDocument(harness.data, harness.scene, harness.document);
    const rebuilt = harness.scene.getObjectByName(ROAD_AUTHORING_HANDLES_NAME);
    assert.equal(rebuilt.visible, false, "rebuilds while Simulation is active stay hidden");
    assert.ok(handleMeshes(rebuilt).length > 0, "meshes remain for editor picking after return");

    setRoadAuthoringHandlesVisible(harness.data, true);
    assert.equal(rebuilt.visible, true);
});
