import assert from "node:assert/strict";
import test from "node:test";

import { applyEditorVisibility, isObjectShown } from "../app/vehicles/editor/editorVisibility.js";
import {
    buildVehicleHierarchy,
    clearModelNodeVisibility,
    hierarchyNodesFromLease,
    hierarchyVisibilityKey,
    retainModelAndZoneVisibility,
} from "../app/vehicles/editor/workspace/vehicleHierarchyModel.js";

const nodes = [
    { index: 0, name: "root", parentIndex: null },
    { index: 1, name: "spare", parentIndex: 0 },
    { index: 2, name: "wheel", parentIndex: 0 },
    { index: 3, name: "hub", parentIndex: 2 },
];

function manifest(extra = {}) {
    return {
        model: { asset: "car.glb", hiddenNodeIndices: [1], ...extra.model },
        wheels: extra.wheels ?? [
            { id: "front-left", axle: "front", visual: { kind: "model-node", nodeIndex: 2 } },
            { id: "rear-left", axle: "rear" },
        ],
        sensors: extra.sensors ?? [{ id: "front-left", name: "Roof lidar", type: "lidar3d" }],
    };
}

function row(rows, kind, id) {
    const match = rows.find((entry) => entry.kind === kind && entry.id === id);
    assert.ok(match, `${kind}:${id}`);
    return match;
}

test("glTF parent indexes come from node children", () => {
    const listed = hierarchyNodesFromLease({
        gltfJson: {
            nodes: [
                { name: "root", children: [1, 2] },
                { name: "spare", children: [3] },
                { name: "wheel" },
                {},
            ],
        },
    });
    assert.deepEqual(listed.map((node) => node.parentIndex), [null, 0, 0, 1]);
    assert.equal(listed[3].name, "part-3");
});

test("viewport hide is inherited and stays separate from semantic hidden nodes", () => {
    const shown = buildVehicleHierarchy(manifest(), { nodes });
    assert.equal(row(shown, "model-node", "node-1").label, "spare (hidden)");
    assert.equal(row(shown, "model-node", "node-1").ownHidden, false);
    assert.equal(row(shown, "model-node", "node-1").hidden, false);
    assert.equal(row(shown, "sensor", "front-left").hidden, false);
    assert.equal(row(shown, "wheel", "front-left").hidden, false);

    const modelHidden = buildVehicleHierarchy(manifest(), {
        nodes,
        hiddenIds: [hierarchyVisibilityKey("model", "model")],
    });
    assert.equal(row(modelHidden, "model", "model").ownHidden, true);
    assert.equal(row(modelHidden, "model-node", "node-0").ownHidden, false);
    assert.equal(row(modelHidden, "model-node", "node-0").hidden, true);
    assert.equal(row(modelHidden, "model-node", "node-3").hidden, true);
    assert.equal(row(modelHidden, "sensor", "front-left").hidden, false);
    assert.equal(row(modelHidden, "wheel", "front-left").hidden, false);
    assert.equal(row(modelHidden, "model-node", "node-1").label, "spare (hidden)");

    const ancestorHidden = buildVehicleHierarchy(manifest(), {
        nodes,
        hiddenIds: [hierarchyVisibilityKey("model-node", "node-2")],
    });
    assert.equal(row(ancestorHidden, "model-node", "node-2").ownHidden, true);
    assert.equal(row(ancestorHidden, "model-node", "node-3").ownHidden, false);
    assert.equal(row(ancestorHidden, "model-node", "node-3").hidden, true);
    assert.equal(row(ancestorHidden, "wheel", "front-left").ownHidden, false);
    assert.equal(row(ancestorHidden, "wheel", "front-left").hidden, true);
    assert.equal(row(ancestorHidden, "wheel", "rear-left").hidden, false);

    const axleHidden = buildVehicleHierarchy(manifest(), {
        nodes,
        hiddenIds: [hierarchyVisibilityKey("axle", "axle-front")],
    });
    assert.equal(row(axleHidden, "axle", "axle-front").ownHidden, true);
    assert.equal(row(axleHidden, "wheel", "front-left").ownHidden, false);
    assert.equal(row(axleHidden, "wheel", "front-left").hidden, true);
    assert.equal(row(axleHidden, "wheel", "rear-left").hidden, false);
    assert.equal(row(axleHidden, "sensor", "front-left").ownHidden, false);
});

