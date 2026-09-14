export const CATALOG_DRAG_MIME = "application/x-cev-editor-catalog";
export const PLACEMENT_DRAG_MIME = "application/x-cev-editor-asset";

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
