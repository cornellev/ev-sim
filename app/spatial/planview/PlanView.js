'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { paintOccupancyCanvas } from "./occupancy/paint.js";
import { PlanOccupancySampler } from "./occupancy/oracleSample.js";
import { PlanLidarSampler } from "./occupancy/lidarSample.js";
import { occupancyImportStatus } from "./occupancy/stackImport.js";
import { usePlanViewFrame } from "./usePlanViewFrame.js";
import styles from "./PlanView.module.css";

const OCCUPANCY_LAYERS = [
    { id: "oracle-occupancy", label: "Oracle occupancy" },
    { id: "lidar-occupancy", label: "Lidar occupancy" },
    { id: "stack-occupancy", label: "Stack occupancy" },
];

function occupancySources(data) {
    const simulation = data?.simulation?.();
    const kernel = simulation?.kernel;
    const resolvedRun = kernel?.resolvedRun ?? null;
    const vehicles = data?.vehicles?.()?.vehicles ?? [];
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const egoVehicle = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === egoId) ?? vehicles[0] ?? null;
    return {
        description: resolvedRun?.world?.description ?? data?.environment?.()?.worldDescription ?? null,
        vehicles,
        resolvedRun,
        obstacles: kernel?.context?.episodeOverlay?.toObstacles?.() ?? [],
        ego: egoVehicle ? { x: Number(egoVehicle.position?.x) || 0, z: Number(egoVehicle.position?.z) || 0 } : null,
        runtime: simulation?.candidateOutputRuntime ?? null,
    };
}

function useOccupancyLayer() {
    const canvasRef = useRef(null);
    const sampleRef = useRef(null);
    const placeKey = useRef("");
    const [place, setPlace] = useState(null);
    const [generation, setGeneration] = useState(0);
    const push = useCallback((sample) => {
        sampleRef.current = sample;
        if (!sample) {
            if (placeKey.current) {
                placeKey.current = "";
                setPlace(null);
            }
            return;
        }
        const key = [sample.originX, sample.originZ, sample.width, sample.height, sample.resolutionM, sample.yawRad || 0].join(":");
        if (key !== placeKey.current) {
            placeKey.current = key;
            setPlace({
                originX: sample.originX,
                originZ: sample.originZ,
                width: sample.width,
                height: sample.height,
                resolutionM: sample.resolutionM,
                yawRad: sample.yawRad || 0,
            });
        }
        if (sample.changed) setGeneration((value) => value + 1);
    }, []);
    useLayoutEffect(() => {
        if (place) paintOccupancyCanvas(canvasRef.current, sampleRef.current);
    }, [place, generation]);
    return { canvasRef, place, push };
}

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

    const frame = usePlanViewFrame(data, { environment, historyMode, selectedActorId, waypointFrame });
    const primitives = useMemo(() => projectPlanView(frame, visibility), [frame, visibility]);
    const ego = frame.vehicles.find((actor) => actor.role === "ego") ?? frame.vehicles[0] ?? null;
    const sensorsOn = isGroupVisible(visibility, "sensors");
    const oracleOn = visibility["oracle-occupancy"] === true;
    const lidarOn = visibility["lidar-occupancy"] === true;
    const stackOn = visibility["stack-occupancy"] === true;
    const { canvasRef: oracleCanvas, place: oraclePlace, push: pushOracle } = useOccupancyLayer();
    const { canvasRef: lidarCanvas, place: lidarPlace, push: pushLidar } = useOccupancyLayer();
    const { canvasRef: stackCanvas, place: stackPlace, push: pushStack } = useOccupancyLayer();
    const oracleSampler = useRef(null);
    const lidarSampler = useRef(null);
    const stackSeen = useRef(null);
    const [stackMessage, setStackMessage] = useState("");

    useEffect(() => {
        if (!oracleOn && !lidarOn && !stackOn) return undefined;
        if (!oracleSampler.current) oracleSampler.current = new PlanOccupancySampler();
        if (!lidarSampler.current) lidarSampler.current = new PlanLidarSampler();
        let raf = 0;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const sources = occupancySources(data);
            if (oracleOn) {
                // shortcut: samples on the UI thread; move the oracle fill to a worker if a new tile hitch shows up
                pushOracle(oracleSampler.current.sample(sources));
            }
            if (lidarOn) pushLidar(lidarSampler.current.sample(sources));
            if (stackOn) {
                const status = occupancyImportStatus(sources.resolvedRun);
                setStackMessage(status.configured ? "" : status.message);
                const imported = status.configured && sources.runtime?.lastOccupancy?.status === "ok"
                    ? sources.runtime.lastOccupancy
                    : null;
                if (imported && imported !== stackSeen.current) {
                    stackSeen.current = imported;
                    pushStack({ ...imported, changed: true });
                } else if (!imported) {
                    stackSeen.current = null;
                    pushStack(null);
                }
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [data, oracleOn, lidarOn, stackOn, pushOracle, pushLidar, pushStack]);

    const occupancy = [
        oracleOn && oraclePlace ? { key: "oracle", sample: oraclePlace, canvasRef: oracleCanvas } : null,
        lidarOn && lidarPlace ? { key: "lidar", sample: lidarPlace, canvasRef: lidarCanvas } : null,
        stackOn && stackPlace ? { key: "stack", sample: stackPlace, canvasRef: stackCanvas } : null,
    ].filter(Boolean);

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
                                checked={visibility[layer.id] !== false}
                                onChange={() => setVisibility((current) => toggleLayer(current, layer.id))}
                            />
                            <span>{layer.label}</span>
                        </label>
                    ))}
                    {OCCUPANCY_LAYERS.map((layer) => (
                        <label key={layer.id} className={styles.layerToggle}>
                            <input
                                type="checkbox"
                                checked={visibility[layer.id] === true}
                                onChange={() => {
                                    const turningOff = visibility[layer.id] === true;
                                    setVisibility((current) => ({ ...current, [layer.id]: current[layer.id] !== true }));
                                    if (layer.id === "stack-occupancy" && turningOff) setStackMessage("");
                                }}
                            />
                            <span>{layer.label}</span>
                        </label>
                    ))}
                    {stackOn && stackMessage ? <p className={styles.layerNote}>{stackMessage}</p> : null}
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
