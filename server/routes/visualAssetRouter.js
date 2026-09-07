import express from "express";

import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../storage/StorageErrors.js";

export function createVisualAssetRouter(service) {
    const router = express.Router();
    const jsonParser = express.json({ limit: "1mb" });
    const store = () => service.visualAssets;

    router.post("/uploads", jsonParser, handle(async (req) => store().createUpload(req.body ?? {})));
    router.delete("/uploads/:id", handle(async (req) => store().abortUpload(req.params.id)));
    router.put("/uploads/:id/content", async (req, res) => {
        try {
            const contentLength = req.headers["content-length"];
            const result = await store().writeUploadContent(req.params.id, req, { contentLength });
            res.json(result);
        } catch (error) {
            sendError(req, res, error);
        }
    });

    router.get("/uses/sha256/:useHash", handle(async (req) => store().getUse(req.params.useHash)));
    router.get("/uses/sha256/:useHash/content", async (req, res) => {
        try {
            await sendContent(res, store(), req.params.useHash, req.headers.range, false);
        } catch (error) {
            sendError(req, res, error);
        }
    });
    router.head("/uses/sha256/:useHash/content", async (req, res) => {
        try {
            await sendContent(res, store(), req.params.useHash, req.headers.range, true);
        } catch (error) {
            sendError(req, res, error);
        }
    });

    router.post("/closures/validate", jsonParser, handle(async (req) => store().validateClosure(req.body ?? {})));

    router.delete("/uses/sha256/:useHash", deletionDisabled);
    router.delete("/uses/sha256/:useHash/content", deletionDisabled);
    router.delete("/sha256/:digest", deletionDisabled);
    router.get("/sha256/:digest", (req, res) => {
        res.status(404).json({
            error: "Digest-only visual asset content URLs are not exposed.",
            code: VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND,
        });
    });
    router.head("/sha256/:digest", (req, res) => {
        res.status(404).end();
    });

    return router;
}

function deletionDisabled(req, res) {
    res.status(405).json({
        error: "Published visual asset deletion is disabled.",
        code: VISUAL_ASSET_ERROR_CODES.DELETION_DISABLED,
    });
}

async function sendContent(res, store, useHash, rangeHeader, headOnly) {
    const stat = await store.statUseContent(useHash);
    const range = parseRange(rangeHeader, stat.size);
    res.setHeader("ETag", `"${stat.digest}"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", stat.mediaType);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
        res.setHeader("Content-Length", String(stat.size));
    }
    if (headOnly) {
        res.end();
        return;
    }
    const opened = await store.openUseContent(useHash, range ?? {});
    opened.stream.pipe(res);
    res.on("close", () => {
        opened.release?.();
    });
}

function parseRange(header, size) {
    if (!header) return null;
    if (header.includes(",")) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.RANGE_NOT_SATISFIABLE,
            "Multiple byte ranges are not supported.",
            { headers: { "Content-Range": `bytes */${size}` } },
        );
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match || (match[1] === "" && match[2] === "")) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.RANGE_NOT_SATISFIABLE,
            "Range header is invalid.",
            { headers: { "Content-Range": `bytes */${size}` } },
        );
    }
    const start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
    const end = match[2] === "" ? size - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size || end >= size) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.RANGE_NOT_SATISFIABLE,
            "Requested byte range is not satisfiable.",
            { headers: { "Content-Range": `bytes */${size}` } },
        );
    }
    return { start, end };
}

function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req);
            res.json(result ?? null);
        } catch (error) {
            sendError(req, res, error);
        }
    };
}

function sendError(req, res, error) {
    const status = Number(error.statusCode) || 400;
    if (error.headers) {
        for (const [key, value] of Object.entries(error.headers)) res.setHeader(key, value);
    }
    if (!res.headersSent) {
        console.error(`[visual-assets] ${req.method} ${req.originalUrl} failed:`, error);
        res.status(status).json(error.toJSON?.() ?? { error: error.message, code: error.code });
        return;
    }
    res.destroy(error);
}
