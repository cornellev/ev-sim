import express from "express";

export function createZenohBrowserRouter({ config = null, error = null } = {}) {
    const router = express.Router();
    router.get("/browser-config", (_req, res) => {
        res.set("Cache-Control", "no-store");
        if (error) return res.status(503).json({ error: error.message, code: "ZENOH_CONFIG_INVALID" });
        return res.json(config);
    });
    return router;
}
