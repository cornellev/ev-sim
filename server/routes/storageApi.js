import express from "express";

import { createStorageRouter } from "./storageRouter.js";
import { createVisualAssetRouter } from "./visualAssetRouter.js";
import { createEditorAssetRouter } from "./editorAssetRouter.js";
import { createPluginRouter } from "./pluginRouter.js";

/**
 * Mount storage HTTP routes. Visual-asset streaming content is registered
 * before the shared JSON parser so PUT bodies are not consumed as JSON.
 */
export function mountStorageApi(app, service, { jsonParser, jsonLimit = "8mb" } = {}) {
    const parser = jsonParser ?? express.json({ limit: jsonLimit });
    app.use("/api/storage/plugins", createPluginRouter(service, { jsonParser: parser }));
    app.use("/api/storage/visual-assets", createVisualAssetRouter(service));
    app.use("/api/storage/editor-assets", parser, createEditorAssetRouter(service));
    app.use("/api/storage", parser, createStorageRouter(service));
}
