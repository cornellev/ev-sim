import express from "express";

import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../marketplace/MarketplaceErrors.js";

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function objectBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("$", "expected a JSON object");
    return value;
}

function exactBody(value, required, optional = []) {
    objectBody(value);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`$.${key}`, "is required");
    for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`$.${key}`, "is not allowed");
    return value;
}

function queryRevision(request) {
    const keys = Object.keys(request.query);
    if (keys.length !== 1 || keys[0] !== "expectedRevision" || !/^(?:0|[1-9][0-9]*)$/u.test(request.query.expectedRevision)) {
        invalid("$.expectedRevision", "expected one non-negative integer query parameter");
    }
    const revision = Number(request.query.expectedRevision);
    if (!Number.isSafeInteger(revision)) invalid("$.expectedRevision", "exceeds the safe integer range");
    return revision;
}

function exactQuery(request, allowed) {
    const result = {};
    const accepted = new Set(allowed);
    for (const [key, value] of Object.entries(request.query)) {
        if (!accepted.has(key)) invalid(`$.${key}`, "is not allowed");
        if (Array.isArray(value) || typeof value !== "string") invalid(`$.${key}`, "must occur exactly once");
        result[key] = value;
    }
    return result;
}

function bodyRevision(value, path = "$.expectedRevision") {
    if (!Number.isSafeInteger(value) || value < 0) invalid(path, "expected a non-negative safe integer");
    return value;
}

function statusFor(error) {
    switch (error.code) {
    case MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND:
        return 404;
    case MARKETPLACE_ERROR_CODES.CONFLICT:
        return 409;
    case MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED:
    case MARKETPLACE_ERROR_CODES.METADATA_EXPIRED:
    case MARKETPLACE_ERROR_CODES.INCOMPATIBLE:
    case MARKETPLACE_ERROR_CODES.RIGHTS_DENIED:
    case MARKETPLACE_ERROR_CODES.RELEASE_YANKED:
    case MARKETPLACE_ERROR_CODES.RELEASE_BLOCKED:
        return 412;
    case MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID:
    case MARKETPLACE_ERROR_CODES.UNSUPPORTED_SCHEMA:
    case MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID:
    case MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH:
        return 422;
    case MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED:
        return 413;
    case MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE:
    case MARKETPLACE_ERROR_CODES.CANCELLED:
    case MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED:
        return 503;
    default:
        return 500;
    }
}

function handler(operation) {
    return async (request, response, next) => {
        try {
            await operation(request, response);
        } catch (error) {
            next(error);
        }
    };
}

