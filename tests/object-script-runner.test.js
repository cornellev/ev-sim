import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { applyObjectScript } from "../app/3d/editor/scripts/applyObjectScript.js";
import { buildPropsAlongRoadDocument } from "../app/3d/editor/scripts/propsAlongRoadTemplate.js";
import { runObjectScript } from "../app/3d/editor/scripts/runObjectScript.js";
import { ScriptManager } from "../app/scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";
import { ObjectIdToSceneObjectBlock } from "../app/scripting/units/conversions/Conversions.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { IfBlock } from "../app/scripting/units/statements/If.block.js";
import { PassthroughBlock, SequenceBlock } from "../app/scripting/units/statements/Unit.block.js";
import { authoringBindingWarnings, CLONE_OBJECT_HOST_ERROR, PLACE_FEATURE_HOST_ERROR } from "../app/scripting/units/world/AuthoringBlocks.block.js";
import { CloneObjectBlock, PlaceFeatureBlock } from "../app/scripting/units/world/AuthoringBlocks.block.js";
import {
    ADD_RIGID_BODY_HOST_ERROR,
    AddRigidBodyBlock,
    GET_RIGID_BODY_HOST_ERROR,
    GetRigidBodyBlock,
    MakeRigidBodyBlock,
} from "../app/scripting/units/world/RigidBodyBlocks.block.js";
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

function connectScript(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    assert.equal(result.ok, true, result.error);
}

function addProgramInput(manager, uuid, label, type, defaultValue) {
    const block = new ProgramInputBlock(uuid);
    const config = { label, type, defaultValue };
    block.hydrateState(config);
    manager.addUnit(block);
    manager.storeData(uuid, config);
}

function addUnitHead(manager) {
    const config = { outputs: [{ id: "output", label: "then", type: "unit" }] };
    const head = new OutputNodeBlock("head");
    head.hydrateState(config);
    manager.addUnit(head);
    manager.storeData("head", config);
    manager.setHead("head");
}

