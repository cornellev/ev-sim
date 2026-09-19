import assert from "node:assert/strict";
import test from "node:test";

import { clearBlockTypeRegistryForTests, ScriptManager } from "../app/scripting/ScriptManager.js";
import { registerBuiltInBlocks } from "../app/scripting/registerBuiltInBlocks.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SIGNAL_PATHS, devicesLeafPath, entityIdSegment, vehiclesLeafPath } from "../app/scripting/runtime/SignalPaths.js";
import {
    finiteFloat,
    finiteInt32,
    finiteResult,
    normalizeActorCommand,
    normalizePose3d,
    normalizeVec3,
    orderedBounds,
    UNIT,
    UNIT_TYPE,
    valuesEqual,
} from "../app/scripting/types/PortTypes.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { RandomNumberBlock } from "../app/scripting/units/math/Random.block.js";
import { RemapRangeBlock, WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import { LowPassFilterBlock, SampleTextureBlock, SensorFusionBlock } from "../app/scripting/units/math/SensorFlow.block.js";
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
    ToStringBlock,
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
import {
    GEOMETRY_BLOCK_PORTS,
    GEOMETRY_BLOCKS,
    LengthVec2Block,
    MakeVec2Block,
} from "../app/scripting/units/geometry/GeometryBlocks.block.js";
import * as scalarMath from "../app/scripting/units/math/scalarMath.js";
import { TerrainNoiseBlock } from "../app/scripting/units/math/Terrain.block.js";
import {
    TEXTURE_BLOCK_PORTS,
    TEXTURE_BLOCKS,
    MultiplyTexBlock,
    ScaleBlock,
    ScaleTextureBlock,
} from "../app/scripting/units/math/tex/Scale.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import { TextureImportBlock } from "../app/scripting/units/objects/TextureImport.block.js";
import { OutputNodeBlock, ProgramInputBlock } from "../app/scripting/units/program/ProgramIO.block.js";
import {
    RouteLengthBlock,
    ROUTE_HELPER_BLOCK_PORTS,
    ROUTE_HELPER_BLOCKS,
    WaypointAtIndexBlock,
} from "../app/scripting/units/mission/RouteBlocks.block.js";
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
    CONTROLLER_BLOCK_PORTS,
    CONTROLLER_BLOCKS,
    PidControllerBlock,
} from "../app/scripting/units/control/ControllerBlocks.block.js";
import {
    TEMPORAL_BLOCK_PORTS,
    TEMPORAL_BLOCKS,
    IntegratorBlock,
    PreviousBlock,
} from "../app/scripting/units/control/TemporalBlocks.block.js";
import * as temporalMath from "../app/scripting/units/control/temporalMath.js";
import {
    VehiclePoseBlock,
    VehicleVelocityBlock,
    LogMessageBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";
import {
    SIMULATOR_ADAPTER_BLOCKS,
    SIMULATOR_ADAPTER_PORTS,
    SimulationClockBlock,
    VehicleStateBlock,
} from "../app/scripting/units/simulator/SimulatorAdapters.block.js";
import {
    SCATTER_SOURCE_ERROR,
    SPAWN_PROP_OVERLAY_ERROR,
    WORLD_BLOCK_PORTS,
    WORLD_BLOCKS,
} from "../app/scripting/units/world/WorldBlocks.block.js";
import { RepeatProgramBlock, repeatProgramPorts } from "../app/scripting/units/statements/RepeatProgram.block.js";
import { EpisodeOverlay } from "../app/simulation/episode/EpisodeOverlay.js";

function configuredBlock(BlockClass, values, options = {}) {
    const block = new BlockClass(options.uuid || "block");
    if (options.state) block.hydrateState(options.state);
    block.inputs = Object.fromEntries(Object.keys(values).map((label) => [label, {}]));
    block.getInput = (label) => values[label];
    block.setManager({
        evaluationPolicy: options.evaluationPolicy || { lazySelectors: true },
        getRuntimeContext: () => ({
            random: options.random || (() => 0),
            ...(options.runtimeContext || {}),
        }),
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

    assert.equal(temporalMath.clampWindow(0), 1);
    assert.equal(temporalMath.clampWindow(9000), 4096);
    assert.equal(temporalMath.median([1, 3, 2, 4]), 2.5);
    assert.equal(temporalMath.integratorStep(0, 10, 0.1, false), 1);
    assert.equal(temporalMath.integratorStep(1, 10, 0.1, true), 0);
    assert.equal(temporalMath.hysteresisStep(false, 3, 5, 1), false);
    assert.equal(temporalMath.hysteresisStep(false, 6, 5, 1), true);
    const bounced = temporalMath.debounceStep({ output: false, candidate: false, elapsed: 0 }, true, 0.1, 0.2);
    assert.equal(bounced.output, false);
    assert.equal(bounced.elapsed, 0.1);
    const pidFrozen = temporalMath.pidStep(
        { integral: 0, previousError: 0, initialized: false },
        { setpoint: 10, measurement: 0, kp: 1, ki: 10, kd: 0, dt: 0.1, min: -1, max: 1, reset: false },
    );
    assert.equal(pidFrozen.outputs.command, 1);
    assert.equal(pidFrozen.outputs.saturated, true);
    assert.equal(pidFrozen.state.integral, 0);
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
        [GEOMETRY_BLOCK_PORTS, GEOMETRY_BLOCKS],
        [ROUTE_HELPER_BLOCK_PORTS, ROUTE_HELPER_BLOCKS],
        [TEMPORAL_BLOCK_PORTS, TEMPORAL_BLOCKS],
        [CONTROLLER_BLOCK_PORTS, CONTROLLER_BLOCKS],
        [TEXTURE_BLOCK_PORTS, TEXTURE_BLOCKS],
        [SIMULATOR_ADAPTER_PORTS, SIMULATOR_ADAPTER_BLOCKS],
        [WORLD_BLOCK_PORTS, WORLD_BLOCKS],
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
    { type: "ToStringBlock", inputs: { value: 12 }, outputs: { out: "12" } },
    { type: "ToStringBlock", inputs: { value: 3.5 }, outputs: { out: "3.5" } },
    { type: "ToStringBlock", inputs: { value: false }, outputs: { out: "false" } },
    { type: "ToStringBlock", inputs: { value: "x" }, outputs: { out: "x" } },
    { type: "ToStringBlock", inputs: { value: { x: 1 } }, outputs: { out: "{\"x\":1}" } },
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
    { type: "StringToRoadIdBlock", inputs: { value: "  e0  " }, outputs: { out: "e0" } },
    { type: "StringToRoadIdBlock", inputs: { value: "" }, outputs: { out: "" } },
    { type: "RoadIdToStringBlock", inputs: { value: "e0" }, outputs: { out: "e0" } },
    { type: "StringToTextureIdBlock", inputs: { value: "  abc  " }, outputs: { out: "abc" } },
    { type: "TextureIdToStringBlock", inputs: { value: "abc" }, outputs: { out: "abc" } },
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
    { type: "LinspaceBlock", inputs: { start: 0, end: 1, count: 3 }, outputs: { out: [0, 0.5, 1] } },
    { type: "LinspaceBlock", inputs: { start: 5, end: 9, count: 1 }, outputs: { out: [5] } },
    { type: "LinspaceBlock", inputs: { start: 0, end: 1, count: 0 }, outputs: { out: [] } },
    { type: "LinspaceBlock", inputs: { start: Number.NaN, end: 1, count: 4 }, outputs: { out: [] } },
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

    for (const reserved of ["__proto__.polluted", "prototype.polluted", "constructor.prototype.polluted"]) {
        assert.throws(
            () => configuredBlock(JsonSetBlock, { document: {}, value: true }, {
                state: { path: reserved, valueType: "boolean" },
            }).execute(),
            /reserved segment/,
        );
    }
    assert.equal(Object.prototype.polluted, undefined);
});

const SAMPLE_ROUTE = {
    waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 0, z: 20 },
    ],
};

