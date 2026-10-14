/**
 * "Obstacles along road": derive the host road, create an Obstacles subgroup,
 * and clone the chosen prop or asset instance on both outer edges.
 * Lateral offset is half the carriageway, plus the shoulder, plus clearance.
 * Copies take the road heading. Built with ScriptManager, not a stored file.
 */

import { createScriptDocument } from "../../../scripting/EditorDocument.js";
import { serializeManagerGraph } from "../../../scripting/GraphDocument.js";
import { ScriptManager } from "../../../scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../../../scripting/registerBuiltInBlocks.js";
import { NumberUnitClass } from "../../../scripting/units/math/Number.block.js";
import { AddBlock, DivideBlock, MaximumBlock, NegateBlock, SubtractBlock } from "../../../scripting/units/math/ScalarBlocks.block.js";
import { Int32ToFloat64Block } from "../../../scripting/units/conversions/NumberConversions.block.js";
import { StringBlock } from "../../../scripting/units/objects/String.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../../../scripting/units/program/ProgramIO.block.js";
import { SequenceBlock } from "../../../scripting/units/statements/Unit.block.js";
import { RepeatProgramBlock } from "../../../scripting/units/statements/RepeatProgram.block.js";
import { RoadCrossSectionBlock, SampleRoadBlock } from "../../../scripting/units/world/WorldBlocks.block.js";
import { CloneObjectBlock, CreateGroupBlock } from "../../../scripting/units/world/AuthoringBlocks.block.js";
import { DeriveFromAttachmentBlock } from "../../../scripting/units/world/DeriveFromAttachment.block.js";

const UNIT_HEAD = Object.freeze({
    outputs: Object.freeze([Object.freeze({ id: "output", label: "then", type: "unit" })]),
});

const OBSTACLE_TYPES = Object.freeze(["builtin-prop", "asset-instance"]);

function connect(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    if (!result.ok) throw new Error(result.error || `Could not connect ${from}.${output} to ${to}.${input}.`);
}

function addInput(manager, uuid, label, type, defaultValue, extra = null) {
    const block = new ProgramInputBlock(uuid);
    const config = { label, type, defaultValue, ...(extra ?? {}) };
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
    addInput(manager, "in-clearance", "clearance", "float64", "0.5");
    addInput(manager, "in-obstacle", "obstacle", "scene_object", "", { sceneTypes: [...OBSTACLE_TYPES] });
    addInput(manager, "in-parent", "parentId", "scene_object", "");
    addInput(manager, "in-index", "index", "int32", "0");
    addInput(manager, "in-count", "count", "int32", "1");

    const units = [
        new Int32ToFloat64Block("index-f"),
        new Int32ToFloat64Block("count-f"),
        new NumberUnitClass("one"),
        new NumberUnitClass("two"),
        new SubtractBlock("count-minus"),
        new MaximumBlock("denom"),
        new DivideBlock("percent"),
        new RoadCrossSectionBlock("cross"),
        new DivideBlock("half"),
        new AddBlock("paved"),
        new AddBlock("lateral"),
        new NegateBlock("neg-lateral"),
        new SampleRoadBlock("sample-right"),
        new SampleRoadBlock("sample-left"),
        new CloneObjectBlock("clone-right"),
        new CloneObjectBlock("clone-left"),
        new SequenceBlock("sequence"),
    ];
    for (const unit of units) manager.addUnit(unit);
    manager.storeData("one", 1);
    manager.storeData("two", 2);

    connect(manager, "in-index", "input", "index-f", "in");
    connect(manager, "in-count", "input", "count-f", "in");
    connect(manager, "count-f", "out", "count-minus", "a");
    connect(manager, "one", "number", "count-minus", "b");
    connect(manager, "count-minus", "out", "denom", "a");
    connect(manager, "one", "number", "denom", "b");
    connect(manager, "index-f", "out", "percent", "a");
    connect(manager, "denom", "out", "percent", "b");

    connect(manager, "in-edge", "input", "cross", "edgeId");
    connect(manager, "cross", "width", "half", "a");
    connect(manager, "two", "number", "half", "b");
    connect(manager, "half", "out", "paved", "a");
    connect(manager, "cross", "shoulderWidth", "paved", "b");
    connect(manager, "paved", "out", "lateral", "a");
    connect(manager, "in-clearance", "input", "lateral", "b");
    connect(manager, "lateral", "out", "neg-lateral", "value");

    connect(manager, "in-edge", "input", "sample-right", "edgeId");
    connect(manager, "in-edge", "input", "sample-left", "edgeId");
    connect(manager, "percent", "out", "sample-right", "percent");
    connect(manager, "percent", "out", "sample-left", "percent");
    connect(manager, "lateral", "out", "sample-right", "lateral");
    connect(manager, "neg-lateral", "out", "sample-left", "lateral");

    connect(manager, "in-obstacle", "input", "clone-right", "sourceId");
    connect(manager, "in-obstacle", "input", "clone-left", "sourceId");
    connect(manager, "in-parent", "input", "clone-right", "parentId");
    connect(manager, "in-parent", "input", "clone-left", "parentId");
    connect(manager, "sample-right", "pose", "clone-right", "pose");
    connect(manager, "sample-left", "pose", "clone-left", "pose");
    connect(manager, "clone-right", "then", "sequence", "first");
    connect(manager, "clone-left", "then", "sequence", "second");
    connect(manager, "sequence", "then", "child-head", "output");
    return manager.compile("obstacles-along-road");
}

export function buildObstaclesAlongRoadDocument() {
    registerBuiltInBlocks();
    const child = compileChild();
    const manager = new ScriptManager();
    addHead(manager, "head");
    addInput(manager, "in-count", "count", "int32", "4");
    addInput(manager, "in-clearance", "clearance", "float64", "0.5");
    addInput(manager, "in-obstacle", "obstacle", "scene_object", "", { sceneTypes: [...OBSTACLE_TYPES] });
    addInput(manager, "in-group", "group", "scene_object", "", { sceneType: "group" });

    const derive = new DeriveFromAttachmentBlock("derive");
    derive.hydrateState({ hostType: "road" });
    manager.addUnit(derive);

    const name = new StringBlock("obstacles-name");
    manager.addUnit(name);
    manager.storeData("obstacles-name", "Obstacles");

    const group = new CreateGroupBlock("create-group");
    manager.addUnit(group);

    const repeat = new RepeatProgramBlock("repeat");
    manager.addUnit(repeat);
    repeat.hydrateState({ compiledProgram: child });

    connect(manager, "derive", "edgeId", "repeat", "edgeId");
    connect(manager, "in-clearance", "input", "repeat", "clearance");
    connect(manager, "in-obstacle", "input", "repeat", "obstacle");
    connect(manager, "in-count", "input", "repeat", "count");
    connect(manager, "obstacles-name", "out", "create-group", "name");
    connect(manager, "in-group", "input", "create-group", "parentId");
    connect(manager, "create-group", "id", "repeat", "parentId");
    connect(manager, "repeat", "then", "head", "output");

    const artifact = manager.compile("Obstacles along road");
    return createScriptDocument({
        name: "Obstacles along road",
        graph: serializeManagerGraph(manager, { headUUID: "head", outputNodeConfig: UNIT_HEAD }),
        latestValidArtifact: artifact,
        compileStatus: { valid: true, error: null },
    });
}
