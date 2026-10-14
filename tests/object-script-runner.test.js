import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { applyObjectScript } from "../app/3d/editor/scripts/applyObjectScript.js";
import { buildPropsAlongRoadDocument } from "../app/3d/editor/scripts/propsAlongRoadTemplate.js";
import { runObjectScript } from "../app/3d/editor/scripts/runObjectScript.js";
import { CLONE_OBJECT_HOST_ERROR, PLACE_FEATURE_HOST_ERROR } from "../app/scripting/units/world/AuthoringBlocks.block.js";
import { CloneObjectBlock, PlaceFeatureBlock } from "../app/scripting/units/world/AuthoringBlocks.block.js";
import { GeneralAttachmentBlock, RoadAttachmentBlock } from "../app/scripting/units/world/DeriveFromAttachment.block.js";
import { scriptHostType } from "../app/scripting/units/world/attachmentHosts.js";
import { buildObstaclesAlongRoadDocument } from "../app/3d/editor/scripts/obstaclesAlongRoadTemplate.js";
import { hashAssetMetric } from "../app/editor-assets/AssetDefinition.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";

function worldHash(document) {
    return createWorldResource({
        environmentId: "yard",
        templateId: "blank",
        document: document.snapshot(),
    }).hash;
}

function barrelsOf(document) {
    return document.objects.filter((record) => (
        record.typeId === "builtin-prop" && document.getFeature(record.id)?.type === "barrel"
    ));
}

test("props along a road become permanent features, replace on run, and keep baked or duplicated copies", () => {
    resetDocumentIdCounter();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const road = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }] });
    assert.equal(road.ok, true, JSON.stringify(road.issues));
    const edgeId = road.result.edge.id;
    const group = service.run("createObject", { typeId: "group", name: "Shoulder" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const groupId = group.result.objectId;
    const script = buildPropsAlongRoadDocument();
    const before = worldHash(document);

    const attached = service.run("attachScript", {
        objectId: edgeId,
        scriptId: script.id,
        hostType: "road",
        parameters: { count: 2, sideOffset: 1.5, assetId: "barrel", group: groupId },
        seed: 1,
    });
    assert.equal(attached.ok, true, JSON.stringify(attached.issues));
    const attachmentId = attached.result.attachmentId;
    assert.equal(worldHash(document), before, "attachment metadata stays out of worldHash");
    assert.equal(service.run("attachScript", {
        objectId: groupId,
        scriptId: script.id,
        hostType: "road",
    }).ok, false);

    const run = () => {
        const record = document.getObject(edgeId);
        const attachment = record.components.scripts.find((entry) => entry.id === attachmentId);
        const ran = runObjectScript({
            artifact: script.latestValidArtifact,
            record,
            document,
            parameters: attachment.parameters,
            seed: attachment.seed,
        });
        assert.equal(ran.ok, true, ran.error);
        const applied = applyObjectScript(service, {
            attachmentId,
            scriptId: script.id,
            ops: ran.ops,
            label: "Run Props along road",
        });
        assert.equal(applied.ok, true, JSON.stringify(applied.issues));
        return ran;
    };

    run();
    const subgroup = document.objects.find((record) => record.name === "Barrels");
    assert.equal(subgroup.typeId, "group");
    assert.equal(subgroup.parentId, groupId);
    assert.equal(subgroup.components.authoredBy.attachmentId, attachmentId);
    assert.equal(barrelsOf(document).length, 4);
    assert.ok(barrelsOf(document).every((record) => record.parentId === subgroup.id));
    assert.ok(barrelsOf(document).every((record) => record.components.authoredBy.scriptId === script.id));
    const xs = barrelsOf(document).map((record) => document.getFeature(record.id).x);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 10, "barrels follow the road, not a single point");
    assert.notEqual(worldHash(document), before);

    const placedIds = barrelsOf(document).map((record) => record.id);
    service.bus.undo();
    assert.equal(barrelsOf(document).length, 0);
    assert.equal(document.getObject(subgroup.id), null);
    assert.equal(worldHash(document), before);

    run();
    assert.equal(barrelsOf(document).length, 4);
    const firstIds = barrelsOf(document).map((record) => record.id);
    run();
    assert.equal(barrelsOf(document).length, 4);
    assert.ok(barrelsOf(document).every((record) => !firstIds.includes(record.id)));
    assert.ok(placedIds.every((id) => document.getObject(id) === null));

    const generated = barrelsOf(document)[0];
    const copied = service.run("duplicateObjects", { objectIds: [generated.id] });
    assert.equal(copied.ok, true, JSON.stringify(copied.issues));
    const copyId = copied.result.rootIds[0];
    const copy = document.getObject(copyId);
    assert.equal(copy.components.authoredBy, undefined);
    assert.equal(copy.parentId, groupId);
    run();
    assert.ok(document.getObject(copyId), "a duplicate survives the next run");
    assert.equal(barrelsOf(document).filter((record) => record.components?.authoredBy).length, 4);

    const bakedIds = barrelsOf(document).filter((record) => record.components?.authoredBy).map((record) => record.id);
    assert.equal(service.run("clearAuthoredBy", { attachmentId }).ok, true);
    assert.ok(bakedIds.every((id) => document.getObject(id) && !document.getObject(id).components.authoredBy));
    run();
    assert.ok(bakedIds.every((id) => document.getObject(id)));
    assert.equal(barrelsOf(document).filter((record) => record.components?.authoredBy).length, 4);
    assert.ok(document.getObject(copyId));

    const missingGroup = runObjectScript({
        artifact: script.latestValidArtifact,
        record: document.getObject(edgeId),
        document,
        parameters: { count: 2, sideOffset: 1.5, assetId: "barrel", group: "" },
        seed: 1,
    });
    assert.equal(missingGroup.ok, false);
    assert.match(missingGroup.error, /group/);
    assert.deepEqual(missingGroup.ops, []);
});