const GEOMETRY_EXECUTE_CASES = [
    { type: "MakeVec2Block", inputs: { x: 3, y: 4 }, outputs: { out: { x: 3, y: 4 } } },
    { type: "SplitVec2Block", inputs: { value: { x: 3, y: 4, extra: 1 } }, outputs: { x: 3, y: 4 } },
    { type: "AddVec2Block", inputs: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } }, outputs: { out: { x: 0, y: 1 } } },
    { type: "SubtractVec2Block", inputs: { a: { x: 5, y: 1 }, b: { x: 2, y: 1 } }, outputs: { out: { x: 3, y: 0 } } },
    { type: "ScaleVec2Block", inputs: { value: { x: 1, y: 2 }, scalar: 0 }, outputs: { out: { x: 0, y: 0 } } },
    { type: "DotVec2Block", inputs: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }, outputs: { out: 11 } },
    { type: "LengthVec2Block", inputs: { value: { x: 3, y: 4 } }, outputs: { out: 5 } },
    { type: "LengthVec2Block", inputs: { value: { x: 0, y: 0 } }, outputs: { out: 0 } },
    { type: "NormalizeVec2Block", inputs: { value: { x: 3, y: 4 } }, outputs: { out: { x: 0.6, y: 0.8 } } },
    { type: "NormalizeVec2Block", inputs: { value: { x: 0, y: 0 } }, outputs: { out: { x: 0, y: 0 } } },
    { type: "DistanceVec2Block", inputs: { a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }, outputs: { out: 5 } },
    { type: "MakeVec3Block", inputs: { x: 1, y: 2, z: 3 }, outputs: { out: { x: 1, y: 2, z: 3 } } },
    { type: "SplitVec3Block", inputs: { value: { x: 1, y: 2, z: 3 } }, outputs: { x: 1, y: 2, z: 3 } },
    { type: "AddVec3Block", inputs: { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } }, outputs: { out: { x: 1, y: 1, z: 0 } } },
    { type: "ScaleVec3Block", inputs: { value: { x: 2, y: 0, z: -1 }, scalar: 3 }, outputs: { out: { x: 6, y: 0, z: -3 } } },
    { type: "DotVec3Block", inputs: { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } }, outputs: { out: 0 } },
    { type: "LengthVec3Block", inputs: { value: { x: 0, y: 3, z: 4 } }, outputs: { out: 5 } },
    { type: "NormalizeVec3Block", inputs: { value: { x: 0, y: 0, z: 0 } }, outputs: { out: { x: 0, y: 0, z: 0 } } },
    { type: "CrossVec3Block", inputs: { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } }, outputs: { out: { x: 0, y: 0, z: 1 } } },
    { type: "DistanceVec3Block", inputs: { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 3, z: 4 } }, outputs: { out: 5 } },
    {
        type: "MakePose2DBlock",
        inputs: { position: { x: 1, y: 2 }, yaw: 0.5 },
        outputs: { out: { position: { x: 1, y: 2 }, yaw: 0.5 } },
    },
    {
        type: "SplitPose2DBlock",
        inputs: { value: { position: { x: 1, y: 2 }, yaw: 0.5, extra: 9 } },
        outputs: { position: { x: 1, y: 2 }, yaw: 0.5 },
    },
    {
        type: "MakePose3DBlock",
        inputs: { position: { x: 1, y: 2, z: 3 }, x: 0.1, y: 0.2, z: 0.3 },
        outputs: {
            out: {
                position: { x: 1, y: 2, z: 3 },
                rotation: { x: 0.1, y: 0.2, z: 0.3, order: "XYZ" },
            },
        },
    },
    {
        type: "SplitPose3DBlock",
        inputs: {
            value: {
                position: { x: 1, y: 2, z: 3 },
                rotation: { x: 0.1, y: 0.2, z: 0.3, order: "YXZ", extra: true },
            },
        },
        outputs: { position: { x: 1, y: 2, z: 3 }, x: 0.1, y: 0.2, z: 0.3, order: "YXZ" },
    },
];

const ROUTE_EXECUTE_CASES = [
    {
        type: "WaypointAtIndexBlock",
        inputs: { route: SAMPLE_ROUTE, index: 1 },
        outputs: { waypoint: { x: 10, y: 0, z: 0 }, found: true },
    },
    {
        type: "WaypointAtIndexBlock",
        inputs: { route: SAMPLE_ROUTE, index: 4 },
        outputs: { waypoint: { id: "", kind: "", position: { x: 0, y: 0, z: 0 }, order: 0 }, found: false },
    },
    {
        type: "WaypointAtIndexBlock",
        inputs: { route: SAMPLE_ROUTE, index: -1 },
        outputs: { waypoint: { id: "", kind: "", position: { x: 0, y: 0, z: 0 }, order: 0 }, found: false },
    },
    {
        type: "WaypointAtIndexBlock",
        inputs: { route: {}, index: 0 },
        outputs: { waypoint: { id: "", kind: "", position: { x: 0, y: 0, z: 0 }, order: 0 }, found: false },
    },
    {
        type: "SplitWaypointBlock",
        inputs: { waypoint: { id: "a", kind: "start", position: { x: 1, y: 2, z: 3 }, order: 0 } },
        outputs: { id: "a", kind: "start", position: { x: 1, y: 2, z: 3 }, order: 0 },
    },
    {
        type: "SplitWaypointBlock",
        inputs: { waypoint: null },
        outputs: { id: "", kind: "", position: { x: 0, y: 0, z: 0 }, order: 0 },
    },
    { type: "RouteLengthBlock", inputs: { route: SAMPLE_ROUTE }, outputs: { length: 30 } },
    {
        type: "DistanceToRouteEndBlock",
        inputs: { route: SAMPLE_ROUTE, pose: { position: { x: 10, y: 0, z: 20 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } } },
        outputs: { distance: 0 },
    },
    {
        type: "DistanceToRouteEndBlock",
        inputs: { route: { waypoints: [] }, pose: { position: { x: 1, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } } },
        outputs: { distance: 0 },
    },
    {
        type: "RouteTangentBlock",
        inputs: { route: SAMPLE_ROUTE, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } } },
        outputs: { heading: Math.atan2(10, 0), tangent: { x: 1, y: 0 }, progress: 0, found: true },
    },
    {
        type: "RouteTangentBlock",
        inputs: { route: { waypoints: [] }, pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } } },
        outputs: { heading: 0, tangent: { x: 0, y: 0 }, progress: 0, found: false },
    },
];

