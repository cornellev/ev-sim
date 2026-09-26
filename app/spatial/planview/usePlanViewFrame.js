'use client';

import { useEffect, useRef, useState } from "react";
import { appendPlanTrails, buildPlanViewFrame, emptyPlanViewFrame, planViewSourcesFromData } from "./frame.js";

function frameKey(frame) {
    const actors = frame.vehicles.map((actor) => [
        actor.id,
        actor.position.x.toFixed(2),
        actor.position.z.toFixed(2),
        actor.yaw.toFixed(3),
        actor.speed.toFixed(2),
        actor.offRoad ? 1 : 0,
        actor.colliding ? 1 : 0,
        actor.trail.length,
        actor.route.length,
        actor.routeProgress ?? "",
    ].join(":")).join("|");
    const estimate = frame.localization.estimate;
    return [
        frame.timeNs,
        frame.historyMode,
        frame.selectedActorId ?? "",
        actors,
        frame.sensors.length,
        frame.signals.length,
        frame.lane.points.length,
        frame.perception.oracle.length,
        frame.perception.candidate.length,
        estimate ? `${estimate.x.toFixed(2)},${estimate.z.toFixed(2)}` : "",
        Object.keys(frame.controls).length,
    ].join("~");
}

/**
 * Sample the running simulation on animation frames. The trail buffer lives
 * here so `buildPlanViewFrame` stays a pure copy.
 */
export function usePlanViewFrame(data, { environment = null, historyMode = "10s", selectedActorId = null } = {}) {
    const trailsRef = useRef(new Map());
    const [frame, setFrame] = useState(emptyPlanViewFrame);

    useEffect(() => {
        let raf = 0;
        let lastKey = "";
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const sources = planViewSourcesFromData(data, {
                environment,
                historyMode,
                selectedActorId,
                trails: trailsRef.current,
            });
            appendPlanTrails(trailsRef.current, sources.vehicles, sources.timeNs);
            const next = buildPlanViewFrame(sources);
            const key = frameKey(next);
            if (key === lastKey) return;
            lastKey = key;
            setFrame(next);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [data, environment, historyMode, selectedActorId]);

    return frame;
}
