import assert from "node:assert/strict";
import test from "node:test";

import { clearBlockTypeRegistryForTests, ScriptManager } from "../app/scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SIGNAL_PATHS } from "../app/scripting/runtime/SignalPaths.js";
import {
    finiteFloat,
    finiteInt32,
    finiteResult,
    normalizeActorCommand,
    orderedBounds,
    valuesEqual,
} from "../app/scripting/types/PortTypes.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { RandomNumberBlock } from "../app/scripting/units/math/Random.block.js";
import { RemapRangeBlock, WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import { LowPassFilterBlock, SensorFusionBlock } from "../app/scripting/units/math/SensorFlow.block.js";
import {
    SCALAR_BLOCK_PORTS,
    SCALAR_BLOCKS,
    AddBlock,
    ClampBlock,
    DivideBlock,
    IntegerBlock,
    JsonBlock,
} from "../app/scripting/units/math/ScalarBlocks.block.js";
import {
    CONVERSION_BLOCK_PORTS,
    CONVERSION_BLOCKS,
    FloorToIntBlock,
    ParseJsonBlock,
} from "../app/scripting/units/conversions/Conversions.block.js";
import { Float64ToInt32Block } from "../app/scripting/units/conversions/NumberConversions.block.js";
import {
    STRING_BLOCK_PORTS,
    STRING_BLOCKS,
    ConcatStringBlock,
} from "../app/scripting/units/strings/StringBlocks.block.js";
import {
    JSON_BLOCK_PORTS,
    JSON_BLOCKS,
    JsonGetBlock,
    JsonSetBlock,
} from "../app/scripting/units/objects/JsonBlocks.block.js";
import { cloneValue, deleteByPath } from "../app/scripting/runtime/SignalStore.js";
import {
    ARRAY_BLOCK_PORTS,
    ARRAY_BLOCKS,
    ArrayGetBlock,
    ArrayLiteralBlock,
    ArraySetBlock,
} from "../app/scripting/units/collections/ArrayBlocks.block.js";
import * as scalarMath from "../app/scripting/units/math/scalarMath.js";
import { TerrainNoiseBlock } from "../app/scripting/units/math/Terrain.block.js";
import { MultiplyTexBlock, ScaleBlock } from "../app/scripting/units/math/tex/Scale.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import { OutputNodeBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import {
    LOGIC_BLOCK_PORTS,
    LOGIC_BLOCKS,
    AndBlock,
    BooleanBlock,
    EqualBlock,
    LessBlock,
    OrBlock,
} from "../app/scripting/units/statements/LogicBlocks.block.js";
import {
    VehiclePoseBlock,
    VehicleVelocityBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";

function configuredBlock(BlockClass, values, options = {}) {
    const block = new BlockClass(options.uuid || "block");
    if (options.state) block.hydrateState(options.state);
    block.inputs = Object.fromEntries(Object.keys(values).map((label) => [label, {}]));
    block.getInput = (label) => values[label];
    block.setManager({
        evaluationPolicy: options.evaluationPolicy || { lazySelectors: true },
        getRuntimeContext: () => ({ random: options.random || (() => 0) }),
        getStoredData: () => options.storedData,
    });
    return block;
}

test("finite numeric helpers and declared constant outputs normalize values", () => {
    assert.equal(finiteFloat(Infinity), 0);
    assert.equal(finiteFloat("3.5"), 3.5);
    assert.equal(finiteInt32(3.9), 3);
    assert.equal(finiteInt32(9e20), 2147483647);
    assert.deepEqual(normalizeActorCommand({ speedMps: Infinity, steeringRad: -Infinity }), {
        actorId: "",
        speedMps: 0,
        steeringRad: 0,
    });

    const manager = new ScriptManager();
    const number = new NumberUnitClass("number");
    const string = new StringBlock("string");
    manager.addUnit(number);
    manager.addUnit(string);
    manager.storeData("number", Infinity);
    manager.storeData("string", false);
    assert.equal(number.execute().get("number"), 0);
    assert.equal(string.execute().get("out"), "false");
    manager.storeData("string", 0);
    assert.equal(string.execute().get("out"), "0");
});

test("audited math blocks preserve legitimate zero and generic falsey values", () => {
    const lowPassValues = { signal: 10, alpha: 1 };
    const lowPass = configuredBlock(LowPassFilterBlock, lowPassValues);
    assert.equal(lowPass.execute().get("filtered"), 10);
    lowPassValues.signal = 20;
    lowPassValues.alpha = 0;
    assert.equal(lowPass.execute().get("filtered"), 10);

    const fusion = configuredBlock(SensorFusionBlock, { primary: 10, secondary: 4, weight: 0, bias: 0 });
    assert.equal(fusion.execute().get("fused"), 4);

    const remap = configuredBlock(RemapRangeBlock, {
        value: 0,
        "in min": 0,
        "in max": 0,
        "out min": 0,
        "out max": 0,
    });
    assert.equal(remap.execute().get("out"), 0);

    const weighted = configuredBlock(WeightedSelectBlock, { a: "", b: false, "prob b": 0 }, {
        evaluationPolicy: { lazySelectors: false },
        random: () => 0.25,
    });
    assert.equal(weighted.execute().get("out"), "");

    const terrain = configuredBlock(TerrainNoiseBlock, { seed: 0, frequency: 1, amplitude: 0, octaves: 1 });
    assert.ok(terrain.execute().get("tex").every((value) => value === 0));
});

test("random and texture blocks serialize state and return BlockOutput values", () => {
    const random = configuredBlock(RandomNumberBlock, {}, { random: () => 0 });
    assert.equal(random.execute().get("out"), 0);
    assert.deepEqual(random.serializeRuntimeState(), { cachedValue: 0 });
    random.hydrateRuntimeState({ cachedValue: 0.75 });
    assert.equal(random.execute().get("out"), 0.75);
    random.hydrateRuntimeState({ cachedValue: Infinity });
    assert.equal(random.serializeRuntimeState().cachedValue, null);

    const scale = configuredBlock(ScaleBlock, { tex1d: [1, 2, 3], scalar: 0 });
    assert.equal(scale.valid(), true);
    assert.deepEqual(scale.execute().get("result"), [0, 0, 0]);

    const multiply = configuredBlock(MultiplyTexBlock, { tex1d_a: [1, 2], tex1d_b: [3, 4] });
    assert.equal(multiply.valid(), true);
    assert.deepEqual(multiply.execute().get("result"), [3, 8]);
    const mismatch = configuredBlock(MultiplyTexBlock, { tex1d_a: [1], tex1d_b: [2, 3] });
    assert.throws(() => mismatch.execute(), /equal lengths/);
});

test("vehicle readers use canonical defaults and narrowly fall back from legacy paths", () => {
    const store = new SignalStore();
    const manager = new ScriptManager();
    manager.setSignalStore(store);
    store.set(SIGNAL_PATHS.VEHICLES_EGO_POSE, { x: 1 });
    store.set(SIGNAL_PATHS.VEHICLES_EGO_VELOCITY, { x: 4, y: 0, z: 0 });

    const fresh = new VehiclePoseBlock("fresh");
    manager.addUnit(fresh);
    assert.equal(fresh.state.path, SIGNAL_PATHS.VEHICLES_EGO_POSE);
    assert.deepEqual(fresh.execute().get("pose"), { x: 1 });

    const legacy = new VehiclePoseBlock("legacy");
    legacy.hydrateState({ path: SIGNAL_PATHS.VEHICLE_EGO_POSE });
    manager.addUnit(legacy);
    assert.deepEqual(legacy.execute().get("pose"), { x: 1 });

    store.set(SIGNAL_PATHS.VEHICLE_EGO_POSE, { x: 2 }, { updatedAt: "2000-01-01T00:00:00.000Z", staleAfter: 0.001 });
    const stale = legacy.execute();
    assert.equal(stale.get("pose"), null);
    assert.equal(stale.get("stale"), true);

    const custom = new VehicleVelocityBlock("custom");
    custom.hydrateState({ path: "custom.velocity" });
    manager.addUnit(custom);
    assert.equal(custom.execute().get("exists"), false);
});

test("scalar math helpers lock domain, bounds, and structural equality", () => {
    assert.equal(finiteResult(Infinity), 0);
    assert.equal(finiteResult(Number.NaN), 0);
    assert.equal(scalarMath.div(1, 0), 0);
    assert.equal(scalarMath.mod(5, 0), 0);
    assert.equal(scalarMath.ln(0), 0);
    assert.equal(scalarMath.log10(-1), 0);
    assert.equal(scalarMath.sqrt(-1), 0);
    assert.equal(scalarMath.pow(-1, 0.5), 0);
    assert.equal(scalarMath.exp(1000), 0);
    assert.equal(scalarMath.asin(2), 0);
    assert.equal(scalarMath.inverseLerp(3, 5, 5), 0);
    assert.deepEqual(orderedBounds(4, 1), { min: 1, max: 4 });
    assert.equal(scalarMath.clamp(2, 5, 1), 2);
    assert.equal(scalarMath.deadband(0.1, 0.2), 0);
    assert.equal(scalarMath.deadband(5, 1), 5);
    assert.equal(valuesEqual(0, -0), true);
    assert.equal(valuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 }), true);
    assert.equal(valuesEqual([1], [1]), true);
    assert.equal(valuesEqual([1], [1, 2]), false);
    assert.equal(valuesEqual("a", "a"), true);
    assert.equal(valuesEqual(false, false), true);
});