test("geometry and route helper blocks execute table", () => {
    const classes = { ...GEOMETRY_BLOCKS, ...ROUTE_HELPER_BLOCKS };
    for (const row of [...GEOMETRY_EXECUTE_CASES, ...ROUTE_EXECUTE_CASES]) {
        const block = configuredBlock(classes[row.type], row.inputs || {});
        const output = block.execute();
        for (const [label, expected] of Object.entries(row.outputs)) {
            assert.deepEqual(output.get(label), expected, `${row.type}.${label}`);
        }
    }

    const left = { x: 1, y: 2, z: 3 };
    const right = { x: 4, y: 5, z: 6 };
    const added = configuredBlock(GEOMETRY_BLOCKS.AddVec3Block, { a: left, b: right });
    const sum = added.execute().get("out");
    sum.x = 99;
    assert.deepEqual(left, { x: 1, y: 2, z: 3 });
    assert.deepEqual(right, { x: 4, y: 5, z: 6 });

    const source = [{ x: 1, y: 0, z: 0 }];
    const indexed = configuredBlock(WaypointAtIndexBlock, { route: { waypoints: source }, index: 0 });
    const waypoint = indexed.execute().get("waypoint");
    waypoint.x = 9;
    assert.deepEqual(source[0], { x: 1, y: 0, z: 0 });
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

    const toStringManager = withHead("string");
    toStringManager.addUnit(new IntegerBlock("value"));
    toStringManager.addUnit(new ToStringBlock("op"));
    toStringManager.storeData("value", 12);
    connect(toStringManager, "value", "out", "op", "value");
    connect(toStringManager, "op", "out", "head", "output");
    const stringed = compileAndRun(toStringManager, "to-string");
    assert.equal(stringed.editor.outputs.result, "12");
    assert.equal(stringed.compiled.outputs.result, "12");
    assert.equal(stringed.artifact.nodes.find((node) => node.uuid === "op").ports.inputs.value, "int32");
    assert.equal(stringed.artifact.nodes.find((node) => node.uuid === "op").ports.outputs.out, "string");

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

    const vecManager = withHead("float64");
    vecManager.addUnit(new NumberUnitClass("x"));
    vecManager.addUnit(new NumberUnitClass("y"));
    vecManager.addUnit(new MakeVec2Block("make"));
    vecManager.addUnit(new LengthVec2Block("length"));
    vecManager.storeData("x", 3);
    vecManager.storeData("y", 4);
    connect(vecManager, "x", "number", "make", "x");
    connect(vecManager, "y", "number", "make", "y");
    connect(vecManager, "make", "out", "length", "value");
    connect(vecManager, "length", "out", "head", "output");
    const vectored = compileAndRun(vecManager, "length-vec2");
    assert.equal(vectored.editor.outputs.result, 5);
    assert.equal(vectored.compiled.outputs.result, 5);
    assert.equal(vectored.artifact.nodes.find((node) => node.uuid === "make").ports.outputs.out, "vec2");

    const routeManager = withHead("float64");
    const routeInput = new ProgramInputBlock("route");
    const routeConfig = {
        label: "route",
        type: "route",
        defaultValue: JSON.stringify({
            waypoints: [
                { x: 0, y: 0, z: 0 },
                { x: 10, y: 0, z: 0 },
                { x: 10, y: 0, z: 20 },
            ],
        }),
    };
    routeInput.hydrateState(routeConfig);
    routeManager.addUnit(routeInput);
    routeManager.storeData("route", routeConfig);
    routeManager.addUnit(new RouteLengthBlock("length"));
    connect(routeManager, "route", "input", "length", "route");
    connect(routeManager, "length", "length", "head", "output");
    const routed = compileAndRun(routeManager, "route-length");
    assert.equal(routed.editor.outputs.result, 30);
    assert.equal(routed.compiled.outputs.result, 30);
    assert.equal(routed.artifact.nodes.find((node) => node.uuid === "length").ports.inputs.route, "route");
});

function addProgramInput(manager, label, type, defaultValue) {
    const uuid = `in-${label}`;
    const block = new ProgramInputBlock(uuid);
    const config = {
        label,
        type,
        defaultValue: String(defaultValue),
    };
    block.hydrateState(config);
    manager.addUnit(block);
    manager.storeData(uuid, config);
    return uuid;
}

function outputMap(block) {
    const result = block.execute();
    return Object.fromEntries(Object.keys(result.map).map((label) => [label, result.get(label)]));
}

