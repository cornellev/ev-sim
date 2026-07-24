import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";

export function createLogRouter(service) {
    const router = express.Router();
    const json = express.json({ limit: "2mb" });
    const batch = express.raw({ type: "application/octet-stream", limit: "8mb" });

    router.get("/", handle(async () => service.listLogs()));
    router.post("/sessions", json, handle(async (req) => service.createSession(req.body || {})));
    router.post("/sessions/:id/batches", batch, handle(async (req) => service.appendBatch(req.params.id, {
        sequence: req.get("x-sflog-sequence"),
        startUs: req.get("x-sflog-start-us"),
        endUs: req.get("x-sflog-end-us"),
        bytes: req.body,
    })));
    router.post("/sessions/:id/finalize", json, handle(async (req) => service.finalize(req.params.id, req.body || {})));
    router.post("/import", handle(async (req) => service.importStream(req, { name: req.get("x-sflog-name") })));
    router.get("/:id/metadata", handle(async (req) => service.getMetadata(req.params.id)));
    router.get("/:id/index", handle(async (req) => service.getIndex(req.params.id)));
    router.get("/:id/chunks", async (req, res) => {
        try {
            const bytes = await service.readChunks(req.params.id, {
                fromUs: Number(req.query.fromUs || 0),
                toUs: req.query.toUs === undefined ? Number.POSITIVE_INFINITY : Number(req.query.toUs),
            });
            res.type("application/x-sflog-records").send(bytes);
        } catch (error) {
            respondError(req, res, error);
        }
    });
    router.get("/:id/file", async (req, res) => {
        try {
            const filePath = service.getFilePath(req.params.id);
            const stat = await fs.stat(filePath);
            const range = req.headers.range;
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath)}"`);
            res.type("application/x-sflog");
            if (!range) {
                res.setHeader("Content-Length", stat.size);
                const handle = await fs.open(filePath, "r");
                const stream = handle.createReadStream();
                stream.on("close", () => handle.close());
                stream.pipe(res);
                return;
            }
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!match) return res.status(416).end();
            const start = Number(match[1]);
            const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
            if (start > end || start >= stat.size) return res.status(416).end();
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
            res.setHeader("Content-Length", end - start + 1);
            const handle = await fs.open(filePath, "r");
            const stream = handle.createReadStream({ start, end });
            stream.on("close", () => handle.close());
            stream.pipe(res);
        } catch (error) {
            respondError(req, res, error);
        }
    });
    router.patch("/:id", json, handle(async (req) => service.updateMetadata(req.params.id, req.body || {})));
    router.delete("/:id", handle(async (req) => service.deleteLog(req.params.id)));
    return router;
}

function handle(fn) {
    return async (req, res) => {
        try {
            res.json((await fn(req)) ?? null);
        } catch (error) {
            respondError(req, res, error);
        }
    };
}

function respondError(req, res, error) {
    console.error(`[logs] ${req.method} ${req.originalUrl} failed:`, error);
    res.status(400).json({ error: error.message });
}
