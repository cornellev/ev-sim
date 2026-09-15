import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    BlockOutput,
    clearBlockTypeRegistryForTests,
    CompiledProgramUnitBlock,
    getRegisteredBlockType,
    LocalScriptProgramBlock,
    registerBlockType,
    ScriptManager,
    UnitBlock,
} from "../app/scripting/ScriptManager.js";
import {
    createArtifactOnlyDocument,
    createScriptDocument,
    isCompiledArtifact,
    isEditorDocument,
} from "../app/scripting/EditorDocument.js";
import {
    restoreManagerFromGraph,
    serializeManagerGraph,
    formatRestoreErrors,
    mergeUnrestoredConnections,
    wouldCreateScriptReferenceCycle,
} from "../app/scripting/GraphDocument.js";
import { createLoadedScript, loadScript } from "../app/scripting/ScriptRuntime.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { OutputNodeBlock, ProgramInputBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import { normalizeOutputNodeState, parseValueByType } from "../app/scripting/units/program/ProgramTypes.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import {
    AdvanceWaypointBlock,
    AssertSignalBlock,
    LogSignalBlock,
    RecordSignalBlock,
    ScenarioFlagWriteBlock,
    SetMissionStateBlock,
    SignalDefaultBlock,
    SignalLatchBlock,
    StagePublishBlock,
    WriteSignalBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";
import { IfBlock } from "../app/scripting/units/statements/If.block.js";
import {
    IgnoreBlock,
    NopBlock,
    PassthroughBlock,
    SequenceBlock,
} from "../app/scripting/units/statements/Unit.block.js";
import { UNIT, UNIT_TYPE } from "../app/scripting/types/PortTypes.js";
import {
    assertSupportedArtifact,
    SUPPORTED_ARTIFACT_VERSIONS,
    VISUAL_SCRIPT_KIND,
    VISUAL_SCRIPT_VERSION,
} from "../app/scripting/runtime/Artifact.js";

class ConstBlock extends UnitBlock {
    constructor(uuid, value = 1) {
        super(uuid);
        this.value = value;
    }

    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    serializeState() {
        return { value: this.value };
    }

    hydrateState(state = {}) {
        this.value = state.value ?? this.value;
        super.hydrateState(state);
    }

    execute() {
        return new BlockOutput().set("out", this.value);
    }
}

class AddBlock extends UnitBlock {
    register() {
        this.registerInput("a", "float64");
        this.registerInput("b", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("a") && this.hasInput("b");
    }

    execute() {
        return new BlockOutput().set("out", this.getInput("a") + this.getInput("b"));
    }
}

class BooleanSourceBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", false);
    }
}

class InputBlock extends UnitBlock {
    static programNodeRole = "input";

    constructor(uuid, label = "x") {
        super(uuid);
        this.state = { label };
        this.reregister();
    }

    register() {
        this.registerOutput("input", "float64");
    }

    serializeState() {
        return { ...this.state };
    }

    getProgramPortDefinition() {
        return {
            role: "input",
            uuid: this.uuid,
            portId: "input",
            label: this.state.label,
            type: "float64"
        };
    }

    valid() {
        return this.hasOutput("input");
    }

    execute() {
        return new BlockOutput().set("input", this.manager.resolveExternalInput(this.state.label, 0));
    }
}

class OutputBlock extends UnitBlock {
    static programNodeRole = "output";

    constructor(uuid, label = "result", type = "float64") {
        super(uuid);
        this.state = { label, type };
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
            label: this.state.label,
            type: this.state.type
        };
    }

    valid() {
        return this.hasInput("output");
    }

    execute() {
        this.manager.setExternalOutput(this.state.label, this.getInput("output"));
        return new BlockOutput();
    }
}

class MultiOutputBlock extends UnitBlock {
    static programNodeRole = "output";

    constructor(uuid) {
        super(uuid);
        this.state = {
            outputs: [
                { id: "primary", label: "primary", type: "float64" },
                { id: "secondary", label: "secondary", type: "float64" }
            ]
        };
        this.reregister();
    }

    register() {
        const outputs = this.state?.outputs || [];
        outputs.forEach((output) => {
            this.registerInput(output.id, output.type);
        });
    }

    serializeState() {
        return { ...this.state };
    }

    getProgramPortDefinition() {
        return this.state.outputs.map((output) => ({
            role: "output",
            uuid: this.uuid,
            portId: output.id,
            label: output.label,
            type: output.type
        }));
    }

    valid() {
        return this.state.outputs.every((output) => this.hasInput(output.id));
    }

    execute() {
        this.state.outputs.forEach((output) => {
            this.manager.setExternalOutput(output.label, this.getInput(output.id));
        });
        return new BlockOutput();
    }
}

class CountingBlock extends UnitBlock {
    static count = 0;

    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        CountingBlock.count += 1;
        return new BlockOutput().set("out", CountingBlock.count);
    }
}

class ThrowBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        throw new Error("boom");
    }
}

class BareObjectBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        return {};
    }
}

class AccumulatorBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.total = 0;
    }

    register() {
        this.registerInput("value", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("value");
    }

    serializeRuntimeState() {
        return { total: this.total };
    }

    hydrateRuntimeState(state = {}) {
        this.total = Number.isFinite(state.total) ? state.total : 0;
    }

    execute() {
        this.total += this.getInput("value");
        return new BlockOutput().set("out", this.total);
    }
}

class SignalWriteTestBlock extends UnitBlock {
    register() {
        this.registerInput("value", "float64");
        this.registerOutput("written", "boolean");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        this.manager.writeSignal("debug.value", this.getInput("value"), {
            type: "float64",
            source: "test"
        });
        return new BlockOutput().set("written", true);
    }
}

class SignalWritePassthroughBlock extends UnitBlock {
    register() {
        this.registerInput("value", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        const value = this.getInput("value");
        this.manager.writeSignal("debug.value", value, {
            type: "float64",
            source: "test"
        });
        return new BlockOutput().set("out", value);
    }
}

class FailingSignalWriteBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        this.manager.writeSignal("debug.value", 99, {
            type: "float64",
            source: "test"
        });
        throw new Error("write failed");
    }
}

class SignalReadValueBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.manager.readSignal("debug.value", { type: "float64" }).value ?? 0);
    }
}

class BindingConfigBlock extends UnitBlock {
    register() {
        this.registerOutput("config", "json");
    }

    valid() {
        return true;
    }

    getBindingDefinition() {
        return {
            kind: "input",
            sourceKind: "topic",
            source: "/controls/command",
            path: "topics./controls/command",
            type: "message"
        };
    }

    execute() {
        return new BlockOutput().set("config", this.getBindingDefinition());
    }
}

class EntrypointConfigBlock extends UnitBlock {
    register() {
        this.registerOutput("config", "json");
    }

    valid() {
        return true;
    }

    getEntrypointDefinition() {
        return {
            kind: "signal-update",
            path: "topics./controls/command"
        };
    }

    execute() {
        return new BlockOutput().set("config", this.getEntrypointDefinition());
    }
}

class BooleanConstBlock extends UnitBlock {
    constructor(uuid, value = true) {
        super(uuid);
        this.value = value;
        this.state = { value };
        this.reregister();
    }

    register() {
        this.registerOutput("out", "boolean");
    }

    serializeState() {
        return { value: this.value };
    }

    hydrateState(state = {}) {
        if (Object.prototype.hasOwnProperty.call(state, "value")) {
            this.value = state.value;
        }
        super.hydrateState(state);
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.value);
    }
}

class ProbeBlock extends UnitBlock {
    static counts = new Map();

    constructor(uuid, value = 1, type = "float64") {
        super(uuid);
        this.value = value;
        this.state = { value, type };
        this.reregister();
        ProbeBlock.counts.set(uuid, 0);
    }

    static count(uuid) {
        return ProbeBlock.counts.get(uuid) || 0;
    }

    register() {
        this.registerOutput("out", this.state?.type || "float64");
    }

    serializeState() {
        return { value: this.value, type: this.state?.type || "float64" };
    }

