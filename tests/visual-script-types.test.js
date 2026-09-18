import assert from "node:assert/strict";
import test from "node:test";

import {
    BlockOutput,
    clearBlockTypeRegistryForTests,
    registerBlockType,
    ScriptManager,
    UnitBlock,
} from "../app/scripting/ScriptManager.js";
import {
    mutateGraphConnections,
    reconfigureGraphUnit,
    restoreManagerFromGraph,
    serializeManagerGraph,
} from "../app/scripting/GraphDocument.js";
import { getRegisteredBlockType } from "../app/scripting/BlockRegistry.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import { SampleRoadBlock } from "../app/scripting/units/world/WorldBlocks.block.js";
import { IfBlock } from "../app/scripting/units/statements/If.block.js";
import { EqualityBlock } from "../app/scripting/units/statements/Equality.block.js";
import {
    EqualBlock,
    LessBlock,
} from "../app/scripting/units/statements/LogicBlocks.block.js";
import { PreviousBlock, ValueChangedBlock } from "../app/scripting/units/control/TemporalBlocks.block.js";
import { IntegerBlock, JsonBlock, AddBlock } from "../app/scripting/units/math/ScalarBlocks.block.js";
import { WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import {
    LogSignalBlock,
    SignalDefaultBlock,
    SignalLatchBlock,
    WriteSignalBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import {
    normalizeType,
    parseValueByType,
    SUPPORTED_TYPES,
} from "../app/scripting/units/program/ProgramTypes.js";
import {
    MakeActorCommandBlock,
} from "../app/scripting/units/mission/ActorCommand.block.js";
import { ArrayGetBlock } from "../app/scripting/units/collections/ArrayBlocks.block.js";
import { JsonSetBlock } from "../app/scripting/units/objects/JsonBlocks.block.js";
import {
    ACTOR_COMMAND_TYPE,
    GENERIC_TYPE,
    isConcreteType,
    isGeneric,
    normalizeActorCommand,
    normalizeOpaqueId,
    normalizePose2d,
    normalizePose3d,
    normalizeVec2,
    normalizeVec3,
    POSE2D_TYPE,
    POSE3D_TYPE,
    portsCompatible,
    ROAD_ID_TYPE,
    TEXTURE_ID_TYPE,
    UNIT,
    UNIT_TYPE,
    VEC2_TYPE,
    VEC3_TYPE,
} from "../app/scripting/types/PortTypes.js";
import {
    declaredPortType,
    getTypeVariable,
    resolvedPortType,
} from "../app/scripting/types/TypeScheme.js";
import { planUnify } from "../app/scripting/types/unifyGraph.js";

class TypedConstBlock extends UnitBlock {
    constructor(uuid, value, type = "float64") {
        super(uuid);
        this.value = value;
        this.state = { type };
        this.reregister();
    }

    register() {
        this.registerOutput("out", this.state?.type || "float64");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.value);
    }
}

class OutputBlock extends UnitBlock {
    static programNodeRole = "output";

    constructor(uuid, type = "float64") {
        super(uuid);
        this.state = { type };
        this.reregister();
    }

    register() {
        this.registerInput("output", this.state?.type || "float64");
    }

    serializeState() {
        return { ...this.state };
    }

    getProgramPortDefinition() {
        return {
            role: "output",
            uuid: this.uuid,
            portId: "output",
            label: "result",
            type: this.state.type,
        };
    }

    valid() {
        return this.hasInput("output");
    }

    execute() {
        this.manager.setExternalOutput("result", this.getInput("output"));
        return new BlockOutput();
    }
}

class BooleanConstBlock extends UnitBlock {
    constructor(uuid, value) {
        super(uuid);
        this.value = value;
    }

    register() {
        this.registerOutput("out", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.value);
    }
}

class SchemeBlock extends UnitBlock {
    static typeScheme = {
        variables: {
            T: {
                inputs: ["left", "right"],
                outputs: ["out"]
            }
        }
    };

    register() {
        this.registerInput("left", GENERIC_TYPE);
        this.registerInput("right", GENERIC_TYPE);
        this.registerOutput("out", GENERIC_TYPE);
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.getInput("left"));
    }
}

function resetRegistry() {
    clearBlockTypeRegistryForTests();
    [
        TypedConstBlock,
        OutputBlock,
        BooleanConstBlock,
        SchemeBlock,
        IfBlock,
        EqualityBlock,
        WeightedSelectBlock,
        SignalLatchBlock,
        SignalDefaultBlock,
        LogSignalBlock,
        WriteSignalBlock,
        NumberUnitClass,
        StringBlock,
        ProgramInputBlock,
        OutputNodeBlock,
        MakeActorCommandBlock,
        EqualBlock,
        LessBlock,
        IntegerBlock,
        JsonBlock,
        PreviousBlock,
        ValueChangedBlock,
    ].forEach((blockClass) => registerBlockType(blockClass.blockType || blockClass.name, blockClass));
}

function connect(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    assert.equal(result.ok, true, result.error || `${from}.${output} -> ${to}.${input}`);
}