test("object id converts to a scene object when the document or this run contains it", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const group = service.run("createObject", { typeId: "group", name: "Bin" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const groupId = group.result.objectId;
    const record = document.getObject(groupId);

    const lookup = new ScriptManager();
    addUnitHead(lookup);
    addProgramInput(lookup, "in-id", "objectId", "string", "");
    addProgramInput(lookup, "in-pose", "pose", "pose3d", "0");
    lookup.addUnit(new StringBlock("asset"));
    lookup.storeData("asset", "barrel");
    lookup.addUnit(new ObjectIdToSceneObjectBlock("convert"));
    lookup.addUnit(new PlaceFeatureBlock("place"));
    connectScript(lookup, "in-id", "input", "convert", "objectId");
    connectScript(lookup, "convert", "out", "place", "parentId");
    connectScript(lookup, "in-pose", "input", "place", "pose");
    connectScript(lookup, "asset", "out", "place", "assetId");
    connectScript(lookup, "place", "then", "head", "output");
    const lookupArtifact = lookup.compile("lookup");

    const found = runObjectScript({
        artifact: lookupArtifact,
        record,
        document,
        parameters: { objectId: `  ${groupId}  ` },
    });
    assert.equal(found.ok, true, found.error);
    assert.equal(found.ops[0].parentId, groupId);

    const missing = runObjectScript({
        artifact: lookupArtifact,
        record,
        document,
        parameters: { objectId: "missing" },
    });
    assert.equal(missing.ok, true, missing.error);
    assert.equal(missing.ops[0].parentId, null);

    const chain = new ScriptManager();
    addUnitHead(chain);
    addProgramInput(chain, "in-root", "root", "scene_object", "");
    addProgramInput(chain, "in-pose", "pose", "pose3d", "0");
    chain.addUnit(new StringBlock("asset"));
    chain.storeData("asset", "barrel");
    chain.addUnit(new PlaceFeatureBlock("place-a"));
    chain.addUnit(new ObjectIdToSceneObjectBlock("convert"));
    chain.addUnit(new PlaceFeatureBlock("place-b"));
    chain.addUnit(new SequenceBlock("sequence"));
    connectScript(chain, "asset", "out", "place-a", "assetId");
    connectScript(chain, "in-pose", "input", "place-a", "pose");
    connectScript(chain, "in-root", "input", "place-a", "parentId");
    connectScript(chain, "place-a", "id", "convert", "objectId");
    connectScript(chain, "convert", "out", "place-b", "parentId");
    connectScript(chain, "asset", "out", "place-b", "assetId");
    connectScript(chain, "in-pose", "input", "place-b", "pose");
    connectScript(chain, "place-a", "then", "sequence", "first");
    connectScript(chain, "place-b", "then", "sequence", "second");
    connectScript(chain, "sequence", "then", "head", "output");
    const chained = runObjectScript({
        artifact: chain.compile("chain"),
        record,
        document,
    });
    assert.equal(chained.ok, true, chained.error);
    assert.equal(chained.ops.length, 2);
    assert.equal(chained.ops[0].parentId, null);
    assert.equal(chained.ops[1].parentId, chained.ops[0].id);
});

test("Clone Object copies a primitive's shape, size, color, and tags onto the pose", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const group = service.run("createObject", { typeId: "group", name: "Bin" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const groupId = group.result.objectId;
    const source = service.run("addPrimitive", {
        shape: "box",
        x: 1,
        y: 2,
        z: 3,
        rotationY: 0.2,
        size: { x: 0.4, y: 1.5, z: 2 },
        color: "#112233",
        tags: ["marker", "solid"],
        name: "Post",
        parentId: groupId,
    });
    assert.equal(source.ok, true, JSON.stringify(source.issues));
    const sourceId = source.result.objectId;

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-source", "source", "scene_object", "");
    addProgramInput(manager, "in-pose", "pose", "pose3d", "0");
    addProgramInput(manager, "in-parent", "parent", "scene_object", "");
    manager.addUnit(new CloneObjectBlock("clone"));
    connectScript(manager, "in-source", "input", "clone", "sourceId");
    connectScript(manager, "in-pose", "input", "clone", "pose");
    connectScript(manager, "in-parent", "input", "clone", "parentId");
    connectScript(manager, "clone", "then", "head", "output");
    const artifact = manager.compile("clone primitive");
    const pose = {
        position: { x: 8, y: 0.75, z: -2 },
        rotation: { x: 0, y: 1.2, z: 0, order: "XYZ" },
    };
    const ran = runObjectScript({
        artifact,
        record: document.getObject(groupId),
        document,
        parameters: { source: sourceId, pose, parent: groupId },
    });
    assert.equal(ran.ok, true, ran.error);
    assert.equal(ran.ops[0].spec.typeId, "primitive");
    assert.equal(ran.ops[0].spec.primitive.shape, "box");
    const applied = applyObjectScript(service, {
        attachmentId: "attachment-1",
        scriptId: "script-1",
        ops: ran.ops,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));

    const clone = document.primitives.find((entry) => entry.id !== sourceId);
    assert.equal(clone.shape, "box");
    assert.deepEqual(clone.size, { x: 0.4, y: 1.5, z: 2 });
    assert.equal(clone.color, "#112233");
    assert.deepEqual(clone.tags, ["marker", "solid"]);
    assert.deepEqual(clone.position, { x: 8, y: 0.75, z: -2 });
    assert.equal(clone.rotationY, 1.2);
    const copy = document.getObject(clone.id);
    assert.equal(copy.name, "Post");
    assert.equal(copy.parentId, groupId);
    assert.equal(copy.typeId, "primitive");
    assert.equal(copy.components.authoredBy.attachmentId, "attachment-1");
    assert.equal(document.primitives.find((entry) => entry.id === sourceId).position.y, 2);
    assert.equal(document.getObject(sourceId).components.authoredBy, undefined);

    const again = runObjectScript({
        artifact,
        record: document.getObject(groupId),
        document,
        parameters: { source: sourceId, pose, parent: groupId },
    });
    assert.equal(again.ok, true, again.error);
    const replaced = applyObjectScript(service, {
        attachmentId: "attachment-1",
        scriptId: "script-1",
        ops: again.ops,
    });
    assert.equal(replaced.ok, true, JSON.stringify(replaced.issues));
    assert.equal(document.primitives.some((entry) => entry.id === clone.id), false);
    assert.equal(document.primitives.filter((entry) => entry.id !== sourceId).length, 1);

    const refused = runObjectScript({
        artifact,
        record: document.getObject(groupId),
        document,
        parameters: { source: groupId, pose, parent: "" },
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /prop, an asset instance, or a primitive/);
});

function addBox(service, id) {
    const added = service.run("addPrimitive", {
        id,
        shape: "box",
        x: 0,
        y: 1,
        z: 0,
        size: { x: 1, y: 1, z: 1 },
    });
    assert.equal(added.ok, true, JSON.stringify(added.issues));
}

function applyScript(service, ops, attachmentId = "attachment-1") {
    return applyObjectScript(service, {
        attachmentId,
        scriptId: "script-1",
        ops,
    });
}

test("Get Rigid Body copies a component and branches when the object has none", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    addBox(service, "heavy");
    addBox(service, "plain");
    addBox(service, "from-body");
    addBox(service, "from-miss");
    assert.equal(service.run("addRigidBody", { objectId: "heavy" }).ok, true);
    assert.equal(service.run("setRigidBody", {
        objectId: "heavy",
        patch: { mass: 4, constantForce: { x: 1, y: 2, z: 3 } },
    }).ok, true);

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-source", "source", "scene_object", "");
    addProgramInput(manager, "in-target", "target", "scene_object", "");
    manager.addUnit(new NumberUnitClass("miss-mass"));
    manager.storeData("miss-mass", 9);
    manager.addUnit(new GetRigidBodyBlock("get"));
    manager.addUnit(new MakeRigidBodyBlock("miss"));
    manager.addUnit(new IfBlock("choose"));
    manager.addUnit(new AddRigidBodyBlock("add"));
    connectScript(manager, "in-source", "input", "get", "object");
    connectScript(manager, "miss-mass", "number", "miss", "mass");
    connectScript(manager, "get", "found", "choose", "condition");
    connectScript(manager, "get", "config", "choose", "true value");
    connectScript(manager, "miss", "config", "choose", "false value");
    connectScript(manager, "in-target", "input", "add", "object");
    connectScript(manager, "choose", "out", "add", "config");
    connectScript(manager, "add", "then", "head", "output");
    const artifact = manager.compile("get rigid body");
    const record = document.getObject("heavy");

    const hit = runObjectScript({
        artifact,
        record,
        document,
        parameters: { source: "heavy", target: "from-body" },
    });
    assert.equal(hit.ok, true, hit.error);
    assert.equal(applyScript(service, hit.ops).ok, true);
    assert.equal(document.getObject("from-body").components.rigidBody.mass, 4);
    assert.equal(document.getObject("from-body").components.rigidBody.constantForce.x, 1);
    assert.equal(document.getObject("heavy").components.rigidBody.mass, 4);

    const miss = runObjectScript({
        artifact,
        record,
        document,
        parameters: { source: "plain", target: "from-miss" },
    });
    assert.equal(miss.ok, true, miss.error);
    assert.equal(applyScript(service, miss.ops, "attachment-2").ok, true);
    assert.equal(document.getObject("from-miss").components.rigidBody.mass, 9);
    assert.equal(document.getObject("plain").components.rigidBody, undefined);
});

test("Get Rigid Body sees a body added earlier in the same run", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    addBox(service, "first");
    addBox(service, "second");
    const record = document.getObject("first");

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-first", "first", "scene_object", "");
    addProgramInput(manager, "in-second", "second", "scene_object", "");
    manager.addUnit(new NumberUnitClass("mass"));
    manager.storeData("mass", 6);
    manager.addUnit(new MakeRigidBodyBlock("make"));
    manager.addUnit(new AddRigidBodyBlock("add-first"));
    manager.addUnit(new GetRigidBodyBlock("get"));
    manager.addUnit(new PassthroughBlock("after-add"));
    manager.addUnit(new AddRigidBodyBlock("add-second"));
    connectScript(manager, "mass", "number", "make", "mass");
    connectScript(manager, "in-first", "input", "add-first", "object");
    connectScript(manager, "make", "config", "add-first", "config");
    connectScript(manager, "in-first", "input", "get", "object");
    connectScript(manager, "add-first", "then", "after-add", "then");
    connectScript(manager, "get", "config", "after-add", "value");
    connectScript(manager, "in-second", "input", "add-second", "object");
    connectScript(manager, "after-add", "value", "add-second", "config");
    connectScript(manager, "add-second", "then", "head", "output");
    const artifact = manager.compile("pending rigid body");
    const ran = runObjectScript({
        artifact,
        record,
        document,
        parameters: { first: "first", second: "second" },
    });
    assert.equal(ran.ok, true, ran.error);
    assert.equal(ran.ops.length, 2);
    assert.equal(ran.ops[0].objectId, "first");
    assert.equal(ran.ops[1].rigidBody.mass, 6);
    const applied = applyScript(service, ran.ops);
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.equal(document.getObject("first").components.rigidBody.mass, 6);
    assert.equal(document.getObject("second").components.rigidBody.mass, 6);
    assert.equal(document.getObject("first").components.authoredBy, undefined);

    const again = runObjectScript({
        artifact,
        record,
        document,
        parameters: { first: "first", second: "second" },
    });
    assert.equal(applyScript(service, again.ops).ok, true);
    assert.equal(document.getObject("first").components.rigidBody.mass, 6);
    assert.equal(document.getObject("second").components.rigidBody.mass, 6);
});

test("Add Rigid Body writes a config onto a cloned primitive and replaces that clone on the next run", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const group = service.run("createObject", { typeId: "group", name: "Bin" });
    assert.equal(group.ok, true, JSON.stringify(group.issues));
    const groupId = group.result.objectId;
    const source = service.run("addPrimitive", {
        shape: "box",
        x: 1,
        y: 2,
        z: 3,
        size: { x: 1, y: 1, z: 1 },
        name: "Post",
        parentId: groupId,
    });
    assert.equal(source.ok, true, JSON.stringify(source.issues));
    const sourceId = source.result.objectId;
    const pose = {
        position: { x: 8, y: 0.75, z: -2 },
        rotation: { x: 0, y: 1.2, z: 0, order: "XYZ" },
    };

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-source", "source", "scene_object", "");
    addProgramInput(manager, "in-pose", "pose", "pose3d", "0");
    addProgramInput(manager, "in-parent", "parent", "scene_object", "");
    manager.addUnit(new NumberUnitClass("mass"));
    manager.storeData("mass", 6);
    manager.addUnit(new CloneObjectBlock("clone"));
    manager.addUnit(new ObjectIdToSceneObjectBlock("convert"));
    manager.addUnit(new MakeRigidBodyBlock("make"));
    manager.addUnit(new AddRigidBodyBlock("add"));
    connectScript(manager, "in-source", "input", "clone", "sourceId");
    connectScript(manager, "in-pose", "input", "clone", "pose");
    connectScript(manager, "in-parent", "input", "clone", "parentId");
    connectScript(manager, "clone", "id", "convert", "objectId");
    connectScript(manager, "mass", "number", "make", "mass");
    connectScript(manager, "convert", "out", "add", "object");
    connectScript(manager, "make", "config", "add", "config");
    connectScript(manager, "add", "then", "head", "output");
    const artifact = manager.compile("clone rigid body");
    const run = (doc) => runObjectScript({
        artifact,
        record: doc.getObject(groupId),
        document: doc,
        parameters: { source: sourceId, pose, parent: groupId },
    });
    const ran = run(document);
    assert.equal(ran.ok, true, ran.error);
    assert.equal(ran.ops[0].op, "clone-object");
    assert.equal(ran.ops[1].op, "put-rigid-body");
    assert.equal(ran.ops[1].objectId, ran.ops[0].id);
    assert.equal(ran.ops[1].id, undefined);
    assert.equal(ran.ops[1].rigidBody.mass, 6);
    const applied = applyScript(service, ran.ops);
    assert.equal(applied.ok, true, JSON.stringify(applied.issues));
    assert.deepEqual(applied.result.created, [ran.ops[0].id]);
    const clone = document.getObject(ran.ops[0].id);
    assert.equal(clone.components.rigidBody.mass, 6);
    assert.equal(clone.components.rigidBody.bodyType, "dynamic");
    assert.equal(clone.components.authoredBy.attachmentId, "attachment-1");
    assert.equal(document.getObject(sourceId).components.rigidBody, undefined);

    const again = run(document);
    assert.equal(again.ok, true, again.error);
    const replaced = applyScript(service, again.ops);
    assert.equal(replaced.ok, true, JSON.stringify(replaced.issues));
    assert.equal(document.getObject(ran.ops[0].id), null);
    const next = document.getObject(again.ops[0].id);
    assert.equal(next.components.rigidBody.mass, 6);
    assert.equal(document.primitives.filter((entry) => entry.id !== sourceId).length, 1);
});

