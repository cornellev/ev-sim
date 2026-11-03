import express from "express";
import { jsonHandler } from "./jsonHandler.js";

const STATUS = {
    ENVIRONMENT_NOT_FOUND: 404,
    RESOURCE_LIMIT: 429,
    ARTIFACT_FAILURE: 502,
    WORKER_CRASHED: 502,
};

export function createBrowserPacketRouter(relay, { maxFrameBytes = "8mb" } = {}) {
    const router = express.Router();
    const handle = (fn) => jsonHandler(fn, {
        logPrefix: "browser-packets",
        statusOf: (error) => STATUS[error.code] ?? 400,
        bodyOf: (error) => ({ error: error.message, code: error.code ?? "INVALID_REQUEST" }),
    });
    router.use((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    });
    router.get("/host", handle(() => relay.hostDescriptor()));
    router.post("/sessions", express.json(), handle((req) => relay.open(req.body ?? {})));
    router.post(
        "/sessions/:sessionId/batches",
        express.raw({ type: "application/octet-stream", limit: maxFrameBytes }),
        handle((req) => relay.submit(req.params.sessionId, req.body)),
    );
    router.delete("/sessions/:sessionId", handle((req) => relay.close(req.params.sessionId)));
    return router;
}
