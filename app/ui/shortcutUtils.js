export function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='combobox']"));
}

export function isInteractiveTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("button, a[href], input, textarea, select, summary, [contenteditable='true'], [contenteditable=''], [role='button'], [role='slider'], [role='switch'], [role='tab'], [role='menuitem'], [role='dialog']"));
}

export function normalizeShortcutKey(key) {
    if (key === " ") return "Space";
    if (key === "Esc") return "Escape";
    return key.length === 1 ? key.toLowerCase() : key;
}

export function matchesShortcut(event, shortcut) {
    const keys = Array.isArray(shortcut) ? shortcut : [shortcut];
    const eventKey = normalizeShortcutKey(event.key);
    return keys.some((key) => normalizeShortcutKey(key) === eventKey);
}

export function getShortcutCandidates(entries, event, { overlayOpen = false } = {}) {
    if (event.defaultPrevented || overlayOpen) return [];
    return [...entries]
        .filter((entry) => entry.enabled !== false && matchesShortcut(event, entry.keys))
        .filter((entry) => entry.allowInEditable || !isEditableTarget(event.target))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}
