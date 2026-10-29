import express from "express";
import { jsonHandler } from "./jsonHandler.js";

export function createBrowserSimRouter(service) {
    const router = express.Router();
    const handle = (fn) => jsonHandler(fn, { logPrefix: "browser-sim" });
    const token = (req) => req.get("X-CEV-Browser-Token");
    router.use((_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
    });
    router.get("/browsers", handle(() => service.list()));
    router.get("/status", handle((req) => service.status(req.query.browserId)));
    router.post("/commands", (req, res, next) => {
        try { res.status(202).json(service.submit(req.body)); }
        catch (error) { next(error); }
    });
    router.get("/commands/:commandId", handle((req) => service.get(req.params.commandId)));
    router.post("/bridge/register", handle((req) => service.register(req.body)));
    router.post("/bridge/:browserId/heartbeat", handle((req) => service.heartbeat(req.params.browserId, token(req), req.body)));
    router.delete("/bridge/:browserId", handle((req) => service.unregister(req.params.browserId, token(req))));
    router.post("/bridge/:browserId/commands/:commandId/claim", handle((req) => service.claim(req.params.browserId, token(req), req.params.commandId, req.body)));
    router.post("/bridge/:browserId/commands/:commandId/complete", handle((req) => service.complete(req.params.browserId, token(req), req.params.commandId, req.body)));
    router.use((error, _req, res, _next) => {
        res.status(error.statusCode || 400).json({ code: error.code ?? "INVALID_REQUEST", error: error.message });
    });
    return router;
}
