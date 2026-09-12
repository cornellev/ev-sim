export function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox'], [role='combobox']"));
}

export function isInteractiveTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("button, a[href], input, textarea, select, summary, [contenteditable='true'], [contenteditable=''], [role='button'], [role='slider'], [role='switch'], [role='tab'], [role='menuitem'], [role='dialog']"));
}

export function normalizeShortcutKey(key) {
    if (typeof key !== "string" || key.length === 0) return "";
    if (key === " ") return "Space";
    if (key === "Esc") return "Escape";
    return key.length === 1 ? key.toLowerCase() : key;
}

const MODIFIER_NAMES = new Set(["mod", "ctrl", "control", "alt", "option", "shift", "meta", "cmd", "command"]);

/**
 * Parse `"Shift+Mod+z"` into `{ key, mod, ctrl, alt, shift, meta }`. `Mod` is
 * Cmd on macOS and Ctrl elsewhere; matching accepts either so one binding
 * serves both platforms.
 */
export function parseShortcut(shortcut) {
    if (typeof shortcut !== "string" || shortcut.length === 0) return null;
    if (shortcut === "+") return { key: "+", mod: false, ctrl: false, alt: false, shift: false, meta: false, hasModifiers: false };
    const parts = shortcut.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 0) return null;
    const parsed = { key: "", mod: false, ctrl: false, alt: false, shift: false, meta: false, hasModifiers: false };
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (parts.length > 1 && MODIFIER_NAMES.has(lower)) {
            parsed.hasModifiers = true;
            if (lower === "mod") parsed.mod = true;
            else if (lower === "ctrl" || lower === "control") parsed.ctrl = true;
            else if (lower === "alt" || lower === "option") parsed.alt = true;
            else if (lower === "shift") parsed.shift = true;
            else parsed.meta = true;
        } else {
            parsed.key = normalizeShortcutKey(part);
        }
    }
    return parsed.key ? parsed : null;
}

export function matchesShortcut(event, shortcut) {
    const eventKey = normalizeShortcutKey(event?.key);
    if (!eventKey) return false;
    const keys = Array.isArray(shortcut) ? shortcut : [shortcut];
    return keys.some((key) => {
        const parsed = parseShortcut(key);
        if (!parsed || parsed.key !== eventKey) return false;
        const meta = Boolean(event?.metaKey);
        const ctrl = Boolean(event?.ctrlKey);
        const alt = Boolean(event?.altKey);
        const shift = Boolean(event?.shiftKey);
        if (parsed.hasModifiers) {
            if (parsed.mod && !(meta || ctrl)) return false;
            if (parsed.ctrl && !ctrl) return false;
            if (parsed.meta && !meta) return false;
            if (parsed.alt !== alt) return false;
            if (parsed.shift !== shift) return false;
            if (!parsed.mod && !parsed.ctrl && !parsed.meta && (meta || ctrl)) return false;
            if (parsed.ctrl && !parsed.mod && !parsed.meta && meta) return false;
            return true;
        }
        // Bare single-character keys never fire while Cmd/Ctrl/Alt is held, so
        // "z" and "Mod+z" stay distinct. Named keys (Escape, Delete) keep the
        // legacy behavior of matching regardless of modifiers.
        if (parsed.key.length === 1 && (meta || ctrl || alt)) return false;
        return true;
    });
}

export function getShortcutCandidates(entries, event, { overlayOpen = false } = {}) {
    if (event.defaultPrevented || overlayOpen) return [];
    return [...entries]
        .filter((entry) => entry.enabled !== false && matchesShortcut(event, entry.keys))
        .filter((entry) => entry.allowInEditable || !isEditableTarget(event.target))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}