const TEMPORAL_EXECUTE_CASES = [
    { type: "PreviousBlock", inputs: { value: {}, initial: { x: 0 } }, outputs: { previous: { x: 0 } } },
    { type: "ValueChangedBlock", inputs: { value: 0 }, outputs: { changed: false } },
    { type: "RisingEdgeBlock", inputs: { value: true }, outputs: { pulse: false } },
    { type: "FallingEdgeBlock", inputs: { value: false }, outputs: { pulse: false } },
    { type: "DebounceBlock", inputs: { value: false, dt: 0, duration: 0.2 }, outputs: { out: false } },
    { type: "HysteresisBlock", inputs: { value: 6, low: 5, high: 1 }, outputs: { out: true } },
    { type: "PulseBlock", inputs: { trigger: true, dt: 0.1, duration: 0.2 }, outputs: { out: false } },
    { type: "StopwatchBlock", inputs: { enabled: true, reset: false, dt: 0 }, outputs: { elapsed: 0 } },
    { type: "MovingAverageBlock", inputs: { value: 4, window: 0 }, outputs: { out: 4 } },
    { type: "MedianFilterBlock", inputs: { value: 0, window: 3 }, outputs: { out: 0 } },
    { type: "SlewRateBlock", inputs: { value: 8, riseRate: 1, fallRate: 1, dt: 0.1 }, outputs: { out: 8 } },
    { type: "IntegratorBlock", inputs: { value: 10, dt: 0, reset: false }, outputs: { out: 0 } },
    { type: "DerivativeBlock", inputs: { value: 5, dt: 0.1, reset: false }, outputs: { out: 0 } },
    {
        type: "PidControllerBlock",
        inputs: {
            setpoint: 1,
            measurement: 0,
            kp: 1,
            ki: 0,
            kd: 0,
            dt: 0.1,
            min: -10,
            max: 10,
            reset: false,
        },
        outputs: { command: 1, error: 1, p: 1, i: 0, d: 0, saturated: false },
    },
];

const TEMPORAL_SEQUENCE_CASES = [
    {
        type: "PreviousBlock",
        ticks: [
            { inputs: { value: 1, initial: 0 }, outputs: { previous: 0 } },
            { inputs: { value: 2, initial: 0 }, outputs: { previous: 1 } },
        ],
    },
    {
        type: "ValueChangedBlock",
        ticks: [
            { inputs: { value: { x: 1 } }, outputs: { changed: false } },
            { inputs: { value: { x: 1 } }, outputs: { changed: false } },
            { inputs: { value: { x: 2 } }, outputs: { changed: true } },
        ],
    },
    {
        type: "RisingEdgeBlock",
        ticks: [
            { inputs: { value: false }, outputs: { pulse: false } },
            { inputs: { value: true }, outputs: { pulse: true } },
            { inputs: { value: true }, outputs: { pulse: false } },
        ],
    },
    {
        type: "DebounceBlock",
        ticks: [
            { inputs: { value: true, dt: 0.1, duration: 0.2 }, outputs: { out: false } },
            { inputs: { value: true, dt: 0.1, duration: 0.2 }, outputs: { out: true } },
        ],
    },
    {
        type: "StopwatchBlock",
        ticks: [
            { inputs: { enabled: true, reset: false, dt: 0.1 }, outputs: { elapsed: 0.1 } },
            { inputs: { enabled: true, reset: false, dt: 0.1 }, outputs: { elapsed: 0.2 } },
            { inputs: { enabled: true, reset: true, dt: 0.1 }, outputs: { elapsed: 0 } },
            { inputs: { enabled: true, reset: false, dt: 0.1 }, outputs: { elapsed: 0.1 } },
        ],
    },
    {
        type: "IntegratorBlock",
        ticks: [
            { inputs: { value: 10, dt: 0.1, reset: false }, outputs: { out: 1 } },
            { inputs: { value: 10, dt: 0.1, reset: false }, outputs: { out: 2 } },
            { inputs: { value: 10, dt: 0.1, reset: true }, outputs: { out: 0 } },
        ],
    },
    {
        type: "PulseBlock",
        ticks: [
            { inputs: { trigger: false, dt: 0.1, duration: 0.3 }, outputs: { out: false } },
            { inputs: { trigger: true, dt: 0.1, duration: 0.3 }, outputs: { out: true } },
            { inputs: { trigger: false, dt: 0.1, duration: 0.3 }, outputs: { out: true } },
            { inputs: { trigger: true, dt: 0.1, duration: 0.3 }, outputs: { out: true } },
        ],
    },
    {
        type: "MovingAverageBlock",
        ticks: [
            { inputs: { value: 1, window: 3 }, outputs: { out: 1 } },
            { inputs: { value: 3, window: 3 }, outputs: { out: 2 } },
            { inputs: { value: 5, window: 3 }, outputs: { out: 3 } },
            { inputs: { value: 7, window: 2 }, outputs: { out: 6 } },
        ],
    },
];

test("control temporal and pid blocks execute first-tick table", () => {
    const classes = { ...TEMPORAL_BLOCKS, ...CONTROLLER_BLOCKS };
    for (const row of TEMPORAL_EXECUTE_CASES) {
        const block = configuredBlock(classes[row.type], row.inputs);
        const actual = outputMap(block);
        assert.deepEqual(actual, row.outputs, row.type);
    }
});

test("control temporal blocks execute sequence table", () => {
    const classes = { ...TEMPORAL_BLOCKS, ...CONTROLLER_BLOCKS };
    for (const row of TEMPORAL_SEQUENCE_CASES) {
        const values = { ...row.ticks[0].inputs };
        const block = configuredBlock(classes[row.type], values);
        row.ticks.forEach((tick, index) => {
            Object.assign(values, tick.inputs);
            const actual = outputMap(block);
            assert.deepEqual(actual, tick.outputs, `${row.type} tick ${index}`);
        });
    }
});

test("control dt failures do not mutate runtime state", () => {
    const values = { value: 1, dt: 0.1, reset: false };
    const integrator = configuredBlock(IntegratorBlock, values);
    integrator.hydrateRuntimeState({ integral: 4 });
    const before = integrator.serializeRuntimeState();
    values.dt = -1;
    assert.throws(() => integrator.execute(), /IntegratorBlock dt must be finite and non-negative/);
    assert.deepEqual(integrator.serializeRuntimeState(), before);
    values.dt = Infinity;
    assert.throws(() => integrator.execute(), /IntegratorBlock dt must be finite and non-negative/);
    assert.deepEqual(integrator.serializeRuntimeState(), before);

    const pidValues = {
        setpoint: 1,
        measurement: 0,
        kp: 1,
        ki: 0,
        kd: 0,
        dt: 0.1,
        min: -1,
        max: 1,
        reset: false,
    };
    const pid = configuredBlock(PidControllerBlock, pidValues);
    pid.hydrateRuntimeState({ integral: 2, previousError: 1, initialized: true });
    const pidBefore = pid.serializeRuntimeState();
    pidValues.dt = -0.01;
    assert.throws(() => pid.execute(), /PidControllerBlock dt must be finite and non-negative/);
    assert.deepEqual(pid.serializeRuntimeState(), pidBefore);
});

