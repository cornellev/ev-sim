import path from "node:path";

import { expect, test } from "@playwright/test";

import { BrowserPluginModuleSource } from "../../app/plugin/browser/BrowserPluginModuleSource.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";

let resource;
let store;

test.beforeAll(async () => {
    resource = await pluginFixtureResource();
    store = new PluginStore(path.resolve(".playwright-data/storage"));
    await store.putPackage(resource);
});

test("verified browser module source loads runtime closure without evaluating UI", async ({ page }) => {
    const verified = verifyPluginPackage(resource);
    const moduleSource = new BrowserPluginModuleSource();
    const runtimeUrl = moduleSource.runtimeUrl(verified);
    await page.goto(`/api/storage/plugins/packages/${resource.packageHash}`);
    const result = await page.evaluate(async (url) => {
        const namespace = await import(url);
        const contributions = [];
        class UnitBlock {
            constructor() { this.state = { factor: 2 }; this.inputs = {}; this.outputs = {}; }
            registerInput(label, type) { this.inputs[label] = type; }
            registerOutput(label, type) { this.outputs[label] = type; }
            hasInput(label) { return label === "value"; }
            getInput(label) { if (label === "value") return 3; throw new Error("missing input"); }
        }
        class BlockOutput {
            constructor() { this.map = {}; }
            set(label, value) { this.map[label] = value; return this; }
        }
        namespace.default.register({
            UnitBlock,
            BlockOutput,
            contributeUnit(definition) { contributions.push(definition); },
        });
        const instance = new contributions[0].blockClass();
        instance.register();
        return {
            fixtureResult: namespace.fixtureResult(3),
            type: contributions[0].type,
            ports: { inputs: instance.inputs, outputs: instance.outputs },
            output: instance.execute().map,
        };
    }, runtimeUrl);
    expect(result).toEqual({
        fixtureResult: 6,
        type: "acme.example.ScaleBlock",
        ports: { inputs: { value: "float64" }, outputs: { result: "float64" } },
        output: { result: 6 },
    });
});
