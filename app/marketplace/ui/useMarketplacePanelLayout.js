"use client";

import { useCallback, useEffect, useState } from "react";

import { readMarketplacePanelLayout, writeMarketplacePanelLayout } from "./marketplaceWorkspacePreferences.js";
import { panelLayoutsEqual, parsePanelLayout } from "./panelLayout.js";

/** Hydrate both Discover and Publish sizes from one preference, and write them back. */
export function useMarketplacePanelLayout() {
    const [layout, setLayout] = useState(() => parsePanelLayout(readMarketplacePanelLayout()));
    useEffect(() => {
        writeMarketplacePanelLayout(layout);
    }, [layout]);
    const updateLayout = useCallback((producer) => {
        setLayout((current) => {
            const next = producer(current);
            return panelLayoutsEqual(next, current) ? current : next;
        });
    }, []);
    return [layout, updateLayout];
}
