import express from "express";
import { storageEvents } from "../mcp/events.js";
import { protobufStorageError } from "../storage/StorageErrors.js";
import { PROTOBUF_IMPORT_JSON_BYTES } from "../storage/ProtobufInterfaceStore.js";
import { jsonHandler } from "./jsonHandler.js";

function uploaded(source) {
    if (source && (source.kind === "local-proto" || source.filePath !== undefined)) {
        throw protobufStorageError("PROTOBUF_INVALID", "HTTP imports require uploaded bytes or a public GitHub reference; filesystem imports use MCP.");
    }
}

export function createProtobufInterfaceRouter(service) {
    const router = express.Router();
    router.use(express.json({ limit: PROTOBUF_IMPORT_JSON_BYTES }));
    const handle = (fn, action) => jsonHandler(async (req) => {
        const result = await fn(req);
        if (action && !result.unchanged) storageEvents.publish({ domain: "protobuf-interface", id: result.source?.id ?? result.sourceId ?? null,
            action, data: { hash: result.hash ?? result.candidateHash, revision: result.source?.revision ?? result.revision } });
        return result;
    }, { logPrefix: "protobuf-storage", quietCodes: ["PROTOBUF_NOT_FOUND", "PROTOBUF_REVISION_CONFLICT", "PROTOBUF_INVALIDATION_ACCEPTANCE_REQUIRED"] });
    const required = (value) => {
        if (!value) throw protobufStorageError("PROTOBUF_NOT_FOUND", "Protobuf resource was not found.");
        return value;
    };
    router.get("/", handle(() => service.listProtobufInterfaces()));
    router.post("/", handle((req) => service.putProtobufInterface(req.body?.document, {
        sourceId: req.body?.sourceId, expectedRevision: req.body?.expectedRevision,
    }), "saved"));
    router.get("/sha256/:hash", handle(async (req) => required(await service.getProtobufInterface(req.params.hash))));
    router.get("/sources/:id", handle(async (req) => required(await service.getProtobufInterfaceSource(req.params.id))));
    router.post("/import-sources", handle((req) => {
        uploaded(req.body?.source);
        return service.importProtobufSources(req.body, { signal: req.signal });
    }, "imported"));
    router.post("/import-descriptor", handle((req) => {
        uploaded(req.body?.source);
        return service.importProtobufDescriptor(req.body, { signal: req.signal });
    }, "imported"));
    router.post("/sources/:id/check-update", handle((req) => {
        uploaded(req.body?.source);
        return service.checkProtobufInterfaceUpdate(req.params.id, req.body, { signal: req.signal });
    }, "checked"));
    router.post("/sources/:id/apply-update", handle((req) => service.applyProtobufInterfaceUpdate(req.params.id, req.body), "updated"));
    router.use((error, _req, res, _next) => {
        const oversized = error.type === "entity.too.large";
        res.status(oversized ? 413 : 400).json({ error: oversized ? "Protobuf request exceeds 16 MiB." : "Invalid protobuf JSON request.",
            code: oversized ? "PROTOBUF_TOO_LARGE" : "PROTOBUF_INVALID" });
    });
    return router;
}
