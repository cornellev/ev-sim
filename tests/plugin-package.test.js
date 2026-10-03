import assert from "node:assert/strict";
import test from "node:test";

import { assertPluginCompatibility } from "../app/plugin/PluginDocument.js";
import { createPluginPackage, verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";

test("plugin hashes are stable across enumeration and isolate package/runtime/UI changes", async () => {
    const files = await pluginFixtureFiles();
    const forward = createPluginPackage(files);
    assert.deepEqual({
        packageHash: forward.packageHash,
        runtimeHash: forward.runtimeHash,
        uiHash: forward.uiHash,
    }, {
        packageHash: "5fb8ec8f4ac2176629414beaa938a48cfbe00d577e13edeae8c69806d0f0909d",
        runtimeHash: "42654d815b24b61dbf836d861b84c83a3be9c0193ed67ef5fc8b79a36cbff232",
        uiHash: "aae5470e2dbb18c3a70cd222d70aa83063fbda998b7636c8b84652ae0400823d",
    });
    const reverse = createPluginPackage(Object.fromEntries(Object.entries(files).reverse()));
    assert.deepEqual(reverse, forward);

    const document = JSON.parse(new TextDecoder().decode(files["plugin.json"]));
    const compact = createPluginPackage({ ...files, "plugin.json": JSON.stringify(document) });
    assert.notEqual(compact.packageHash, forward.packageHash);
    assert.equal(compact.runtimeHash, forward.runtimeHash);
    assert.equal(compact.uiHash, forward.uiHash);

    const uiEdit = await pluginFixtureResource({ fixture: "acme.example-ui-edit" });
    assert.notEqual(uiEdit.packageHash, forward.packageHash);
    assert.equal(uiEdit.runtimeHash, forward.runtimeHash);
    assert.notEqual(uiEdit.uiHash, forward.uiHash);

    const runtimeEdit = await pluginFixtureResource({ fixture: "acme.example-runtime-edit" });
    assert.notEqual(runtimeEdit.runtimeHash, forward.runtimeHash);
});

test("plugin verifier rejects import escapes, dynamic import, top-level await, bare and unused invalid modules", async () => {
    const files = await pluginFixtureFiles();
    for (const source of [
        "import x from 'external'; export default x;",
        "await Promise.resolve(); export default {};",
        "export const value = import('./shared/math.js');",
        "export { value } from '../../../escape.js';",
    ]) {
        assert.throws(() => createPluginPackage({ ...files, "runtime/index.js": source }), /import|await|module/i);
    }
    assert.throws(() => createPluginPackage({ ...files, "unused.js": "import value from 'bare';" }), /Unsupported import/);
    assert.throws(() => createPluginPackage({ ...files, "unused.cjs": "require('node:fs');" }), /Unsupported plugin module format/);
    assert.throws(() => createPluginPackage({ ...files, "Runtime/Index.js": "export default {};" }), /case-folding/);
});

test("plugin document and engine compatibility fail explicitly", async () => {
    const resource = await pluginFixtureResource();
    const verified = verifyPluginPackage(resource);
    assert.doesNotThrow(() => assertPluginCompatibility(verified.document, { pluginApi: 1, simulatorVersion: "0.1.0" }));
    assert.doesNotThrow(() => assertPluginCompatibility(verified.document, { pluginApi: 1, simulatorVersion: "0.2.0" }));
    assert.throws(() => assertPluginCompatibility(verified.document, { pluginApi: 1, simulatorVersion: "1.0.0" }), (error) => error.code === "PLUGIN_COMPATIBILITY");
    assert.throws(
        () => assertPluginCompatibility(
            { ...verified.document, engines: { cevSim: ">=0.1.0 <0.2.0" } },
            { pluginApi: 1, simulatorVersion: "0.2.0" },
        ),
        (error) => error.code === "PLUGIN_COMPATIBILITY",
    );
    await assert.rejects(async () => pluginFixtureResource({ mutateDocument: (document) => { document.id = "cev.forbidden"; } }), /reserved cev namespace/);
    await assert.rejects(async () => pluginFixtureResource({ mutateDocument: (document) => { document.units[0].type = "acme.exampleish.Block"; } }), /must start/);
    await assert.rejects(async () => pluginFixtureResource({ mutateDocument: (document) => { document.units[0].defaults.factor = "2"; } }), /finite number/);
    await assert.rejects(async () => pluginFixtureResource({ mutateDocument: (document) => { document.units[0].catalog.placeable = "yes"; } }), /must be a boolean/);
});

test("portable resources reject unknown metadata and non-canonical base64", async () => {
    const resource = await pluginFixtureResource();
    assert.throws(() => verifyPluginPackage({ ...resource, document: {} }), /unknown field/);
    const files = resource.files.map((entry, index) => index === 0 ? { ...entry, data: `${entry.data}\n` } : entry);
    assert.throws(() => verifyPluginPackage({ ...resource, files }), /byte verification/);
});