test("portsCompatible treats generic as a wildcard and requires exact concrete equality", () => {
    assert.equal(portsCompatible("generic", "float64"), true);
    assert.equal(portsCompatible("float64", "generic"), true);
    assert.equal(portsCompatible("generic", "generic"), true);
    assert.equal(portsCompatible("float64", "float64"), true);
    assert.equal(portsCompatible("float64", "int32"), false);
    assert.equal(portsCompatible("array[float64]", "array[int32]"), false);
    assert.equal(portsCompatible("array[float64]", "array[float64]"), true);
    assert.equal(isGeneric(GENERIC_TYPE), true);
    assert.equal(isConcreteType("float64"), true);
    assert.equal(isConcreteType("generic"), false);
    assert.equal(isConcreteType(UNIT_TYPE), true);
    assert.equal(portsCompatible(UNIT_TYPE, UNIT_TYPE), true);
    assert.equal(portsCompatible(UNIT_TYPE, "float64"), false);
    assert.equal(isConcreteType(ACTOR_COMMAND_TYPE), true);
    assert.equal(portsCompatible(ACTOR_COMMAND_TYPE, ACTOR_COMMAND_TYPE), true);
    assert.equal(portsCompatible(ACTOR_COMMAND_TYPE, "float64"), false);
    assert.equal(portsCompatible(ACTOR_COMMAND_TYPE, UNIT_TYPE), false);
    assert.equal(isConcreteType(ROAD_ID_TYPE), true);
    assert.equal(portsCompatible(ROAD_ID_TYPE, ROAD_ID_TYPE), true);
    assert.equal(portsCompatible("string", ROAD_ID_TYPE), false);
    assert.equal(portsCompatible(ROAD_ID_TYPE, TEXTURE_ID_TYPE), false);
});