    hydrateState(state = {}) {
        if (Object.prototype.hasOwnProperty.call(state, "value")) {
            this.value = state.value;
        }
        super.hydrateState(state);
    }

    valid() {
        return true;
    }

    execute() {
        ProbeBlock.counts.set(this.uuid, ProbeBlock.count(this.uuid) + 1);
        return new BlockOutput().set("out", this.value);
    }
}

class OrderedEffectBlock extends UnitBlock {
    static order = [];

    constructor(uuid, name) {
        super(uuid);
        this.name = name;
    }

    register() {
        this.registerOutput("then", UNIT_TYPE);
    }

    valid() {
        return true;
    }

    execute() {
        OrderedEffectBlock.order.push(this.name);
        return new BlockOutput().set("then", UNIT);
    }
}

class MessageConstBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "message");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", {});
    }
}

class StringConstBlock extends UnitBlock {
    constructor(uuid, value = "idle") {
        super(uuid);
        this.value = value;
    }

    register() {
        this.registerOutput("out", "string");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("out", this.value);
    }
}

const V2_EAGER_EFFECTS_FIXTURE = JSON.parse(readFileSync(
    new URL("./fixtures/scripting/visual-script-v2-eager-effects.json", import.meta.url),
    "utf8"
));

function withArtifactVersion(artifact, version) {
    return JSON.parse(JSON.stringify({ ...artifact, version }));
}

function resetRegistry() {
    clearBlockTypeRegistryForTests();
    [
        ConstBlock,
        AddBlock,
        BooleanSourceBlock,
        InputBlock,
        OutputBlock,
        MultiOutputBlock,
        CountingBlock,
        ThrowBlock,
        BareObjectBlock,
        AccumulatorBlock,
        SignalWriteTestBlock,
        SignalWritePassthroughBlock,
        FailingSignalWriteBlock,
        SignalReadValueBlock,
        BindingConfigBlock,
        EntrypointConfigBlock,
        BooleanConstBlock,
        ProbeBlock,
        CompiledProgramUnitBlock,
        LocalScriptProgramBlock,
        OutputNodeBlock,
        ProgramInputBlock,
        NumberUnitClass,
        IfBlock,
        WeightedSelectBlock,
        SignalLatchBlock,
        SignalDefaultBlock,
        WriteSignalBlock,
        AdvanceWaypointBlock,
        AssertSignalBlock,
        LogSignalBlock,
        RecordSignalBlock,
        ScenarioFlagWriteBlock,
        SetMissionStateBlock,
        StagePublishBlock,
        IgnoreBlock,
        NopBlock,
        PassthroughBlock,
        SequenceBlock,
        OrderedEffectBlock,
        MessageConstBlock,
        StringConstBlock,
    ].forEach((blockClass) => registerBlockType(blockClass.name, blockClass));
    registerBlockType(LocalScriptProgramBlock.blockType, LocalScriptProgramBlock);
}

function createBasicProgram() {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("zero", 0));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("zero", "out", "add", "a");
    manager.connectUnits("two", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");

    return manager;
}

test("compile creates deterministic Q, nodeIndex, and reverseSuccess tables", () => {
    const artifact = createBasicProgram().compile("basic");

    assert.equal(artifact.kind, VISUAL_SCRIPT_KIND);
    assert.equal(artifact.version, VISUAL_SCRIPT_VERSION);
    assert.equal(artifact.version, 3);
    assert.equal(artifact.nodes.every((node) => node.ports && typeof node.ports.inputs === "object" && typeof node.ports.outputs === "object"), true);
    assert.deepEqual(artifact.Q, ["zero", "two", "add", "output"]);
    assert.deepEqual(artifact.nodeIndex, {
        zero: 0,
        two: 1,
        add: 2,
        output: 3
    });
    assert.deepEqual(artifact.startStates, ["zero", "two"]);
    assert.equal(artifact.reverseSuccess.add.a.from, "zero");
    assert.equal(artifact.reverseSuccess.add.b.from, "two");
    assert.equal(artifact.reverseSuccess.output.output.from, "add");
    assert.equal(artifact.transitions.failure.length, 0);
});

test("runtime executes source nodes and preserves falsey output values", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new BooleanSourceBlock("source"));
    manager.addUnit(new OutputBlock("output", "result", "boolean"));
    manager.connectUnits("source", "out", "output", "output");

    const run = ScriptManager.runCompiled(manager.compile("bool"), {});

    assert.equal(run.status, "success");
    assert.equal(run.outputs.result, false);
});

test("runtime memoizes shared upstream nodes once per run", () => {
    resetRegistry();
    CountingBlock.count = 0;

    const manager = new ScriptManager();
    manager.addUnit(new CountingBlock("count"));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("count", "out", "add", "a");
    manager.connectUnits("count", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");

    const run = ScriptManager.runCompiled(manager.compile("memo"), {});

    assert.equal(run.status, "success");
    assert.equal(CountingBlock.count, 1);
    assert.equal(run.outputs.result, 2);
});

test("evaluateUnit memos only successful BlockOutputs and clears evaluating on throw", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ThrowBlock("throw"));
    manager.addUnit(new BareObjectBlock("bare"));
    manager._beginEvaluation();

    assert.throws(() => manager.evaluateUnit("throw"), /boom/);
    assert.equal(manager.outputMemo.has("throw"), false);
    assert.equal(manager.evaluating.has("throw"), false);

    assert.throws(() => manager.evaluateUnit("bare"), /did not return a BlockOutput/);
    assert.equal(manager.outputMemo.has("bare"), false);
    assert.throws(() => manager.evaluateUnit("missing"), /Runtime node "missing" is not available/);
});

test("editor executeProgram memos a shared diamond once per call", () => {
    resetRegistry();
    CountingBlock.count = 0;

    const manager = new ScriptManager();
    manager.addUnit(new CountingBlock("count"));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("count", "out", "add", "a");
    manager.connectUnits("count", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");

    const first = manager.executeProgram();
    assert.equal(first.status, "success");
    assert.equal(CountingBlock.count, 1);
    assert.equal(first.outputs.result, 2);

    const second = manager.executeProgram();
    assert.equal(second.status, "success");
    assert.equal(CountingBlock.count, 2);
    assert.equal(second.outputs.result, 4);
});

test("editor executeProgram writes a shared effectful diamond once", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("value", 12));
    manager.addUnit(new SignalWriteTestBlock("write"));
    manager.addUnit(new OutputBlock("ok-a", "ok-a", "boolean"));
    manager.addUnit(new OutputBlock("ok-b", "ok-b", "boolean"));
    manager.connectUnits("value", "out", "write", "value");
    manager.connectUnits("write", "written", "ok-a", "output");
    manager.connectUnits("write", "written", "ok-b", "output");

    const signalStore = new SignalStore();
    const run = manager.executeProgram({}, { signalStore });

    assert.equal(manager.evaluationPolicy.memoizeExecute, true);
    assert.equal(run.status, "success");
    assert.deepEqual(run.outputs, { "ok-a": true, "ok-b": true });
    assert.equal(signalStore.read("debug.value").value, 12);
});

test("editor executeProgram shares memoization across multiple OutputNodes", () => {
    resetRegistry();
    CountingBlock.count = 0;

    const manager = new ScriptManager();
    manager.addUnit(new CountingBlock("count"));
    manager.addUnit(new OutputBlock("out-a", "a"));
    manager.addUnit(new OutputBlock("out-b", "b"));
    manager.connectUnits("count", "out", "out-a", "output");
    manager.connectUnits("count", "out", "out-b", "output");

    const run = manager.executeProgram();

    assert.equal(run.status, "success");
    assert.equal(CountingBlock.count, 1);
    assert.deepEqual(run.outputs, { a: 1, b: 1 });
});

