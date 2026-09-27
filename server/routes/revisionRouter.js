import express from "express";

import { jsonHandler } from "./jsonHandler.js";

export function createRevisionRouter(probe) {
    const router = express.Router();
    router.get("/", jsonHandler(() => probe.status(), { logPrefix: "revision" }));
    return router;
}