test("parseValueByType always returns the UNIT singleton", () => {
    assert.equal(SUPPORTED_TYPES.includes(UNIT_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(GENERIC_TYPE), false);
    assert.equal(normalizeType(UNIT_TYPE), UNIT_TYPE);
    assert.equal(parseValueByType(undefined, UNIT_TYPE), UNIT);
    assert.equal(parseValueByType("foo", UNIT_TYPE), UNIT);
    assert.equal(parseValueByType({ type: "nope" }, UNIT_TYPE), UNIT);
});

test("parseValueByType normalizes actor_command payloads", () => {
    const empty = { actorId: "", speedMps: 0, steeringRad: 0 };
    assert.equal(SUPPORTED_TYPES.includes(ACTOR_COMMAND_TYPE), true);
    assert.equal(normalizeType(ACTOR_COMMAND_TYPE), ACTOR_COMMAND_TYPE);
    assert.deepEqual(parseValueByType(undefined, ACTOR_COMMAND_TYPE), empty);
    assert.deepEqual(parseValueByType({}, ACTOR_COMMAND_TYPE), empty);
    assert.deepEqual(parseValueByType("", ACTOR_COMMAND_TYPE), empty);
    assert.deepEqual(
        parseValueByType('{"actorId":"ego","speedMps":5,"steeringRad":0.1}', ACTOR_COMMAND_TYPE),
        { actorId: "ego", speedMps: 5, steeringRad: 0.1 },
    );
    assert.deepEqual(
        parseValueByType({ actorId: "npc", speedMps: "3.5", steeringRad: "bad", extra: 9 }, ACTOR_COMMAND_TYPE),
        { actorId: "npc", speedMps: 3.5, steeringRad: 0 },
    );
    assert.deepEqual(parseValueByType({ actorId: null }, ACTOR_COMMAND_TYPE), empty);
    assert.deepEqual(
        normalizeActorCommand({ actorId: 7, speedMps: Infinity, steeringRad: undefined }),
        { actorId: "7", speedMps: 0, steeringRad: 0 },
    );
});

test("parseValueByType normalizes opaque road and texture ids", () => {
    assert.equal(SUPPORTED_TYPES.includes(ROAD_ID_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(TEXTURE_ID_TYPE), true);
    assert.equal(normalizeType(ROAD_ID_TYPE), ROAD_ID_TYPE);
    assert.equal(normalizeType(TEXTURE_ID_TYPE), TEXTURE_ID_TYPE);
    assert.equal(parseValueByType(undefined, ROAD_ID_TYPE), "");
    assert.equal(parseValueByType("  e0  ", ROAD_ID_TYPE), "e0");
    assert.equal(parseValueByType(12, TEXTURE_ID_TYPE), "12");
    assert.equal(normalizeOpaqueId("  abc  "), "abc");
    assert.equal(parseValueByType('{"id":"e0"}', ROAD_ID_TYPE), '{"id":"e0"}');
});

test("parseValueByType freezes vec and pose shapes", () => {
    const zeroVec2 = { x: 0, y: 0 };
    const zeroVec3 = { x: 0, y: 0, z: 0 };
    const zeroPose2d = { position: zeroVec2, yaw: 0 };
    const zeroPose3d = {
        position: zeroVec3,
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    };

    assert.equal(SUPPORTED_TYPES.includes(VEC2_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(VEC3_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(POSE2D_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(POSE3D_TYPE), true);
    assert.equal(normalizeType(VEC2_TYPE), VEC2_TYPE);
    assert.equal(normalizeType(POSE3D_TYPE), POSE3D_TYPE);

    assert.deepEqual(parseValueByType(undefined, VEC2_TYPE), zeroVec2);
    assert.deepEqual(parseValueByType({}, VEC2_TYPE), zeroVec2);
    assert.deepEqual(parseValueByType("", VEC2_TYPE), zeroVec2);
    assert.deepEqual(parseValueByType([1, 2], VEC2_TYPE), zeroVec2);
    assert.deepEqual(parseValueByType('{"x":3,"y":4,"extra":9}', VEC2_TYPE), { x: 3, y: 4 });
    assert.deepEqual(parseValueByType({ x: "3.5", y: Infinity, extra: 9 }, VEC2_TYPE), { x: 3.5, y: 0 });
    assert.deepEqual(normalizeVec2({ x: 1, y: 2, extra: true }), { x: 1, y: 2 });

    assert.deepEqual(parseValueByType(undefined, VEC3_TYPE), zeroVec3);
    assert.deepEqual(parseValueByType({ x: 1, y: 2 }, VEC3_TYPE), { x: 1, y: 2, z: 0 });
    assert.deepEqual(normalizeVec3({ x: Infinity, y: "4", z: "-1" }), { x: 0, y: 4, z: -1 });

    assert.deepEqual(parseValueByType(undefined, POSE2D_TYPE), zeroPose2d);
    assert.deepEqual(
        parseValueByType({ x: 1, y: 2, yaw: "0.5", extra: 1 }, POSE2D_TYPE),
        { position: { x: 1, y: 2 }, yaw: 0.5 },
    );
    assert.deepEqual(
        normalizePose2d({ position: { x: 3, y: 4, z: 9 }, yaw: Infinity }),
        { position: { x: 3, y: 4 }, yaw: 0 },
    );

    assert.deepEqual(parseValueByType(undefined, POSE3D_TYPE), zeroPose3d);
    assert.deepEqual(parseValueByType({ x: 1, y: 2, z: 3 }, POSE3D_TYPE), {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    });
    assert.deepEqual(
        parseValueByType(
            '{"position":{"x":1,"y":2,"z":3},"rotation":{"x":0.1,"y":0.2,"z":0.3,"order":"YXZ","extra":true},"extra":9}',
            POSE3D_TYPE,
        ),
        {
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: 0.1, y: 0.2, z: 0.3, order: "YXZ" },
        },
    );
    assert.deepEqual(
        normalizePose3d({ position: { x: 1 }, rotation: { order: "abc" } }),
        {
            position: { x: 1, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        },
    );
});

test("BlockOutput.setDeclared writes only ports present on the unit", () => {
    const unit = new WriteSignalBlock("write");
    unit.hydrateState({ path: "debug.value", type: "float64", source: "script", staleAfter: "" });
    const current = new BlockOutput()
        .setDeclared(unit, "value", 1)
        .setDeclared(unit, "then", UNIT)
        .setDeclared(unit, "written", true);
    assert.equal(current.has("value"), true);
    assert.equal(current.has("then"), true);
    assert.equal(current.has("written"), false);

    unit.typeMap = {
        inputs: { value: "float64" },
        outputs: { written: "boolean" }
    };
    const frozen = new BlockOutput()
        .setDeclared(unit, "value", 1)
        .setDeclared(unit, "then", UNIT)
        .setDeclared(unit, "written", true);
    assert.equal(frozen.has("written"), true);
    assert.equal(frozen.get("written"), true);
    assert.equal(frozen.has("then"), false);
    assert.equal(frozen.has("value"), false);
});

test("type schemes resolve T across sibling ports and ignore typeBindings on concrete ports", () => {
    const unit = new SchemeBlock("scheme");
    unit.typeBindings = { T: "string" };
    assert.equal(getTypeVariable(unit, "inputs", "left"), "T");
    assert.equal(getTypeVariable(unit, "outputs", "out"), "T");
    assert.equal(declaredPortType(unit, "inputs", "left"), GENERIC_TYPE);
    assert.equal(resolvedPortType(unit, "outputs", "out"), "string");

    const concrete = new TypedConstBlock("n", 1, "float64");
    concrete.typeBindings = { T: "string" };
    assert.equal(getTypeVariable(concrete, "outputs", "out"), null);
    assert.equal(resolvedPortType(concrete, "outputs", "out"), "float64");
});

test("planUnify binds concrete-to-generic, unions generic-to-generic, and rejects conflicting concretes", () => {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new TypedConstBlock("num", 1, "float64"));
    manager.addUnit(new TypedConstBlock("text", "x", "string"));
    manager.addUnit(new SchemeBlock("a"));
    manager.addUnit(new SchemeBlock("b"));

    const unbound = planUnify(manager);
    assert.equal(unbound.ok, true);
    assert.equal(unbound.bindings.size, 0);

    connect(manager, "num", "out", "a", "left");
    assert.equal(manager.units.find((unit) => unit.uuid === "a").typeBindings.T, "float64");
    assert.equal(manager.units.find((unit) => unit.uuid === "a").outputType("out"), "float64");

    connect(manager, "a", "out", "b", "left");
    assert.equal(manager.units.find((unit) => unit.uuid === "b").typeBindings.T, "float64");

    const conflict = planUnify(manager, {
        outputUUID: "text",
        outputLabel: "out",
        inputUUID: "a",
        inputLabel: "right"
    });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /Type conflict on SchemeBlock "a" variable T: float64 vs string/);
    assert.equal(manager.connectUnits("text", "out", "a", "right"), false);
    assert.equal(manager.units.find((unit) => unit.uuid === "a").inputs.right, undefined);
    assert.equal(manager.units.find((unit) => unit.uuid === "a").typeBindings.T, "float64");
});

test("disconnect unbinds an unconstrained component and persisted typeBindings are not authority", () => {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new TypedConstBlock("num", 1));
    manager.addUnit(new SchemeBlock("poly"));
    manager.addUnit(new OutputBlock("output"));
    connect(manager, "num", "out", "poly", "left");
    connect(manager, "poly", "out", "output", "output");
    assert.equal(manager.units.find((unit) => unit.uuid === "poly").typeBindings.T, "float64");

    assert.equal(manager.disconnectUnits("num", "out", "poly", "left"), true);
    assert.equal(manager.units.find((unit) => unit.uuid === "poly").typeBindings.T, "float64");
    assert.equal(manager.disconnectUnits("poly", "out", "output", "output"), true);
    assert.deepEqual(manager.units.find((unit) => unit.uuid === "poly").typeBindings, {});
    assert.equal(manager.units.find((unit) => unit.uuid === "poly").inputType("left"), GENERIC_TYPE);

    const graph = serializeManagerGraph(manager, { headUUID: "missing-head" });
    const polyNode = graph.nodes.find((node) => node.uuid === "poly");
    assert.equal(polyNode.typeBindings, undefined);

    connect(manager, "num", "out", "poly", "left");
    const boundGraph = serializeManagerGraph(manager);
    const boundNode = boundGraph.nodes.find((node) => node.uuid === "poly");
    assert.deepEqual(boundNode.typeBindings, { T: "float64" });
    boundNode.typeBindings = { T: "string" };

    const restored = restoreManagerFromGraph(boundGraph, getRegisteredBlockType);
    assert.equal(restored.units.find((unit) => unit.uuid === "poly").typeBindings.T, "float64");
});

test("compile ignores unreachable generics and rejects reachable unbound T", () => {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new TypedConstBlock("num", 2));
    manager.addUnit(new OutputBlock("output"));
    manager.addUnit(new IfBlock("unused-if"));
    connect(manager, "num", "out", "output", "output");

    const artifact = manager.compile("reachable-only");
    assert.equal(artifact.nodes.some((node) => node.uuid === "unused-if"), false);
    assert.equal(JSON.stringify(artifact.nodes).includes("generic"), false);
    assert.equal(JSON.stringify(artifact.transitions).includes("generic"), false);
    assert.equal(manager.checkValidity(), true);

    const unbound = new ScriptManager();
    unbound.addUnit(new BooleanConstBlock("cond", true));
    unbound.addUnit(new SchemeBlock("left"));
    unbound.addUnit(new SchemeBlock("right"));
    unbound.addUnit(new IfBlock("if"));
    unbound.addUnit(new SchemeBlock("sink"));
    unbound.setHead("sink");
    connect(unbound, "cond", "out", "if", "condition");
    connect(unbound, "left", "out", "if", "true value");
    connect(unbound, "right", "out", "if", "false value");
    connect(unbound, "if", "out", "sink", "left");
    assert.equal(unbound.checkValidity(), false);
    assert.throws(() => unbound.compile("unbound"), /Unbound generic T on (IfBlock "if"|SchemeBlock "left")/);
});

test("If, latch, default, log, and weighted select bind T from connections", () => {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new BooleanConstBlock("cond", true));
    manager.addUnit(new TypedConstBlock("hello", "hi", "string"));
    manager.addUnit(new TypedConstBlock("world", "there", "string"));
    manager.addUnit(new IfBlock("if"));
    manager.addUnit(new OutputBlock("output", "string"));
    connect(manager, "cond", "out", "if", "condition");
    connect(manager, "hello", "out", "if", "true value");
    connect(manager, "world", "out", "if", "false value");
    connect(manager, "if", "out", "output", "output");
    assert.equal(manager.units.find((unit) => unit.uuid === "if").typeBindings.T, "string");
    const artifact = manager.compile("if-string");
    const ifNode = artifact.nodes.find((node) => node.uuid === "if");
    assert.equal(ifNode.ports.outputs.out, "string");

    const latchManager = new ScriptManager();
    latchManager.addUnit(new TypedConstBlock("value", 3));
    latchManager.addUnit(new BooleanConstBlock("valid", true));
    latchManager.addUnit(new SignalLatchBlock("latch"));
    latchManager.addUnit(new OutputBlock("output"));
    connect(latchManager, "value", "out", "latch", "value");
    connect(latchManager, "valid", "out", "latch", "valid");
    connect(latchManager, "latch", "value", "output", "output");
    assert.equal(latchManager.units.find((unit) => unit.uuid === "latch").typeBindings.T, "float64");

    const defaultManager = new ScriptManager();
    defaultManager.addUnit(new TypedConstBlock("value", 1));
    defaultManager.addUnit(new TypedConstBlock("fallback", 2));
    defaultManager.addUnit(new BooleanConstBlock("use", false));
    defaultManager.addUnit(new SignalDefaultBlock("default"));
    defaultManager.addUnit(new OutputBlock("output"));
    connect(defaultManager, "value", "out", "default", "value");
    connect(defaultManager, "fallback", "out", "default", "fallback");
    connect(defaultManager, "use", "out", "default", "useDefault");
    connect(defaultManager, "default", "value", "output", "output");
    assert.equal(defaultManager.units.find((unit) => unit.uuid === "default").typeBindings.T, "float64");

    const logManager = new ScriptManager();
    logManager.addUnit(new TypedConstBlock("value", 8));
    logManager.addUnit(new LogSignalBlock("log"));
    logManager.addUnit(new OutputBlock("output"));
    connect(logManager, "value", "out", "log", "value");
    connect(logManager, "log", "value", "output", "output");
    assert.equal(logManager.units.find((unit) => unit.uuid === "log").typeBindings.T, "float64");

    const selectManager = new ScriptManager();
    selectManager.addUnit(new TypedConstBlock("a", true, "boolean"));
    selectManager.addUnit(new TypedConstBlock("b", false, "boolean"));
    selectManager.addUnit(new TypedConstBlock("prob", 0));
    selectManager.addUnit(new WeightedSelectBlock("select"));
    selectManager.addUnit(new OutputBlock("output", "boolean"));
    connect(selectManager, "a", "out", "select", "a");
    connect(selectManager, "b", "out", "select", "b");
    connect(selectManager, "prob", "out", "select", "prob b");
    connect(selectManager, "select", "out", "output", "output");
    assert.equal(selectManager.units.find((unit) => unit.uuid === "select").typeBindings.T, "boolean");
});