test("editor executeProgram reports a runtime cycle without leaking staged signal writes", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("one", 1));
    manager.addUnit(new SignalWritePassthroughBlock("write"));
    manager.addUnit(new AddBlock("a"));
    manager.addUnit(new AddBlock("b"));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("one", "out", "write", "value");
    manager.connectUnits("write", "out", "a", "a");
    manager.connectUnits("b", "out", "a", "b");
    manager.connectUnits("two", "out", "b", "a");
    manager.connectUnits("a", "out", "b", "b");
    manager.connectUnits("a", "out", "output", "output");

    assert.equal(manager.checkValidity(), true);

    const signalStore = new SignalStore();
    const run = manager.executeProgram({}, { signalStore });

    assert.equal(run.status, "failure");
    assert.match(run.e.message, /Cycle detected at runtime while evaluating "/);
    assert.equal(signalStore.read("debug.value").exists, false);
    assert.equal(Object.keys(signalStore.pendingSnapshot()).length, 0);
});

test("single output node can expose multiple program outputs", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("one", 1));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new MultiOutputBlock("outputs"));
    manager.connectUnits("one", "out", "outputs", "primary");
    manager.connectUnits("two", "out", "outputs", "secondary");

    const artifact = manager.compile("multi-output");
    const run = ScriptManager.runCompiled(artifact, {});

    assert.deepEqual(artifact.interface.outputs.map((output) => output.label), ["primary", "secondary"]);
    assert.equal(artifact.reverseSuccess.outputs.primary.from, "one");
    assert.equal(artifact.reverseSuccess.outputs.secondary.from, "two");
    assert.deepEqual(run.outputs, {
        primary: 1,
        secondary: 2
    });
});

test("runtime exceptions return failure results", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ThrowBlock("throw"));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("throw", "out", "output", "output");

    const run = ScriptManager.runCompiled(manager.compile("failure"), {});

    assert.equal(run.status, "failure");
    assert.equal(run.outputs.result, undefined);
    assert.match(run.e.message, /boom/);
});

test("compile rejects invalid graph shapes", () => {
    resetRegistry();

    const missingInput = new ScriptManager();
    missingInput.addUnit(new ConstBlock("one", 1));
    missingInput.addUnit(new AddBlock("add"));
    missingInput.addUnit(new OutputBlock("output"));
    missingInput.connectUnits("add", "out", "output", "output");
    assert.throws(() => missingInput.compile("missing"), /invalid/);

    class UnknownBlock extends UnitBlock {
        register() {
            this.registerOutput("out", "float64");
        }

        valid() {
            return true;
        }
    }

    const unknown = new ScriptManager();
    unknown.addUnit(new UnknownBlock("unknown"));
    unknown.addUnit(new OutputBlock("output"));
    unknown.connectUnits("unknown", "out", "output", "output");
    assert.throws(() => unknown.compile("unknown"), /Unknown block type/);

    const duplicateLabels = new ScriptManager();
    duplicateLabels.addUnit(new InputBlock("input-a", "x"));
    duplicateLabels.addUnit(new InputBlock("input-b", "x"));
    duplicateLabels.addUnit(new AddBlock("add"));
    duplicateLabels.addUnit(new OutputBlock("output"));
    duplicateLabels.connectUnits("input-a", "input", "add", "a");
    duplicateLabels.connectUnits("input-b", "input", "add", "b");
    duplicateLabels.connectUnits("add", "out", "output", "output");
    assert.throws(() => duplicateLabels.compile("duplicate-labels"), /Duplicate program input label/);
});

test("compile rejects cycles, type mismatches, and duplicate input edges", () => {
    resetRegistry();

    const cycle = new ScriptManager();
    cycle.addUnit(new AddBlock("a"));
    cycle.addUnit(new AddBlock("b"));
    cycle.addUnit(new OutputBlock("output"));
    cycle.connectUnits("a", "out", "b", "a");
    cycle.connectUnits("b", "out", "a", "a");
    cycle.connectUnits("a", "out", "output", "output");
    assert.throws(() => cycle.compile("cycle"), /Cycle detected/);

    const typeMismatch = createBasicProgram();
    const source = typeMismatch.units.find((unit) => unit.uuid === "zero");
    const target = typeMismatch.units.find((unit) => unit.uuid === "add");
    target.typeMap.inputs.a = "boolean";
    assert.throws(() => typeMismatch.compile("type-mismatch"), /Type mismatch/);

    const duplicateEdge = createBasicProgram();
    const add = duplicateEdge.units.find((unit) => unit.uuid === "add");
    const two = duplicateEdge.units.find((unit) => unit.uuid === "two");
    const duplicateConnection = {
        getOutput: () => ({ unit: two, label: "out" }),
        getInput: () => ({ unit: add, label: "a" })
    };
    two.outputs.out.push(duplicateConnection);
    assert.throws(() => duplicateEdge.compile("duplicate-edge"), /Duplicate input edge/);

    assert.ok(source);
});

test("compiled program block maps imported inputs and outputs", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new InputBlock("input", "x"));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("input", "input", "add", "a");
    manager.connectUnits("two", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");
    const artifact = manager.compile("imported");

    const imported = new CompiledProgramUnitBlock("imported");
    imported.hydrateState({ compiledProgram: artifact });
    imported.inputs.x = {};
    imported.getInput = () => 3;

    const output = imported.execute();

    assert.equal(artifact.interface.inputs[0].label, "x");
    assert.equal(artifact.interface.inputs[0].portId, "input");
    assert.equal(imported.inputType("x"), "float64");
    assert.equal(imported.outputType("result"), "float64");
    assert.equal(output.get("result"), 5);
});

test("executeProgram surfaces outputs from connected imported programs", () => {
    resetRegistry();

    const inner = new ScriptManager();
    inner.addUnit(new InputBlock("input", "x"));
    inner.addUnit(new AddBlock("add"));
    inner.addUnit(new ConstBlock("two", 2));
    inner.addUnit(new OutputBlock("output", "result"));
    inner.connectUnits("input", "input", "add", "a");
    inner.connectUnits("two", "out", "add", "b");
    inner.connectUnits("add", "out", "output", "output");
    const artifact = inner.compile("add-two");

    const outer = new ScriptManager();
    outer.addUnit(new ConstBlock("three", 3));

    const imported = new CompiledProgramUnitBlock("imported");
    imported.hydrateState({ compiledProgram: artifact });
    outer.addUnit(imported);

    outer.addUnit(new OutputBlock("output", "final"));
    outer.connectUnits("three", "out", "imported", "x");
    outer.connectUnits("imported", "result", "output", "output");

    assert.equal(outer.checkValidity(), true);

    const run = outer.executeProgram();
    assert.equal(run.status, "success");
    assert.deepEqual(run.outputs, { final: 5 });
});

test("persistent runners preserve runtime state across runs", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new InputBlock("input", "x"));
    manager.addUnit(new AccumulatorBlock("acc"));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("input", "input", "acc", "value");
    manager.connectUnits("acc", "out", "output", "output");

    const runner = ScriptManager.createRunner(manager.compile("stateful"));

    assert.equal(runner.run({ x: 2 }).outputs.result, 2);
    assert.equal(runner.run({ x: 2 }).outputs.result, 4);
    assert.deepEqual(runner.serializeRuntimeState().acc, { total: 4 });
});

test("signal store reads expose value, age, stale status, and changed status", () => {
    const now = Date.parse("2026-06-09T00:00:10.000Z");
    const store = new SignalStore({
        "topics./controls/command": {
            value: { speed: 4 },
            type: "message",
            updatedAt: "2026-06-09T00:00:08.000Z",
            source: "mock-ros",
            staleAfter: 5
        }
    }, {
        now: () => now
    });

    const fresh = store.read("topics./controls/command");
    assert.deepEqual(fresh.value, { speed: 4 });
    assert.equal(fresh.age, 2);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.source, "mock-ros");
    assert.equal(store.changed("topics./controls/command"), false);

    store.set("topics./controls/command", { speed: 6 }, {
        type: "message",
        updatedAt: "2026-06-09T00:00:01.000Z",
        staleAfter: 5
    });

    const stale = store.read("topics./controls/command");
    assert.equal(stale.stale, true);
    assert.equal(store.changed("topics./controls/command"), true);
});