function typeMapFromPorts(ports) {
    return {
        inputs: Object.fromEntries(ports.inputs.map((port) => [port.label, port.type])),
        outputs: Object.fromEntries(ports.outputs.map((port) => [port.label, port.type])),
    };
}

test("atomic scalar and logic blocks share catalog port descriptors", () => {
    const portMaps = [
        [SCALAR_BLOCK_PORTS, SCALAR_BLOCKS],
        [LOGIC_BLOCK_PORTS, LOGIC_BLOCKS],
        [CONVERSION_BLOCK_PORTS, CONVERSION_BLOCKS],
        [STRING_BLOCK_PORTS, STRING_BLOCKS],
        [JSON_BLOCK_PORTS, JSON_BLOCKS],
        [ARRAY_BLOCK_PORTS, ARRAY_BLOCKS],
    ];
    for (const [portsByType, classes] of portMaps) {
        for (const [type, ports] of Object.entries(portsByType)) {
            const block = new classes[type]("ports");
            assert.deepEqual(block.typeMap, typeMapFromPorts(ports), type);
            assert.equal(block.constructor.blockType, type);
        }
    }
});

const ATOMIC_EXECUTE_CASES = [
    { type: "IntegerBlock", storedData: 0, out: 0 },
    { type: "JsonBlock", storedData: { x: 1 }, out: { x: 1 } },
    { type: "AddBlock", inputs: { a: 1, b: 2 }, out: 3 },
    { type: "AddBlock", inputs: { a: 0, b: 0 }, out: 0 },
    { type: "SubtractBlock", inputs: { a: 5, b: 2 }, out: 3 },
    { type: "MultiplyBlock", inputs: { a: 0, b: 4 }, out: 0 },
    { type: "DivideBlock", inputs: { a: 8, b: 2 }, out: 4 },
    { type: "DivideBlock", inputs: { a: 1, b: 0 }, out: 0 },
    { type: "ModuloBlock", inputs: { a: 5, b: 2 }, out: 1 },
    { type: "ModuloBlock", inputs: { a: 5, b: 0 }, out: 0 },
    { type: "PowerBlock", inputs: { a: 2, b: 3 }, out: 8 },
    { type: "MinimumBlock", inputs: { a: 1, b: 4 }, out: 1 },
    { type: "MaximumBlock", inputs: { a: 1, b: 4 }, out: 4 },
    { type: "NegateBlock", inputs: { value: 5 }, out: -5 },
    { type: "AbsoluteBlock", inputs: { value: -3 }, out: 3 },
    { type: "SignBlock", inputs: { value: -2 }, out: -1 },
    { type: "SignBlock", inputs: { value: 0 }, out: 0 },
    { type: "SquareRootBlock", inputs: { value: 9 }, out: 3 },
    { type: "SquareRootBlock", inputs: { value: -4 }, out: 0 },
    { type: "ExponentialBlock", inputs: { value: 0 }, out: 1 },
    { type: "NaturalLogBlock", inputs: { value: 1 }, out: 0 },
    { type: "NaturalLogBlock", inputs: { value: 0 }, out: 0 },
    { type: "Log10Block", inputs: { value: 100 }, out: 2 },
    { type: "ClampBlock", inputs: { value: 5, min: 0, max: 3 }, out: 3 },
    { type: "ClampBlock", inputs: { value: 2, min: 5, max: 1 }, out: 2 },
    { type: "LerpBlock", inputs: { a: 0, b: 10, t: 0.5 }, out: 5 },
    { type: "InverseLerpBlock", inputs: { value: 5, min: 0, max: 10 }, out: 0.5 },
    { type: "InverseLerpBlock", inputs: { value: 1, min: 3, max: 3 }, out: 0 },
    { type: "SmoothstepBlock", inputs: { value: 5, min: 0, max: 10 }, out: 0.5 },
    { type: "DeadbandBlock", inputs: { value: 0.1, width: 0.2 }, out: 0 },
    { type: "SinBlock", inputs: { value: 0 }, out: 0 },
    { type: "CosBlock", inputs: { value: 0 }, out: 1 },
    { type: "TanBlock", inputs: { value: 0 }, out: 0 },
    { type: "AsinBlock", inputs: { value: 0 }, out: 0 },
    { type: "AsinBlock", inputs: { value: 2 }, out: 0 },
    { type: "AcosBlock", inputs: { value: 1 }, out: 0 },
    { type: "AtanBlock", inputs: { value: 0 }, out: 0 },
    { type: "DegreesToRadiansBlock", inputs: { value: 180 }, out: Math.PI },
    { type: "RadiansToDegreesBlock", inputs: { value: Math.PI }, out: 180 },
    { type: "WrapRadiansBlock", inputs: { value: 3 * Math.PI }, out: Math.PI },
    { type: "Atan2Block", inputs: { y: 1, x: 0 }, out: Math.PI / 2 },
    { type: "BooleanBlock", storedData: false, out: false },
    { type: "NotBlock", inputs: { value: false }, out: true },
    { type: "AndBlock", inputs: { a: true, b: true }, out: true },
    { type: "AndBlock", inputs: { a: false, b: true }, out: false },
    { type: "OrBlock", inputs: { a: false, b: true }, out: true },
    { type: "XorBlock", inputs: { a: true, b: true }, out: false },
    { type: "EqualBlock", inputs: { a: 1, b: 1 }, out: true },
    { type: "EqualBlock", inputs: { a: "", b: "" }, out: true },
    { type: "EqualBlock", inputs: { a: { b: 2, a: 1 }, b: { a: 1, b: 2 } }, out: true },
    { type: "NotEqualBlock", inputs: { a: 1, b: 2 }, out: true },
    { type: "LessBlock", inputs: { a: 1, b: 2 }, out: true },
    { type: "LessEqualBlock", inputs: { a: 2, b: 2 }, out: true },
    { type: "GreaterBlock", inputs: { a: 2, b: 1 }, out: true },
    { type: "GreaterEqualBlock", inputs: { a: 2, b: 2 }, out: true },
    { type: "NearlyEqualBlock", inputs: { a: 1, b: 1.001, tolerance: 0.01 }, out: true },
    { type: "IsFiniteBlock", inputs: { value: 0 }, out: true },
    { type: "IsFiniteBlock", inputs: { value: Infinity }, out: false },
];