test("Equality eq accepts any concrete type and ordered operators reject strings", () => {
    resetRegistry();
    const eqManager = new ScriptManager();
    eqManager.addUnit(new TypedConstBlock("a", "one", "string"));
    eqManager.addUnit(new TypedConstBlock("b", "two", "string"));
    const equality = new EqualityBlock("eq");
    eqManager.addUnit(equality);
    eqManager.addUnit(new OutputBlock("output", "boolean"));
    eqManager.storeData("eq", "eq");
    connect(eqManager, "a", "out", "eq", "input a");
    connect(eqManager, "b", "out", "eq", "input b");
    connect(eqManager, "eq", "out", "output", "output");
    assert.equal(eqManager.checkValidity(), true);
    assert.equal(eqManager.executeProgram().outputs.result, false);

    eqManager.storeData("eq", "gt");
    assert.equal(eqManager.checkValidity(), false);
    assert.equal(eqManager.units.find((unit) => unit.uuid === "eq").inputs["input a"] != null, true);
    assert.throws(() => eqManager.compile("ordered-string"), /variable T: string is not accepted/);

    const gtManager = new ScriptManager();
    gtManager.addUnit(new TypedConstBlock("a", "one", "string"));
    gtManager.addUnit(new TypedConstBlock("b", "two", "string"));
    gtManager.addUnit(new EqualityBlock("eq"));
    gtManager.addUnit(new OutputBlock("output", "boolean"));
    gtManager.storeData("eq", "gt");
    const rejected = gtManager.connectUnitsDetailed("a", "out", "eq", "input a");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /string is not accepted/);
    assert.equal(gtManager.units.find((unit) => unit.uuid === "eq").inputs["input a"], undefined);
});