const OBSTACLE_METRIC = {
    version: 1,
    collision: [{
        id: "body",
        kind: "convex",
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        triangles: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
    }],
    lidar: [],
};

function runAttachment(service, document, script, edgeId, parameters) {
    const attached = service.run("attachScript", {
        objectId: edgeId,
        scriptId: script.id,
        hostType: "road",
        parameters,
        seed: 1,
    });
    assert.equal(attached.ok, true, JSON.stringify(attached.issues));
    const attachmentId = attached.result.attachmentId;
    const record = document.getObject(edgeId);
    const attachment = record.components.scripts.find((entry) => entry.id === attachmentId);
    const ran = runObjectScript({
        artifact: script.latestValidArtifact,
        record,
        document,
        parameters: attachment.parameters,
        seed: attachment.seed,
    });
    return { attachmentId, ran };
}

function applyRun(service, script, attachmentId, ran) {
    assert.equal(ran.ok, true, ran.error);
    const applied = applyObjectScript(service, {
        attachmentId,
        scriptId: script.id,
        ops: ran.ops,
        label: "Run Obstacles along road",
    });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    return applied;
}

test("obstacles along a road clone a prop onto both outer edges and replace that set on the next run", () => {
    resetDocumentIdCounter();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const road = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }] });
    assert.equal(road.ok, true, JSON.stringify(road.issues));
    const edgeId = road.result.edge.id;
    const group = service.run("createObject", { typeId: "group", name: "Shoulder" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const source = service.run("addFeature", {
        type: "cone",
        x: 2,
        z: 0.2,
        rotationY: 0.3,
        dir: 2,
        tags: ["marker"],
        name: "Source cone",
    });
    assert.equal(source.ok, true, JSON.stringify(source.issues));
    const sourceId = source.result.objectId;
    const script = buildObstaclesAlongRoadDocument();
    const obstacle = script.latestValidArtifact.interface.inputs.find((port) => port.label === "obstacle");
    assert.deepEqual(obstacle.sceneTypes, ["builtin-prop", "asset-instance"]);
    const before = worldHash(document);

    assert.equal(service.run("attachScript", {
        objectId: group.result.objectId,
        scriptId: script.id,
        hostType: "road",
    }).ok, false);

    const parameters = { count: 2, clearance: 0.5, obstacle: sourceId, group: group.result.objectId };
    const first = runAttachment(service, document, script, edgeId, parameters);
    applyRun(service, script, first.attachmentId, first.ran);

    const subgroup = document.objects.find((record) => record.name === "Obstacles");
    assert.equal(subgroup.typeId, "group");
    assert.equal(subgroup.parentId, group.result.objectId);
    const clones = document.objects.filter((record) => record.components?.authoredBy?.attachmentId === first.attachmentId && record.typeId === "builtin-prop");
    assert.equal(clones.length, 4);
    assert.ok(clones.every((record) => record.parentId === subgroup.id));
    assert.equal(document.getObject(sourceId).components.authoredBy, undefined);
    const features = clones.map((record) => document.getFeature(record.id));
    assert.ok(features.every((feature) => feature.type === "cone" && feature.dir === 2 && feature.tags.includes("marker")));
    const xs = features.map((feature) => feature.x);
    const zs = features.map((feature) => feature.z);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 30);
    assert.ok(zs.some((z) => Math.abs(z - 4) < 1e-6));
    assert.ok(zs.some((z) => Math.abs(z + 4) < 1e-6));
    assert.ok(features.every((feature) => Math.abs(feature.rotationY - Math.PI / 2) < 1e-6));
    assert.notEqual(worldHash(document), before);

    const firstIds = clones.map((record) => record.id);
    const record = document.getObject(edgeId);
    const attachment = record.components.scripts.find((entry) => entry.id === first.attachmentId);
    const again = runObjectScript({
        artifact: script.latestValidArtifact,
        record,
        document,
        parameters: attachment.parameters,
        seed: attachment.seed,
    });
    applyRun(service, script, first.attachmentId, again);
    const replaced = document.objects.filter((record) => record.components?.authoredBy?.attachmentId === first.attachmentId && record.typeId === "builtin-prop");
    assert.equal(replaced.length, 4);
    assert.ok(replaced.every((record) => !firstIds.includes(record.id)));
    assert.ok(document.getObject(sourceId));

    const missing = runObjectScript({
        artifact: script.latestValidArtifact,
        record: document.getObject(edgeId),
        document,
        parameters: { count: 2, clearance: 0.5, obstacle: "", group: group.result.objectId },
        seed: 1,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /builtin-prop or asset-instance/);
    const wrong = runObjectScript({
        artifact: script.latestValidArtifact,
        record: document.getObject(edgeId),
        document,
        parameters: { count: 2, clearance: 0.5, obstacle: group.result.objectId, group: group.result.objectId },
        seed: 1,
    });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /not a group/);
});

