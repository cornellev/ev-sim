export const SOURCE_KIND_LABELS = Object.freeze({
    blank: "Blank environment",
    google: "Google Earth",
    gltf: "GLTF Tile",
});

export function sourceKindLabel(kind) {
    return SOURCE_KIND_LABELS[kind] ?? SOURCE_KIND_LABELS.blank;
}

export function inspectEnvironment(list, id) {
    const items = Array.isArray(list) ? list : [];
    const key = id == null ? "" : String(id);
    if (!key) return null;
    return items.find((entry) => entry && String(entry.id) === key) ?? null;
}

export function canEditIdentity(entry) {
    return Boolean(entry) && entry.builtIn !== true;
}

export function shouldLoadOnOpen(inspectedId, activeId) {
    return Boolean(inspectedId) && String(inspectedId) !== String(activeId ?? "");
}