test("EqualBlock accepts strings and LessBlock rejects them", () => {
    resetRegistry();
    const eqManager = new ScriptManager();
    eqManager.addUnit(new TypedConstBlock("a", "one", "string"));
    eqManager.addUnit(new TypedConstBlock("b", "two", "string"));
    eqManager.addUnit(new EqualBlock("eq"));
    eqManager.addUnit(new OutputBlock("output", "boolean"));
    connect(eqManager, "a", "out", "eq", "a");
    connect(eqManager, "b", "out", "eq", "b");
    connect(eqManager, "eq", "out", "output", "output");
    assert.equal(eqManager.checkValidity(), true);
    assert.equal(eqManager.executeProgram().outputs.result, false);
    const artifact = eqManager.compile("equal-strings");
    assert.equal(artifact.nodes.find((node) => node.uuid === "eq").ports.inputs.a, "string");
    assert.equal(JSON.stringify(artifact).includes("generic"), false);

    const lessManager = new ScriptManager();
    lessManager.addUnit(new TypedConstBlock("a", "one", "string"));
    lessManager.addUnit(new LessBlock("lt"));
    const rejected = lessManager.connectUnitsDetailed("a", "out", "lt", "a");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /string is not accepted/);
    assert.equal(lessManager.units.find((unit) => unit.uuid === "lt").inputs.a, undefined);
});

