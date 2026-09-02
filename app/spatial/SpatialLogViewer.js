'use client';

import { useCallback, useId, useMemo, useState } from "react";
import {
    IconLayersIntersect,
    IconMap2,
    IconRoute,
    IconTimeline,
} from "@tabler/icons-react";

import ScenarioMapViewport from "../scenarios/ui/ScenarioMapViewport.js";
import { Button, NativeSelect, StatusMessage } from "../ui";
import SpatialOverlayLayers from "./SpatialOverlayLayers.js";
import { SPATIAL_LAYER_DEFAULTS, TRAIL_HISTORY_MODES } from "./spatialLogModel.js";
import { useSpatialLogData } from "./useSpatialLogData.js";
import styles from "./SpatialLogViewer.module.css";

function normalizeEnvironment(environment) {
    if (!environment) return null;
    return environment;
}

export default function SpatialLogViewer({
    dataset,
    timeUs = 0,
    timeline,
    exactSync = false,
    primaryEntityId = null,
    layers: initialLayers = SPATIAL_LAYER_DEFAULTS,
    historyMode: initialHistoryMode = "full",
    onHistoryModeChange,
    onLayersChange,
    compareTrails = [],
    compact = false,
    className = "",
    emptyDetail = "Record a run with environment.json and vehicle pose channels to populate the map.",
    onAutonomyChange = null,
}) {
    const reactId = useId();
    const [layers, setLayers] = useState(initialLayers);
    const [historyMode, setHistoryMode] = useState(initialHistoryMode);
    const [layerPanelOpen, setLayerPanelOpen] = useState(false);

    const { status, error, model, autonomy } = useSpatialLogData(dataset, {
        enabled: Boolean(dataset),
        timeUs,
        historyMode,
        layers,
        primaryEntityId,
        exactSync,
        compareTrails,
        onAutonomyChange,
    });

    const environment = useMemo(() => normalizeEnvironment(model.environment), [model.environment]);
    const fitKey = useMemo(
        () => `${dataset?.id || "none"}:${model.fitPoints?.length || 0}:${historyMode}`,
        [dataset?.id, historyMode, model.fitPoints?.length],
    );

    const handleSeek = useCallback((nextTimeUs) => {
        if (!Number.isFinite(nextTimeUs)) return;
        timeline?.seek?.(nextTimeUs);
    }, [timeline]);

    const updateLayers = (patch) => {
        setLayers((current) => {
            const next = { ...current, ...patch };
            onLayersChange?.(next);
            return next;
        });
    };

    const updateHistoryMode = (value) => {
        setHistoryMode(value);
        onHistoryModeChange?.(value);
    };

    if (!dataset) {
        return (
            <div className={`${styles.viewer} ${styles.empty} ${className}`.trim()}>
                <div className={styles.emptyCopy}>
                    <IconMap2 size={22} stroke={1.75} aria-hidden="true" />
                    <strong>No log selected</strong>
                    <p>{emptyDetail}</p>
                </div>
            </div>
        );
    }

    return (
        <div className={`${styles.viewer} ${compact ? styles.compact : ""} ${className}`.trim()} data-status={status}>
            <div className={styles.toolbar} data-map-control>
                <div className={styles.toolbarGroup}>
                    <NativeSelect
                        aria-label="Trail history window"
                        value={historyMode}
                        onChange={(event) => updateHistoryMode(event.target.value)}
                        className={styles.historySelect}
                    >
                        {TRAIL_HISTORY_MODES.map((mode) => (
                            <option key={mode.id} value={mode.id}>{mode.label}</option>
                        ))}
                    </NativeSelect>
                    <Button
                        size="compact"
                        aria-pressed={layerPanelOpen}
                        onClick={() => setLayerPanelOpen((open) => !open)}
                    >
                        <IconLayersIntersect size={15} stroke={1.75} />
                        Layers
                    </Button>
                </div>
                {!compact && (
                    <span className={styles.toolbarHint}>
                        <IconTimeline size={14} stroke={1.75} aria-hidden="true" />
                        Click trail or marker to seek
                    </span>
                )}
            </div>

            {layerPanelOpen && (
                <div className={styles.layerPanel} data-map-control role="group" aria-label="Map layers">
                    {Object.entries({
                        environment: "Environment",
                        route: "Planned route",
                        trails: "Vehicle trails",
                        cursor: "Cursor pose",
                        events: "Events",
                        localization: "EKF estimate",
                        perception: "Perception boxes",
                    }).map(([key, label]) => (
                        <label key={key} className={styles.layerToggle}>
                            <input
                                type="checkbox"
                                checked={Boolean(layers[key])}
                                onChange={(event) => updateLayers({ [key]: event.target.checked })}
                            />
                            <span>{label}</span>
                        </label>
                    ))}
                </div>
            )}

            <div className={styles.mapRegion}>
                {status === "loading" && (
                    <div className={styles.loadingState} aria-live="polite">
                        <div className={styles.loadingSkeleton} />
                        <span>Loading spatial data</span>
                    </div>
                )}
                {error && <StatusMessage tone="danger" title="Spatial data unavailable">{error}</StatusMessage>}
                {status === "empty" && !error && (
                    <div className={styles.emptyCopy}>
                        <IconRoute size={22} stroke={1.75} aria-hidden="true" />
                        <strong>No map geometry in this log</strong>
                        <p>{emptyDetail}</p>
                    </div>
                )}
                {(status === "ready" || (environment && status !== "loading")) && (
                    <ScenarioMapViewport
                        environment={environment || { roads: { nodes: [], edges: [] }, buildings: [], features: [] }}
                        ariaLabel={`Spatial replay map ${reactId}`}
                        interaction="pan"
                        fitPoints={model.fitPoints}
                        fitKey={fitKey}
                        className={styles.mapViewport}
                    >
                        {({ toScreen }) => (
                            <SpatialOverlayLayers
                                model={model}
                                autonomy={autonomy}
                                layers={layers}
                                toScreen={toScreen}
                                onSeek={handleSeek}
                            />
                        )}
                    </ScenarioMapViewport>
                )}
            </div>
        </div>
    );
}
