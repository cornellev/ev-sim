import path from "node:path";

import { expect, test } from "@playwright/test";

import { BrowserPluginModuleSource } from "../../app/plugin/browser/BrowserPluginModuleSource.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";

let resource;
let sensorResource;
let store;

test.beforeAll(async () => {
    resource = await pluginFixtureResource();
    sensorResource = await pluginFixtureResource({ fixture: "test.range-image-fixture" });
    store = new PluginStore(path.resolve(".playwright-data/storage"));
    await Promise.all([store.putPackage(resource), store.putPackage(sensorResource)]);
});

test("verified browser module source registers and executes a range-image sensor factory", async ({ page }) => {
    const verified = verifyPluginPackage(sensorResource);
    const moduleSource = new BrowserPluginModuleSource();
    const runtimeUrl = moduleSource.runtimeUrl(verified);
    const descriptor = verified.document.sensorTypes[0];
    await page.goto(`/api/storage/plugins/packages/${sensorResource.packageHash}`);
    const result = await page.evaluate(async ({ url, sensorDescriptor }) => {
        const namespace = await import(url);
        const contributions = [];
        namespace.default.register({
            contributeSensorType(definition) { contributions.push(definition); },
        });
        const instance = contributions[0].create();
        const calibration = {
            scanLayout: sensorDescriptor.defaults.scanLayout,
            parameters: { measurementScale: 1, statusEvery: 2 },
            products: { points: true, packets: true },
        };
        instance.prepare({ calibration, helpers: Object.freeze({ sensorAbi: 1, family: "range-image" }) });
        instance.reset({ resetSeed: "0", sensorId: "fixture" });
        const captured = instance.captureAt({
            buffer: new Float32Array(3 * 4 * 4),
            calibration,
            captureTimeNs: 100,
            sampleIndex: 0,
            scanDurationNs: 2_000,
            rng: Object.freeze({ next: () => 0.5, range: () => 0, int: () => 0, intRange: () => 0 }),
            sampling: Object.freeze({
                buildPointCloud2: () => ({ marker: "point-cloud" }),
                buildObservation: () => ({ marker: "observation" }),
            }),
        });
        const state = instance.getDeterministicState();
        const finalized = instance.finalize();
        instance.dispose();
        return {
            type: contributions[0].type,
            messageProducts: captured.messages.map((entry) => entry.productId),
            observation: captured.observation.marker,
            state,
            finalized,
        };
    }, { url: runtimeUrl, sensorDescriptor: descriptor });
    expect(result).toEqual({
        type: "test.range-image-fixture.synthetic-3x4",
        messageProducts: ["points", "packets", "packets"],
        observation: "observation",
        state: { sequence: 1, prepared: true },
        finalized: { sequence: 1 },
    });
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
