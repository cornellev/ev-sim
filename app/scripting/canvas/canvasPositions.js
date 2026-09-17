export function getFallbackNodePosition(index = 0) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return {
        x: 220 + column * 230,
        y: 140 + row * 170,
    };
}

export function normalizeRestoredPosition(position, index = 0) {
    const fallback = getFallbackNodePosition(index);
    if (!position) return fallback;

    const rawX = Number(position.x);
    const rawY = Number(position.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return fallback;

    return { x: rawX, y: rawY };
}

export function normalizeOutputNodePosition(position) {
    const fallback = { x: 100, y: 100 };
    if (!position) return fallback;

    const rawX = Number(position.x);
    const rawY = Number(position.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return fallback;

    return { x: rawX, y: rawY };
}
