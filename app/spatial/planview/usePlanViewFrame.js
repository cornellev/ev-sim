'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createPlanViewFrameStore, emptyPlanViewFrame } from "./frame.js";

const EMPTY_FRAME = emptyPlanViewFrame();
const EMPTY_MAP = Object.freeze({ tools: {} });

export function usePlanViewFrame(data, { historyMode = "10s", selectedActorId = null, waypointFrame = "global" } = {}) {
    const store = useMemo(() => createPlanViewFrameStore(data), [data]);
    const frame = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_FRAME);
    const manager = data?.simulation?.()?.visualizationManager;
    const subscribeMap = useCallback((listener) => manager?.subscribeMap(listener) ?? (() => {}), [manager]);
    const getMapSnapshot = useCallback(() => manager?.getMapSnapshot() ?? EMPTY_MAP, [manager]);
    const visualizationMap = useSyncExternalStore(subscribeMap, getMapSnapshot, () => EMPTY_MAP);

    useEffect(() => {
        manager?.tools?.trajectoryPast?.setHistoryMode?.(historyMode);
        manager?._schedule();
    }, [manager, historyMode]);

    return useMemo(() => ({ ...frame, visualizationMap, historyMode, selectedActorId, waypointFrame }),
        [frame, visualizationMap, historyMode, selectedActorId, waypointFrame]);
}
