import express from "express";
import { storageEvents } from "../mcp/events.js";

/**
 * Builds the Express router mounted at `/api/storage`.
 *
 * This layer is intentionally thin: it only translates HTTP requests into
 * StorageService calls and serializes the results back as JSON. All storage
 * behavior (caching, atomic writes, on-disk layout) lives in StorageService.
 *
 * @param {import("../storage/StorageService.js").StorageService} service
 */
export function createStorageRouter(service) {
    const router = express.Router();

    // --- Environments ---
    router.get("/environments", handle(async () => service.listEnvironments()));
    router.post("/environments", handle(async (req) => service.createEnvironment(req.body ?? {})));
    router.post("/environments/:id/duplicate", handle(async (req) => (
        service.duplicateEnvironment(req.params.id, req.body ?? {})
    )));
    router.patch("/environments/:id", handle(async (req) => (
        service.renameEnvironment(req.params.id, req.body?.name)
    )));
    router.delete("/environments/:id", handle(async (req) => service.deleteEnvironment(req.params.id)));
    router.get("/environments/:id", handle(async (req) => service.getEnvironment(req.params.id)));
    router.put("/environments/:id", handle(async (req) => service.putEnvironment(req.params.id, req.body)));

    // --- Scripts ---
    router.get("/scripts", handle(async () => service.listScripts()));
    router.get("/scripts/:id", handle(async (req) => service.getScript(req.params.id)));
    router.put("/scripts/:id", handle(async (req) => service.putScript(req.body)));
    router.delete("/scripts/:id", handle(async (req) => service.deleteScript(req.params.id)));

    // --- Bindings ---
    router.get("/bindings", handle(async () => service.getBindings()));
    router.put("/bindings", handle(async (req) => service.putBindings(req.body)));

    // --- Settings ---
    router.get("/settings/:key", handle(async (req) => ({ value: await service.getSetting(req.params.key) })));
    router.put("/settings/:key", handle(async (req) => ({ value: await service.putSetting(req.params.key, req.body?.value) })));

    // --- MCP live-sync SSE (MCP-originated changes only) ---
    router.get("/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        res.write(": connected\n\n");

        const onChange = (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        storageEvents.on("change", onChange);

        const heartbeat = setInterval(() => {
            res.write(": heartbeat\n\n");
        }, 25000);

        req.on("close", () => {
            clearInterval(heartbeat);
            storageEvents.off("change", onChange);
        });
    });

    return router;
}

/**
 * Wrap an async handler so it always responds with JSON and forwards errors as
 * a 500 with a readable message instead of crashing the request.
 */
function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req);
            res.json(result ?? null);
        } catch (error) {
            console.error(`[storage] ${req.method} ${req.originalUrl} failed:`, error);
            res.status(400).json({ error: error.message });
        }
    };
}
