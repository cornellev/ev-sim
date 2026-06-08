import assert from "node:assert/strict";
import test from "node:test";

import {
    BlockOutput,
    clearBlockTypeRegistryForTests,
    CompiledProgramUnitBlock,
    registerBlockType,
    ScriptManager,
    UnitBlock,
} from "../app/scripting/ScriptManager.js";

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
        AccumulatorBlock,
        CompiledProgramUnitBlock,
    ].forEach((blockClass) => registerBlockType(blockClass.name, blockClass));
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

    const imported = new CompiledProgramUnitBlock("imported");
    imported.hydrateState({ compiledProgram: manager.compile("imported") });
    imported.inputs.x = {};
    imported.getInput = () => 3;

    const output = imported.execute();

    assert.equal(imported.inputType("x"), "float64");
    assert.equal(imported.outputType("result"), "float64");
    assert.equal(output.get("result"), 5);
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