test("control blocks clone stored values and hydrate missing runtime state", () => {
    const previous = configuredBlock(PreviousBlock, { value: { x: 1 }, initial: { x: 0 } });
    const first = previous.execute().get("previous");
    first.x = 9;
    const second = previous.execute().get("previous");
    assert.deepEqual(second, { x: 1 });
    second.x = 8;
    assert.deepEqual(previous.serializeRuntimeState().value, { x: 1 });

    previous.hydrateRuntimeState({});
    assert.deepEqual(previous.serializeRuntimeState(), { value: null, initialized: false });
    previous.hydrateRuntimeState({ initialized: false, value: { x: 4 } });
    assert.equal(previous.serializeRuntimeState().initialized, false);

    const integrator = configuredBlock(IntegratorBlock, { value: 1, dt: 0.1, reset: false });
    integrator.hydrateRuntimeState({ integral: Infinity });
    assert.equal(integrator.serializeRuntimeState().integral, 0);

    const average = configuredBlock(TEMPORAL_BLOCKS.MovingAverageBlock, { value: 1, window: 2 });
    average.hydrateRuntimeState({ samples: "bad" });
    assert.deepEqual(average.serializeRuntimeState().samples, []);
});

test("control blocks compile to v3 ports and persist across compiled runs", () => {
    ensureBuiltIns();

    const integratorManager = withHead("float64");
    addProgramInput(integratorManager, "value", "float64", 10);
    addProgramInput(integratorManager, "dt", "float64", 0.1);
    addProgramInput(integratorManager, "reset", "boolean", false);
    integratorManager.addUnit(new IntegratorBlock("int"));
    connect(integratorManager, "in-value", "input", "int", "value");
    connect(integratorManager, "in-dt", "input", "int", "dt");
    connect(integratorManager, "in-reset", "input", "int", "reset");
    connect(integratorManager, "int", "out", "head", "output");
    const integratorArtifact = integratorManager.compile("integrator");
    assert.equal(JSON.stringify(integratorArtifact).includes("generic"), false);
    assert.equal(integratorArtifact.nodes.find((node) => node.uuid === "int").ports.inputs.dt, "float64");
    const editor = integratorManager.executeProgram({ value: 10, dt: 0.1, reset: false });
    assert.equal(editor.status, "success", editor.e?.message);
    assert.equal(editor.outputs.result, 1);
    const integratorRunner = ScriptManager.createRunner(integratorArtifact);
    assert.equal(integratorRunner.run({ value: 10, dt: 0.1, reset: false }).outputs.result, 1);
    assert.equal(integratorRunner.run({ value: 10, dt: 0.1, reset: false }).outputs.result, 2);

    const previousManager = withHead("float64");
    previousManager.addUnit(new NumberUnitClass("value"));
    previousManager.addUnit(new NumberUnitClass("initial"));
    previousManager.addUnit(new PreviousBlock("prev"));
    previousManager.storeData("value", 1);
    previousManager.storeData("initial", 0);
    connect(previousManager, "value", "number", "prev", "value");
    connect(previousManager, "initial", "number", "prev", "initial");
    connect(previousManager, "prev", "previous", "head", "output");
    const previousArtifact = previousManager.compile("previous");
    assert.equal(previousArtifact.nodes.find((node) => node.uuid === "prev").ports.outputs.previous, "float64");
    const previousRunner = ScriptManager.createRunner(previousArtifact);
    assert.equal(previousRunner.run().outputs.result, 0);
    assert.equal(previousRunner.run().outputs.result, 1);

    const pidManager = withHead("float64");
    addProgramInput(pidManager, "setpoint", "float64", 1);
    addProgramInput(pidManager, "measurement", "float64", 0);
    addProgramInput(pidManager, "kp", "float64", 1);
    addProgramInput(pidManager, "ki", "float64", 0);
    addProgramInput(pidManager, "kd", "float64", 0);
    addProgramInput(pidManager, "dt", "float64", 0.1);
    addProgramInput(pidManager, "min", "float64", -10);
    addProgramInput(pidManager, "max", "float64", 10);
    addProgramInput(pidManager, "reset", "boolean", false);
    pidManager.addUnit(new PidControllerBlock("pid"));
    connect(pidManager, "in-setpoint", "input", "pid", "setpoint");
    connect(pidManager, "in-measurement", "input", "pid", "measurement");
    connect(pidManager, "in-kp", "input", "pid", "kp");
    connect(pidManager, "in-ki", "input", "pid", "ki");
    connect(pidManager, "in-kd", "input", "pid", "kd");
    connect(pidManager, "in-dt", "input", "pid", "dt");
    connect(pidManager, "in-min", "input", "pid", "min");
    connect(pidManager, "in-max", "input", "pid", "max");
    connect(pidManager, "in-reset", "input", "pid", "reset");
    connect(pidManager, "pid", "command", "head", "output");
    const pidArtifact = pidManager.compile("pid");
    assert.equal(pidArtifact.nodes.find((node) => node.uuid === "pid").ports.outputs.command, "float64");
    const pidRun = ScriptManager.createRunner(pidArtifact).run();
    assert.equal(pidRun.status, "success", pidRun.e?.message);
    assert.equal(pidRun.outputs.result, 1);
});

function signalAdapter(BlockClass, store, values = {}) {
    const manager = new ScriptManager();
    manager.setSignalStore(store);
    const block = new BlockClass("adapter");
    manager.addUnit(block);
    if (Object.keys(values).length) {
        block.inputs = Object.fromEntries(Object.keys(values).map((label) => [label, {}]));
        block.getInput = (label) => values[label];
    }
    return block;
}

const ZERO_POSE = normalizePose3d(null);
const ZERO_VEC3 = normalizeVec3(null);
const SAMPLE_POSE = {
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0.5, z: 0, order: "XYZ" },
};
const SAMPLE_VELOCITY = { x: 4, y: 0, z: -1 };

test("signal path helpers reject dotted ids and default ego", () => {
    assert.equal(entityIdSegment("", "ego"), "ego");
    assert.equal(entityIdSegment("  ego  "), "ego");
    assert.equal(entityIdSegment("foo.bar"), "");
    assert.equal(vehiclesLeafPath("", "pose"), "vehicles.ego.pose");
    assert.equal(vehiclesLeafPath("npc-1", "steeringAngle"), "vehicles.npc-1.steeringAngle");
    assert.equal(vehiclesLeafPath("bad.id", "pose"), "");
    assert.equal(devicesLeafPath("", "pose"), "");
    assert.equal(devicesLeafPath("front_camera", "enabled"), "devices.front_camera.enabled");
});

