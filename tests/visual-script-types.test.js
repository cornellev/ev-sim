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
    restoreManagerFromGraph,
    serializeManagerGraph,
} from "../app/scripting/GraphDocument.js";
import { getRegisteredBlockType } from "../app/scripting/BlockRegistry.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import { IfBlock } from "../app/scripting/units/statements/If.block.js";
import { EqualityBlock } from "../app/scripting/units/statements/Equality.block.js";
import { WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import {
    LogSignalBlock,
    SignalDefaultBlock,
    SignalLatchBlock,
    WriteSignalBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";
import { OutputNodeBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import {
    normalizeType,
    parseValueByType,
    SUPPORTED_TYPES,
} from "../app/scripting/units/program/ProgramTypes.js";
import {
    GENERIC_TYPE,
    isConcreteType,
    isGeneric,
    portsCompatible,
    UNIT,
    UNIT_TYPE,
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
        OutputNodeBlock,
    ].forEach((blockClass) => registerBlockType(blockClass.name, blockClass));
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
});

test("parseValueByType always returns the UNIT singleton", () => {
    assert.equal(SUPPORTED_TYPES.includes(UNIT_TYPE), true);
    assert.equal(SUPPORTED_TYPES.includes(GENERIC_TYPE), false);
    assert.equal(normalizeType(UNIT_TYPE), UNIT_TYPE);
    assert.equal(parseValueByType(undefined, UNIT_TYPE), UNIT);
    assert.equal(parseValueByType("foo", UNIT_TYPE), UNIT);
    assert.equal(parseValueByType({ type: "nope" }, UNIT_TYPE), UNIT);
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