test("Add Rigid Body on a group rolls the run back", () => {
    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const group = service.run("createObject", { typeId: "group", name: "Bin" });
    const groupId = group.result.objectId;
    const before = document.features.length;

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-object", "object", "scene_object", "");
    addProgramInput(manager, "in-pose", "pose", "pose3d", "0");
    addProgramInput(manager, "in-parent", "parent", "scene_object", "");
    manager.addUnit(new StringBlock("asset"));
    manager.storeData("asset", "barrel");
    manager.addUnit(new PlaceFeatureBlock("place"));
    manager.addUnit(new MakeRigidBodyBlock("make"));
    manager.addUnit(new AddRigidBodyBlock("add"));
    manager.addUnit(new SequenceBlock("sequence"));
    connectScript(manager, "asset", "out", "place", "assetId");
    connectScript(manager, "in-pose", "input", "place", "pose");
    connectScript(manager, "in-parent", "input", "place", "parentId");
    connectScript(manager, "in-object", "input", "add", "object");
    connectScript(manager, "make", "config", "add", "config");
    connectScript(manager, "place", "then", "sequence", "first");
    connectScript(manager, "add", "then", "sequence", "second");
    connectScript(manager, "sequence", "then", "head", "output");
    const ran = runObjectScript({
        artifact: manager.compile("group rigid body"),
        record: document.getObject(groupId),
        document,
        parameters: { object: groupId, parent: "" },
    });
    assert.equal(ran.ok, true, ran.error);
    assert.equal(ran.ops[1].op, "put-rigid-body");
    assert.equal(ran.ops[1].objectId, groupId);
    const applied = applyScript(service, ran.ops);
    assert.equal(applied.ok, false);
    assert.match(applied.error, /group/);
    assert.equal(document.features.length, before);
    assert.equal(document.getObject(groupId).components.rigidBody, undefined);
});