export function createMarketplaceRouter(service, {
    jsonParser = express.json({ limit: "32kb", strict: true }),
    logger = console,
} = {}) {
    const router = express.Router();
    router.use((request, response, next) => {
        response.set("Cache-Control", "no-store");
        next();
    });
    router.use(jsonParser);

    router.get("/status", handler(async (request, response) => {
        exactQuery(request, []);
        response.json(service.status());
    }));

    router.post("/install-plans", handler(async (request, response) => {
        const body = exactBody(request.body, ["sourceId", "itemId", "releaseVersion"]);
        response.status(201).json(await service.createInstallPlan(body));
    }));

    router.post("/install-jobs", handler(async (request, response) => {
        const body = exactBody(request.body, ["planHash"]);
        response.status(202).json(await service.startInstallJob(body.planHash));
    }));

    router.get("/install-jobs/:jobId/events", handler(async (request, response) => {
        exactQuery(request, []);
        const initial = await service.getInstallJob(request.params.jobId);
        response.status(200).set({
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        response.flushHeaders?.();
        let closed = false;
        let heartbeat = null;
        let unsubscribe = () => {};
        let lastRevision = -1;
        const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            unsubscribe();
            if (!response.writableEnded) response.end();
        };
        const send = (view) => {
            if (closed || response.writableEnded) return;
            if (view.job.revision <= lastRevision) return;
            lastRevision = view.job.revision;
            response.write(`id: ${view.job.revision}\nevent: job\ndata: ${JSON.stringify(view)}\n\n`);
            if (["failed", "cancelled", "complete", "needs-attention"].includes(view.job.phase)) setImmediate(close);
        };
        send(initial);
        if (closed || response.writableEnded) return;
        unsubscribe = service.subscribeInstallJob(request.params.jobId, send);
        heartbeat = setInterval(() => {
            if (!closed && !response.writableEnded) response.write(": heartbeat\n\n");
        }, 25_000);
        heartbeat.unref?.();
        request.once("close", close);
    }));

    router.get("/install-jobs/:jobId", handler(async (request, response) => {
        exactQuery(request, []);
        response.json(await service.getInstallJob(request.params.jobId));
    }));

    router.post("/install-jobs/:jobId/commit", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision", "finalPlanHash"]);
        bodyRevision(body.expectedRevision);
        response.status(202).json(await service.confirmInstallJob(request.params.jobId, body));
    }));

    router.post("/install-jobs/:jobId/cancel", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision"]);
        response.json(await service.cancelInstallJob(request.params.jobId, bodyRevision(body.expectedRevision)));
    }));

    router.post("/install-jobs/:jobId/resume", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision"]);
        response.status(202).json(await service.resumeInstallJob(request.params.jobId, bodyRevision(body.expectedRevision)));
    }));

    router.post("/install-jobs/:jobId/replan", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision"]);
        response.status(202).json(await service.replanInstallJob(request.params.jobId, bodyRevision(body.expectedRevision)));
    }));

    router.get("/install-jobs/:jobId/operations", handler(async (request, response) => {
        const query = exactQuery(request, ["offset", "limit", "status"]);
        response.json(await service.listInstallJobOperations(request.params.jobId, query));
    }));

    router.get("/installed", handler(async (request, response) => {
        exactQuery(request, []);
        response.json(await service.listInstalled());
    }));

    router.get("/receipts/:receiptHash", handler(async (request, response) => {
        exactQuery(request, []);
        response.json(await service.readReceipt(request.params.receiptHash));
    }));

    router.delete("/installed/:sourceId/:itemId/:releaseVersion/:artifactSha256", handler(async (request, response) => {
        response.json(await service.removeInstalled({
            ...request.params,
            expectedRevision: queryRevision(request),
        }));
    }));

    router.get("/discover", handler(async (request, response) => {
        const query = exactQuery(request, [
            "q", "track", "contentKind", "sourceId", "publisherId", "license", "offset", "limit",
        ]);
        try {
            response.json(await service.searchCatalog(query));
        } catch (error) {
            if (error instanceof TypeError) invalid("$", error.message);
            throw error;
        }
    }));

    router.get("/items/:sourceId/:itemId", handler(async (request, response) => {
        const query = exactQuery(request, ["releaseVersion"]);
        response.json(await service.getCatalogItem(request.params.sourceId, request.params.itemId, {
            releaseVersion: query.releaseVersion || null,
        }));
    }));

    router.get("/items/:sourceId/:itemId/previews/:digest", handler(async (request, response) => {
        exactQuery(request, []);
        const result = await service.readVerifiedPreview(
            request.params.sourceId,
            request.params.itemId,
            request.params.digest,
        );
        const etag = `"${result.descriptor.sha256}"`;
        response.set({
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Type": result.descriptor.mediaType,
            "Content-Length": String(result.bytes.byteLength),
            ETag: etag,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-origin",
        });
        if (request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
            response.status(304).end();
            return;
        }
        response.send(result.bytes);
    }));

    router.post("/sources/preview", handler(async (request, response) => {
        const body = exactBody(request.body, ["baseUrl"], ["credential"]);
        response.json(await service.previewSource(body));
    }));

    router.get("/sources", handler(async (_request, response) => {
        response.json(await service.listSources());
    }));

    router.post("/sources", handler(async (request, response) => {
        const body = exactBody(request.body, [
            "expectedRevision", "name", "baseUrl", "registryId", "trustedRootFingerprint", "enabled", "priority",
        ], ["credential"]);
        response.status(201).json(await service.addSource(body));
    }));

    router.patch("/sources/:sourceId", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision"], ["name", "enabled", "priority", "credential"]);
        if (Object.keys(body).length === 1) invalid("$", "expected at least one source update");
        response.json(await service.updateSource(request.params.sourceId, body));
    }));

    router.delete("/sources/:sourceId", handler(async (request, response) => {
        response.json(await service.removeSource(request.params.sourceId, queryRevision(request)));
    }));

    router.post("/sources/:sourceId/refresh", handler(async (request, response) => {
        const body = exactBody(request.body, ["expectedRevision"]);
        response.json(await service.refreshSource(request.params.sourceId, body));
    }));

    router.use((error, request, response, _next) => {
        let publicError;
        if (error instanceof MarketplaceError && error.code === MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED) {
            publicError = marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace local state requires recovery.");
        } else if (error instanceof MarketplaceError) publicError = error;
        else if (error?.type === "entity.too.large") {
            publicError = marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace request body exceeds 32 KiB.");
        } else if (error instanceof SyntaxError && Object.hasOwn(error, "body")) {
            publicError = marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Marketplace request body is not valid JSON.");
        } else {
            publicError = marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace request failed.");
        }
        const route = request.route?.path ?? "unmatched";
        logger.error?.(`[marketplace] ${request.method} ${route} ${publicError.code}`);
        response.status(statusFor(publicError)).json({
            error: {
                ...publicError.toJSON(),
                ...(Number.isSafeInteger(publicError.currentRevision) ? { currentRevision: publicError.currentRevision } : {}),
            },
        });
    });
    return router;
}
