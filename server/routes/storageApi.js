import express from "express";

import { createStorageRouter } from "./storageRouter.js";
import { createVisualAssetRouter } from "./visualAssetRouter.js";

/**
 * Mount storage HTTP routes. Visual-asset streaming content is registered
 * before the shared JSON parser so PUT bodies are not consumed as JSON.
 */
export function mountStorageApi(app, service, { jsonParser, jsonLimit = "20mb" } = {}) {
    const parser = jsonParser ?? express.json({ limit: jsonLimit });
    app.use("/api/storage/visual-assets", createVisualAssetRouter(service));
    app.use("/api/storage", parser, createStorageRouter(service));
}
