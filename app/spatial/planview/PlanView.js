'use client';

import { useEffect, useMemo, useState } from "react";
import { IconCurrentLocation, IconLayersIntersect, IconRadar2 } from "@tabler/icons-react";

import ScenarioMapViewport from "../../scenarios/ui/ScenarioMapViewport.js";
import { Button, NativeSelect } from "../../ui";
import { TRAIL_HISTORY_MODES } from "../spatialLogModel.js";
import "./layers/index.js";
import { projectPlanView } from "./project.js";
import { listPlanLayers } from "./registry.js";
import { getPlanSelection, setPlanSelection, subscribePlanSelection } from "./selection.js";
import { defaultVisibility, isGroupVisible, toggleGroup, toggleLayer } from "./visibility.js";
import { PlanViewLayers } from "./PlanViewLayers.js";
import { usePlanViewFrame } from "./usePlanViewFrame.js";
import styles from "./PlanView.module.css";

export function PlanView({ data }) {
    const [visibility, setVisibility] = useState(() => defaultVisibility());
    const [historyMode, setHistoryMode] = useState("10s");
    const [following, setFollowing] = useState(true);
    const [followEpoch, setFollowEpoch] = useState(0);
    const [layerPanelOpen, setLayerPanelOpen] = useState(false);
    const [selectedActorId, setSelectedActorId] = useState(() => getPlanSelection());
    const [environment, setEnvironment] = useState(() => data?.environment?.()?.getDocument?.()?.snapshot?.() ?? null);

    useEffect(() => subscribePlanSelection(setSelectedActorId), []);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        if (!document?.subscribe) return undefined;
        return document.subscribe((snapshot) => setEnvironment(snapshot));
    }, [data]);

    const frame = usePlanViewFrame(data, { environment, historyMode, selectedActorId });
    const primitives = useMemo(() => projectPlanView(frame, visibility), [frame, visibility]);
    const ego = frame.vehicles.find((actor) => actor.role === "ego") ?? frame.vehicles[0] ?? null;
    const sensorsOn = isGroupVisible(visibility, "sensors");

    return (
        <div className={styles.host}>
            <div className={styles.toolbar} data-map-control>
                <NativeSelect
                    aria-label="Trail history window"
                    value={historyMode}
                    onChange={(event) => setHistoryMode(event.target.value)}
                >
                    {TRAIL_HISTORY_MODES.map((mode) => (
                        <option key={mode.id} value={mode.id}>{mode.label}</option>
                    ))}
                </NativeSelect>
                <Button size="compact" aria-pressed={layerPanelOpen} onClick={() => setLayerPanelOpen((open) => !open)}>
                    <IconLayersIntersect size={15} stroke={1.75} />
                    Layers
                </Button>
                <Button
                    size="compact"
                    aria-pressed={following}
                    onClick={() => {
                        setFollowing(true);
                        setFollowEpoch((epoch) => epoch + 1);
                    }}
                >
                    <IconCurrentLocation size={15} stroke={1.75} />
                    Follow
                </Button>
                <Button
                    size="compact"
                    aria-pressed={sensorsOn}
                    onClick={() => setVisibility((current) => toggleGroup(current, "sensors"))}
                >
                    <IconRadar2 size={15} stroke={1.75} />
                    Sensors
                </Button>
            </div>
            {layerPanelOpen && (
                <div className={styles.layers} data-map-control role="group" aria-label="Map layers">
                    {listPlanLayers().map((layer) => (
                        <label key={layer.id} className={styles.layerToggle}>
                            <input
                                type="checkbox"
                                checked={visibility[layer.id] !== false}
                                onChange={() => setVisibility((current) => toggleLayer(current, layer.id))}
                            />
                            <span>{layer.label}</span>
                        </label>
                    ))}
                </div>
            )}
            <ScenarioMapViewport
                environment={environment || { roads: { nodes: [], edges: [] }, buildings: [], features: [] }}
                ariaLabel="Simulation map"
                interaction="pan"
                fill
                className={styles.map}
                followCenter={following && ego ? { x: ego.position.x, z: ego.position.z } : null}
                followEpoch={followEpoch}
                onNavigate={() => setFollowing(false)}
            >
                {({ toScreen }) => (
                    <PlanViewLayers
                        primitives={primitives}
                        toScreen={toScreen}
                        onSelectActor={setPlanSelection}
                    />
                )}
            </ScenarioMapViewport>
        </div>
    );
}