test("Add Rigid Body requires a host, and a missing object discards ops", () => {
    const block = new AddRigidBodyBlock("add");
    block.inputs = { object: {}, config: {} };
    block.getInput = (label) => (label === "object" ? "box" : { mass: 1 });
    block.setManager({ getRuntimeContext: () => ({}) });
    assert.throws(() => block.execute(), new RegExp(ADD_RIGID_BODY_HOST_ERROR));

    const reader = new GetRigidBodyBlock("get");
    reader.inputs = { object: {} };
    reader.getInput = () => "box";
    reader.setManager({ getRuntimeContext: () => ({}) });
    assert.throws(() => reader.execute(), new RegExp(GET_RIGID_BODY_HOST_ERROR));

    resetDocumentIdCounter();
    registerBuiltInBlocks();
    const document = new EnvironmentDocument({ environmentId: "yard" });
    const service = createEnvironmentCommandService({ document });
    const group = service.run("createObject", { typeId: "group", name: "Bin" });
    const groupId = group.result.objectId;

    const manager = new ScriptManager();
    addUnitHead(manager);
    addProgramInput(manager, "in-pose", "pose", "pose3d", "0");
    addProgramInput(manager, "in-parent", "parent", "scene_object", "");
    manager.addUnit(new StringBlock("asset"));
    manager.storeData("asset", "barrel");
    manager.addUnit(new StringBlock("missing"));
    manager.storeData("missing", "no-such-object");
    manager.addUnit(new ObjectIdToSceneObjectBlock("convert"));
    manager.addUnit(new PlaceFeatureBlock("place"));
    manager.addUnit(new MakeRigidBodyBlock("make"));
    manager.addUnit(new AddRigidBodyBlock("add"));
    manager.addUnit(new SequenceBlock("sequence"));
    connectScript(manager, "asset", "out", "place", "assetId");
    connectScript(manager, "in-pose", "input", "place", "pose");
    connectScript(manager, "in-parent", "input", "place", "parentId");
    connectScript(manager, "missing", "out", "convert", "objectId");
    connectScript(manager, "convert", "out", "add", "object");
    connectScript(manager, "make", "config", "add", "config");
    connectScript(manager, "place", "then", "sequence", "first");
    connectScript(manager, "add", "then", "sequence", "second");
    connectScript(manager, "sequence", "then", "head", "output");
    const ran = runObjectScript({
        artifact: manager.compile("missing rigid body"),
        record: document.getObject(groupId),
        document,
        parameters: { parent: "" },
    });
    assert.equal(ran.ok, false);
    assert.match(ran.error, /does not exist/);
    assert.deepEqual(ran.ops, []);
    assert.equal(document.features.length, 0);
});

test("Add Rigid Body warns on a simulation binding", () => {
    assert.equal(authoringBindingWarnings({ nodes: [{ type: "AddRigidBodyBlock" }] }).length, 1);
    assert.deepEqual(authoringBindingWarnings({
        nodes: [
            { type: "MakeRigidBodyBlock" },
            { type: "SplitRigidBodyBlock" },
            { type: "GetRigidBodyBlock" },
        ],
    }), []);
});