test("signal writes are staged and only committed after successful execution", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("value", 12));
    manager.addUnit(new SignalWriteTestBlock("write"));
    manager.addUnit(new OutputBlock("output", "ok", "boolean"));
    manager.connectUnits("value", "out", "write", "value");
    manager.connectUnits("write", "written", "output", "output");

    const signalStore = new SignalStore();
    const runner = ScriptManager.createRunner(manager.compile("write-signal"), { signalStore });

    assert.equal(signalStore.read("debug.value").exists, false);

    const run = runner.run();

    assert.equal(run.status, "success");
    assert.equal(run.outputs.ok, true);
    assert.equal(signalStore.read("debug.value").value, 12);
    assert.equal(signalStore.read("debug.value").source, "test");
});

test("signal writes roll back when execution fails", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new FailingSignalWriteBlock("write"));
    manager.addUnit(new OutputBlock("output"));
    manager.connectUnits("write", "out", "output", "output");

    const signalStore = new SignalStore();
    const run = ScriptManager.runCompiled(manager.compile("rollback-signal"), {}, { signalStore });

    assert.equal(run.status, "failure");
    assert.match(run.e.message, /write failed/);
    assert.equal(signalStore.read("debug.value").exists, false);
});

test("compiler emits binding and entrypoint metadata from config units", () => {
    resetRegistry();

    const manager = createBasicProgram();
    manager.addUnit(new BindingConfigBlock("binding"));
    manager.addUnit(new EntrypointConfigBlock("entrypoint"));

    const artifact = manager.compile("metadata");

    assert.deepEqual(artifact.bindings, [{
        uuid: "binding",
        blockType: "BindingConfigBlock",
        kind: "input",
        sourceKind: "topic",
        source: "/controls/command",
        path: "topics./controls/command",
        type: "message"
    }]);
    assert.deepEqual(artifact.entrypoints, [{
        uuid: "entrypoint",
        blockType: "EntrypointConfigBlock",
        kind: "signal-update",
        path: "topics./controls/command"
    }]);
});

test("loaded scripts can execute against an injected signal store", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new SignalReadValueBlock("read"));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("read", "out", "output", "output");

    const signalStore = new SignalStore();
    const script = createLoadedScript(manager.compile("read-signal"), { signalStore });

    script.setSignal("debug.value", 42, {
        type: "float64",
        source: "test"
    });

    assert.deepEqual(script.run(), { result: 42 });
    assert.equal(script.readSignal("debug.value").value, 42);
});

test("editor graph serialization round-trips nodes, state, positions, connections, and runtime state", () => {
    resetRegistry();

    const outputNodeConfig = normalizeOutputNodeState({
        outputs: [
            { id: "total", label: "total", type: "float64" }
        ]
    });

    const manager = new ScriptManager();
    const head = new OutputNodeBlock("head-uuid");
    head.hydrateState(outputNodeConfig);
    manager.addUnit(head);
    manager.setHead("head-uuid");
    manager.storeData("head-uuid", outputNodeConfig);
    manager.addUnit(new ConstBlock("one", 1));
    manager.addUnit(new AccumulatorBlock("acc"));
    manager.connectUnits("one", "out", "acc", "value");
    manager.connectUnits("acc", "out", "head-uuid", "total");

    const accumulator = manager.units.find((unit) => unit.uuid === "acc");
    accumulator.total = 7;

    const graph = serializeManagerGraph(manager, {
        outputNodeConfig,
        positions: {
            "head-uuid": { x: 480, y: 120 },
            one: { x: 12, y: 24 },
            acc: { x: 120, y: 240 },
        },
        headUUID: "head-uuid"
    });

    assert.deepEqual(graph.outputNodeConfig, outputNodeConfig);
    assert.deepEqual(graph.headPosition, { x: 480, y: 120 });
    assert.equal(graph.nodes.some((node) => node.uuid === "head-uuid"), false);
    assert.deepEqual(graph.nodes.find((node) => node.uuid === "acc").position, { x: 120, y: 240 });
    assert.deepEqual(graph.nodes.find((node) => node.uuid === "acc").runtimeState, { total: 7 });
    assert.deepEqual(graph.connections.map((edge) => `${edge.from}:${edge.output}->${edge.to}:${edge.input}`), [
        "one:out->acc:value",
        "acc:out->head-uuid:total"
    ]);

    const restored = restoreManagerFromGraph(graph, getRegisteredBlockType);
    const run = restored.executeProgram();

    assert.equal(restored.checkValidity(), true);
    assert.equal(restored.head, "head-uuid");
    assert.equal(restored.units.find((unit) => unit.uuid === "acc").total, 8);
    assert.deepEqual(run.outputs, { total: 8 });
});

test("autosave-style document updates keep the previous latest valid artifact when a graph becomes invalid", () => {
    const artifact = createBasicProgram().compile("stable");
    const document = createScriptDocument({
        name: "Stable Script",
        latestValidArtifact: artifact,
        compileStatus: {
            valid: true,
            error: null,
            artifactUpdatedAt: "2026-06-09T00:00:00.000Z"
        }
    });

    const invalidUpdate = {
        ...document,
        graph: {
            head: "head-uuid",
            outputNodeConfig: null,
            nodes: [],
            connections: []
        },
        compileStatus: {
            valid: false,
            error: "Graph is not valid.",
            artifactUpdatedAt: document.compileStatus.artifactUpdatedAt
        }
    };

    assert.equal(invalidUpdate.latestValidArtifact, artifact);
    assert.equal(invalidUpdate.compileStatus.valid, false);
    assert.equal(invalidUpdate.compileStatus.artifactUpdatedAt, "2026-06-09T00:00:00.000Z");
});

test("live-linked local script blocks can refresh to a newer compiled artifact", () => {
    resetRegistry();

    const makeAddProgram = (amount, name) => {
        const manager = new ScriptManager();
        manager.addUnit(new InputBlock("input", "x"));
        manager.addUnit(new ConstBlock("amount", amount));
        manager.addUnit(new AddBlock("add"));
        manager.addUnit(new OutputBlock("output", "result"));
        manager.connectUnits("input", "input", "add", "a");
        manager.connectUnits("amount", "out", "add", "b");
        manager.connectUnits("add", "out", "output", "output");
        return manager.compile(name);
    };

    const addTwo = makeAddProgram(2, "add-two");
    const addThree = makeAddProgram(3, "add-three");

    const outer = new ScriptManager();
    outer.addUnit(new ConstBlock("value", 3));

    const local = new LocalScriptProgramBlock("local");
    local.hydrateState({
        sourceScriptId: "child",
        sourceRevision: "rev-1",
        compiledProgram: addTwo,
        name: "Child Script"
    });
    outer.addUnit(local);

    outer.addUnit(new OutputBlock("output", "final"));
    outer.connectUnits("value", "out", "local", "x");
    outer.connectUnits("local", "result", "output", "output");

    assert.deepEqual(outer.executeProgram().outputs, { final: 5 });

    local.hydrateState({
        ...local.state,
        sourceRevision: "rev-2",
        compiledProgram: addThree
    });

    assert.equal(local.inputType("x"), "float64");
    assert.equal(local.outputType("result"), "float64");
    assert.deepEqual(outer.executeProgram().outputs, { final: 6 });
});

test("script-reference cycle detection rejects self-reference and indirect cycles", () => {
    const scriptA = createScriptDocument({
        id: "a",
        graph: {
            head: "head-uuid",
            outputNodeConfig: null,
            nodes: [
                { uuid: "local-b", type: "LocalScriptProgramBlock", state: { sourceScriptId: "b" } }
            ],
            connections: []
        }
    });
    const scriptB = createScriptDocument({
        id: "b",
        graph: {
            head: "head-uuid",
            outputNodeConfig: null,
            nodes: [
                { uuid: "local-c", type: "LocalScriptProgramBlock", state: { sourceScriptId: "c" } }
            ],
            connections: []
        }
    });
    const scriptC = createScriptDocument({
        id: "c",
        graph: {
            head: "head-uuid",
            outputNodeConfig: null,
            nodes: [],
            connections: []
        }
    });

    const documents = [scriptA, scriptB, scriptC];

    assert.equal(wouldCreateScriptReferenceCycle("a", "a", documents), true);
    assert.equal(wouldCreateScriptReferenceCycle("c", "a", documents), true);
    assert.equal(wouldCreateScriptReferenceCycle("a", "c", documents), false);
});

