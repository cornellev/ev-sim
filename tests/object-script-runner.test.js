import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/index.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { applyObjectScript } from "../app/3d/editor/scripts/applyObjectScript.js";
import { buildPropsAlongRoadDocument } from "../app/3d/editor/scripts/propsAlongRoadTemplate.js";
import { runObjectScript } from "../app/3d/editor/scripts/runObjectScript.js";
import { PLACE_FEATURE_HOST_ERROR } from "../app/scripting/units/world/AuthoringBlocks.block.js";
import { PlaceFeatureBlock } from "../app/scripting/units/world/AuthoringBlocks.block.js";
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
