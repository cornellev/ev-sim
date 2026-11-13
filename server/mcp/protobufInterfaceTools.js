import { z } from "zod";
import { readProtobufFile } from "../interfaces/ProtobufSourceLoader.js";
import { PROTOBUF_IMPORT_JSON_BYTES } from "../storage/ProtobufInterfaceStore.js";
import { protobufStorageError } from "../storage/StorageErrors.js";
import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
const files = z.array(z.string().min(1).max(4096)).min(1).max(128);
const includeDirs = z.array(z.string().max(4096)).max(128).optional();
const protoSource = z.union([
    z.object({ kind: z.literal("local-proto"), entryFiles: files, includeDirs }).strict(),
    z.object({ kind: z.literal("github"), url: z.string().min(1).max(2048), ref: z.string().min(1).max(256).optional(), entryFiles: files.optional(), includeDirs }).strict(),
]);
const descriptorSource = z.object({ kind: z.literal("descriptor"), filePath: z.string().min(1).max(4096).optional(), descriptorBase64: z.string().max(933_336).optional() }).strict();
const jsonObject = z.record(z.string(), z.unknown());
const importSchema = { sourceId: id, schemaId: id, expectedRevision: revision.optional(), baseHash: hash.optional(),
    routes: z.array(jsonObject).max(64).optional(), bootstrap: z.array(jsonObject).max(64).optional() };

export function registerProtobufInterfaceTools(server, storage) {
    const register = (name, description, inputSchema, handler, action) => server.registerTool(name, {
        title: description, description, inputSchema,
    }, async (input) => {
        try {
            const result = await handler(input);
            if (result === null) throw protobufStorageError("PROTOBUF_NOT_FOUND", "Protobuf resource was not found.");
            if (action && !result.unchanged) storageEvents.publish({ domain: "protobuf-interface", id: result.source?.id ?? result.sourceId ?? null,
                action, data: { hash: result.hash ?? result.candidateHash, revision: result.source?.revision ?? result.revision } });
            return ok(result);
        } catch (error) { return fail(error, error.issues ? { issues: error.issues } : {}); }
    });
    register("protobuf_interface_list", "List immutable Protobuf interfaces and imported sources", {}, () => storage.listProtobufInterfaces());
    register("protobuf_interface_get", "Get a verified immutable Protobuf interface by SHA-256", { hash }, ({ hash }) => storage.getProtobufInterface(hash));
    register("protobuf_interface_get_source", "Get source pins, pending preview, and disabled route drafts", { sourceId: id }, ({ sourceId }) => storage.getProtobufInterfaceSource(sourceId));
    register("protobuf_interface_put", "Publish a valid interface; tracked routing repairs require expectedRevision", {
        document: jsonObject.optional(), filePath: z.string().min(1).max(4096).optional(), sourceId: id.optional(), expectedRevision: revision.optional(),
    }, async ({ document, filePath, sourceId, expectedRevision }) => {
        if ((document === undefined) === (filePath === undefined)) throw protobufStorageError("PROTOBUF_INVALID", "Select one interface document or JSON file.");
        const input = filePath === undefined ? document : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readProtobufFile(filePath, PROTOBUF_IMPORT_JSON_BYTES)));
        return storage.putProtobufInterface(input, { sourceId, expectedRevision });
    }, "saved");
    register("protobuf_interface_import_sources", "Import local proto3 files or a pinned public GitHub closure", { ...importSchema, source: protoSource }, (input) => storage.importProtobufSources(input), "imported");
    register("protobuf_interface_import_descriptor", "Import a binary FileDescriptorSet from a local file or exact base64 bytes", { ...importSchema, source: descriptorSource }, (input) => storage.importProtobufDescriptor(input), "imported");
    register("protobuf_interface_check_update", "Preview a schema update and list routes/bootstrap values that would be disabled", {
        sourceId: id, schemaId: id, expectedRevision: revision, source: z.union([protoSource, descriptorSource]).optional(),
    }, ({ sourceId, ...input }) => storage.checkProtobufInterfaceUpdate(sourceId, input), "checked");
    register("protobuf_interface_apply_update", "Apply the exact cached preview; acceptInvalidations explicitly accepts disabled drafts", {
        sourceId: id, checkId: z.string().min(1).max(128), expectedRevision: revision, acceptInvalidations: z.boolean().optional(),
    }, ({ sourceId, ...input }) => storage.applyProtobufInterfaceUpdate(sourceId, input), "updated");
}
