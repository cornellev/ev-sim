import express from "express";

import { jsonHandler } from "./jsonHandler.js";

export function createEditorAssetRouter(service) {
    const router = express.Router();
    const store = () => service.editorAssets;

    router.use((_req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    router.get("/", handle(async (req) => store().list(req.query ?? {})));
    router.get("/capabilities", handle(async () => service.getEditorAssetCapabilities()));
    router.post("/", handle(async (req) => store().publishRevision(req.body ?? {}, req.body?.expectedRevision)));

    router.get("/folders", handle(async () => {
        const catalog = await store().list({ archived: true });
        return { catalogRevision: catalog.catalogRevision, folders: catalog.folders };
    }));
    router.post("/folders", handle(async (req) => store().createFolder(req.body ?? {}, req.body?.expectedRevision)));
    router.patch("/folders/:folderId", handle(async (req) => store().updateFolder(req.params.folderId, req.body ?? {}, req.body?.expectedRevision)));
    router.delete("/folders/:folderId", handle(async (req) => store().deleteFolder(req.params.folderId, expected(req))));

    router.get("/:assetId/references", handle(async (req) => ({
        references: await service.findEditorAssetReferences(req.params.assetId, req.query?.revision),
    })));
    router.get("/:assetId/revisions", handle(async (req) => store().listRevisions(req.params.assetId)));
    router.post("/:assetId/revisions", handle(async (req) => store().publishRevision({ ...(req.body ?? {}), assetId: req.params.assetId }, req.body?.expectedRevision)));
    router.get("/:assetId/revisions/:revision", handle(async (req) => store().getRevision(req.params.assetId, Number(req.params.revision))));
    router.put("/:assetId/revisions/:revision/thumbnail", handle(async (req) => store().setThumbnail(
        req.params.assetId,
        Number(req.params.revision),
        req.body?.useHash,
        req.body?.expectedRevision,
    )));
    router.get("/:assetId", handle(async (req) => store().get(req.params.assetId)));
    router.patch("/:assetId", handle(async (req) => store().updateMetadata(req.params.assetId, req.body ?? {}, req.body?.expectedRevision)));

    return router;
}

function expected(req) {
    const value = req.query?.expectedRevision ?? req.body?.expectedRevision;
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
}

const handle = (fn) => jsonHandler(fn, { logPrefix: "editor-assets" });
