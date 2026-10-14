/**
 * "Props along road": derive the host road, create a Barrels subgroup, and
 * place the chosen prop on both shoulders. Built with ScriptManager, not a
 * stored file.
 */

import { createScriptDocument } from "../../../scripting/EditorDocument.js";
import { serializeManagerGraph } from "../../../scripting/GraphDocument.js";
import { ScriptManager } from "../../../scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../../../scripting/registerBuiltInBlocks.js";
import { NumberUnitClass } from "../../../scripting/units/math/Number.block.js";
import { DivideBlock, MaximumBlock, NegateBlock, SubtractBlock } from "../../../scripting/units/math/ScalarBlocks.block.js";
import { Int32ToFloat64Block } from "../../../scripting/units/conversions/NumberConversions.block.js";
import { StringBlock } from "../../../scripting/units/objects/String.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../../../scripting/units/program/ProgramIO.block.js";
import { SequenceBlock } from "../../../scripting/units/statements/Unit.block.js";
import { RepeatProgramBlock } from "../../../scripting/units/statements/RepeatProgram.block.js";
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

function compileChild() {
    const manager = new ScriptManager();
    addHead(manager, "child-head");
    addInput(manager, "in-edge", "edgeId", "road_id", "");
    addInput(manager, "in-offset", "sideOffset", "float64", "0");
    addInput(manager, "in-asset", "assetId", "string", "barrel");
    addInput(manager, "in-parent", "parentId", "scene_object", "");
    addInput(manager, "in-index", "index", "int32", "0");
    addInput(manager, "in-count", "count", "int32", "1");

    const units = [
        new Int32ToFloat64Block("index-f"),
        new Int32ToFloat64Block("count-f"),
        new NumberUnitClass("one"),
        new SubtractBlock("count-minus"),
        new MaximumBlock("denom"),
        new DivideBlock("percent"),
        new NegateBlock("neg-offset"),
        new SampleRoadBlock("sample-right"),
        new SampleRoadBlock("sample-left"),
        new PlaceFeatureBlock("place-right"),
        new PlaceFeatureBlock("place-left"),
        new SequenceBlock("sequence"),
    ];
    for (const unit of units) manager.addUnit(unit);
    manager.storeData("one", 1);

    connect(manager, "in-index", "input", "index-f", "in");
    connect(manager, "in-count", "input", "count-f", "in");
    connect(manager, "count-f", "out", "count-minus", "a");
    connect(manager, "one", "number", "count-minus", "b");
    connect(manager, "count-minus", "out", "denom", "a");
    connect(manager, "one", "number", "denom", "b");
    connect(manager, "index-f", "out", "percent", "a");
    connect(manager, "denom", "out", "percent", "b");

    connect(manager, "in-edge", "input", "sample-right", "edgeId");
    connect(manager, "in-edge", "input", "sample-left", "edgeId");
    connect(manager, "percent", "out", "sample-right", "percent");
    connect(manager, "percent", "out", "sample-left", "percent");
    connect(manager, "in-offset", "input", "sample-right", "lateral");
    connect(manager, "in-offset", "input", "neg-offset", "value");
    connect(manager, "neg-offset", "out", "sample-left", "lateral");

    connect(manager, "in-asset", "input", "place-right", "assetId");
    connect(manager, "in-asset", "input", "place-left", "assetId");
    connect(manager, "in-parent", "input", "place-right", "parentId");
    connect(manager, "in-parent", "input", "place-left", "parentId");
    connect(manager, "sample-right", "pose", "place-right", "pose");
    connect(manager, "sample-left", "pose", "place-left", "pose");
    connect(manager, "place-right", "then", "sequence", "first");
    connect(manager, "place-left", "then", "sequence", "second");
    connect(manager, "sequence", "then", "child-head", "output");
    return manager.compile("barrels-along-road");
}

export function buildPropsAlongRoadDocument() {
    registerBuiltInBlocks();
    const child = compileChild();
    const manager = new ScriptManager();
    addHead(manager, "head");
    addInput(manager, "in-count", "count", "int32", "2");
    addInput(manager, "in-offset", "sideOffset", "float64", "1.5");
    addInput(manager, "in-asset", "assetId", "string", "barrel");
    addInput(manager, "in-group", "group", "scene_object", "", "group");

    const derive = new DeriveFromAttachmentBlock("derive");
    derive.hydrateState({ hostType: "road" });
    manager.addUnit(derive);

    const name = new StringBlock("barrels-name");
    manager.addUnit(name);
    manager.storeData("barrels-name", "Barrels");

    const group = new CreateGroupBlock("create-group");
    manager.addUnit(group);

    const repeat = new RepeatProgramBlock("repeat");
    manager.addUnit(repeat);
    repeat.hydrateState({ compiledProgram: child });

    connect(manager, "derive", "edgeId", "repeat", "edgeId");
    connect(manager, "in-offset", "input", "repeat", "sideOffset");
    connect(manager, "in-asset", "input", "repeat", "assetId");
    connect(manager, "in-count", "input", "repeat", "count");
    connect(manager, "barrels-name", "out", "create-group", "name");
    connect(manager, "in-group", "input", "create-group", "parentId");
    connect(manager, "create-group", "id", "repeat", "parentId");
    connect(manager, "repeat", "then", "head", "output");

    const artifact = manager.compile("Props along road");
    return createScriptDocument({
        name: "Props along road",
        graph: serializeManagerGraph(manager, { headUUID: "head", outputNodeConfig: UNIT_HEAD }),
        latestValidArtifact: artifact,
        compileStatus: { valid: true, error: null },
    });
}