test("obstacles along a road clone an asset instance and keep its pin, scale, and type version", () => {
    resetDocumentIdCounter();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const road = service.run("createRoad", { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }] });
    assert.equal(road.ok, true, JSON.stringify(road.issues));
    const group = service.run("createObject", { typeId: "group", name: "Shoulder" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const metricHash = hashAssetMetric(OBSTACLE_METRIC);
    const placed = service.run("placeAssetInstance", {
        record: {
            id: "source-crate",
            typeId: "asset-instance",
            typeVersion: 2,
            name: "Crate",
            parentId: null,
            components: {
                asset: {
                    assetId: "crate",
                    revision: 2,
                    position: { x: 1, y: 0.2, z: 0 },
                    rotationY: 0.4,
                    scale: { x: 2, y: 1, z: 0.5 },
                    overrides: {},
                },
            },
        },
        publishedRevision: { version: 2, revision: 2, metric: OBSTACLE_METRIC, metricHash },
    });
    assert.equal(placed.ok, true, JSON.stringify(placed.issues));
    const script = buildObstaclesAlongRoadDocument();
    const ran = runAttachment(service, document, script, road.result.edge.id, {
        count: 2,
        clearance: 0.5,
        obstacle: "source-crate",
        group: group.result.objectId,
    });
    applyRun(service, script, ran.attachmentId, ran.ran);
    const clones = document.objects.filter((record) => record.id !== "source-crate" && record.typeId === "asset-instance");
    assert.equal(clones.length, 4);
    assert.ok(clones.every((record) => record.typeVersion === 2));
    assert.ok(clones.every((record) => record.components.authoredBy.attachmentId === ran.attachmentId));
    assert.ok(clones.every((record) => {
        const asset = record.components.asset;
        return asset.assetId === "crate"
            && asset.revision === 2
            && asset.scale.x === 2
            && asset.scale.y === 1
            && asset.scale.z === 0.5
            && asset.position.y === 0
            && Math.abs(asset.rotationY - Math.PI / 2) < 1e-6;
    }));
    const zs = clones.map((record) => record.components.asset.position.z);
    assert.ok(zs.some((z) => Math.abs(z - 4) < 1e-6));
    assert.ok(zs.some((z) => Math.abs(z + 4) < 1e-6));
    assert.equal(document.assetMetrics.definitions.length, 1);
    assert.equal(document.getObject("source-crate").components.asset.position.y, 0.2);
});

