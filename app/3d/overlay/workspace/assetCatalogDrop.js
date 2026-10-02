export const CATALOG_DRAG_MIME = "application/x-cev-editor-catalog";
export const PLACEMENT_DRAG_MIME = "application/x-cev-editor-asset";

function dragTypesInclude(types, mime) {
    if (!types) return false;
    if (typeof types.includes === "function" && types.includes(mime)) return true;
    if (typeof types.contains === "function" && types.contains(mime)) return true;
    return false;
}

/** Scene drops land on the WebGL canvas, which sits under the pointer-events-none workspace grid. */
export function isSceneCanvasPlacementDrop(event, canvas) {
    return Boolean(canvas) && event?.target === canvas && dragTypesInclude(event.dataTransfer?.types, PLACEMENT_DRAG_MIME);
}

export function catalogDropDestination(entry) {
    const id = entry?.id;
    if (!id || id === "all" || id === "built-ins") return null;
    if (id === "root") return { folderId: null, parentId: null };
    return { folderId: id, parentId: id };
}

export function parseCatalogDragPayload(raw) {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const payload = JSON.parse(raw);
        if (payload?.kind !== "asset" && payload?.kind !== "folder") return null;
        const id = String(payload.id ?? "").trim();
        if (!id) return null;
        return {
            kind: payload.kind,
            id,
            folderId: payload.folderId ?? null,
            parentId: payload.parentId ?? null,
        };
    } catch {
        return null;
    }
}

export function folderSubtreeIds(folders, id) {
    const ids = new Set([String(id)]);
    let added = true;
    while (added) {
        added = false;
        for (const folder of folders) {
            if (folder.parentId && ids.has(String(folder.parentId)) && !ids.has(folder.id)) {
                ids.add(folder.id);
                added = true;
            }
        }
    }
    return ids;
}

export function canAcceptCatalogDrop(payload, entry, folders = []) {
    if (!payload?.kind || !payload.id) return false;
    const destination = catalogDropDestination(entry);
    if (!destination) return false;
    if (payload.kind === "asset") {
        return (payload.folderId ?? null) !== destination.folderId;
    }
    if (payload.kind !== "folder") return false;
    if ((payload.parentId ?? null) === destination.parentId) return false;
    if (destination.parentId === null) return true;
    return !folderSubtreeIds(folders, payload.id).has(String(destination.parentId));
}
