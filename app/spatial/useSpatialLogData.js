'use client';

import { useEffect, useMemo, useState } from "react";

import {
    buildSpatialLogModel,
    SPATIAL_LAYER_DEFAULTS,
} from "./spatialLogModel.js";
import {
    loadAutonomySnapshotForDataset,
    loadSpatialEnvironment,
    loadVehicleTrails,
} from "./spatialLogQueries.js";

export function useSpatialLogData(dataset, {
    enabled = true,
    timeUs = 0,
    historyMode = "full",
    layers = SPATIAL_LAYER_DEFAULTS,
    primaryEntityId = null,
    exactSync = false,
    compareTrails = [],
} = {}) {
    const [status, setStatus] = useState("idle");
    const [error, setError] = useState(null);
    const [environment, setEnvironment] = useState(null);
    const [trails, setTrails] = useState([]);
    const [events, setEvents] = useState([]);
    const [autonomy, setAutonomy] = useState(null);

    useEffect(() => {
        if (!enabled || !dataset) return undefined;

        let cancelled = false;
        queueMicrotask(() => {
            if (!cancelled) {
                setStatus("loading");
                setError(null);
            }
        });

        Promise.allSettled([
            loadSpatialEnvironment(dataset),
            loadVehicleTrails(dataset),
            dataset.lazy && !dataset.events?.length
                ? dataset.loadEvents({ limit: 5000 }).then((result) => result.events)
                : Promise.resolve(dataset.events || []),
        ])
            .then((results) => {
                if (cancelled) return;
                const loadedEnvironment = results[0].status === "fulfilled" ? results[0].value : null;
                const loadedTrails = results[1].status === "fulfilled" ? results[1].value : [];
                const loadedEvents = results[2].status === "fulfilled" ? results[2].value : [];
                setEnvironment(loadedEnvironment);
                setTrails(loadedTrails);
                setEvents(loadedEvents);
                setStatus(loadedTrails.length || loadedEnvironment ? "ready" : "empty");
                const failures = results.filter((result) => result.status === "rejected");
                if (failures.length === results.length) {
                    setError(failures[0].reason?.message || "Spatial data could not be loaded.");
                }
            })
            .catch((caught) => {
                if (!cancelled) {
                    setError(caught.message);
                    setStatus("error");
                }
            });

        return () => { cancelled = true; };
    }, [dataset, enabled]);

    useEffect(() => {
        if (!enabled || !dataset || status !== "ready") return undefined;
        let cancelled = false;
        loadAutonomySnapshotForDataset(dataset, timeUs, { exactSync })
            .then((snapshot) => { if (!cancelled) setAutonomy(snapshot); })
            .catch(() => { if (!cancelled) setAutonomy(null); });
        return () => { cancelled = true; };
    }, [dataset, enabled, exactSync, status, timeUs]);

    const mergedTrails = useMemo(
        () => [...(trails || []), ...(compareTrails || [])],
        [compareTrails, trails],
    );

    const model = useMemo(() => buildSpatialLogModel({
        environment,
        resolvedRun: dataset?.resolvedRun,
        route: null,
        trails: mergedTrails,
        events,
        timeUs,
        historyMode,
        layers,
        primaryEntityId,
    }), [environment, dataset?.resolvedRun, mergedTrails, events, timeUs, historyMode, layers, primaryEntityId]);

    return {
        status: !enabled || !dataset ? "idle" : status,
        error,
        model,
        autonomy,
        trails: !enabled || !dataset ? [] : trails,
        events: !enabled || !dataset ? [] : events,
        environment: !enabled || !dataset ? null : environment,
    };
}