const TEXTURE_EXECUTE_CASES = [
    { type: "ScaleTextureBlock", inputs: { tex: [1, 2, 3], scalar: 0 }, outputs: { out: [0, 0, 0] } },
    { type: "ScaleTextureBlock", inputs: { tex: [], scalar: 4 }, outputs: { out: [] } },
    { type: "MultiplyTexBlock", inputs: { a: [1, 2], b: [3, 4] }, outputs: { out: [3, 8] } },
    { type: "AddTextureBlock", inputs: { a: [1, 0], b: [2, 3] }, outputs: { out: [3, 3] } },
    { type: "SubtractTextureBlock", inputs: { a: [5, 1], b: [2, 1] }, outputs: { out: [3, 0] } },
    { type: "ClampTextureBlock", inputs: { tex: [-1, 0.5, 8], min: 5, max: 1 }, outputs: { out: [1, 1, 5] } },
    { type: "InvertTextureBlock", inputs: { tex: [0, 0.25, 1] }, outputs: { out: [1, 0.75, 0] } },
];

test("texture blocks execute table and fail closed on malformed inputs", () => {
    for (const row of TEXTURE_EXECUTE_CASES) {
        const block = configuredBlock(TEXTURE_BLOCKS[row.type], row.inputs);
        const output = block.execute();
        for (const [label, expected] of Object.entries(row.outputs)) {
            assert.deepEqual(output.get(label), expected, `${row.type}.${label}`);
        }
    }

    const source = [1, 2];
    const scaled = configuredBlock(ScaleTextureBlock, { tex: source, scalar: 2 });
    const out = scaled.execute().get("out");
    out[0] = 99;
    assert.deepEqual(source, [1, 2]);

    const mismatch = configuredBlock(MultiplyTexBlock, { a: [1], b: [2, 3] });
    assert.throws(() => mismatch.execute(), /equal lengths/);
    const nanTex = configuredBlock(TEXTURE_BLOCKS.AddTextureBlock, { a: [1, Number.NaN], b: [2, 3] });
    assert.throws(() => nanTex.execute(), /finite/);
    const infTex = configuredBlock(TEXTURE_BLOCKS.InvertTextureBlock, { tex: [Infinity] });
    assert.throws(() => infTex.execute(), /finite/);
    assert.throws(
        () => configuredBlock(ScaleTextureBlock, { tex: { length: 2 }, scalar: 1 }).execute(),
        /array/,
    );

    const legacy = configuredBlock(MultiplyTexBlock, { tex1d_a: [1, 2], tex1d_b: [3, 4] });
    legacy.typeMap = {
        inputs: { tex1d_a: "tex1d", tex1d_b: "tex1d" },
        outputs: { result: "tex1d" },
    };
    assert.equal(legacy.valid(), true);
    const legacyOut = legacy.execute();
    assert.deepEqual(legacyOut.get("result"), [3, 8]);
    assert.equal(legacyOut.has("out"), false);

    const sample = configuredBlock(SampleTextureBlock, { tex: [0, 1, 2, 3], x: 1, y: 1 });
    assert.equal(sample.execute().get("out"), 3);
    const origin = configuredBlock(SampleTextureBlock, { tex: [4, 5, 6, 7], x: 0, y: 0 });
    assert.equal(origin.execute().get("out"), 4);
    assert.throws(
        () => configuredBlock(SampleTextureBlock, { tex: [1, 2], x: 0, y: 0 }).execute(),
        /perfect square/,
    );
    assert.throws(
        () => configuredBlock(SampleTextureBlock, { tex: [], x: 0, y: 0 }).execute(),
        /perfect square/,
    );
});