test("atomic blocks execute table covers zeros, false, empty, and invalid domains", () => {
    const classes = { ...SCALAR_BLOCKS, ...LOGIC_BLOCKS };
    for (const row of ATOMIC_EXECUTE_CASES) {
        const block = configuredBlock(classes[row.type], row.inputs || {}, { storedData: row.storedData });
        const actual = block.execute().get("out");
        if (typeof row.out === "number" && !Number.isInteger(row.out)) {
            assert.ok(Math.abs(actual - row.out) < 1e-12, `${row.type} ${actual} != ${row.out}`);
        } else {
            assert.deepEqual(actual, row.out, row.type);
        }
    }

    const integer = configuredBlock(IntegerBlock, {}, { storedData: 3.9 });
    assert.equal(integer.execute().get("out"), 3);
    integer.setManager({ getStoredData: () => Infinity });
    assert.equal(integer.execute().get("out"), 0);
    integer.setManager({ getStoredData: () => 9e20 });
    assert.equal(integer.execute().get("out"), 2147483647);

    const json = configuredBlock(JsonBlock, {}, { storedData: "not-json" });
    assert.equal(json.execute().get("out"), null);
    const jsonZero = configuredBlock(JsonBlock, {}, { storedData: 0 });
    assert.equal(jsonZero.execute().get("out"), 0);
    const jsonFalse = configuredBlock(JsonBlock, {}, { storedData: false });
    assert.equal(jsonFalse.execute().get("out"), false);
    const jsonEmpty = configuredBlock(JsonBlock, {}, { storedData: "" });
    assert.equal(jsonEmpty.execute().get("out"), null);
});

