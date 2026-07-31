'use client';

import { useEffect, useMemo, useState } from "react";
import {
    IconArrowLeft,
    IconArrowRight,
    IconCheck,
    IconFlag3,
    IconMapPin,
    IconRoute,
    IconTrash,
} from "@tabler/icons-react";

import { Button, Field, NativeSelect } from "../../ui";
import { environmentDocumentFrom, projectPointToRoadNetwork } from "../route/index.js";
import ScenarioMapViewport from "./ScenarioMapViewport.js";
import { orderedWaypoints, renumberWaypoints } from "./scenarioUiModel.js";
import styles from "./ScenarioWorkspace.module.css";

function hasRoadGraph(manifest) {
    const document = environmentDocumentFrom(manifest);
    return Array.isArray(document.roads?.edges) && document.roads.edges.length > 0;
}

function waypointLabel(point) {
    if (point.kind === "start") return "S";
    if (point.kind === "finish") return "F";
    return String(point.order);
}

export default function RouteMapEditor({
    route,
    environment,
    onChange,
    onVerify,
    verifying,
    onContinue,
    onClose,
}) {
    const [tool, setTool] = useState(() => route?.waypoints?.some((point) => point.kind === "start") ? "intermediate" : "start");
    const [selectedId, setSelectedId] = useState(null);
    const [placementError, setPlacementError] = useState(null);
    const graphAvailable = useMemo(() => hasRoadGraph(environment), [environment]);
    const waypoints = orderedWaypoints(route?.waypoints || []);
    const selected = waypoints.find((point) => point.id === selectedId) || null;
    const verified = Boolean(route?.verification);

    const removeSelected = () => {
        if (!selectedId) return;
        const next = renumberWaypoints((route?.waypoints || []).filter((point) => point.id !== selectedId));
        onChange({ ...route, waypoints: next, verification: null });
        setSelectedId(null);
    };

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key !== "Delete" || !selectedId) return;
            if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
            event.preventDefault();
            removeSelected();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    });

    const place = (authoredPosition) => {
        if (!graphAvailable) return;
        const projection = projectPointToRoadNetwork({ ...authoredPosition, y: 0 }, environment);
        if (!projection) {
            setPlacementError("Waypoints must sit on a road or intersection.");
            return;
        }
        const snapped = {
            authoredPosition: { ...authoredPosition, y: 0 },
            position: { ...projection.point },
            anchor: {
                kind: projection.kind,
                id: projection.nodeId ?? projection.edgeId,
                fraction: projection.t ?? 0,
            },
        };
        setPlacementError(null);
        const ids = new Set(waypoints.map((point) => point.id));
        let nextIndex = waypoints.length + 1;
        while (ids.has(`waypoint-${nextIndex}`)) nextIndex += 1;
        const nextPoint = {
            id: `waypoint-${nextIndex}`,
            kind: tool,
            order: tool === "intermediate" ? waypoints.filter((point) => point.kind === "intermediate").length + 1 : 0,
            heading: 0,
            ...snapped,
        };
        let next = route?.waypoints || [];
        if (tool === "start" || tool === "finish") next = next.filter((point) => point.kind !== tool);
        next = renumberWaypoints([...next, nextPoint]);
        onChange({ ...route, waypoints: next, verification: null });
        setSelectedId(nextPoint.id);
        if (tool === "start") setTool("intermediate");
    };

    const reorder = (order) => {
        if (!selected || selected.kind !== "intermediate") return;
        const middle = waypoints.filter((point) => point.kind === "intermediate" && point.id !== selected.id);
        const index = Math.max(0, Math.min(middle.length, Number(order) - 1));
        middle.splice(index, 0, selected);
        const start = waypoints.find((point) => point.kind === "start");
        const finish = waypoints.find((point) => point.kind === "finish");
        onChange({ ...route, waypoints: renumberWaypoints([start, ...middle, finish].filter(Boolean)), verification: null });
    };

    const pathPoints = route?.verification?.polyline
        || route?.verification?.sections?.flatMap((section, index) => index ? section.polyline?.slice(1) || [] : section.polyline || [])
        || [];

    return (
        <section className={styles.routeEditor} aria-label={`${route?.name || "Actor"} route editor`}>
            <div className={styles.mapToolbar}>
                <Button size="compact" onClick={onClose} aria-label="Back to routes"><IconArrowLeft size={14} stroke={1.75} /> Routes</Button>
                <div className={styles.toolGroup} aria-label="Waypoint placement tool">
                    <button type="button" data-active={tool === "start" || undefined} onClick={() => setTool("start")}>
                        <IconMapPin size={14} stroke={1.75} /> Start
                    </button>
                    <button type="button" data-active={tool === "intermediate" || undefined} onClick={() => setTool("intermediate")}>
                        <IconRoute size={14} stroke={1.75} /> Waypoint
                    </button>
                    <button type="button" data-active={tool === "finish" || undefined} onClick={() => setTool("finish")}>
                        <IconFlag3 size={14} stroke={1.75} /> Finish
                    </button>
                </div>
                <span className={styles.mapHint}>Click to place · drag to pan · scroll to zoom.</span>
                <div className={styles.mapActions}>
                    <Button size="compact" onClick={onVerify} loading={verifying} disabled={waypoints.length < 2}>
                        <IconCheck size={14} stroke={1.75} /> Verify
                    </Button>
                    <Button size="compact" variant="primary" onClick={onContinue} disabled={!verified}>
                        Continue <IconArrowRight size={14} stroke={1.75} />
                    </Button>
                </div>
            </div>

            <div className={styles.mapStage}>
                <ScenarioMapViewport
                    environment={environment}
                    ariaLabel={`Road map for placing ${route?.name || "the actor route"}`}
                    interaction="place"
                    onPlace={place}
                >
                    {({ toScreen }) => (
                        <>
                            {pathPoints.length > 1 && (
                                <polyline
                                    className={styles.verifiedPath}
                                    points={pathPoints.map((point) => {
                                        const screen = toScreen(point);
                                        return `${screen.x},${screen.y}`;
                                    }).join(" ")}
                                />
                            )}
                            <g>
                                {waypoints.map((point) => {
                                    const screen = toScreen(point.position);
                                    return (
                                        <g
                                            key={point.id}
                                            className={styles.mapWaypoint}
                                            data-map-interactive
                                            data-kind={point.kind}
                                            data-selected={point.id === selectedId || undefined}
                                            role="button"
                                            tabIndex="0"
                                            aria-label={`${point.kind} ${waypointLabel(point)}`}
                                            onPointerDown={(event) => { event.stopPropagation(); setSelectedId(point.id); }}
                                            onKeyDown={(event) => { if (["Enter", " "].includes(event.key)) setSelectedId(point.id); }}
                                        >
                                            <circle cx={screen.x} cy={screen.y} r="16" />
                                            <text x={screen.x} y={screen.y + 1}>{waypointLabel(point)}</text>
                                        </g>
                                    );
                                })}
                            </g>
                        </>
                    )}
                </ScenarioMapViewport>

                {!graphAvailable && (
                    <div className={styles.mapEmpty}>
                        <IconRoute size={23} stroke={1.45} aria-hidden="true" />
                        <strong>No authored road graph</strong>
                        <p>Add roads in the Environment Editor before placing this route.</p>
                    </div>
                )}

                {placementError && <div className={styles.placementError} role="status">{placementError}</div>}

                <aside className={styles.waypointInspector} aria-label="Selected waypoint">
                    <span className={styles.eyebrow}>Waypoint inspector</span>
                    {selected ? (
                        <>
                            <div className={styles.inspectorTitle}>
                                <strong>{selected.kind === "intermediate" ? `Waypoint ${selected.order}` : selected.kind}</strong>
                                <button type="button" onClick={removeSelected} aria-label="Remove selected waypoint"><IconTrash size={14} stroke={1.75} /></button>
                            </div>
                            <dl className={styles.coordinateList}>
                                <div><dt>X</dt><dd>{selected.position.x.toFixed(2)} m</dd></div>
                                <div><dt>Z</dt><dd>{selected.position.z.toFixed(2)} m</dd></div>
                                <div><dt>Anchor</dt><dd>{selected.anchor.kind}</dd></div>
                            </dl>
                            {selected.kind === "intermediate" && (
                                <Field label="Route number">
                                    <NativeSelect value={selected.order} onChange={(event) => reorder(event.target.value)}>
                                        {waypoints.filter((point) => point.kind === "intermediate").map((point, index) => (
                                            <option key={point.id} value={index + 1}>{index + 1}</option>
                                        ))}
                                    </NativeSelect>
                                </Field>
                            )}
                            <small>Press Delete to remove the selected waypoint.</small>
                        </>
                    ) : <p>Select a waypoint to inspect its position and order.</p>}
                </aside>
            </div>
        </section>
    );
}
