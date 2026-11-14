import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";
import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { PluginRunSession, PLG03_RUNTIME_CAPABILITIES } from "../app/plugin/PluginRunSession.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { PluginTopicRuntime } from "../app/plugin/PluginTopicRuntime.js";
import { createPluginSensorTypeDefinition } from "../app/plugin/PluginSensorContract.js";

test("native plugin topics require ABI 2 and publish the declared contract", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-native-plugin-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const abi of [1, 2]) {
        const resource = await pluginFixtureResource({ fixture: "acme.topics", mutateDocument(document) { if (abi === 2) document.topicAbi = 2; }, mutateFiles(files) {
            files["runtime/index.js"] = new TextEncoder().encode(new TextDecoder().decode(files["runtime/index.js"]).replace('typeStr: "std_msgs/Float64"', 'valueContract: { id: "cev.scalar-f64", version: 1 }'));
        } });
        const document = verifyPluginPackage(resource).document;
        const store = new PluginStore(root);
        await store.putPackage(resource);
        const session = await new PluginRunSession({ moduleSource: new NodePluginModuleSource({ pluginStore: store }), plugins: [{ pluginId: document.id, version: document.version, packageHash: resource.packageHash, runtimeHash: resource.runtimeHash, capabilities: document.capabilities }], availableCapabilities: PLG03_RUNTIME_CAPABILITIES }).prepareDefinitions([resource]);
        t.after(() => session.dispose());
        const valueContract = { id: "cev.scalar-f64", version: 1 };
        const topics = ["in", "out"].map((suffix) => ({ id: `plugin-${suffix}`, name: `/plugin-${suffix}`, direction: suffix === "in" ? "input" : "output", producer: suffix === "in" ? "candidate" : "simulator", valueContract }));
        const packets = [];
        const router = new TopicContractRouter({ id: "run", version: 13, topics }, { publicationPort: (packet) => { packets.push(packet); return true; } });
        if (abi === 1) { assert.throws(() => session.bindServices({ topicRouter: router }), /topicAbi 2/); continue; }
        session.bindServices({ topicRouter: router, clock: () => ({ step: 1, timeNs: 10 }) });
        session.prepareInstances();
        assert.equal(router.routeInbound({ name: "plugin-in", valueContract, value: 4 }, { applyStep: 1, applyTimeNs: 10 }).ok, true);
        session.deliverTopics({ step: 1, timeNs: 10 });
        session.dispatchSystems(0.01, { step: 1, timeNs: 10 });
        assert.equal(packets.length, 1);
        assert.equal(packets[0].value, 4);
        assert.deepEqual(packets[0].valueContract, valueContract);
    }
});

test("ABI 2 range-image products stay native and topic queues keep heavy/control restrictions", async () => {
    const resource = await pluginFixtureResource({ fixture: "test.range-image-fixture", mutateDocument(document) {
        document.sensorTypes[0].sensorAbi = 2;
        for (const product of document.sensorTypes[0].products) if (product.kind === "pointCloud") { delete product.rosType; product.valueContract = { id: "cev.points", version: 1 }; }
    } });
    const descriptor = verifyPluginPackage(resource).document.sensorTypes[0];
    const definition = createPluginSensorTypeDefinition(descriptor, {});
    assert.equal(Object.hasOwn(definition.run.normalize(), "schema"), false);
    assert.deepEqual(definition.run.outputs[0].valueContract, { id: "cev.points", version: 1 });
    const topics = new PluginTopicRuntime();
    for (const id of ["cev.points", "cev.semantic-points", "cev.image", "cev.control-command"]) assert.throws(() => topics.subscribe({ pluginId: "test", systemId: "test", topic: { id: "in", name: "/in", valueContract: { id, version: 1 } }, onMessage() {} }), /heavy|control/);
});