test("And and Or skip the unused input even when selectors are eager", () => {
    const andBlock = new AndBlock("and");
    andBlock.inputs = { a: {}, b: {} };
    let readB = false;
    andBlock.getInput = (label) => {
        if (label === "b") {
            readB = true;
            throw new Error("should skip b");
        }
        return false;
    };
    andBlock.setManager({ evaluationPolicy: { lazySelectors: false } });
    assert.equal(andBlock.execute().get("out"), false);
    assert.equal(readB, false);

    const orBlock = new OrBlock("or");
    orBlock.inputs = { a: {}, b: {} };
    let readOrB = false;
    orBlock.getInput = (label) => {
        if (label === "b") {
            readOrB = true;
            throw new Error("should skip b");
        }
        return true;
    };
    orBlock.setManager({ evaluationPolicy: { lazySelectors: false } });
    assert.equal(orBlock.execute().get("out"), true);
    assert.equal(readOrB, false);
});

test("JsonBlock clones stored objects and IntegerBlock preserves zero", () => {
    const manager = new ScriptManager();
    const json = new JsonBlock("json");
    const integer = new IntegerBlock("integer");
    manager.addUnit(json);
    manager.addUnit(integer);
    manager.storeData("json", { x: 1 });
    manager.storeData("integer", 0);
    const value = json.execute().get("out");
    value.x = 9;
    assert.deepEqual(manager.getStoredData("json"), { x: 1 });
    assert.equal(integer.execute().get("out"), 0);
});

function ensureBuiltIns() {
    clearBlockTypeRegistryForTests();
    registerBuiltInBlocks();
}

function connect(manager, from, output, to, input) {
    const result = manager.connectUnitsDetailed(from, output, to, input);
    assert.equal(result.ok, true, result.error);
}

