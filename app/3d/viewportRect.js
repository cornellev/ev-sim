/**
 * Render viewport resolution for `TotalScene`. The canvas is sized from, in
 * order of precedence: an embedded viewport (Experiments diagnostics), the
 * environment workspace's scene pane, or the window. Pure and node-testable.
 */

export function normalizeViewportRect(rect) {
    if (!rect || typeof rect !== "object") return null;
    const width = Math.max(1, Math.round(Number(rect.width) || 0));
    const height = Math.max(1, Math.round(Number(rect.height) || 0));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
        top: Math.round(Number(rect.top) || 0),
        left: Math.round(Number(rect.left) || 0),
        width,
        height,
    };
}

export function viewportRectsEqual(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.top === right.top && left.left === right.left && left.width === right.width && left.height === right.height;
}

/**
 * @returns {{ rect: { top: number, left: number, width: number, height: number }, source: "embedded"|"workspace"|"window" }}
 */
export function resolveRenderViewport({ embedded = null, workspace = null, window: win = null } = {}) {
    const embeddedRect = normalizeViewportRect(embedded);
    if (embeddedRect) return { rect: embeddedRect, source: "embedded" };
    const workspaceRect = normalizeViewportRect(workspace);
    if (workspaceRect) return { rect: workspaceRect, source: "workspace" };
    return {
        rect: {
            top: 0,
            left: 0,
            width: Math.max(1, Math.round(Number(win?.innerWidth) || 1)),
            height: Math.max(1, Math.round(Number(win?.innerHeight) || 1)),
        },
        source: "window",
    };
}