test("LessBlock binds int32 from IntegerBlock and EqualBlock binds json", () => {
    resetRegistry();
    const lessManager = new ScriptManager();
    lessManager.addUnit(new IntegerBlock("a"));
    lessManager.addUnit(new IntegerBlock("b"));
    lessManager.addUnit(new LessBlock("lt"));
    lessManager.addUnit(new OutputBlock("output", "boolean"));
    lessManager.storeData("a", 1);
    lessManager.storeData("b", 2);
    connect(lessManager, "a", "out", "lt", "a");
    connect(lessManager, "b", "out", "lt", "b");
    connect(lessManager, "lt", "out", "output", "output");
    assert.equal(lessManager.units.find((unit) => unit.uuid === "lt").typeBindings.T, "int32");
    const lessArtifact = lessManager.compile("less-int32");
    assert.equal(lessArtifact.nodes.find((node) => node.uuid === "lt").ports.inputs.a, "int32");

    const equalManager = new ScriptManager();
    equalManager.addUnit(new JsonBlock("left"));
    equalManager.addUnit(new JsonBlock("right"));
    equalManager.addUnit(new EqualBlock("eq"));
    equalManager.addUnit(new OutputBlock("output", "boolean"));
    equalManager.storeData("left", { x: 1 });
    equalManager.storeData("right", { x: 1 });
    connect(equalManager, "left", "out", "eq", "a");
    connect(equalManager, "right", "out", "eq", "b");
    connect(equalManager, "eq", "out", "output", "output");
    assert.equal(equalManager.units.find((unit) => unit.uuid === "eq").typeBindings.T, "json");
    assert.equal(equalManager.executeProgram().outputs.result, true);
});

test("PreviousBlock unifies T across value initial and previous", () => {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new TypedConstBlock("value", "now", "string"));
    manager.addUnit(new TypedConstBlock("initial", "start", "string"));
    manager.addUnit(new PreviousBlock("prev"));
    manager.addUnit(new OutputBlock("output", "string"));
    connect(manager, "value", "out", "prev", "value");
    connect(manager, "initial", "out", "prev", "initial");
    connect(manager, "prev", "previous", "output", "output");
    assert.equal(manager.units.find((unit) => unit.uuid === "prev").typeBindings.T, "string");
    const artifact = manager.compile("previous-string");
    assert.equal(artifact.nodes.find((node) => node.uuid === "prev").ports.outputs.previous, "string");
    assert.equal(JSON.stringify(artifact).includes("generic"), false);
    assert.equal(manager.executeProgram().outputs.result, "start");

    const conflict = new ScriptManager();
    conflict.addUnit(new TypedConstBlock("value", 1, "float64"));
    conflict.addUnit(new TypedConstBlock("initial", "x", "string"));
    conflict.addUnit(new PreviousBlock("prev"));
    connect(conflict, "value", "out", "prev", "value");
    const rejected = conflict.connectUnitsDetailed("initial", "out", "prev", "initial");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Type conflict/);
    assert.equal(conflict.units.find((unit) => unit.uuid === "prev").inputs.initial, undefined);
    assert.equal(conflict.units.find((unit) => unit.uuid === "prev").typeBindings.T, "float64");

    const changed = new ScriptManager();
    changed.addUnit(new TypedConstBlock("value", 3));
    changed.addUnit(new ValueChangedBlock("chg"));
    changed.addUnit(new OutputBlock("output", "boolean"));
    connect(changed, "value", "out", "chg", "value");
    connect(changed, "chg", "changed", "output", "output");
    assert.equal(changed.units.find((unit) => unit.uuid === "chg").typeBindings.T, "float64");
    const changedArtifact = changed.compile("value-changed");
    assert.equal(changedArtifact.nodes.find((node) => node.uuid === "chg").ports.inputs.value, "float64");
    assert.equal(JSON.stringify(changedArtifact).includes("generic"), false);
});