function compileAndRun(manager, name) {
    const editor = manager.executeProgram();
    assert.equal(editor.status, "success", editor.e?.message);
    const artifact = manager.compile(name);
    assert.equal(JSON.stringify(artifact).includes("generic"), false);
    const compiled = ScriptManager.createRunner(artifact).run();
    assert.equal(compiled.status, "success", compiled.e?.message);
    return { editor, artifact, compiled };
}

function withHead(type) {
    const manager = new ScriptManager();
    const head = new OutputNodeBlock("head");
    const config = { outputs: [{ id: "output", label: "result", type }] };
    head.hydrateState(config);
    manager.addUnit(head);
    manager.storeData("head", config);
    manager.setHead("head");
    return manager;
}

test("atomic blocks compile to v3 ports and match editor execution", () => {
    ensureBuiltIns();

    const addManager = withHead("float64");
    addManager.addUnit(new NumberUnitClass("a"));
    addManager.addUnit(new NumberUnitClass("b"));
    addManager.addUnit(new AddBlock("op"));
    addManager.storeData("a", 1);
    addManager.storeData("b", 2);
    connect(addManager, "a", "number", "op", "a");
    connect(addManager, "b", "number", "op", "b");
    connect(addManager, "op", "out", "head", "output");
    const added = compileAndRun(addManager, "add");
    assert.equal(added.editor.outputs.result, 3);
    assert.equal(added.compiled.outputs.result, 3);
    assert.equal(added.artifact.nodes.find((node) => node.uuid === "op").ports.outputs.out, "float64");

    const divideManager = withHead("float64");
    divideManager.addUnit(new NumberUnitClass("a"));
    divideManager.addUnit(new NumberUnitClass("b"));
    divideManager.addUnit(new DivideBlock("op"));
    divideManager.storeData("a", 1);
    divideManager.storeData("b", 0);
    connect(divideManager, "a", "number", "op", "a");
    connect(divideManager, "b", "number", "op", "b");
    connect(divideManager, "op", "out", "head", "output");
    const divided = compileAndRun(divideManager, "divide-zero");
    assert.equal(divided.editor.outputs.result, 0);
    assert.equal(divided.compiled.outputs.result, 0);

    const clampManager = withHead("float64");
    clampManager.addUnit(new NumberUnitClass("value"));
    clampManager.addUnit(new NumberUnitClass("min"));
    clampManager.addUnit(new NumberUnitClass("max"));
    clampManager.addUnit(new ClampBlock("op"));
    clampManager.storeData("value", 2);
    clampManager.storeData("min", 5);
    clampManager.storeData("max", 1);
    connect(clampManager, "value", "number", "op", "value");
    connect(clampManager, "min", "number", "op", "min");
    connect(clampManager, "max", "number", "op", "max");
    connect(clampManager, "op", "out", "head", "output");
    const clamped = compileAndRun(clampManager, "clamp");
    assert.equal(clamped.editor.outputs.result, 2);
    assert.equal(clamped.compiled.outputs.result, 2);

    const booleanManager = withHead("boolean");
    booleanManager.addUnit(new BooleanBlock("flag"));
    booleanManager.storeData("flag", false);
    connect(booleanManager, "flag", "out", "head", "output");
    const flagged = compileAndRun(booleanManager, "boolean-false");
    assert.equal(flagged.editor.outputs.result, false);
    assert.equal(flagged.compiled.outputs.result, false);

    const andManager = withHead("boolean");
    andManager.addUnit(new BooleanBlock("a"));
    andManager.addUnit(new BooleanBlock("b"));
    andManager.addUnit(new AndBlock("op"));
    andManager.storeData("a", false);
    andManager.storeData("b", true);
    connect(andManager, "a", "out", "op", "a");
    connect(andManager, "b", "out", "op", "b");
    connect(andManager, "op", "out", "head", "output");
    const anded = compileAndRun(andManager, "and");
    assert.equal(anded.editor.outputs.result, false);
    assert.equal(anded.compiled.outputs.result, false);

    const equalManager = withHead("boolean");
    equalManager.addUnit(new StringBlock("left"));
    equalManager.addUnit(new StringBlock("right"));
    equalManager.addUnit(new EqualBlock("op"));
    equalManager.storeData("left", "a");
    equalManager.storeData("right", "a");
    connect(equalManager, "left", "out", "op", "a");
    connect(equalManager, "right", "out", "op", "b");
    connect(equalManager, "op", "out", "head", "output");
    const equaled = compileAndRun(equalManager, "equal-strings");
    assert.equal(equaled.editor.outputs.result, true);
    assert.equal(equaled.compiled.outputs.result, true);
    assert.equal(equaled.artifact.nodes.find((node) => node.uuid === "op").ports.inputs.a, "string");

    const lessManager = withHead("boolean");
    lessManager.addUnit(new IntegerBlock("a"));
    lessManager.addUnit(new IntegerBlock("b"));
    lessManager.addUnit(new LessBlock("op"));
    lessManager.storeData("a", 1);
    lessManager.storeData("b", 2);
    connect(lessManager, "a", "out", "op", "a");
    connect(lessManager, "b", "out", "op", "b");
    connect(lessManager, "op", "out", "head", "output");
    const less = compileAndRun(lessManager, "less-int32");
    assert.equal(less.editor.outputs.result, true);
    assert.equal(less.compiled.outputs.result, true);
    assert.equal(less.artifact.nodes.find((node) => node.uuid === "op").ports.inputs.a, "int32");
});

