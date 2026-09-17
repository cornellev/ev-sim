export const DEFAULT_CANVAS_VIEWPORT = Object.freeze({
    x: 0,
    y: 0,
    scale: 1,
});

export const CANVAS_MIN_SCALE = 0.25;
export const CANVAS_MAX_SCALE = 3;
export const CANVAS_FIT_PADDING = 80;
export const CANVAS_TOOLBAR_ZOOM_FACTOR = 1.15;
export const CANVAS_VIEWPORT_CHANGED_EVENT = "canvas-viewport-changed";

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function clampScale(scale) {
    return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, finite(scale, 1)));
}

export function normalizeCanvasViewport(value) {
    if (!value || typeof value !== "object") {
        return { ...DEFAULT_CANVAS_VIEWPORT };
    }

    return {
        x: finite(value.x, DEFAULT_CANVAS_VIEWPORT.x),
        y: finite(value.y, DEFAULT_CANVAS_VIEWPORT.y),
        scale: clampScale(value.scale),
    };
}

export function screenToWorld(screen, viewport, origin = { x: 0, y: 0 }) {
    const camera = normalizeCanvasViewport(viewport);
    const scale = Math.max(Number.EPSILON, camera.scale);
    return {
        x: (finite(screen?.x) - finite(origin?.x) - camera.x) / scale,
        y: (finite(screen?.y) - finite(origin?.y) - camera.y) / scale,
    };
}

export function worldToScreen(world, viewport, origin = { x: 0, y: 0 }) {
    const camera = normalizeCanvasViewport(viewport);
    return {
        x: finite(origin?.x) + finite(world?.x) * camera.scale + camera.x,
        y: finite(origin?.y) + finite(world?.y) * camera.scale + camera.y,
    };
}

export function panViewport(viewport, dxScreen, dyScreen) {
    const camera = normalizeCanvasViewport(viewport);
    return {
        ...camera,
        x: camera.x + finite(dxScreen),
        y: camera.y + finite(dyScreen),
    };
}

export function zoomViewportAt(viewport, screen, factor, origin = { x: 0, y: 0 }) {
    const current = normalizeCanvasViewport(viewport);
    const nextScale = clampScale(current.scale * finite(factor, 1));
    if (nextScale === current.scale) return current;

    const world = screenToWorld(screen, current, origin);
    return {
        x: finite(screen?.x) - finite(origin?.x) - world.x * nextScale,
        y: finite(screen?.y) - finite(origin?.y) - world.y * nextScale,
        scale: nextScale,
    };
}

export function canvasWorldTransform(viewport) {
    const camera = normalizeCanvasViewport(viewport);
    return `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
}

export function wheelZoomFactor(deltaY) {
    return Math.exp(-finite(deltaY) * 0.0015);
}

export function fitViewportToWorldPoints(points, size, { padding = CANVAS_FIT_PADDING } = {}) {
    const normalized = (points || [])
        .map((point) => ({ x: finite(point?.x), y: finite(point?.y) }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

    if (normalized.length === 0) return { ...DEFAULT_CANVAS_VIEWPORT };

    const xs = normalized.map((point) => point.x);
    const ys = normalized.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const inset = Math.max(0, finite(padding, CANVAS_FIT_PADDING));
    const width = Math.max(1, finite(size?.width, 800));
    const height = Math.max(1, finite(size?.height, 600));
    const innerWidth = Math.max(1, width - inset * 2);
    const innerHeight = Math.max(1, height - inset * 2);
    const scale = clampScale(Math.min(innerWidth / spanX, innerHeight / spanY));
    const centerWorldX = (minX + maxX) / 2;
    const centerWorldY = (minY + maxY) / 2;

    return {
        x: width / 2 - centerWorldX * scale,
        y: height / 2 - centerWorldY * scale,
        scale,
    };
}

export function canvasOriginFromElement(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
        return { x: 0, y: 0 };
    }

    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
}

export function isEditableTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    return Boolean(target.closest("input, textarea, select, [contenteditable]"))
        || target.isContentEditable;
}

export function isCanvasChromeTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    if (isEditableTarget(target)) return true;
    return Boolean(target.closest("[data-block-library]"));
}

export function canStartEmptyCanvasPan(target) {
    if (!target || typeof target.closest !== "function") return true;
    return !target.closest(".input, .output, [data-block-library], [data-uuid]");
}

export function dispatchCanvasViewportChanged(viewport) {
    if (typeof document === "undefined") return;
    document.dispatchEvent(new CustomEvent(CANVAS_VIEWPORT_CHANGED_EVENT, {
        detail: { viewport: normalizeCanvasViewport(viewport) },
    }));
}
