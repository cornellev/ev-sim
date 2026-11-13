import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { StorageService } from "../server/storage/StorageService.js";
import { createSensorFusionMcpServer } from "../server/mcp/createMcpRouter.js";
import { registerProtobufInterfaceTools } from "../server/mcp/protobufInterfaceTools.js";
import { importInput, protoV1, protoV2, temporaryStore } from "./helpers/protobufFixtures.js";

test("ZPB-02 MCP imports local files, previews diagnostics, applies and repairs a tracked document", async (t) => {
    const { directory } = await temporaryStore(t);
    const storage = new StorageService(directory);
    const tools = new Map();
    registerProtobufInterfaceTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } }, storage);
    assert.equal(tools.size, 8);
    const invoke = async (name, input) => {
        const tool = tools.get(name);
        const parsed = await tool.handler(input);
        return { ...parsed, value: JSON.parse(parsed.content[0].text) };
    };
    const file = path.join(directory, "sample.proto");
    await writeFile(file, protoV1);
    const original = await invoke("protobuf_interface_import_sources", importInput({ kind: "local-proto", entryFiles: [file] }));
    assert.equal(original.isError, undefined);
    await writeFile(file, protoV2);
    const check = await invoke("protobuf_interface_check_update", { sourceId: "autonomy", schemaId: "main", expectedRevision: 1 });
    assert.equal(check.value.invalidatedRoutes.length, 2);
    const request = { sourceId: "autonomy", checkId: check.value.checkId, expectedRevision: check.value.revision };
    const refused = await invoke("protobuf_interface_apply_update", request);
    assert.equal(refused.isError, true);
    assert.equal(refused.value.code, "PROTOBUF_INVALIDATION_ACCEPTANCE_REQUIRED");
    assert.equal(refused.value.issues.length, 3);
    const applied = await invoke("protobuf_interface_apply_update", { ...request, acceptInvalidations: true });
    assert.equal(applied.value.document.routes.length, 1);
    const jsonFile = path.join(directory, "interface.json");
    await writeFile(jsonFile, JSON.stringify(applied.value.document));
    const published = await invoke("protobuf_interface_put", { filePath: jsonFile });
    assert.equal(published.value.hash, applied.value.hash);
    assert.deepEqual((await invoke("protobuf_interface_get", { hash: original.value.hash })).value, original.value.document);
    assert.equal((await invoke("protobuf_interface_get_source", { sourceId: "autonomy" })).value.invalidatedRoutes.length, 2);
    assert.equal((await invoke("protobuf_interface_list", {})).value.interfaces.length, 2);
    assert.equal((await invoke("protobuf_interface_get", { hash: "0".repeat(64) })).value.code, "PROTOBUF_NOT_FOUND");
});

test("ZPB-02 tools register on the actual MCP server with bounded input schemas", async (t) => {
    const { directory } = await temporaryStore(t);
    const server = createSensorFusionMcpServer(new StorageService(directory), {});
    t.after(() => server.close());
    assert.ok(server._registeredTools.protobuf_interface_check_update);
    assert.ok(server._registeredTools.protobuf_interface_import_descriptor);
    const tools = new Map();
    registerProtobufInterfaceTools({ registerTool(name, definition) { tools.set(name, definition); } }, {});
    const schema = tools.get("protobuf_interface_import_sources").inputSchema.source;
    assert.equal(schema.safeParse({ kind: "github", url: "https://github.com/acme/repo", token: "secret" }).success, false);
    assert.equal(schema.safeParse({ kind: "local-proto", entryFiles: Array(129).fill("x") }).success, false);
});