const STDLIB_EXECUTE_CASES = [
    { type: "FloorToIntBlock", inputs: { value: 3.9 }, outputs: { out: 3 } },
    { type: "FloorToIntBlock", inputs: { value: -1.1 }, outputs: { out: -2 } },
    { type: "FloorToIntBlock", inputs: { value: 0 }, outputs: { out: 0 } },
    { type: "CeilToIntBlock", inputs: { value: 3.1 }, outputs: { out: 4 } },
    { type: "RoundToIntBlock", inputs: { value: 2.5 }, outputs: { out: 3 } },
    { type: "TruncateToIntBlock", inputs: { value: -1.9 }, outputs: { out: -1 } },
    { type: "BooleanToIntBlock", inputs: { value: false }, outputs: { out: 0 } },
    { type: "BooleanToIntBlock", inputs: { value: true }, outputs: { out: 1 } },
    { type: "BooleanToFloatBlock", inputs: { value: false }, outputs: { out: 0 } },
    { type: "IntToBooleanBlock", inputs: { value: 0 }, outputs: { out: false } },
    { type: "IntToBooleanBlock", inputs: { value: 2 }, outputs: { out: true } },
    { type: "FloatToBooleanBlock", inputs: { value: 0 }, outputs: { out: false } },
    { type: "FloatToBooleanBlock", inputs: { value: Infinity }, outputs: { out: false } },
    { type: "FloatToStringBlock", inputs: { value: 0 }, outputs: { out: "0" } },
    { type: "IntToStringBlock", inputs: { value: 0 }, outputs: { out: "0" } },
    { type: "BooleanToStringBlock", inputs: { value: false }, outputs: { out: "false" } },
    { type: "StringToFloatBlock", inputs: { value: "3.5" }, outputs: { out: 3.5, valid: true } },
    { type: "StringToFloatBlock", inputs: { value: "" }, outputs: { out: 0, valid: false } },
    { type: "StringToFloatBlock", inputs: { value: "abc" }, outputs: { out: 0, valid: false } },
    { type: "StringToIntBlock", inputs: { value: "12" }, outputs: { out: 12, valid: true } },
    { type: "StringToIntBlock", inputs: { value: "3.9" }, outputs: { out: 0, valid: false } },
    { type: "StringToIntBlock", inputs: { value: "" }, outputs: { out: 0, valid: false } },
    { type: "StringToBooleanBlock", inputs: { value: "true" }, outputs: { out: true, valid: true } },
    { type: "StringToBooleanBlock", inputs: { value: "0" }, outputs: { out: false, valid: true } },
    { type: "StringToBooleanBlock", inputs: { value: "yes" }, outputs: { out: false, valid: false } },
    { type: "ParseJsonBlock", inputs: { value: "{\"x\":1}" }, outputs: { out: { x: 1 }, valid: true } },
    { type: "ParseJsonBlock", inputs: { value: "" }, outputs: { out: null, valid: false } },
    { type: "ParseJsonBlock", inputs: { value: "not-json" }, outputs: { out: null, valid: false } },
    { type: "StringifyJsonBlock", inputs: { value: { x: 1 } }, outputs: { out: "{\"x\":1}", valid: true } },
    { type: "ConcatStringBlock", inputs: { a: "", b: "" }, outputs: { out: "" } },
    { type: "ConcatStringBlock", inputs: { a: "a", b: "b" }, outputs: { out: "ab" } },
    { type: "StringLengthBlock", inputs: { value: "" }, outputs: { length: 0 } },
    { type: "StringContainsBlock", inputs: { value: "abc", search: "" }, outputs: { out: true } },
    { type: "StringStartsWithBlock", inputs: { value: "abc", search: "a" }, outputs: { out: true } },
    { type: "StringEndsWithBlock", inputs: { value: "abc", search: "c" }, outputs: { out: true } },
    { type: "TrimStringBlock", inputs: { value: "  x  " }, outputs: { out: "x" } },
    { type: "LowercaseStringBlock", inputs: { value: "Ab" }, outputs: { out: "ab" } },
    { type: "UppercaseStringBlock", inputs: { value: "Ab" }, outputs: { out: "AB" } },
    { type: "SliceStringBlock", inputs: { value: "hello", start: 1, end: 4 }, outputs: { out: "ell" } },
    { type: "ReplaceStringBlock", inputs: { value: "aa", search: "a", replacement: "b" }, outputs: { out: "bb" } },
    { type: "ReplaceStringBlock", inputs: { value: "aa", search: "", replacement: "b" }, outputs: { out: "aa" } },
    { type: "SplitStringBlock", inputs: { value: "a,b", separator: "," }, outputs: { out: ["a", "b"] } },
    { type: "JoinStringBlock", inputs: { values: ["a", "b"], separator: "," }, outputs: { out: "a,b" } },
    { type: "JsonMergeBlock", inputs: { a: { x: 1 }, b: { y: 2 } }, outputs: { out: { x: 1, y: 2 } } },
    { type: "ArrayLengthBlock", inputs: { values: [1, 2, 3] }, outputs: { length: 3 } },
    { type: "ArrayConcatBlock", inputs: { a: [1], b: [2] }, outputs: { out: [1, 2] } },
    { type: "ArraySliceBlock", inputs: { values: [1, 2, 3, 4], start: 1, end: 3 }, outputs: { out: [2, 3] } },
    { type: "ArrayContainsBlock", inputs: { values: [1, 0, 3], value: 0 }, outputs: { out: true } },
    { type: "ArrayAppendBlock", inputs: { values: [1], value: 0 }, outputs: { out: [1, 0] } },
];

