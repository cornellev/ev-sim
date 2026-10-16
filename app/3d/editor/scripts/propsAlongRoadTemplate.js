/**
 * "Props along road": derive the host road, create a Barrels subgroup, and
 * place the chosen prop on both shoulders. Built with ScriptManager, not a
 * stored file.
 */

import { createScriptDocument } from "../../../scripting/EditorDocument.js";
import { serializeManagerGraph } from "../../../scripting/GraphDocument.js";
import { ScriptManager } from "../../../scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../../../scripting/registerBuiltInBlocks.js";
import { NegateBlock } from "../../../scripting/units/math/ScalarBlocks.block.js";
import { StringBlock } from "../../../scripting/units/objects/String.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../../../scripting/units/program/ProgramIO.block.js";
import { SequenceBlock } from "../../../scripting/units/statements/Unit.block.js";
import { RepeatBlock, RepeatIndexBlock } from "../../../scripting/units/statements/Repeat.block.js";
import { SampleRoadBlock } from "../../../scripting/units/world/WorldBlocks.block.js";
import { CreateGroupBlock, PlaceFeatureBlock } from "../../../scripting/units/world/AuthoringBlocks.block.js";
import { DeriveFromAttachmentBlock } from "../../../scripting/units/world/DeriveFromAttachment.block.js";

const UNIT_HEAD = Object.freeze({
    outputs: Object.freeze([Object.freeze({ id: "output", label: "then", type: "unit" })]),
});

function connect(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    if (!result.ok) throw new Error(result.error || `Could not connect ${from}.${output} to ${to}.${input}.`);
}

function addInput(manager, uuid, label, type, defaultValue, sceneType = null) {
    const block = new ProgramInputBlock(uuid);
    const config = { label, type, defaultValue };
    if (sceneType) config.sceneType = sceneType;
    block.hydrateState(config);
    manager.addUnit(block);
    manager.storeData(uuid, config);
    return uuid;
}

function addHead(manager, uuid) {
    const head = new OutputNodeBlock(uuid);
    head.hydrateState(UNIT_HEAD);
    manager.addUnit(head);
    manager.storeData(uuid, UNIT_HEAD);
    manager.setHead(uuid);
}

export function buildPropsAlongRoadDocument() {
    registerBuiltInBlocks();
    const manager = new ScriptManager();
    addHead(manager, "head");
    addInput(manager, "in-count", "count", "int32", "2");
    addInput(manager, "in-offset", "sideOffset", "float64", "1.5");
    addInput(manager, "in-asset", "assetId", "string", "barrel");
    addInput(manager, "in-group", "group", "scene_object", "", "group");

    const derive = new DeriveFromAttachmentBlock("derive");
    derive.hydrateState({ hostType: "road" });
    manager.addUnit(derive);

    const units = [
        new StringBlock("barrels-name"),
        new CreateGroupBlock("create-group"),
        new RepeatBlock("repeat"),
        new RepeatIndexBlock("index"),
        new NegateBlock("neg-offset"),
        new SampleRoadBlock("sample-right"),
        new SampleRoadBlock("sample-left"),
        new PlaceFeatureBlock("place-right"),
        new PlaceFeatureBlock("place-left"),
        new SequenceBlock("sequence"),
    ];
    for (const unit of units) manager.addUnit(unit);
    manager.storeData("barrels-name", "Barrels");

    connect(manager, "barrels-name", "out", "create-group", "name");
    connect(manager, "in-group", "input", "create-group", "parentId");

    connect(manager, "in-count", "input", "repeat", "count");
    connect(manager, "repeat", "repeat", "index", "repeat");

    connect(manager, "derive", "edgeId", "sample-right", "edgeId");
    connect(manager, "derive", "edgeId", "sample-left", "edgeId");
    connect(manager, "index", "t", "sample-right", "percent");
    connect(manager, "index", "t", "sample-left", "percent");
    connect(manager, "in-offset", "input", "sample-right", "lateral");
    connect(manager, "in-offset", "input", "neg-offset", "value");
    connect(manager, "neg-offset", "out", "sample-left", "lateral");

    connect(manager, "in-asset", "input", "place-right", "assetId");
    connect(manager, "in-asset", "input", "place-left", "assetId");
    connect(manager, "create-group", "id", "place-right", "parentId");
    connect(manager, "create-group", "id", "place-left", "parentId");
    connect(manager, "sample-right", "pose", "place-right", "pose");
    connect(manager, "sample-left", "pose", "place-left", "pose");
    connect(manager, "place-right", "then", "sequence", "first");
    connect(manager, "place-left", "then", "sequence", "second");
    connect(manager, "sequence", "then", "repeat", "body");
    connect(manager, "repeat", "then", "head", "output");

    const artifact = manager.compile("Props along road");
    return createScriptDocument({
        name: "Props along road",
        graph: serializeManagerGraph(manager, { headUUID: "head", outputNodeConfig: UNIT_HEAD }),
        latestValidArtifact: artifact,
        compileStatus: { valid: true, error: null },
    });
}
