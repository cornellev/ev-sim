export function catalogFiltersActive({ kind = "all", sort = "name", showArchived = false } = {}) {
    return kind !== "all" || sort !== "name" || Boolean(showArchived);
}

export function showImportSourcePicker(sources) {
    return Array.isArray(sources) && sources.length > 1;
}

export function resolveImportSource(sources, currentId) {
    const ids = (Array.isArray(sources) ? sources : [])
        .map((source) => source?.id)
        .filter(Boolean);
    if (currentId && ids.includes(currentId)) return currentId;
    return ids[0] ?? "";
}