test("stdlib conversion string json and array blocks execute table", () => {
    const classes = { ...CONVERSION_BLOCKS, ...STRING_BLOCKS, ...JSON_BLOCKS, ...ARRAY_BLOCKS };
    for (const row of STDLIB_EXECUTE_CASES) {
        const block = configuredBlock(classes[row.type], row.inputs || {}, {
            storedData: row.storedData,
            state: row.state,
        });
        const output = block.execute();
        for (const [label, expected] of Object.entries(row.outputs)) {
            assert.deepEqual(output.get(label), expected, `${row.type}.${label}`);
        }
    }

    const floorLegacy = configuredBlock(Float64ToInt32Block, { in: 0 });
    assert.equal(floorLegacy.execute().get("out"), 0);
    const floorNaN = configuredBlock(Float64ToInt32Block, { in: Number.NaN });
    assert.equal(floorNaN.execute().get("out"), 0);

    const jsonGet = configuredBlock(JsonGetBlock, { document: { a: 0, nested: { x: 1 } } }, {
        state: { path: "a", valueType: "float64", fallback: 9 },
    });
    const got = jsonGet.execute();
    assert.equal(got.get("value"), 0);
    assert.equal(got.get("exists"), true);

    const missing = configuredBlock(JsonGetBlock, { document: { a: 1 } }, {
        state: { path: "missing", valueType: "float64", fallback: 0 },
    });
    const missed = missing.execute();
    assert.equal(missed.get("value"), 0);
    assert.equal(missed.get("exists"), false);

    const presentNull = configuredBlock(JsonGetBlock, { document: { a: null } }, {
        state: { path: "a", valueType: "json", fallback: 1 },
    });
    assert.equal(presentNull.execute().get("exists"), true);
    assert.equal(presentNull.execute().get("value"), null);

    const arrayGet = configuredBlock(ArrayGetBlock, { values: [10, 20], index: 1 }, {
        state: { itemType: "float64", fallback: 0 },
    });
    assert.equal(arrayGet.execute().get("out"), 20);
    assert.equal(arrayGet.execute().get("found"), true);

    const oob = configuredBlock(ArrayGetBlock, { values: [10], index: 4 }, {
        state: { itemType: "float64", fallback: 0 },
    });
    assert.equal(oob.execute().get("out"), 0);
    assert.equal(oob.execute().get("found"), false);

    const emptyFalse = configuredBlock(ArrayGetBlock, { values: [false], index: 0 }, {
        state: { itemType: "boolean", fallback: true },
    });
    assert.equal(emptyFalse.execute().get("out"), false);
    assert.equal(emptyFalse.execute().get("found"), true);

    const literal = configuredBlock(ArrayLiteralBlock, {}, { storedData: [0, 2], state: { itemType: "float64" } });
    assert.deepEqual(literal.execute().get("out"), [0, 2]);
});