test("simulator adapters read typed signal-store leafs", () => {
    const store = new SignalStore();
    store.set(SIGNAL_PATHS.VEHICLES_EGO_POSE, SAMPLE_POSE);
    store.set(SIGNAL_PATHS.VEHICLES_EGO_VELOCITY, SAMPLE_VELOCITY);
    store.set("vehicles.ego.steeringAngle", 0.25);

    const fresh = signalAdapter(VehicleStateBlock, store, { actorId: "ego" });
    assert.deepEqual(fresh.execute().get("pose"), SAMPLE_POSE);
    assert.deepEqual(fresh.execute().get("velocity"), SAMPLE_VELOCITY);
    assert.equal(fresh.execute().get("steering"), 0.25);
    assert.equal(fresh.execute().get("exists"), true);
    assert.equal(fresh.execute().get("stale"), false);

    const missing = signalAdapter(VehicleStateBlock, new SignalStore(), { actorId: "ghost" });
    const missingOut = missing.execute();
    assert.deepEqual(missingOut.get("pose"), ZERO_POSE);
    assert.deepEqual(missingOut.get("velocity"), ZERO_VEC3);
    assert.equal(missingOut.get("steering"), 0);
    assert.equal(missingOut.get("exists"), false);
    assert.equal(missingOut.get("stale"), true);

    const noSteerStore = new SignalStore();
    noSteerStore.set(SIGNAL_PATHS.VEHICLES_EGO_POSE, SAMPLE_POSE);
    noSteerStore.set(SIGNAL_PATHS.VEHICLES_EGO_VELOCITY, SAMPLE_VELOCITY);
    const noSteer = signalAdapter(VehicleStateBlock, noSteerStore, { actorId: "" });
    assert.equal(noSteer.execute().get("exists"), true);
    assert.equal(noSteer.execute().get("stale"), false);
    assert.equal(noSteer.execute().get("steering"), 0);

    const legacyStore = new SignalStore();
    legacyStore.set(SIGNAL_PATHS.VEHICLE_EGO_POSE, SAMPLE_POSE);
    legacyStore.set(SIGNAL_PATHS.VEHICLE_EGO_VELOCITY, SAMPLE_VELOCITY);
    legacyStore.set("vehicle.ego.steeringAngle", -0.1);
    const legacy = signalAdapter(VehicleStateBlock, legacyStore, { actorId: "ego" });
    assert.deepEqual(legacy.execute().get("pose"), SAMPLE_POSE);
    assert.equal(legacy.execute().get("steering"), -0.1);
    assert.equal(legacy.execute().get("exists"), true);

    const invalid = signalAdapter(VehicleStateBlock, store, { actorId: "ego.nested" });
    assert.equal(invalid.execute().get("exists"), false);

    const deviceStore = new SignalStore();
    deviceStore.set("devices.front_camera.pose", SAMPLE_POSE);
    deviceStore.set("devices.front_camera.enabled", true);
    const device = signalAdapter(SIMULATOR_ADAPTER_BLOCKS.DeviceStateBlock, deviceStore, { deviceId: "front_camera" });
    assert.deepEqual(device.execute().get("pose"), SAMPLE_POSE);
    assert.equal(device.execute().get("enabled"), true);
    assert.equal(device.execute().get("exists"), true);
    const noEnabledStore = new SignalStore();
    noEnabledStore.set("devices.front_camera.pose", SAMPLE_POSE);
    const noEnabled = signalAdapter(SIMULATOR_ADAPTER_BLOCKS.DeviceStateBlock, noEnabledStore, { deviceId: "front_camera" });
    assert.equal(noEnabled.execute().get("exists"), true);
    assert.equal(noEnabled.execute().get("enabled"), false);
    assert.equal(noEnabled.execute().get("stale"), false);

    const blobStore = new SignalStore();
    blobStore.set(SIGNAL_PATHS.SIMULATION, { dt: 0.02, time: 1.5, step: 7, frame: 7 });
    const blobClock = signalAdapter(SimulationClockBlock, blobStore);
    assert.equal(blobClock.execute().get("time"), 1.5);
    assert.equal(blobClock.execute().get("dt"), 0.02);
    assert.equal(blobClock.execute().get("step"), 7);
    assert.equal(blobClock.execute().get("status"), "");

    const leafStore = new SignalStore();
    leafStore.set(SIGNAL_PATHS.SIMULATION_TIME, 4);
    leafStore.set(SIGNAL_PATHS.SIMULATION_FIXED_DT, 0.05);
    leafStore.set(SIGNAL_PATHS.SIMULATION_STEP, 9);
    leafStore.set(SIGNAL_PATHS.SIMULATION_STATUS, "running");
    const leafClock = signalAdapter(SimulationClockBlock, leafStore);
    assert.equal(leafClock.execute().get("time"), 4);
    assert.equal(leafClock.execute().get("dt"), 0.05);
    assert.equal(leafClock.execute().get("step"), 9);
    assert.equal(leafClock.execute().get("status"), "running");

    const bothStore = new SignalStore();
    bothStore.set(SIGNAL_PATHS.SIMULATION, { dt: 0.01, time: 99, step: 1, frame: 1 });
    bothStore.set(SIGNAL_PATHS.SIMULATION_TIME, 8);
    bothStore.set(SIGNAL_PATHS.SIMULATION_FIXED_DT, 0.5);
    bothStore.set(SIGNAL_PATHS.SIMULATION_STEP, 12);
    bothStore.set(SIGNAL_PATHS.SIMULATION_STATUS, "paused");
    const bothClock = signalAdapter(SimulationClockBlock, bothStore);
    assert.equal(bothClock.execute().get("time"), 8);
    assert.equal(bothClock.execute().get("dt"), 0.01);
    assert.equal(bothClock.execute().get("step"), 12);
    assert.equal(bothClock.execute().get("status"), "paused");

    const scenarioStore = new SignalStore();
    const terminal = { status: "success", reason: "goal" };
    const trigger = { id: "t1", kind: "timeout" };
    scenarioStore.set(SIGNAL_PATHS.SCENARIO_STATUS, "running");
    scenarioStore.set(SIGNAL_PATHS.SCENARIO_TERMINAL, terminal);
    scenarioStore.set(SIGNAL_PATHS.SCENARIO_LATEST_TRIGGER, trigger);
    const scenario = signalAdapter(SIMULATOR_ADAPTER_BLOCKS.ScenarioStatusBlock, scenarioStore);
    const scenarioOut = scenario.execute();
    assert.equal(scenarioOut.get("status"), "running");
    assert.deepEqual(scenarioOut.get("terminal"), terminal);
    scenarioOut.get("terminal").reason = "mutated";
    assert.deepEqual(scenarioStore.read(SIGNAL_PATHS.SCENARIO_TERMINAL).value, terminal);
    const emptyScenario = signalAdapter(SIMULATOR_ADAPTER_BLOCKS.ScenarioStatusBlock, new SignalStore());
    assert.equal(emptyScenario.execute().get("status"), "");
    assert.equal(emptyScenario.execute().get("terminal"), null);
});

test("simulation clock and scale texture compile to v3 and match editor execution", () => {
    ensureBuiltIns();

    const store = new SignalStore();
    store.set(SIGNAL_PATHS.SIMULATION, { dt: 0.02, time: 1, step: 5, frame: 5 });
    const clockManager = withHead("float64");
    clockManager.setSignalStore(store);
    clockManager.addUnit(new SimulationClockBlock("clock"));
    connect(clockManager, "clock", "dt", "head", "output");
    const editor = clockManager.executeProgram();
    assert.equal(editor.status, "success", editor.e?.message);
    assert.equal(editor.outputs.result, 0.02);
    const clockArtifact = clockManager.compile("clock");
    assert.equal(clockArtifact.nodes.find((node) => node.uuid === "clock").ports.outputs.dt, "float64");
    const compiledClock = ScriptManager.createRunner(clockArtifact, { signalStore: store }).run();
    assert.equal(compiledClock.status, "success", compiledClock.e?.message);
    assert.equal(compiledClock.outputs.result, 0.02);

    const texManager = withHead("tex1d");
    const texId = addProgramInput(texManager, "tex", "tex1d", "[1,2,3]");
    texManager.addUnit(new NumberUnitClass("scalar"));
    texManager.addUnit(new ScaleTextureBlock("op"));
    texManager.storeData("scalar", 2);
    connect(texManager, texId, "input", "op", "tex");
    connect(texManager, "scalar", "number", "op", "scalar");
    connect(texManager, "op", "out", "head", "output");
    const scaled = compileAndRun(texManager, "scale-texture");
    assert.deepEqual(scaled.editor.outputs.result, [2, 4, 6]);
    assert.deepEqual(scaled.compiled.outputs.result, [2, 4, 6]);
});

const NORTH_ROUTE = {
    waypoints: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 10 },
    ],
};

const NORTH_ROAD_WORLD = {
    roads: {
        nodes: [
            { id: "n0", x: 0, y: 0, z: 0 },
            { id: "n1", x: 0, y: 0, z: 10 },
        ],
        edges: [{ id: "e0", startNodeId: "n0", endNodeId: "n1" }],
    },
};

const ORIGIN_POSE = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
};

test("repeat program exposes count plus last-iteration ports", () => {
    const ports = repeatProgramPorts();
    assert.deepEqual(typeMapFromPorts(ports), {
        inputs: { count: "int32" },
        outputs: { then: UNIT_TYPE, count: "int32" },
    });
    const block = new RepeatProgramBlock("repeat");
    assert.deepEqual(block.typeMap, typeMapFromPorts(ports));
});