test("import format detection separates editable documents from compiled artifacts", () => {
    const artifact = createBasicProgram().compile("compiled");
    const document = createScriptDocument({
        name: "Editable",
        latestValidArtifact: artifact
    });

    assert.equal(isEditorDocument(document), true);
    assert.equal(isCompiledArtifact(document), false);
    assert.equal(isCompiledArtifact(artifact), true);
    assert.equal(isEditorDocument(artifact), false);
});

test("legacy v2 compiled artifacts remain executable as artifact-only blocks", () => {
    resetRegistry();

    const artifactDocument = createArtifactOnlyDocument(V2_EAGER_EFFECTS_FIXTURE, {
        name: "Legacy Artifact"
    });

    const outer = new ScriptManager();
    outer.addUnit(new BooleanConstBlock("choose-true", true));

    const imported = new CompiledProgramUnitBlock("imported");
    imported.hydrateState({
        compiledProgram: artifactDocument.latestValidArtifact,
        name: artifactDocument.name
    });
    outer.addUnit(imported);

    outer.addUnit(new OutputBlock("output", "final", "boolean"));
    outer.connectUnits("choose-true", "out", "imported", "condition");
    outer.connectUnits("imported", "output", "output", "output");

    const run = outer.executeProgram();

    assert.equal(artifactDocument.editable, false);
    assert.equal(artifactDocument.latestValidArtifact.version, 2);
    assert.equal(run.status, "success");
    assert.deepEqual(run.outputs, { final: true });
});

test("createLoadedScript runs a compiled artifact with named and positional inputs", () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new InputBlock("input", "x"));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("input", "input", "add", "a");
    manager.connectUnits("two", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");

    const script = createLoadedScript(manager.compile("add-two"));

    assert.deepEqual(script.run({ x: 3 }), { result: 5 });
    assert.deepEqual(script.run(4), { result: 6 });
});

test("loadScript resolves editor documents and local script ids", async () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new InputBlock("input", "x"));
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new AddBlock("add"));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("input", "input", "add", "a");
    manager.connectUnits("two", "out", "add", "b");
    manager.connectUnits("add", "out", "output", "output");

    const document = createScriptDocument({
        id: "local-add-two",
        name: "Local Add Two",
        latestValidArtifact: manager.compile("local-add-two")
    });

    const direct = await loadScript(document, { registerBuiltIns: false });
    const local = await loadScript("local:local-add-two", {
        registerBuiltIns: false,
        getDocument: async (id) => {
            assert.equal(id, "local-add-two");
            return document;
        }
    });

    assert.deepEqual(direct.run(5), { result: 7 });
    assert.deepEqual(local.run({ x: 6 }), { result: 8 });
});

test("loadScript resolves URL JSON with an injected fetcher", async () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("two", "out", "output", "output");

    const artifact = manager.compile("url-script");
    const script = await loadScript("https://example.test/url-script.json", {
        registerBuiltIns: false,
        fetcher: async (url) => {
            assert.equal(url, "https://example.test/url-script.json");
            return {
                ok: true,
                json: async () => artifact
            };
        }
    });

    assert.deepEqual(script.run(), { result: 2 });
});

test("loadScript default fetch preserves global binding", async () => {
    resetRegistry();

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("two", 2));
    manager.addUnit(new OutputBlock("output", "result"));
    manager.connectUnits("two", "out", "output", "output");
    const artifact = manager.compile("url-script");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = function fetchWithStrictThis(url) {
        assert.equal(this, globalThis);
        assert.equal(url, "https://example.test/default-fetch-script.json");
        return Promise.resolve({
            ok: true,
            json: async () => artifact
        });
    };

    try {
        const script = await loadScript("https://example.test/default-fetch-script.json", {
            registerBuiltIns: false,
        });
        assert.deepEqual(script.run(), { result: 2 });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function connect(manager, from, output, to, input) {
    assert.equal(manager.connectUnits(from, output, to, input), true, `${from}.${output} -> ${to}.${input}`);
}

function createIfSelectorManager({ condition, trueValue, falseValue, type = "float64" }) {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new BooleanConstBlock("cond", condition));
    manager.addUnit(new ProbeBlock("true-probe", trueValue, type));
    manager.addUnit(new ProbeBlock("false-probe", falseValue, type));
    const ifBlock = new IfBlock("if");
    ifBlock.hydrateState({ type });
    manager.addUnit(ifBlock);
    manager.addUnit(new OutputBlock("output", "result", type));
    connect(manager, "cond", "out", "if", "condition");
    connect(manager, "true-probe", "out", "if", "true value");
    connect(manager, "false-probe", "out", "if", "false value");
    connect(manager, "if", "out", "output", "output");
    return manager;
}

function createWeightedSelectManager() {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new ProbeBlock("a-probe", 0));
    manager.addUnit(new ProbeBlock("b-probe", 99));
    manager.addUnit(new ConstBlock("prob", 0));
    manager.addUnit(new WeightedSelectBlock("select"));
    manager.addUnit(new OutputBlock("output", "result"));
    connect(manager, "a-probe", "out", "select", "a");
    connect(manager, "b-probe", "out", "select", "b");
    connect(manager, "prob", "out", "select", "prob b");
    connect(manager, "select", "out", "output", "output");
    return manager;
}

function createLatchManager() {
    resetRegistry();
    const manager = new ScriptManager();
    const validIn = new ProgramInputBlock("valid-in");
    validIn.hydrateState({ label: "valid", type: "boolean", defaultValue: "true" });
    manager.addUnit(validIn);
    manager.addUnit(new ProbeBlock("value-probe", 7));
    const latch = new SignalLatchBlock("latch");
    latch.hydrateState({ type: "float64" });
    manager.addUnit(latch);
    manager.addUnit(new OutputBlock("output", "result"));
    connect(manager, "valid-in", "input", "latch", "valid");
    connect(manager, "value-probe", "out", "latch", "value");
    connect(manager, "latch", "value", "output", "output");
    return manager;
}

function createDefaultManager(useDefault) {
    resetRegistry();
    const manager = new ScriptManager();
    manager.addUnit(new BooleanConstBlock("use-default", useDefault));
    manager.addUnit(new ProbeBlock("value-probe", 1));
    manager.addUnit(new ProbeBlock("fallback-probe", 2));
    const block = new SignalDefaultBlock("default");
    block.hydrateState({ type: "float64" });
    manager.addUnit(block);
    manager.addUnit(new OutputBlock("output", "result"));
    connect(manager, "use-default", "out", "default", "useDefault");
    connect(manager, "value-probe", "out", "default", "value");
    connect(manager, "fallback-probe", "out", "default", "fallback");
    connect(manager, "default", "value", "output", "output");
    return manager;
}

