import express from "express";

import { storageEvents } from "../mcp/events.js";
import { installPluginSource, removePluginSource } from "../plugins/pluginLibrary.js";
import { listSensorCatalog } from "../plugins/sensorCatalog.js";
import { PLUGIN_PACKAGE_MEDIA_TYPE, PORTABLE_PLUGIN_MAX_JSON_BYTES } from "../plugins/PortablePluginFile.js";

function mimeType(filePath) {
    if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
    if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
    if (filePath.endsWith(".svg")) return "image/svg+xml";
    if (filePath.endsWith(".png")) return "image/png";
    return "application/octet-stream";
}

function sendError(res, error) {
    const missing = error.code === "ENOENT";
    res.status(missing ? 404 : 400).json({
        ok: false,
        error: error.code ?? "PLUGIN_REQUEST_INVALID",
        message: error.message,
        path: error.path ?? null,
    });
}

function publishLibrary(pluginId, action, packageHash, revision) {
    storageEvents.publish({
        domain: "plugin",
        id: pluginId,
        action,
        data: { packageHash, revision },
    });
}

export async function sendPluginFileResponse(service, { packageHash, member, head = false }, res) {
    try {
        const resource = await service.plugins.getPackage(packageHash);
        const record = resource.files.find((entry) => entry.path === member);
        if (!record) {
            const error = new Error(`Plugin package does not contain "${member}".`);
            error.code = "ENOENT";
            throw error;
        }
        const bytes = await service.plugins.readFile(packageHash, member);
        res.set("Content-Type", mimeType(member));
        res.set("Content-Length", String(bytes.byteLength));
        res.set("ETag", `"${record.sha256}"`);
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.set("X-Content-Type-Options", "nosniff");
        if (head) res.end();
        else res.send(Buffer.from(bytes));
    } catch (error) {
        sendError(res, error);
    }
}

export function createPluginRouter(service, { jsonParser } = {}) {
    const parser = jsonParser ?? express.json({ limit: "8mb" });
    const packageParser = express.raw({
        type: [PLUGIN_PACKAGE_MEDIA_TYPE, "application/json"],
        limit: PORTABLE_PLUGIN_MAX_JSON_BYTES,
    });
    const router = express.Router();

    router.get("/sensors", async (_req, res) => {
        try {
            const catalog = await listSensorCatalog(service);
            res.json(catalog);
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/library", async (_req, res) => {
        try {
            const library = await service.listPluginLibrary();
            res.json({ ok: true, revision: library.revision, packages: library.packages });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/install", parser, async (req, res) => {
        try {
            const metadata = await installPluginSource(service, req.body?.source);
            const library = await service.listPluginLibrary();
            publishLibrary(metadata.pluginId, "installed", metadata.packageHash, library.revision);
            res.json({
                ok: true,
                package: metadata,
                revision: library.revision,
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/install-file", packageParser, async (req, res) => {
        try {
            const bytes = req.body instanceof Uint8Array
                ? req.body
                : Buffer.isBuffer(req.body)
                    ? new Uint8Array(req.body)
                    : null;
            if (!bytes) {
                const error = new Error("Plugin file install requires a raw package body.");
                error.code = "PLUGIN_DOCUMENT_INVALID";
                throw error;
            }
            const metadata = await service.installPluginFromBytes(bytes);
            const library = await service.listPluginLibrary();
            publishLibrary(metadata.pluginId, "installed", metadata.packageHash, library.revision);
            res.json({
                ok: true,
                package: metadata,
                revision: library.revision,
            });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/remove", parser, async (req, res) => {
        try {
            const pluginId = req.body?.pluginId;
            const packageHash = req.body?.packageHash;
            const removed = await removePluginSource(service, { pluginId, packageHash });
            if (!removed) {
                const error = new Error(`Plugin "${pluginId}" package ${packageHash} is not in the library.`);
                error.code = "ENOENT";
                throw error;
            }
            const library = await service.listPluginLibrary();
            publishLibrary(pluginId, "removed", packageHash, library.revision);
            res.json({ ok: true, removed: true, revision: library.revision });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/packages/:packageHash", async (req, res) => {
        try {
            const resource = await service.plugins.getPackage(req.params.packageHash);
            res.set("ETag", `"${resource.packageHash}"`);
            res.set("Cache-Control", "public, max-age=31536000, immutable");
            res.set("X-Content-Type-Options", "nosniff");
            res.json(resource);
        } catch (error) {
            sendError(res, error);
        }
    });

    const fileRoute = /^\/packages\/([a-f0-9]{64})\/files\/(.+)$/;
    router.get(fileRoute, (req, res) => sendPluginFileResponse(service, {
        packageHash: req.params[0],
        member: req.params[1],
    }, res));
    router.head(fileRoute, (req, res) => sendPluginFileResponse(service, {
        packageHash: req.params[0],
        member: req.params[1],
        head: true,
    }, res));

    return router;
}