test("path frame spawn scatter and sample-road blocks execute", () => {
    const frame = configuredBlock(WORLD_BLOCKS.FrameAlongPathBlock, {
        route: NORTH_ROUTE,
        percent: 0.5,
        lateral: 1,
    }).execute();
    assert.equal(frame.get("found"), true);
    assert.ok(Math.abs(frame.get("pose").position.x + 1) < 1e-9);
    assert.ok(Math.abs(frame.get("pose").position.z - 5) < 1e-9);
    assert.equal(frame.get("pose").rotation.y, 0);

    const missing = configuredBlock(WORLD_BLOCKS.FrameAlongPathBlock, {
        route: { waypoints: [] },
        percent: 0.5,
        lateral: 0,
    }).execute();
    assert.equal(missing.get("found"), false);
    assert.deepEqual(missing.get("pose"), ORIGIN_POSE);

    const road = configuredBlock(WORLD_BLOCKS.SampleRoadBlock, {
        edgeId: "e0",
        percent: 0.5,
        lateral: 1,
    }, { runtimeContext: { world: NORTH_ROAD_WORLD } }).execute();
    assert.equal(road.get("found"), true);
    assert.ok(Math.abs(road.get("pose").position.x + 1) < 1e-9);
    assert.ok(Math.abs(road.get("pose").position.z - 5) < 1e-9);

    const unknownRoad = configuredBlock(WORLD_BLOCKS.SampleRoadBlock, {
        edgeId: "missing",
        percent: 0,
        lateral: 0,
    }, { runtimeContext: { world: NORTH_ROAD_WORLD } }).execute();
    assert.equal(unknownRoad.get("found"), false);

    const noWorld = configuredBlock(WORLD_BLOCKS.SampleRoadBlock, {
        edgeId: "e0",
        percent: 0,
        lateral: 0,
    }).execute();
    assert.equal(noWorld.get("found"), false);

    const nearest = configuredBlock(WORLD_BLOCKS.GetNearestRoadBlock, {
        pose: { position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    }, { runtimeContext: { world: NORTH_ROAD_WORLD } }).execute();
    assert.equal(nearest.get("found"), true);
    assert.equal(nearest.get("edgeId"), "e0");
    assert.ok(nearest.get("distance") < 1e-9);

    const far = configuredBlock(WORLD_BLOCKS.GetNearestRoadBlock, {
        pose: { position: { x: 40, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    }, { runtimeContext: { world: NORTH_ROAD_WORLD } }).execute();
    assert.equal(far.get("found"), true);
    assert.equal(far.get("edgeId"), "e0");

    const missingWorld = configuredBlock(WORLD_BLOCKS.GetNearestRoadBlock, {
        pose: ORIGIN_POSE,
    }).execute();
    assert.equal(missingWorld.get("found"), false);
    assert.equal(missingWorld.get("edgeId"), "");

    assert.throws(
        () => configuredBlock(WORLD_BLOCKS.SpawnPropBlock, {
            assetId: "barrel",
            pose: ORIGIN_POSE,
        }).execute(),
        { message: SPAWN_PROP_OVERLAY_ERROR },
    );

    const overlay = new EpisodeOverlay();
    const spawned = configuredBlock(WORLD_BLOCKS.SpawnPropBlock, {
        assetId: "barrel",
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0.25, z: 0, order: "XYZ" } },
    }, {
        runtimeContext: {
            scriptId: "s",
            spawnProp: (spec) => overlay.upsert({ ...spec, scriptId: spec.scriptId ?? "s" }),
        },
    }).execute();
    assert.equal(spawned.get("ok"), true);
    assert.equal(spawned.get("then"), UNIT);
    assert.equal(spawned.get("id"), "episode:s:0");
    assert.equal(overlay.size, 1);

    const upserted = configuredBlock(WORLD_BLOCKS.SpawnPropBlock, {
        assetId: "cone",
        pose: ORIGIN_POSE,
        id: "named",
    }, {
        runtimeContext: {
            scriptId: "s",
            spawnProp: (spec) => overlay.upsert({ ...spec, scriptId: spec.scriptId ?? "s" }),
        },
    }).execute();
    assert.equal(upserted.get("id"), "episode:named");
    assert.equal(overlay.size, 2);

    assert.throws(
        () => configuredBlock(WORLD_BLOCKS.ScatterFeaturesBlock, {
            count: 1,
            sideOffset: 1,
            centerProbability: 0,
            alongJitter: 0,
            lateralJitter: 0,
            assetId: "barrel",
        }, {
            runtimeContext: {
                spawnProp: () => "episode:s:0",
            },
        }).execute(),
        { message: SCATTER_SOURCE_ERROR },
    );

    assert.throws(
        () => configuredBlock(WORLD_BLOCKS.ScatterFeaturesBlock, {
            route: NORTH_ROUTE,
            edgeId: "e0",
            count: 1,
            sideOffset: 1,
            centerProbability: 0,
            alongJitter: 0,
            lateralJitter: 0,
            assetId: "barrel",
        }, {
            runtimeContext: {
                world: NORTH_ROAD_WORLD,
                spawnProp: () => "episode:s:0",
            },
        }).execute(),
        { message: SCATTER_SOURCE_ERROR },
    );

    const scatterOverlay = new EpisodeOverlay();
    const scatter = configuredBlock(WORLD_BLOCKS.ScatterFeaturesBlock, {
        route: NORTH_ROUTE,
        count: 2,
        sideOffset: 2,
        centerProbability: 0,
        alongJitter: 0,
        lateralJitter: 0,
        assetId: "barrel",
    }, {
        runtimeContext: {
            scriptId: "s",
            spawnProp: (spec) => scatterOverlay.upsert({ ...spec, scriptId: spec.scriptId ?? "s" }),
        },
    }).execute();
    assert.equal(scatter.get("count"), 2);
    assert.deepEqual(scatter.get("ids"), ["episode:s:0", "episode:s:1"]);
    const poses = scatterOverlay.snapshot().map((record) => record.pose.position);
    assert.ok(poses.every((position) => Math.abs(position.x - 2) < 1e-6));
    assert.ok(Math.abs(poses[0].z) < 1e-6);
    assert.ok(Math.abs(poses[1].z - 10) < 1e-6);
});

test("texture import emits stored texture ids", () => {
    const empty = configuredBlock(TextureImportBlock, {}, { storedData: "" });
    assert.equal(empty.execute().get("out"), "");
    const hashed = configuredBlock(TextureImportBlock, {}, { storedData: "  abc123  " });
    assert.equal(hashed.execute().get("out"), "abc123");
});

test("log message prints and sequences then", () => {
    const logged = [];
    const original = console.log;
    console.log = (...args) => logged.push(args);
    try {
        const output = configuredBlock(LogMessageBlock, { message: "hello" }, {
            state: { label: "test" },
        }).execute();
        assert.equal(output.get("then"), UNIT);
        assert.deepEqual(logged[0], ["[visual-script:test]", "hello"]);
    } finally {
        console.log = original;
    }
});

