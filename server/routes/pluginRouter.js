import express from "express";

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
        error: error.code ?? "PLUGIN_REQUEST_INVALID",
        message: error.message,
        path: error.path ?? null,
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

export function createPluginRouter(service) {
    const router = express.Router();

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