test("supported artifact versions accept v2 and v3 and reject others", () => {
    resetRegistry();

    const v3 = createBasicProgram().compile("current");
    const v2 = withArtifactVersion(v3, 2);

    assert.deepEqual([...SUPPORTED_ARTIFACT_VERSIONS], [2, 3]);
    assert.equal(VISUAL_SCRIPT_VERSION, 3);
    assert.doesNotThrow(() => assertSupportedArtifact(v2));
    assert.doesNotThrow(() => assertSupportedArtifact(v3));
    assert.equal(isCompiledArtifact(v2), true);
    assert.equal(isCompiledArtifact(v3), true);
    assert.equal(isCompiledArtifact({ kind: VISUAL_SCRIPT_KIND, version: 1 }), false);
    assert.equal(isCompiledArtifact({ kind: VISUAL_SCRIPT_KIND, version: 4 }), false);

    assert.throws(
        () => assertSupportedArtifact({ kind: VISUAL_SCRIPT_KIND, version: 1 }),
        /version 2 or 3/
    );
    assert.throws(
        () => assertSupportedArtifact({ kind: VISUAL_SCRIPT_KIND, version: 4 }),
        /version 2 or 3/
    );

    const retained = createScriptDocument({
        name: "Saved v2",
        latestValidArtifact: V2_EAGER_EFFECTS_FIXTURE
    });
    assert.equal(retained.latestValidArtifact.version, 2);

    const importedV2 = createArtifactOnlyDocument(v2, { name: "v2" });
    const importedV3 = createArtifactOnlyDocument(v3, { name: "v3" });
    assert.equal(importedV2.latestValidArtifact.version, 2);
    assert.equal(importedV3.latestValidArtifact.version, 3);
    assert.throws(
        () => createArtifactOnlyDocument({ kind: VISUAL_SCRIPT_KIND, version: 1 }, { name: "v1" }),
        /unsupported artifact/
    );
});

test("If evaluates both branches on v2 and only the selected branch on v3 and editor", () => {
    const cases = [
        { type: "float64", trueValue: 0, falseValue: 99, output: 0 },
        { type: "boolean", trueValue: false, falseValue: true, output: false },
        { type: "string", trueValue: "", falseValue: "x", output: "" }
    ];

    for (const { type, trueValue, falseValue, output } of cases) {
        const editor = createIfSelectorManager({
            condition: true,
            trueValue,
            falseValue,
            type
        });
        const editorRun = editor.executeProgram();
        assert.equal(editorRun.status, "success", type);
        assert.equal(editorRun.outputs.result, output, type);
        assert.equal(ProbeBlock.count("true-probe"), 1, `${type} editor true`);
        assert.equal(ProbeBlock.count("false-probe"), 0, `${type} editor false`);
        assert.equal(editor.evaluationPolicy.lazySelectors, true);

        const artifact = editor.compile("if-select");
        assert.equal(artifact.version, 3);
        const ifNode = artifact.nodes.find((node) => node.uuid === "if");
        assert.equal(ifNode.ports.inputs["true value"], type);
        assert.equal(ifNode.ports.inputs["false value"], type);
        assert.equal(ifNode.ports.outputs.out, type);
        for (const transition of artifact.transitions.success) {
            assert.notEqual(transition.type, "generic", transition.input);
        }

        const v3 = ScriptManager.createRunner(artifact);
        const v3Run = v3.run();
        assert.equal(v3Run.status, "success", type);
        assert.equal(v3Run.outputs.result, output, type);
        assert.equal(ProbeBlock.count("true-probe"), 1, `${type} v3 true`);
        assert.equal(ProbeBlock.count("false-probe"), 0, `${type} v3 false`);
        assert.equal(v3.units.get("if").manager.evaluationPolicy.lazySelectors, true);

        const v2 = ScriptManager.createRunner(withArtifactVersion(artifact, 2));
        const v2Run = v2.run();
        assert.equal(v2Run.status, "success", type);
        assert.equal(v2Run.outputs.result, output, type);
        assert.equal(ProbeBlock.count("true-probe"), 1, `${type} v2 true`);
        assert.equal(ProbeBlock.count("false-probe"), 1, `${type} v2 false`);
        assert.equal(v2.units.get("if").manager.evaluationPolicy.lazySelectors, false);
    }
});

test("WeightedSelect evaluates both inputs on v2 and only the chosen input on v3 and editor", () => {
    const alwaysChooseA = { context: { random: () => 1 } };
    const editor = createWeightedSelectManager();
    const editorRun = editor.executeProgram({}, alwaysChooseA);
    assert.equal(editorRun.status, "success");
    assert.equal(editorRun.outputs.result, 0);
    assert.equal(ProbeBlock.count("a-probe"), 1);
    assert.equal(ProbeBlock.count("b-probe"), 0);

    const artifact = editor.compile("weighted-select");
    const v3 = ScriptManager.createRunner(artifact);
    const v3Run = v3.run({}, alwaysChooseA);
    assert.equal(v3Run.status, "success");
    assert.equal(v3Run.outputs.result, 0);
    assert.equal(ProbeBlock.count("a-probe"), 1);
    assert.equal(ProbeBlock.count("b-probe"), 0);

    const v2 = ScriptManager.createRunner(withArtifactVersion(artifact, 2));
    const v2Run = v2.run({}, alwaysChooseA);
    assert.equal(v2Run.status, "success");
    assert.equal(v2Run.outputs.result, 0);
    assert.equal(ProbeBlock.count("a-probe"), 1);
    assert.equal(ProbeBlock.count("b-probe"), 1);
});

test("SignalLatch skips value on v3 and editor when invalid with a cached sample", () => {
    const editor = createLatchManager();
    const first = editor.executeProgram({ valid: true });
    const second = editor.executeProgram({ valid: false });
    assert.equal(first.status, "success");
    assert.equal(second.status, "success");
    assert.equal(first.outputs.result, 7);
    assert.equal(second.outputs.result, 7);
    assert.equal(ProbeBlock.count("value-probe"), 1);

    const artifact = createLatchManager().compile("latch");
    const v3 = ScriptManager.createRunner(artifact);
    assert.equal(v3.run({ valid: true }).outputs.result, 7);
    assert.equal(ProbeBlock.count("value-probe"), 1);
    assert.equal(v3.run({ valid: false }).outputs.result, 7);
    assert.equal(ProbeBlock.count("value-probe"), 1);

    const v2 = ScriptManager.createRunner(withArtifactVersion(artifact, 2));
    assert.equal(v2.run({ valid: true }).outputs.result, 7);
    assert.equal(ProbeBlock.count("value-probe"), 1);
    assert.equal(v2.run({ valid: false }).outputs.result, 7);
    assert.equal(ProbeBlock.count("value-probe"), 2);
});

test("SignalDefault stays lazy on editor and v2 compiled execution", () => {
    const editor = createDefaultManager(true);
    const editorRun = editor.executeProgram();
    assert.equal(editorRun.status, "success");
    assert.equal(editorRun.outputs.result, 2);
    assert.equal(ProbeBlock.count("value-probe"), 0);
    assert.equal(ProbeBlock.count("fallback-probe"), 1);

    const artifact = editor.compile("default");
    const v2 = ScriptManager.createRunner(withArtifactVersion(artifact, 2));
    const v2Run = v2.run();
    assert.equal(v2Run.status, "success");
    assert.equal(v2Run.outputs.result, 2);
    assert.equal(ProbeBlock.count("value-probe"), 0);
    assert.equal(ProbeBlock.count("fallback-probe"), 1);
    assert.equal(v2.units.get("default").manager.evaluationPolicy.lazySelectors, false);
});

test("frozen artifact ports override current class registration", () => {
    const artifact = withArtifactVersion(createBasicProgram().compile("ports"), 3);
    const node = artifact.nodes.find((entry) => entry.uuid === "two");
    node.ports = {
        inputs: {},
        outputs: {
            out: "int32",
            leftover: "boolean"
        }
    };

    const runner = ScriptManager.createRunner(artifact);
    const unit = runner.units.get("two");
    assert.equal(unit.outputType("out"), "int32");
    assert.equal(unit.outputType("leftover"), "boolean");
    assert.notEqual(unit.outputType("out"), "float64");
});

