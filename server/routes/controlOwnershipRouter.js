import express from "express";

export function createControlOwnershipRouter(service) {
    const router = express.Router();
    router.use(express.json({ limit: "8kb" }));
    router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    const token = (req) => req.get("Authorization")?.replace(/^Bearer /, "");
    router.post("/", (req, res, next) => {
        try {
            if (!req.body || Object.keys(req.body).some((key) => !["target", "mode"].includes(key))) throw Object.assign(new Error("Unknown control ownership field."), { statusCode: 400, code: "CONTROL_LEASE_INVALID" });
            res.status(201).json(service.acquire(req.body));
        } catch (error) { next(error); }
    });
    router.get("/:leaseId", (req, res, next) => { try { res.json(service.status(req.params.leaseId)); } catch (error) { next(error); } });
    router.post("/:leaseId/renew", (req, res, next) => { try { res.json(service.renew(req.params.leaseId, token(req))); } catch (error) { next(error); } });
    router.delete("/:leaseId", (req, res, next) => { try { res.json(service.release(req.params.leaseId, token(req))); } catch (error) { next(error); } });
    router.use((error, _req, res, _next) => res.status(error.type === "entity.too.large" ? 413 : error.statusCode || 400).json({ code: error.code || "CONTROL_LEASE_INVALID", error: error.type ? "Invalid control ownership request." : error.message }));
    return router;
}
