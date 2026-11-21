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

const OCCUPANCY_LAYERS = [
    { id: "oracle-occupancy", channel: "oracle", label: "Oracle occupancy" },
    { id: "lidar-occupancy", channel: "lidar", label: "Lidar occupancy" },
    { id: "stack-occupancy", channel: "stack", label: "Stack occupancy" },
];
const TOOL_LAYERS = { controls: "ackermann", trails: "trajectoryPast", localization: "localization", "planned-trajectory": "plannedTrajectory" };

export function PlanView({ data }) {
    const [visibility, setVisibility] = useState(() => defaultVisibility());
    const [historyMode, setHistoryMode] = useState("10s");
    const [following, setFollowing] = useState(true);
    const [followEpoch, setFollowEpoch] = useState(0);
    const [layerPanelOpen, setLayerPanelOpen] = useState(false);
    const [selectedActorId, setSelectedActorId] = useState(() => getPlanSelection());
    const [waypointFrame, setWaypointFrame] = useState("global");
    const [environment, setEnvironment] = useState(() => data?.environment?.()?.getDocument?.()?.snapshot?.() ?? null);

    useEffect(() => subscribePlanSelection(setSelectedActorId), []);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        if (!document?.subscribe) return undefined;
        return document.subscribe((snapshot) => setEnvironment(snapshot));
    }, [data]);

    const frame = usePlanViewFrame(data, { historyMode, selectedActorId, waypointFrame });
    const manager = data?.simulation?.()?.visualizationManager;
    const visualizationMap = frame.visualizationMap;
    const layerVisibility = useMemo(() => ({ ...visibility, ...Object.fromEntries(Object.entries(TOOL_LAYERS)
        .filter(([, toolId]) => visualizationMap.tools[toolId])
        .map(([layerId, toolId]) => [layerId, visualizationMap.tools[toolId].visible])) }), [visibility, visualizationMap]);
    const primitives = useMemo(() => projectPlanView(frame, layerVisibility), [frame, layerVisibility]);
    const ego = frame.vehicles.find((actor) => actor.role === "ego") ?? frame.vehicles[0] ?? null;
    const sensorsOn = isGroupVisible(visibility, "sensors");
    const occupancyTool = visualizationMap.tools.occupancy;
    const occupancyVisibility = Object.fromEntries(OCCUPANCY_LAYERS.map(({ id, channel }) => [channel,
        (occupancyTool?.visible ?? true) && (occupancyTool?.layerVisibility[channel] ?? visibility[id] === true)]));
    const oracleOn = occupancyVisibility.oracle;
    const lidarOn = occupancyVisibility.lidar;
    const stackOn = occupancyVisibility.stack;
    const grids = occupancyTool?.visible ? occupancyTool.output?.grids : null;
    const oracleGrid = oracleOn ? grids?.oracle : null;
    const lidarGrid = lidarOn ? grids?.lidar : null;
    const stackGrid = stackOn ? grids?.stack : null;
    const stackMessage = occupancyTool?.output?.stackMessage || (occupancyTool?.status === "error" ? occupancyTool.message : "");

    useEffect(() => {
        if (!manager?.entries.has("occupancy")) return;
        for (const { channel } of OCCUPANCY_LAYERS) {
            if (manager.tools.occupancy.layerVisibility.map[channel] === undefined) manager.setLayerVisible("occupancy", channel, "map", false);
        }
    }, [manager]);

    const occupancy = [
        oracleGrid ? { key: "oracle", sample: oracleGrid } : null,
        lidarGrid ? { key: "lidar", sample: lidarGrid } : null,
        stackGrid ? { key: "stack", sample: stackGrid } : null,
    ].filter(Boolean);

    return (
        <div className={styles.host}>
            <div className={styles.toolbarAnchor}>
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
                    aria-pressed={waypointFrame === "body"}
                    onClick={() => setWaypointFrame((mode) => (mode === "body" ? "global" : "body"))}
                >
                    {waypointFrame === "body" ? "Path: Car" : "Path: Global"}
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
                                checked={layerVisibility[layer.id] !== false}
                                onChange={() => {
                                    const toolId = TOOL_LAYERS[layer.id];
                                    if (manager?.entries.has(toolId)) manager.setVisible(toolId, "map", layerVisibility[layer.id] === false);
                                    else setVisibility((current) => toggleLayer(current, layer.id));
                                }}
                            />
                            <span>{layer.label}</span>
                        </label>
                    ))}
                    {OCCUPANCY_LAYERS.map((layer) => (
                        <label key={layer.id} className={styles.layerToggle}>
                            <input
                                type="checkbox"
                                checked={occupancyVisibility[layer.channel]}
                                onChange={() => {
                                    const visible = !occupancyVisibility[layer.channel];
                                    if (manager?.entries.has("occupancy")) {
                                        manager.setLayerVisible("occupancy", layer.channel, "map", visible);
                                        if (visible) manager.setVisible("occupancy", "map", true);
                                    }
                                    else setVisibility((current) => ({ ...current, [layer.id]: visible }));
                                }}
                            />
                            <span>{layer.label}</span>
                        </label>
                    ))}
                    {stackOn && stackMessage ? <p className={styles.layerNote}>{stackMessage}</p> : null}
                </div>
            )}
            </div>
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
                {({ toScreen, viewport, size }) => (
                    <PlanViewLayers
                        primitives={primitives}
                        toScreen={toScreen}
                        onSelectActor={setPlanSelection}
                        occupancy={occupancy}
                        viewport={viewport}
                        size={size}
                    />
                )}
            </ScenarioMapViewport>
        </div>
    );
}