test("Place Feature refuses to write without an editor host", () => {
    const block = new PlaceFeatureBlock("place");
    block.inputs = { assetId: {}, pose: {}, parentId: {} };
    block.getInput = (label) => ({
        assetId: "barrel",
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        parentId: "",
    }[label]);
    block.setManager({ getRuntimeContext: () => ({}) });
    assert.throws(() => block.execute(), new RegExp(PLACE_FEATURE_HOST_ERROR));
});

test("an attachment script declares one host, and general fits any object", () => {
    const road = scriptHostType({ nodes: [{ type: "RoadAttachmentBlock" }] });
    assert.equal(road.ok, true);
    assert.equal(road.hostType, "road");
    assert.equal(road.typeId, "road");

    const general = scriptHostType({ nodes: [{ type: "GeneralAttachmentBlock" }] });
    assert.equal(general.ok, true);
    assert.equal(general.hostType, "general");
    assert.equal(general.typeId, null);

    const anyObject = scriptHostType({ nodes: [] });
    assert.equal(anyObject.ok, true);
    assert.equal(anyObject.hostType, null);
    assert.equal(anyObject.typeId, null);

    const mixed = scriptHostType({
        nodes: [{ type: "RoadAttachmentBlock" }, { type: "BuildingAttachmentBlock" }],
    });
    assert.equal(mixed.ok, false);
    assert.match(mixed.error, /more than one attachment host/);

    const legacy = scriptHostType({
        nodes: [{ type: "DeriveFromAttachmentBlock", state: { hostType: "road" } }],
    });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.typeId, "road");

    const roadBlock = new RoadAttachmentBlock("road-host");
    roadBlock.setManager({
        getRuntimeContext: () => ({
            attachment: { typeId: "road", objectId: "edge-1", edgeId: "edge-1", name: "Main" },
        }),
    });
    const roadOut = roadBlock.execute();
    assert.equal(roadOut.get("found"), true);
    assert.equal(roadOut.get("edgeId"), "edge-1");
    assert.equal(roadOut.get("name"), "Main");

    const generalBlock = new GeneralAttachmentBlock("general-host");
    generalBlock.setManager({
        getRuntimeContext: () => ({
            attachment: { typeId: "road", objectId: "edge-1", name: "Main" },
        }),
    });
    const generalOut = generalBlock.execute();
    assert.equal(generalOut.get("found"), true);
    assert.equal(generalOut.get("objectId"), "edge-1");
    assert.equal(generalOut.get("name"), "Main");
});

test("Clone Object refuses to write without an editor host", () => {
    const block = new CloneObjectBlock("clone");
    block.inputs = { sourceId: {}, pose: {}, parentId: {} };
    block.getInput = () => "";
    block.setManager({ getRuntimeContext: () => ({}) });
    assert.throws(() => block.execute(), new RegExp(CLONE_OBJECT_HOST_ERROR));
});
