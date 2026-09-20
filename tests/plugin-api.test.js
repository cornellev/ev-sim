import assert from "node:assert/strict";
import test from "node:test";

import { createRegistrationApi, ports } from "../app/plugin-api/index.js";
import { PLUGIN_UI_API_VERSION } from "../app/plugin-api/ui.js";
import { BlockOutput } from "../app/plugin-api/BlockOutput.js";
import { UnitBlock as PublicUnitBlock } from "../app/plugin-api/UnitBlock.js";
import { PLUGIN_PORT_TYPES } from "../app/plugin-api/ports.js";
import { SUPPORTED_TYPES } from "../app/scripting/units/program/ProgramTypes.js";
import { createPluginUnitAdapterClass } from "../app/scripting/PluginUnitAdapter.js";

const definition = {
    type: "acme.example.FixedBlock",
    ports: { inputs: {}, outputs: { result: "float64" } },
    settings: [{ target: "state", key: "value", valueType: "float64", default: 4 }],
    defaults: { value: 4 },
};
const ownership = { pluginId: "acme.example", version: "1.0.0", runtimeHash: "b".repeat(64) };

test("public API is frozen and tracks the concrete program port vocabulary", () => {
    const api = createRegistrationApi({ plugin: ownership, capabilities: [], contributeUnit() {}, contributeSystem() {} });
    assert.equal(Object.isFrozen(api), true);
    assert.equal(Object.isFrozen(api.plugin), true);
    assert.equal(Object.isFrozen(api.capabilities), true);
    assert.deepEqual(PLUGIN_PORT_TYPES, SUPPORTED_TYPES.filter((type) => type !== "generic"));
    assert.equal(ports.types.includes("generic"), false);
    assert.equal(PLUGIN_UI_API_VERSION, 1);
});

test("PluginUnitAdapter delegates state/output and revokes a disposed unit", () => {
    let disposed = 0;
    class FixedBlock extends PublicUnitBlock {
        register() { this.registerOutput("result", "float64"); }
        valid() { return true; }
        execute() { return new BlockOutput().set("result", this.state.value); }
        serializeRuntimeState() { return { count: 1 }; }
        dispose() { disposed += 1; }
    }
    const Adapter = createPluginUnitAdapterClass({ definition, blockClass: FixedBlock, ownership });
    const unit = new Adapter("fixed");
    assert.equal(unit.valid(), true);
    assert.equal(unit.execute().get("result"), 4);
    unit.hydrateState({ value: 7 });
    assert.deepEqual(unit.serializeState(), { value: 7 });
    assert.deepEqual(unit.serializeRuntimeState(), { count: 1 });
    unit.dispose();
    unit.dispose();
    assert.equal(disposed, 1);
    assert.throws(() => unit.execute(), /disposed/);
});

test("adapter rejects asynchronous hooks and undeclared outputs", async () => {
    class AsyncBlock extends PublicUnitBlock {
        register() { this.registerOutput("result", "float64"); }
        valid() { return true; }
        async execute() { return new BlockOutput().set("result", 1); }
    }
    const AsyncAdapter = createPluginUnitAdapterClass({ definition, blockClass: AsyncBlock, ownership });
    const asyncUnit = new AsyncAdapter("async");
    assert.throws(() => asyncUnit.execute(), (error) => error.code === "PLUGIN_ASYNC_HOOK");
    await Promise.resolve();

    class ExtraOutput extends PublicUnitBlock {
        register() { this.registerOutput("result", "float64"); }
        valid() { return true; }
        execute() { return new BlockOutput().set("other", 1); }
    }
    const ExtraAdapter = createPluginUnitAdapterClass({ definition, blockClass: ExtraOutput, ownership });
    assert.throws(() => new ExtraAdapter("extra").execute(), /undeclared output/);

    class WrongOutput extends PublicUnitBlock {
        register() { this.registerOutput("result", "float64"); }
        valid() { return true; }
        execute() { return new BlockOutput().set("result", "not a number"); }
    }
    const WrongAdapter = createPluginUnitAdapterClass({ definition, blockClass: WrongOutput, ownership });
    assert.throws(() => new WrongAdapter("wrong").execute(), (error) => error.code === "PLUGIN_STATE_INVALID");

    const extraState = new WrongAdapter("state");
    assert.throws(() => extraState.hydrateState({ unknown: 1 }), /no declared setting/);
});
