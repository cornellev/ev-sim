import express from "express";

import { compileGraph, listUnitCatalog } from "./scriptingHandlers.js";

export function createScriptingRouter(storage) {
    const router = express.Router();

    router.get("/units", async (_req, res) => {
        try {
            const catalog = await listUnitCatalog(storage);
            res.json(catalog);
        } catch (error) {
            res.status(500).json({
                ok: false,
                error: error?.message || String(error),
                units: [],
            });
        }
    });

    router.post("/compile", async (req, res) => {
        try {
            const graph = req.body?.graph;
            const name = req.body?.name || "compiled-program";
            const result = await compileGraph(storage, graph, name);
            res.json(result);
        } catch (error) {
            const status = error.status || 200;
            res.status(status === 400 ? 400 : 200).json({
                ok: false,
                error: error?.message || String(error),
            });
        }
    });

    return router;
}
