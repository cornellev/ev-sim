"use client";

import { useEffect, useState } from "react";

import {
    getPerspectiveViewSnapshot,
    subscribePerspectiveView,
} from "./perspectiveViewRegistry.js";

export { attachPerspectiveView, detachPerspectiveView, getPerspectiveViewSnapshot } from "./perspectiveViewRegistry.js";

export function usePerspectiveViewActive() {
    const [active, setActive] = useState(() => getPerspectiveViewSnapshot().active);
    useEffect(() => {
        const sync = () => setActive(getPerspectiveViewSnapshot().active === true);
        sync();
        return subscribePerspectiveView(sync);
    }, []);
    return active;
}