test("MCP-style mutateGraphConnections rejects conflicts before rewriting the graph", () => {
    resetRegistry();
    const graph = {
        head: "head-uuid",
        outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] },
        nodes: [
            { uuid: "num", type: "NumberUnitClass", state: {}, storedData: 1, position: { x: 0, y: 0 } },
            { uuid: "text", type: "StringBlock", state: {}, storedData: "x", position: { x: 10, y: 0 } },
            { uuid: "iff", type: "IfBlock", state: {}, storedData: null, position: { x: 20, y: 0 } }
        ],
        connections: []
    };

    const withNumber = mutateGraphConnections(graph, getRegisteredBlockType, (manager) => (
        manager.connectUnitsDetailed("num", "number", "iff", "true value")
    ));
    assert.equal(withNumber.ok, true);
    const ifNode = withNumber.graph.nodes.find((node) => node.uuid === "iff");
    assert.deepEqual(ifNode.typeBindings, { T: "float64" });
    const edge = withNumber.graph.connections.find((connection) => connection.to === "iff");
    assert.equal(edge.type, "float64");

    const conflict = mutateGraphConnections(withNumber.graph, getRegisteredBlockType, (manager) => (
        manager.connectUnitsDetailed("text", "out", "iff", "false value")
    ));
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /Type conflict on IfBlock "iff" variable T/);

    const disconnected = mutateGraphConnections(withNumber.graph, getRegisteredBlockType, (manager) => {
        const removed = manager.disconnectUnits("num", "number", "iff", "true value");
        return removed ? { ok: true } : { ok: false, error: "missing" };
    });
    assert.equal(disconnected.ok, true);
    const unbound = disconnected.graph.nodes.find((node) => node.uuid === "iff");
    assert.equal(unbound.typeBindings, undefined);
});

test("string cannot connect to Sample Road edgeId", () => {
    resetRegistry();
    registerBlockType("StringBlock", StringBlock);
    registerBlockType("SampleRoadBlock", SampleRoadBlock);
    const manager = new ScriptManager();
    manager.addUnit(new StringBlock("str"));
    manager.addUnit(new SampleRoadBlock("road"));
    const result = manager.connectUnitsDetailed("str", "out", "road", "edgeId");
    assert.equal(result.ok, false);
    assert.match(result.error, /Type mismatch|incompatible|string|road_id/i);
    assert.equal(manager.units.find((unit) => unit.uuid === "road").inputs.edgeId, undefined);
});

test("actor_command cannot connect to float64 and binds If T", () => {
    resetRegistry();
    const conflictManager = new ScriptManager();
    conflictManager.addUnit(new MakeActorCommandBlock("make"));
    conflictManager.addUnit(new OutputBlock("output"));
    const conflict = conflictManager.connectUnitsDetailed("make", "command", "output", "output");
    assert.equal(conflict.ok, false);
    assert.equal(conflictManager.units.find((unit) => unit.uuid === "output").inputs.output, undefined);

    const manager = new ScriptManager();
    manager.addUnit(new BooleanConstBlock("cond", true));
    manager.addUnit(new MakeActorCommandBlock("true-cmd"));
    manager.addUnit(new MakeActorCommandBlock("false-cmd"));
    manager.addUnit(new TypedConstBlock("speed", 1));
    manager.addUnit(new TypedConstBlock("steering", 0.2));
    manager.addUnit(new IfBlock("if"));
    manager.addUnit(new OutputBlock("output", ACTOR_COMMAND_TYPE));
    connect(manager, "speed", "out", "true-cmd", "speed");
    connect(manager, "steering", "out", "true-cmd", "steering");
    connect(manager, "speed", "out", "false-cmd", "speed");
    connect(manager, "steering", "out", "false-cmd", "steering");
    connect(manager, "cond", "out", "if", "condition");
    connect(manager, "true-cmd", "command", "if", "true value");
    connect(manager, "false-cmd", "command", "if", "false value");
    connect(manager, "if", "out", "output", "output");
    assert.equal(manager.units.find((unit) => unit.uuid === "if").typeBindings.T, ACTOR_COMMAND_TYPE);
    const artifact = manager.compile("if-actor-command");
    const ifNode = artifact.nodes.find((node) => node.uuid === "if");
    assert.equal(ifNode.ports.outputs.out, ACTOR_COMMAND_TYPE);
    assert.equal(artifact.interface.outputs[0].type, ACTOR_COMMAND_TYPE);
    assert.equal(JSON.stringify(artifact).includes("generic"), false);
});

