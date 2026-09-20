import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { PerceptionTruthIndex } from "../app/autonomy/PerceptionTruthIndex.js";
import {
    HANDLE_PIXEL_SIZES,
    ROAD_AUTHORING_HANDLE_KINDS,
    ROAD_AUTHORING_HANDLE_STEMS_NAME,
    ROAD_AUTHORING_HANDLES_NAME,
    createEndpointHandle,
    scaleHandleToPixels,
    shouldShowRoadTangentHandle,
    syncRoadAuthoringHandleOverlay,
} from "../app/3d/editor/projection/roadRuntimeEntities.js";
import { setRoadAuthoringHandlesVisible } from "../app/3d/runtimeVisibility.js";
import { createEditorHarness } from "./helpers/editorRuntimeHarness.js";

function handleMarkers(group) {
    return (group?.children ?? []).filter((child) => child.userData?.editorHelper === true);
}

function childNamed(object3D, suffix) {
    return object3D?.children?.find((child) => child.name?.endsWith(suffix)) ?? null;
}

test("road authoring handles parent under one group, skip perception, and hide when Simulation is active", async () => {
    const harness = await createEditorHarness({ fixture: "asymmetric-lanes.v2.json" });
    const group = harness.scene.getObjectByName(ROAD_AUTHORING_HANDLES_NAME);
    assert.ok(group, "handles share a RoadAuthoringHandles group");
    assert.equal(group.visible, true, "undefined authoringHelpersVisible stays visible for editor tests");

    const handles = handleMarkers(group);
    assert.ok(handles.length > 0, "v2 roads create node/knot/handle markers");
    for (const handle of handles) {
        assert.equal(handle.isGroup, true);
        assert.equal(handle.parent, group);
        assert.equal(handle.userData.bakeIgnore, true);
        assert.equal(handle.userData.editorHelper, true);
        assert.equal(handle.userData.perceptionSourceId, undefined);
        assert.equal(handle.userData.skipEnvironmentSelection, undefined);
        const fill = childNamed(handle, ":fill");
        const halo = childNamed(handle, ":halo");
        assert.ok(fill?.isMesh, "fill sphere child");
        assert.ok(halo?.isMesh, "halo sphere child");
        assert.equal(fill.material.isMeshBasicMaterial, true);
        assert.equal(fill.material.depthTest, false);
        assert.equal(halo.material.depthTest, false);
        assert.equal(fill.renderOrder, 1001);
        assert.equal(halo.renderOrder, 1000);
    }

    const kinds = new Set(harness.registry.listEntities().map((entity) => entity.kind));
    assert.ok(ROAD_AUTHORING_HANDLE_KINDS.some((kind) => kinds.has(kind)));

    const truth = new PerceptionTruthIndex();
    const snapshot = truth.refresh({ scene: harness.scene, environmentRegistry: harness.registry });
    assert.equal(snapshot.some((entity) => ROAD_AUTHORING_HANDLE_KINDS.includes(entity.kind)), false);

    setRoadAuthoringHandlesVisible(harness.data, false);
    assert.equal(harness.environment.authoringHelpersVisible, false);
    assert.equal(group.visible, false);

    harness.projector.applyFullDocument({ source: "load" });
    const rebuilt = harness.scene.getObjectByName(ROAD_AUTHORING_HANDLES_NAME);
    assert.equal(rebuilt.visible, false, "rebuilds while Simulation is active stay hidden");
    assert.ok(handleMarkers(rebuilt).length > 0, "meshes remain for editor picking after return");

    setRoadAuthoringHandlesVisible(harness.data, true);
    assert.equal(rebuilt.visible, true);

    harness.registry.registerExistingContent(harness.scene, harness.data);
    for (const handle of handleMarkers(rebuilt)) {
        const fill = childNamed(handle, ":fill");
        const halo = childNamed(handle, ":halo");
        assert.equal(fill?.parent, handle, "hydrate must not steal fill meshes into chunks");
        assert.equal(halo?.parent, handle);
        assert.equal(String(fill?.parent?.name ?? "").startsWith("EnvironmentChunk"), false);
    }
});

test("scaleHandleToPixels keeps fill diameter in pixels, clamped to world radius", () => {
    const handle = createEndpointHandle({ id: "n0", x: 0, y: 0, z: 0 });
    assert.equal(handle.userData.handlePixelSize, HANDLE_PIXEL_SIZES["road-node"]);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 20);
    camera.updateMatrixWorld();
    const renderer = { domElement: { clientHeight: 800 } };
    const scale = scaleHandleToPixels(handle, camera, renderer);
    const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(50) / 2) * 20;
    const expected = Math.min(1.5, Math.max(0.08, HANDLE_PIXEL_SIZES["road-node"] * worldHeight / 800 / 2));
    assert.ok(Math.abs(scale - expected) < 1e-9);
    assert.equal(handle.scale.x, scale);
});

test("tangent handles stay hidden until a knot is selected or Road handles is on", async () => {
    const harness = await createEditorHarness({ fixture: "asymmetric-lanes.v2.json" });
    const tangents = harness.registry.listEntities()
        .filter((entity) => entity.kind === "road-handle")
        .map((entity) => harness.registry.getEntity(entity.id));
    assert.ok(tangents.length > 0, "v2 roads create Bézier handles");
    for (const entity of tangents) {
        assert.equal(entity.object3D.visible, false);
    }

    const knot = harness.registry.getEntity(
        `road-knot:${tangents[0].edgeId}:${tangents[0].knotId}`,
    );
    const sub = { kind: "road-knot", edgeId: knot.edgeId, knotId: knot.knotId };
    assert.equal(shouldShowRoadTangentHandle(tangents[0], { sub: { kind: "road-node", id: "n0" } }), false);

    syncRoadAuthoringHandleOverlay({
        scene: harness.scene,
        registry: harness.registry,
        sub,
        showAll: false,
    });
    const selected = tangents.filter((entity) => entity.edgeId === knot.edgeId && entity.knotId === knot.knotId);
    const others = tangents.filter((entity) => entity.edgeId !== knot.edgeId || entity.knotId !== knot.knotId);
    assert.ok(selected.length > 0);
    for (const entity of selected) assert.equal(entity.object3D.visible, true);
    for (const entity of others) assert.equal(entity.object3D.visible, false);

    const stems = harness.scene.getObjectByName(ROAD_AUTHORING_HANDLE_STEMS_NAME);
    assert.ok(stems);
    assert.equal(stems.userData.skipEnvironmentSelection, true);
    assert.equal(stems.children.length, selected.length);
    assert.equal(stems.parent, harness.scene);
    assert.notEqual(stems.parent, harness.scene.getObjectByName(ROAD_AUTHORING_HANDLES_NAME));

    syncRoadAuthoringHandleOverlay({
        scene: harness.scene,
        registry: harness.registry,
        sub: null,
        showAll: true,
    });
    for (const entity of tangents) assert.equal(entity.object3D.visible, true);
    assert.equal(stems.children.length, tangents.length);

    setRoadAuthoringHandlesVisible(harness.data, false);
    assert.equal(stems.visible, false);
});