test("session visibility keeps model and zone across vehicles and drops node indexes with the asset", () => {
    const hidden = new Set([
        hierarchyVisibilityKey("model", "model"),
        hierarchyVisibilityKey("lidar", "lidar"),
        hierarchyVisibilityKey("body", "body"),
        hierarchyVisibilityKey("wheel", "front-left"),
        hierarchyVisibilityKey("model-node", "node-2"),
    ]);
    const kept = retainModelAndZoneVisibility(hidden);
    assert.deepEqual([...kept].sort(), ["lidar:lidar", "model:model"]);
    const cleared = clearModelNodeVisibility(hidden);
    assert.equal(cleared.has(hierarchyVisibilityKey("model-node", "node-2")), false);
    assert.equal(cleared.has(hierarchyVisibilityKey("wheel", "front-left")), true);
    assert.equal(hidden.has(hierarchyVisibilityKey("model-node", "node-2")), true);
});

function object() {
    return { visible: true, parent: null, children: [], userData: {} };
}

function adopt(parent, child) {
    child.parent = parent;
    parent.children.push(child);
    return child;
}

function sceneFixture() {
    const modelRoot = object();
    const body = adopt(modelRoot, object());
    const spare = adopt(body, object());
    const bolt = adopt(spare, object());
    const wheelsGroup = object();
    const frontPivot = adopt(wheelsGroup, object());
    frontPivot.userData.pick = { kind: "wheel", id: "front-left" };
    const wheelMesh = adopt(frontPivot, object());
    const rearPivot = adopt(wheelsGroup, object());
    rearPivot.userData.pick = { kind: "wheel", id: "rear-left" };
    const sensorsGroup = object();
    const sensor = adopt(sensorsGroup, object());
    sensor.userData.pick = { kind: "sensor", id: "front-left" };
    const ray = adopt(sensor, object());
    const scene = {
        bboxMesh: object(),
        modelRoot,
        zoneGroup: object(),
        wheelsGroup,
        sensorsGroup,
        nodeMappings: new Map([
            [body, { nodeIndex: 0 }],
            [spare, { nodeIndex: 1 }],
            [bolt, { nodeIndex: 4 }],
            [wheelMesh, { nodeIndex: 2 }],
        ]),
    };
    const graph = [
        { index: 0, parentIndex: null },
        { index: 1, parentIndex: 0 },
        { index: 4, parentIndex: 1 },
        { index: 2, parentIndex: 0 },
    ];
    return { scene, graph, body, spare, bolt, wheelMesh, frontPivot, rearPivot, sensor, ray };
}

test("studio visibility hides a sensor group without detaching its rays", () => {
    const { scene, graph, sensor, ray } = sceneFixture();
    applyEditorVisibility(scene, {
        manifest: manifest(),
        nodes: graph,
        hiddenIds: [hierarchyVisibilityKey("sensor", "front-left")],
    });
    assert.equal(sensor.visible, false);
    assert.equal(ray.parent, sensor);
    assert.equal(ray.visible, true);
    assert.equal(isObjectShown(ray), false);
    assert.equal(isObjectShown(sensor), false);
});

test("semantic node hides stay off when the viewport says show", () => {
    const { scene, graph, body, spare, bolt, wheelMesh, frontPivot } = sceneFixture();
    spare.visible = true;
    bolt.visible = true;
    applyEditorVisibility(scene, { manifest: manifest(), nodes: graph, hiddenIds: [] });
    assert.equal(body.visible, true);
    assert.equal(spare.visible, false);
    assert.equal(bolt.visible, false);
    assert.equal(wheelMesh.visible, true);
    assert.equal(frontPivot.visible, true);
});

test("a reparented wheel follows its source node and its axle", () => {
    const fixture = sceneFixture();
    applyEditorVisibility(fixture.scene, {
        manifest: manifest(),
        nodes: fixture.graph,
        hiddenIds: [hierarchyVisibilityKey("model-node", "node-2")],
    });
    assert.equal(fixture.frontPivot.visible, false);
    assert.equal(fixture.wheelMesh.visible, true);
    assert.equal(fixture.rearPivot.visible, true);
    assert.equal(isObjectShown(fixture.wheelMesh), false);

    applyEditorVisibility(fixture.scene, {
        manifest: manifest(),
        nodes: fixture.graph,
        hiddenIds: [hierarchyVisibilityKey("axle", "axle-front")],
    });
    assert.equal(fixture.frontPivot.visible, false);
    assert.equal(fixture.rearPivot.visible, true);

    applyEditorVisibility(fixture.scene, {
        manifest: manifest(),
        nodes: fixture.graph,
        hiddenIds: [hierarchyVisibilityKey("model", "model")],
    });
    assert.equal(fixture.scene.modelRoot.visible, false);
    assert.equal(fixture.body.visible, false);
    assert.equal(fixture.frontPivot.visible, true);
    assert.equal(fixture.rearPivot.visible, true);
    assert.equal(fixture.scene.zoneGroup.visible, true);
    assert.equal(fixture.scene.bboxMesh.visible, true);
});
