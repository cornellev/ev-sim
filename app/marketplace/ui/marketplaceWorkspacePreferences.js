/**
 * Marketplace workspace preferences persisted in localStorage. Panel sizes
 * are local UI state. Nothing here is marketplace metadata, an install
 * receipt, or a simulator hash input.
 */

import { serializePanelLayout } from "./panelLayout.js";

export const MARKETPLACE_PANEL_LAYOUT_KEY = "cev-sim.ui.marketplace.panelLayout";

export function readMarketplacePanelLayout(storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        if (!store?.getItem) return null;
        const raw = store.getItem(MARKETPLACE_PANEL_LAYOUT_KEY);
        if (raw === null || raw === undefined) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function writeMarketplacePanelLayout(layout, storage = null) {
    try {
        const store = storage ?? globalThis.localStorage;
        store?.setItem?.(MARKETPLACE_PANEL_LAYOUT_KEY, JSON.stringify(serializePanelLayout(layout)));
    } catch {
        // Ignore storage failures (private mode, SSR).
    }
}