test("reconfigureUnitDetailed commits compatible changes and rolls back port conflicts", () => {
    resetRegistry();
    const manager = new ScriptManager();
    const input = new ProgramInputBlock("input");
    manager.addUnit(input);
    manager.storeData("input", { label: "value", type: "float64", defaultValue: "0" });
    input.reregister();
    manager.addUnit(new OutputBlock("output", "float64"));
    connect(manager, "input", "input", "output", "output");

    const beforePorts = structuredClone(input.typeMap);
    const beforeStoredData = structuredClone(manager.getStoredData("input"));
    const rejected = manager.reconfigureUnitDetailed("input", {
        storedData: { label: "value", type: "string", defaultValue: "" },
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Type mismatch/);
    assert.deepEqual(input.typeMap, beforePorts);
    assert.deepEqual(manager.getStoredData("input"), beforeStoredData);
    assert.equal(input.outputs.input.length, 1);
    assert.equal(manager.units.find((unit) => unit.uuid === "output").inputs.output.getOutput().unit, input);

    assert.equal(manager.disconnectUnits("input", "input", "output", "output"), true);
    const accepted = manager.reconfigureUnitDetailed("input", {
        storedData: { label: "text", type: "string", defaultValue: "" },
    });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(accepted.ports.outputs.input, "string");
    assert.equal(accepted.storedData.label, "text");
});

test("reconfigureUnitDetailed restores generic bindings and OutputNode ports atomically", () => {
    resetRegistry();
    const equalityManager = new ScriptManager();
    const left = new StringBlock("left");
    const right = new StringBlock("right");
    const equality = new EqualityBlock("equality");
    equalityManager.addUnit(left);
    equalityManager.addUnit(right);
    equalityManager.addUnit(equality);
    equalityManager.storeData("left", "a");
    equalityManager.storeData("right", "b");
    equalityManager.storeData("equality", "eq");
    connect(equalityManager, "left", "out", "equality", "input a");
    connect(equalityManager, "right", "out", "equality", "input b");
    assert.equal(equality.typeBindings.T, "string");

    const rejectedOperator = equalityManager.reconfigureUnitDetailed("equality", { storedData: "gt" });
    assert.equal(rejectedOperator.ok, false);
    assert.match(rejectedOperator.error, /string is not accepted/);
    assert.equal(equalityManager.getStoredData("equality"), "eq");
    assert.deepEqual(equality.typeBindings, { T: "string" });

    const outputManager = new ScriptManager();
    const number = new NumberUnitClass("number");
    const head = new OutputNodeBlock("head");
    const config = { outputs: [{ id: "result", label: "result", type: "float64" }] };
    head.hydrateState(config);
    outputManager.addUnit(number);
    outputManager.addUnit(head);
    outputManager.storeData("number", 3);
    outputManager.storeData("head", config);
    outputManager.setHead("head");
    connect(outputManager, "number", "number", "head", "result");

    const next = { outputs: [{ id: "result", label: "result", type: "string" }] };
    const rejectedHead = outputManager.reconfigureUnitDetailed("head", { state: next, storedData: next });
    assert.equal(rejectedHead.ok, false);
    assert.equal(head.typeMap.inputs.result, "float64");
    assert.deepEqual(head.serializeState(), config);
    assert.deepEqual(outputManager.getStoredData("head"), config);
    assert.ok(head.inputs.result);
});

test("reconfigureGraphUnit leaves the source graph unchanged when a typed edit fails", () => {
    resetRegistry();
    const graph = {
        head: "head",
        headPosition: { x: 20, y: 30 },
        outputNodeConfig: { outputs: [{ id: "result", label: "result", type: "float64" }] },
        nodes: [{
            uuid: "number",
            type: "NumberUnitClass",
            state: {},
            storedData: 2,
            runtimeState: {},
            position: { x: 0, y: 0 },
        }],
        connections: [{ from: "number", output: "number", to: "head", input: "result", type: "float64" }],
    };
    const before = structuredClone(graph);
    const next = { outputs: [{ id: "result", label: "result", type: "string" }] };
    const rejected = reconfigureGraphUnit(graph, getRegisteredBlockType, "head", {
        state: next,
        storedData: next,
        position: { x: 90, y: 100 },
    });
    assert.equal(rejected.ok, false);
    assert.deepEqual(graph, before);
});

test("reconfigureUnitDetailed rejects itemType and valueType conflicts", () => {
    resetRegistry();
    const arrayManager = new ScriptManager();
    const getter = new ArrayGetBlock("get");
    getter.hydrateState({ itemType: "float64", fallback: 0 });
    const add = new AddBlock("add");
    arrayManager.addUnit(getter);
    arrayManager.addUnit(add);
    connect(arrayManager, "get", "out", "add", "a");
    const beforeState = structuredClone(getter.serializeState());
    const rejectedType = arrayManager.reconfigureUnitDetailed("get", {
        state: { itemType: "string", fallback: 0 },
    });
    assert.equal(rejectedType.ok, false);
    assert.match(rejectedType.error, /Type mismatch/);
    assert.deepEqual(getter.serializeState(), beforeState);
    assert.equal(getter.typeMap.outputs.out, "float64");
    assert.ok(add.inputs.a);

    const jsonManager = new ScriptManager();
    const setter = new JsonSetBlock("set");
    setter.hydrateState({ path: "x", valueType: "float64" });
    const number = new NumberUnitClass("number");
    jsonManager.addUnit(setter);
    jsonManager.addUnit(number);
    connect(jsonManager, "number", "number", "set", "value");
    const rejectedValue = jsonManager.reconfigureUnitDetailed("set", {
        state: { path: "x", valueType: "string" },
    });
    assert.equal(rejectedValue.ok, false);
    assert.match(rejectedValue.error, /Type mismatch/);
    assert.equal(setter.typeMap.inputs.value, "float64");
    assert.equal(setter.serializeState().valueType, "float64");
});