test("committed v2 eager-effects fixture keeps written ports and eager If side effects", () => {
    resetRegistry();

    assertSupportedArtifact(V2_EAGER_EFFECTS_FIXTURE);
    assert.equal(V2_EAGER_EFFECTS_FIXTURE.version, 2);
    assert.equal(
        V2_EAGER_EFFECTS_FIXTURE.nodes.find((node) => node.uuid === "write-true").ports.outputs.written,
        "boolean"
    );
    assert.equal(
        V2_EAGER_EFFECTS_FIXTURE.nodes.find((node) => node.uuid === "write-false").ports.outputs.written,
        "boolean"
    );

    const document = createArtifactOnlyDocument(V2_EAGER_EFFECTS_FIXTURE, { name: "v2 eager" });
    const signalStore = new SignalStore();
    const run = ScriptManager.runCompiled(document.latestValidArtifact, { condition: true }, { signalStore });

    assert.equal(run.status, "success");
    assert.equal(run.outputs.output, true);
    assert.equal(signalStore.read("debug.if.true").exists, true);
    assert.equal(signalStore.read("debug.if.true").value, 1);
    assert.equal(signalStore.read("debug.if.false").exists, true);
    assert.equal(signalStore.read("debug.if.false").value, 2);
});

test("early-v3 artifacts keep written ports and skip unused If writes", () => {
    resetRegistry();

    const artifact = withArtifactVersion(V2_EAGER_EFFECTS_FIXTURE, 3);
    const signalStore = new SignalStore();
    const run = ScriptManager.runCompiled(artifact, { condition: true }, { signalStore });

    assert.equal(run.status, "success");
    assert.equal(run.outputs.output, true);
    assert.equal(signalStore.read("debug.if.true").exists, true);
    assert.equal(signalStore.read("debug.if.true").value, 1);
    assert.equal(signalStore.read("debug.if.false").exists, false);
    assert.equal(
        artifact.nodes.find((node) => node.uuid === "write-true").ports.outputs.written,
        "boolean"
    );
});

test("Sequence executes first then second", () => {
    resetRegistry();
    OrderedEffectBlock.order = [];

    const manager = new ScriptManager();
    manager.addUnit(new OrderedEffectBlock("a", "first"));
    manager.addUnit(new OrderedEffectBlock("b", "second"));
    manager.addUnit(new SequenceBlock("seq"));
    manager.addUnit(new OutputBlock("output", "result", UNIT_TYPE));
    connect(manager, "a", "then", "seq", "first");
    connect(manager, "b", "then", "seq", "second");
    connect(manager, "seq", "then", "output", "output");

    const run = manager.executeProgram();
    assert.equal(run.status, "success");
    assert.equal(run.outputs.result, UNIT);
    assert.deepEqual(OrderedEffectBlock.order, ["first", "second"]);
});

test("Passthrough evaluates then before value and makes effects reachable", () => {
    resetRegistry();

    const manager = new ScriptManager();
    const write = new WriteSignalBlock("write");
    write.hydrateState({ path: "debug.value", type: "float64", source: "script", staleAfter: "" });
    manager.addUnit(new ConstBlock("value", 9));
    manager.addUnit(write);
    manager.addUnit(new PassthroughBlock("pass"));
    manager.addUnit(new OutputBlock("output", "result", "float64"));
    connect(manager, "value", "out", "write", "value");
    connect(manager, "write", "then", "pass", "then");
    connect(manager, "value", "out", "pass", "value");
    connect(manager, "pass", "value", "output", "output");

    const signalStore = new SignalStore();
    const run = manager.executeProgram({}, { signalStore });
    assert.equal(run.status, "success");
    assert.equal(run.outputs.result, 9);
    assert.equal(signalStore.read("debug.value").value, 9);

    const artifact = manager.compile("passthrough-write");
    assert.equal(artifact.nodes.some((node) => node.uuid === "write"), true);
    assert.equal(artifact.nodes.find((node) => node.uuid === "write").ports.outputs.then, UNIT_TYPE);
    assert.equal(artifact.nodes.find((node) => node.uuid === "write").ports.outputs.written, undefined);
});

test("unconsumed WriteSignal is omitted from compiled Q", () => {
    resetRegistry();

    const manager = new ScriptManager();
    const write = new WriteSignalBlock("write");
    write.hydrateState({ path: "debug.value", type: "float64", source: "script", staleAfter: "" });
    manager.addUnit(new ConstBlock("value", 3));
    manager.addUnit(write);
    manager.addUnit(new OutputBlock("output", "result", "float64"));
    connect(manager, "value", "out", "write", "value");
    connect(manager, "value", "out", "output", "output");

    const artifact = manager.compile("unused-write");
    assert.equal(artifact.Q.includes("write"), false);
});

test("shared WriteSignal then fan-out executes the effect once per call", () => {
    resetRegistry();

    const manager = new ScriptManager();
    const write = new WriteSignalBlock("write");
    write.hydrateState({ path: "debug.value", type: "float64", source: "script", staleAfter: "" });
    manager.addUnit(new ConstBlock("value", 12));
    manager.addUnit(write);
    manager.addUnit(new OutputBlock("ok-a", "ok-a", UNIT_TYPE));
    manager.addUnit(new OutputBlock("ok-b", "ok-b", UNIT_TYPE));
    connect(manager, "value", "out", "write", "value");
    connect(manager, "write", "then", "ok-a", "output");
    connect(manager, "write", "then", "ok-b", "output");

    const signalStore = new SignalStore();
    const first = manager.executeProgram({}, { signalStore });
    assert.equal(first.status, "success");
    assert.equal(first.outputs["ok-a"], UNIT);
    assert.equal(first.outputs["ok-b"], UNIT);
    assert.equal(signalStore.read("debug.value").value, 12);

    const second = manager.executeProgram({}, { signalStore });
    assert.equal(second.status, "success");
    assert.equal(signalStore.read("debug.value").value, 12);
});

test("If skips unused WriteSignal branches on editor and v3", () => {
    resetRegistry();

    const manager = new ScriptManager();
    const writeTrue = new WriteSignalBlock("write-true");
    const writeFalse = new WriteSignalBlock("write-false");
    writeTrue.hydrateState({ path: "debug.if.true", type: "float64", source: "script", staleAfter: "" });
    writeFalse.hydrateState({ path: "debug.if.false", type: "float64", source: "script", staleAfter: "" });
    manager.addUnit(new BooleanConstBlock("cond", true));
    manager.addUnit(new ConstBlock("true-value", 1));
    manager.addUnit(new ConstBlock("false-value", 2));
    manager.addUnit(writeTrue);
    manager.addUnit(writeFalse);
    manager.addUnit(new IfBlock("if"));
    manager.addUnit(new OutputBlock("output", "result", UNIT_TYPE));
    connect(manager, "true-value", "out", "write-true", "value");
    connect(manager, "false-value", "out", "write-false", "value");
    connect(manager, "cond", "out", "if", "condition");
    connect(manager, "write-true", "then", "if", "true value");
    connect(manager, "write-false", "then", "if", "false value");
    connect(manager, "if", "out", "output", "output");

    const editorStore = new SignalStore();
    const editorRun = manager.executeProgram({}, { signalStore: editorStore });
    assert.equal(editorRun.status, "success");
    assert.equal(editorStore.read("debug.if.true").exists, true);
    assert.equal(editorStore.read("debug.if.false").exists, false);

    const artifact = manager.compile("lazy-write-if");
    const v3Store = new SignalStore();
    const v3Run = ScriptManager.runCompiled(artifact, {}, { signalStore: v3Store });
    assert.equal(v3Run.status, "success");
    assert.equal(v3Store.read("debug.if.true").exists, true);
    assert.equal(v3Store.read("debug.if.false").exists, false);
});