test("json and array writes clone inputs and leave out-of-range arrays unchanged", () => {
    const document = { a: { b: 1 }, keep: 2 };
    const set = configuredBlock(JsonSetBlock, { document, value: 9 }, { state: { path: "a.b", valueType: "float64" } });
    const next = set.execute().get("document");
    next.a.b = 3;
    assert.deepEqual(document, { a: { b: 1 }, keep: 2 });

    const deleted = deleteByPath({ a: { b: 1 }, keep: 2 }, "a.b");
    assert.equal(deleted.deleted, true);
    assert.deepEqual(deleted.value, { a: {}, keep: 2 });
    const empty = deleteByPath({ a: 1 }, "");
    assert.equal(empty.deleted, false);
    assert.deepEqual(empty.value, { a: 1 });
    const missing = deleteByPath({ a: 1 }, "b.c");
    assert.equal(missing.deleted, false);
    assert.deepEqual(missing.value, { a: 1 });

    const source = [1, 2, 3];
    const written = configuredBlock(ArraySetBlock, { values: source, index: 1, value: 9 });
    const updated = written.execute().get("out");
    assert.deepEqual(updated, [1, 9, 3]);
    updated[0] = 99;
    assert.deepEqual(source, [1, 2, 3]);
    assert.equal(written.execute().get("changed"), true);

    const oob = configuredBlock(ArraySetBlock, { values: source, index: -1, value: 9 });
    assert.deepEqual(oob.execute().get("out"), [1, 2, 3]);
    assert.equal(oob.execute().get("changed"), false);

    const notArray = configuredBlock(ArraySetBlock, { values: { x: 1 }, index: 0, value: 9 });
    assert.deepEqual(notArray.execute().get("out"), []);
    assert.equal(notArray.execute().get("changed"), false);

    const cloned = cloneValue({ x: 1 });
    cloned.x = 2;
    assert.deepEqual(cloneValue({ x: 1 }), { x: 1 });
});

test("stdlib blocks compile to v3 ports and match editor execution", () => {
    ensureBuiltIns();

    const floorManager = withHead("int32");
    floorManager.addUnit(new NumberUnitClass("value"));
    floorManager.addUnit(new FloorToIntBlock("op"));
    floorManager.storeData("value", 3.9);
    connect(floorManager, "value", "number", "op", "value");
    connect(floorManager, "op", "out", "head", "output");
    const floored = compileAndRun(floorManager, "floor");
    assert.equal(floored.editor.outputs.result, 3);
    assert.equal(floored.compiled.outputs.result, 3);
    assert.equal(floored.artifact.nodes.find((node) => node.uuid === "op").ports.outputs.out, "int32");

    const concatManager = withHead("string");
    concatManager.addUnit(new StringBlock("a"));
    concatManager.addUnit(new StringBlock("b"));
    concatManager.addUnit(new ConcatStringBlock("op"));
    concatManager.storeData("a", "");
    concatManager.storeData("b", "x");
    connect(concatManager, "a", "out", "op", "a");
    connect(concatManager, "b", "out", "op", "b");
    connect(concatManager, "op", "out", "head", "output");
    const concated = compileAndRun(concatManager, "concat");
    assert.equal(concated.editor.outputs.result, "x");
    assert.equal(concated.compiled.outputs.result, "x");

    const parseManager = withHead("json");
    parseManager.addUnit(new StringBlock("text"));
    parseManager.addUnit(new ParseJsonBlock("op"));
    parseManager.storeData("text", "not-json");
    connect(parseManager, "text", "out", "op", "value");
    connect(parseManager, "op", "out", "head", "output");
    const parsed = compileAndRun(parseManager, "parse-json");
    assert.equal(parsed.editor.outputs.result, null);
    assert.equal(parsed.compiled.outputs.result, null);

    const arrayManager = withHead("float64");
    const literal = new ArrayLiteralBlock("literal");
    const getter = new ArrayGetBlock("get");
    getter.hydrateState({ itemType: "float64", fallback: 0 });
    arrayManager.addUnit(literal);
    arrayManager.addUnit(new IntegerBlock("index"));
    arrayManager.addUnit(getter);
    arrayManager.storeData("literal", [4, 5, 6]);
    arrayManager.storeData("index", 1);
    connect(arrayManager, "literal", "out", "get", "values");
    connect(arrayManager, "index", "out", "get", "index");
    connect(arrayManager, "get", "out", "head", "output");
    const gotten = compileAndRun(arrayManager, "array-get");
    assert.equal(gotten.editor.outputs.result, 5);
    assert.equal(gotten.compiled.outputs.result, 5);
    assert.equal(gotten.artifact.nodes.find((node) => node.uuid === "get").ports.inputs.values, "array[float64]");

    const jsonManager = withHead("float64");
    const json = new JsonBlock("json");
    const get = new JsonGetBlock("get");
    get.hydrateState({ path: "a", valueType: "float64", fallback: 0 });
    jsonManager.addUnit(json);
    jsonManager.addUnit(get);
    jsonManager.storeData("json", { a: 0 });
    connect(jsonManager, "json", "out", "get", "document");
    connect(jsonManager, "get", "value", "head", "output");
    const jsoned = compileAndRun(jsonManager, "json-get");
    assert.equal(jsoned.editor.outputs.result, 0);
    assert.equal(jsoned.compiled.outputs.result, 0);
});

