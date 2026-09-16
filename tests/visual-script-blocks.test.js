import assert from "node:assert/strict";
import test from "node:test";

import { ScriptManager } from "../app/scripting/ScriptManager.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SIGNAL_PATHS } from "../app/scripting/runtime/SignalPaths.js";
import { finiteFloat, finiteInt32, normalizeActorCommand } from "../app/scripting/types/PortTypes.js";
import { NumberUnitClass } from "../app/scripting/units/math/Number.block.js";
import { RandomNumberBlock } from "../app/scripting/units/math/Random.block.js";
import { RemapRangeBlock, WeightedSelectBlock } from "../app/scripting/units/math/Randomization.block.js";
import { LowPassFilterBlock, SensorFusionBlock } from "../app/scripting/units/math/SensorFlow.block.js";
import { TerrainNoiseBlock } from "../app/scripting/units/math/Terrain.block.js";
import { MultiplyTexBlock, ScaleBlock } from "../app/scripting/units/math/tex/Scale.block.js";
import { StringBlock } from "../app/scripting/units/objects/String.block.js";
import {
    VehiclePoseBlock,
    VehicleVelocityBlock,
} from "../app/scripting/units/signals/SignalBlocks.block.js";

function configuredBlock(BlockClass, values, options = {}) {
    const block = new BlockClass(options.uuid || "block");
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