test("current effect blocks expose then plus identity and omit legacy ports", () => {
    resetRegistry();

    const write = new WriteSignalBlock("write");
    write.hydrateState({ path: "debug.value", type: "float64", source: "script", staleAfter: "" });
    assert.equal(write.outputType("then"), UNIT_TYPE);
    assert.equal(write.outputType("value"), "float64");
    assert.equal(write.outputType("written"), undefined);

    const mission = new SetMissionStateBlock("mission");
    assert.equal(mission.outputType("state"), "string");
    assert.equal(mission.outputType("then"), UNIT_TYPE);
    assert.equal(mission.outputType("written"), undefined);

    const flag = new ScenarioFlagWriteBlock("flag");
    assert.equal(flag.outputType("value"), "boolean");
    assert.equal(flag.outputType("then"), UNIT_TYPE);
    assert.equal(flag.outputType("written"), undefined);

    const stage = new StagePublishBlock("stage");
    assert.equal(stage.outputType("path"), "string");
    assert.equal(stage.outputType("then"), UNIT_TYPE);
    assert.equal(stage.outputType("staged"), undefined);

    const assertBlock = new AssertSignalBlock("assert");
    assert.equal(assertBlock.outputType("then"), UNIT_TYPE);
    assert.equal(assertBlock.outputType("ok"), undefined);

    const log = new LogSignalBlock("log");
    assert.equal(log.outputType("value"), "generic");
    assert.equal(log.outputType("then"), UNIT_TYPE);

    const record = new RecordSignalBlock("record");
    assert.equal(record.outputType("count"), "int32");
    assert.equal(record.outputType("then"), UNIT_TYPE);

    const advance = new AdvanceWaypointBlock("advance");
    assert.equal(advance.outputType("index"), "int32");
    assert.equal(advance.outputType("then"), UNIT_TYPE);

    const manager = new ScriptManager();
    manager.addUnit(new ConstBlock("value", 4));
    manager.addUnit(write);
    manager.addUnit(new OutputBlock("output", "done", UNIT_TYPE));
    connect(manager, "value", "out", "write", "value");
    connect(manager, "write", "then", "output", "output");
    const artifact = manager.compile("write-then");
    const node = artifact.nodes.find((entry) => entry.uuid === "write");
    assert.equal(node.ports.outputs.then, UNIT_TYPE);
    assert.equal(node.ports.outputs.value, "float64");
    assert.equal(node.ports.outputs.written, undefined);

    const remaining = [
        ["mission", new SetMissionStateBlock("mission"), new StringConstBlock("state-in"), "state", "out"],
        ["flag", new ScenarioFlagWriteBlock("flag"), new BooleanConstBlock("flag-in", true), "value", "out"],
        ["stage", new StagePublishBlock("stage"), new MessageConstBlock("msg"), "message", "out"],
        ["assert", new AssertSignalBlock("assert"), new BooleanConstBlock("ok-in", true), "condition", "out"],
        ["log", new LogSignalBlock("log"), new ConstBlock("log-in", 1), "value", "out"],
        ["record", new RecordSignalBlock("record"), new ConstBlock("rec-in", 1), "value", "out"],
        ["advance", new AdvanceWaypointBlock("advance"), new BooleanConstBlock("go", true), "advance", "out"],
    ];

    for (const [uuid, block, source, input, sourceOut] of remaining) {
        const graph = new ScriptManager();
        if (uuid === "record") {
            block.hydrateState({ path: "debug.recorded", type: "float64", maxSamples: 8 });
        }
        graph.addUnit(source);
        graph.addUnit(block);
        graph.addUnit(new OutputBlock("output", "done", UNIT_TYPE));
        connect(graph, source.uuid, sourceOut, uuid, input);
        connect(graph, uuid, "then", "output", "output");
        const compiled = graph.compile(`${uuid}-then`);
        const compiledNode = compiled.nodes.find((entry) => entry.uuid === uuid);
        assert.equal(compiledNode.ports.outputs.then, UNIT_TYPE, uuid);
        assert.equal(compiledNode.ports.outputs.written, undefined, uuid);
        assert.equal(compiledNode.ports.outputs.ok, undefined, uuid);
        assert.equal(compiledNode.ports.outputs.staged, undefined, uuid);
    }
});

test("Ignore evaluates its value subgraph and Nop sources unit", () => {
    resetRegistry();
    OrderedEffectBlock.order = [];

    const manager = new ScriptManager();
    manager.addUnit(new OrderedEffectBlock("effect", "ignored"));
    manager.addUnit(new IgnoreBlock("ignore"));
    manager.addUnit(new NopBlock("nop"));
    manager.addUnit(new SequenceBlock("seq"));
    manager.addUnit(new OutputBlock("output", "result", UNIT_TYPE));

    class UnitFromEffect extends UnitBlock {
        register() {
            this.registerInput("then", UNIT_TYPE);
            this.registerOutput("value", "float64");
        }

        valid() {
            return this.hasInput("then");
        }

        execute() {
            this.getInput("then");
            return new BlockOutput().set("value", 1);
        }
    }

    registerBlockType("UnitFromEffect", UnitFromEffect);
    manager.addUnit(new UnitFromEffect("lift"));
    connect(manager, "effect", "then", "lift", "then");
    connect(manager, "lift", "value", "ignore", "value");
    connect(manager, "ignore", "then", "seq", "first");
    connect(manager, "nop", "then", "seq", "second");
    connect(manager, "seq", "then", "output", "output");

    const run = manager.executeProgram();
    assert.equal(run.status, "success");
    assert.deepEqual(OrderedEffectBlock.order, ["ignored"]);
    assert.equal(run.outputs.result, UNIT);
});

test("Program Input of type unit always yields the UNIT singleton", () => {
    resetRegistry();

    const manager = new ScriptManager();
    const input = new ProgramInputBlock("in");
    input.hydrateState({ label: "go", type: UNIT_TYPE, defaultValue: "ignored" });
    manager.addUnit(input);
    manager.storeData("in", { label: "go", type: UNIT_TYPE, defaultValue: "ignored" });
    input.reregister();
    manager.addUnit(new OutputBlock("output", "result", UNIT_TYPE));
    connect(manager, "in", "input", "output", "output");

    const run = manager.executeProgram({ go: { type: "nope" } });
    assert.equal(run.status, "success");
    assert.equal(run.outputs.result, UNIT);
    assert.equal(parseValueByType("foo", UNIT_TYPE), UNIT);

    const artifact = manager.compile("unit-io");
    assert.equal(artifact.interface.inputs[0].type, UNIT_TYPE);
    assert.equal(artifact.interface.outputs[0].type, UNIT_TYPE);
});

test("restoring written connections is fail-closed and does not compile a stripped graph", () => {
    resetRegistry();

    const graph = {
        head: "head-uuid",
        outputNodeConfig: { outputs: [{ id: "output", label: "output", type: UNIT_TYPE }] },
        nodes: [
            { uuid: "value", type: "ConstBlock", state: { value: 4 }, storedData: undefined, position: { x: 0, y: 0 } },
            {
                uuid: "write",
                type: "WriteSignalBlock",
                state: { path: "debug.value", type: "float64", source: "script", staleAfter: "" },
                storedData: undefined,
                position: { x: 10, y: 0 }
            }
        ],
        connections: [
            { from: "value", output: "out", to: "write", input: "value", type: "float64" },
            { from: "write", output: "written", to: "head-uuid", input: "output", type: "boolean" }
        ]
    };

    const restored = restoreManagerFromGraph(graph, getRegisteredBlockType);
    assert.equal(restored.restoreErrors.length, 1);
    assert.match(restored.restoreErrors[0].error, /written/);
    assert.match(formatRestoreErrors(restored.restoreErrors), /Rewire this connection manually/);

    const live = serializeManagerGraph(restored, {
        outputNodeConfig: graph.outputNodeConfig,
        headUUID: "head-uuid"
    });
    const merged = mergeUnrestoredConnections(live.connections, restored.restoreErrors);
    assert.equal(merged.some((connection) => connection.output === "written"), true);
    assert.equal(live.connections.some((connection) => connection.output === "written"), false);

    assert.throws(() => {
        if (restored.restoreErrors.length) {
            throw new Error(formatRestoreErrors(restored.restoreErrors));
        }
        restored.compile("stripped");
    }, /Rewire this connection manually/);

    const rewired = restored.connectUnitsDetailed("write", "then", "head-uuid", "output");
    assert.equal(rewired.ok, true, rewired.error);
    assert.equal(restored.restoreErrors.length, 0);

    const artifact = restored.compile("rewired");
    const writeNode = artifact.nodes.find((node) => node.uuid === "write");
    assert.equal(writeNode.ports.outputs.then, UNIT_TYPE);
    assert.equal(writeNode.ports.outputs.written, undefined);
});

