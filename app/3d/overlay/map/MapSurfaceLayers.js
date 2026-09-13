import { useMemo } from "react";
import { getMapColorForAsset } from "../../editor/placement/placementCatalogData.js";
import {
    canMoveNode,
    getEdgeIntersectionConnectors,
    getEdgeRenderEndpoints,
    getIntersectionNodes,
    getEndpointNodes,
} from "../../editor/document/documentMutations.js";
import {
    MAP_WORLD_SCALE,
    worldSizeToScreen,
    worldToScreen,
} from "../../editor/map/mapCoords.js";
import { DEFAULT_ROAD_EDGE } from "../../editor/document/EnvironmentDocument.js";
import { MAP_SELECTION_TYPES } from "../../editor/EditorState.js";
import { DEFAULT_CHUNK_SIZE } from "../../editor/chunks/ChunkIndex.js";
import {
    hasExplicitRoadLanes,
    laneCenterPoint,
    laneDirections,
    laneDividerDescriptors,
    offsetRoadPoint,
    roadIsBidirectional,
    roadIsReversed,
    roadLaneCount,
    roadLanes,
} from "../../../roads/RoadLaneModel.js";
import { planRoadNetworkGeometry } from "../../../roads/RoadNetworkGeometry.js";
import { assetMapFootprint } from "../../editor/map/mapHitTest.js";
import { isAssetBackedObject } from "../../../editor-assets/AssetBackedObject.js";

function screenPoints(points, viewport, size) {
    return points.map((point) => {
        const screen = worldToScreen(point, viewport, size);
        return `${screen.x},${screen.y}`;
    }).join(" ");
}

/** Midpoint polyline between two compiled lateral paths (same deterministic topology). */
function midpointPolyline(left, right) {
    const count = Math.min(left?.length ?? 0, right?.length ?? 0);
    return Array.from({ length: count }, (_, index) => ({
        x: (left[index].x + right[index].x) * 0.5,
        y: (left[index].y + right[index].y) * 0.5,
        z: (left[index].z + right[index].z) * 0.5,
    }));
}

/** Screen-space arrow polygon at a polyline's midpoint pointing along `direction` travel. */
function arrowAlong(points, direction, viewport, size) {
    if (!points || points.length < 2) return null;
    const index = Math.floor((points.length - 1) / 2);
    const from = worldToScreen(points[Math.max(0, index)], viewport, size);
    const to = worldToScreen(points[Math.min(points.length - 1, index + 1)], viewport, size);
    const center = worldToScreen(points[index], viewport, size);
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if (direction === -1) { dx = -dx; dy = -dy; }
    const length = Math.hypot(dx, dy) || 1;
    const tx = dx / length;
    const ty = dy / length;
    const nx = -ty;
    const ny = tx;
    return [
        `${center.x + tx * 6},${center.y + ty * 6}`,
        `${center.x - tx * 4 + nx * 3.5},${center.y - ty * 4 + ny * 3.5}`,
        `${center.x - tx * 4 - nx * 3.5},${center.y - ty * 4 - ny * 3.5}`,
    ].join(" ");
}

/** Divider stroke for an authored marking or the automatic opposing/same-direction style. */
function dividerStroke(divider) {
    const marking = divider.marking ?? (divider.opposing ? "solid_yellow" : "dashed_white");
    if (marking === "none") return null;
    return {
        marking,
        stroke: marking.endsWith("yellow") ? "#facc15" : "#f4f4f5",
        strokeWidth: marking.startsWith("solid") ? 1.5 : 1,
        strokeDasharray: marking.startsWith("dashed") ? "7 6" : undefined,
    };
}

function CompiledRoadEdges({ plan, viewport, size, mapSelection, showDetail }) {
    return plan.edges.map((entry) => {
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.ROAD && mapSelection.id === entry.edge.id;
        const selectedLaneId = selected && mapSelection.sub?.kind === "road-lane" ? mapSelection.sub.laneId : null;
        const surface = entry.surface;
        const polygon = [...surface.leftBoundary, ...[...surface.rightBoundary].reverse()];
        const lanes = roadLanes(entry.edge);
        const centerlines = surface.laneCenterlines ?? [];
        // Lane k is bounded on its right by the divider toward k-1 (or the
        // carriageway edge) and on its left by the divider toward k+1.
        const laneRightBoundary = (index) => (index === 0 ? surface.carriagewayRight : midpointPolyline(centerlines[index - 1], centerlines[index]));
        const laneLeftBoundary = (index) => (index === lanes.length - 1 ? surface.carriagewayLeft : midpointPolyline(centerlines[index], centerlines[index + 1]));
        const dividers = laneDividerDescriptors(entry.edge).map((divider) => ({
            ...divider,
            points: midpointPolyline(centerlines[divider.dividerIndex - 1], centerlines[divider.dividerIndex]),
            style: dividerStroke(divider),
        }));
        const showArrows = showDetail && (selected || !roadIsBidirectional(entry.edge) || hasExplicitRoadLanes(entry.edge));
        const arrows = showArrows ? lanes.flatMap((lane, index) => laneDirections(entry.edge, index).map((direction) => ({
            key: `${lane.id}:${direction}`,
            laneId: lane.id,
            direction,
            points: arrowAlong(centerlines[index], direction, viewport, size),
        }))).filter((arrow) => arrow.points) : [];
        const highlightIndex = selectedLaneId ? lanes.findIndex((lane) => lane.id === selectedLaneId) : -1;
        const highlight = highlightIndex >= 0
            ? [...laneLeftBoundary(highlightIndex), ...[...laneRightBoundary(highlightIndex)].reverse()]
            : null;
        const geometryHandles = selected ? entry.edge.geometry.knots.flatMap((knot, index, knots) => {
            const elements = [];
            const anchor = worldToScreen(knot.position, viewport, size);
            for (const [side, handle] of [["in", knot.handleIn], ["out", knot.handleOut]]) {
                if (!handle || side === "in" && index === 0 || side === "out" && index === knots.length - 1) continue;
                const target = worldToScreen({ x: knot.position.x + handle.x, y: knot.position.y + handle.y, z: knot.position.z + handle.z }, viewport, size);
                elements.push(<line key={`${knot.id}-${side}-line`} x1={anchor.x} y1={anchor.y} x2={target.x} y2={target.y} stroke="#a78bfa" strokeWidth={1} />);
                elements.push(<circle key={`${knot.id}-${side}`} cx={target.x} cy={target.y} r={4} fill="#8b5cf6" stroke="#ede9fe" data-road-handle={`${knot.id}:${side}`} />);
            }
            elements.push(<circle key={`${knot.id}-knot`} cx={anchor.x} cy={anchor.y} r={index === 0 || index === knots.length - 1 ? 4 : 5} fill="#38bdf8" stroke="#e0f2fe" data-road-knot={knot.id} />);
            return elements;
        }) : null;
        return (
            <g key={entry.edge.id} data-road-id={entry.edge.id} data-road-geometry-version="2" data-lane-count={lanes.length} data-lanes-explicit={hasExplicitRoadLanes(entry.edge) || undefined}>
                <polygon points={screenPoints(polygon, viewport, size)} fill={selected ? "#075985" : "#52525b"} stroke="none" />
                {highlight && highlight.length >= 3 && (
                    <polygon data-lane-selected={selectedLaneId} points={screenPoints(highlight, viewport, size)} fill="#0ea5e9" opacity={0.55} stroke="none" />
                )}
                <polyline data-road-boundary points={screenPoints(surface.leftBoundary, viewport, size)} fill="none" stroke="#d4d4d8" strokeWidth={1} />
                <polyline data-road-boundary points={screenPoints(surface.rightBoundary, viewport, size)} fill="none" stroke="#d4d4d8" strokeWidth={1} />
                {dividers.map((divider) => divider.style && divider.points.length >= 2 && (
                    <polyline
                        key={`divider-${divider.dividerIndex}`}
                        data-lane-divider={divider.opposing ? "opposing" : "same-direction"}
                        data-lane-marking={divider.style.marking}
                        points={screenPoints(divider.points, viewport, size)}
                        fill="none"
                        stroke={divider.style.stroke}
                        strokeWidth={divider.style.strokeWidth}
                        strokeDasharray={divider.style.strokeDasharray}
                    />
                ))}
                {arrows.map((arrow) => (
                    <polygon key={arrow.key} data-one-way-arrow data-lane-id={arrow.laneId} data-lane-direction={arrow.direction} points={arrow.points} fill="#f4f4f5" opacity={0.9} />
                ))}
                <polyline points={screenPoints(entry.trimmedSamples.points, viewport, size)} fill="none" stroke={selected ? "#38bdf8" : "transparent"} strokeWidth={2} />
                {geometryHandles}
            </g>
        );
    });
}

function GridLines({ viewport, size, visible }) {
    if (!visible) return null;

    const scale = viewport.zoom * MAP_WORLD_SCALE;
    const startX = Math.floor((viewport.centerX - size.width / scale / 2) / DEFAULT_CHUNK_SIZE) * DEFAULT_CHUNK_SIZE;
    const endX = Math.ceil((viewport.centerX + size.width / scale / 2) / DEFAULT_CHUNK_SIZE) * DEFAULT_CHUNK_SIZE;
    const startZ = Math.floor((viewport.centerZ - size.height / scale / 2) / DEFAULT_CHUNK_SIZE) * DEFAULT_CHUNK_SIZE;
    const endZ = Math.ceil((viewport.centerZ + size.height / scale / 2) / DEFAULT_CHUNK_SIZE) * DEFAULT_CHUNK_SIZE;

    const lines = [];

    for (let x = startX; x <= endX; x += DEFAULT_CHUNK_SIZE) {
        const a = worldToScreen({ x, z: startZ }, viewport, size);
        const b = worldToScreen({ x, z: endZ }, viewport, size);
        lines.push(
            <line
                key={`v-${x}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="rgba(148,163,184,0.15)"
                strokeWidth={x % (DEFAULT_CHUNK_SIZE * 5) === 0 ? 1 : 0.5}
            />,
        );
    }

    for (let z = startZ; z <= endZ; z += DEFAULT_CHUNK_SIZE) {
        const a = worldToScreen({ x: startX, z }, viewport, size);
        const b = worldToScreen({ x: endX, z }, viewport, size);
        lines.push(
            <line
                key={`h-${z}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="rgba(148,163,184,0.15)"
                strokeWidth={z % (DEFAULT_CHUNK_SIZE * 5) === 0 ? 1 : 0.5}
            />,
        );
    }

    return <g className="pointer-events-none">{lines}</g>;
}

function RoadEdges({ documentSnapshot, viewport, size, layers, mapSelection, showDetail, compiledPlan }) {
    if (!layers.roads) return null;
    if (compiledPlan) return <CompiledRoadEdges plan={compiledPlan} viewport={viewport} size={size} mapSelection={mapSelection} showDetail={showDetail} />;

    return documentSnapshot.roads.edges.map((edge) => {
        const endpoints = getEdgeRenderEndpoints(documentSnapshot, edge);
        if (!endpoints) return null;
        const a = worldToScreen(endpoints.startPoint, viewport, size);
        const b = worldToScreen(endpoints.endPoint, viewport, size);
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.ROAD
            && mapSelection.id === edge.id;
        const roadWidthPx = worldSizeToScreen(edge.width ?? DEFAULT_ROAD_EDGE.width, viewport);
        const width = edge.width ?? DEFAULT_ROAD_EDGE.width;
        const boundaries = [-width * 0.5, width * 0.5].map((rightOffset) => {
            const start = worldToScreen(offsetRoadPoint(endpoints.startPoint, endpoints.startPoint, endpoints.endPoint, rightOffset), viewport, size);
            const end = worldToScreen(offsetRoadPoint(endpoints.endPoint, endpoints.startPoint, endpoints.endPoint, rightOffset), viewport, size);
            return { start, end, rightOffset };
        });
        const dividers = laneDividerDescriptors(edge).map((divider) => {
            const start = worldToScreen(offsetRoadPoint(endpoints.startPoint, endpoints.startPoint, endpoints.endPoint, divider.rightOffset), viewport, size);
            const end = worldToScreen(offsetRoadPoint(endpoints.endPoint, endpoints.startPoint, endpoints.endPoint, divider.rightOffset), viewport, size);
            return { ...divider, start, end };
        });
        const arrows = [];
        if (showDetail && !roadIsBidirectional(edge)) {
            const reversed = roadIsReversed(edge);
            const startPoint = reversed ? endpoints.endPoint : endpoints.startPoint;
            const endPoint = reversed ? endpoints.startPoint : endpoints.endPoint;
            for (let laneIndex = 0; laneIndex < roadLaneCount(edge); laneIndex += 1) {
                const center = {
                    x: (endpoints.startPoint.x + endpoints.endPoint.x) * 0.5,
                    y: ((endpoints.startPoint.y ?? 0) + (endpoints.endPoint.y ?? 0)) * 0.5,
                    z: (endpoints.startPoint.z + endpoints.endPoint.z) * 0.5,
                };
                const lanePoint = laneCenterPoint(center, endpoints.startPoint, endpoints.endPoint, edge, laneIndex);
                const screen = worldToScreen(lanePoint, viewport, size);
                const screenStart = worldToScreen(startPoint, viewport, size);
                const screenEnd = worldToScreen(endPoint, viewport, size);
                const dx = screenEnd.x - screenStart.x;
                const dy = screenEnd.y - screenStart.y;
                const length = Math.hypot(dx, dy) || 1;
                const tx = dx / length;
                const ty = dy / length;
                const nx = -ty;
                const ny = tx;
                arrows.push({
                    laneIndex,
                    points: [
                        `${screen.x + tx * 6},${screen.y + ty * 6}`,
                        `${screen.x - tx * 4 + nx * 3.5},${screen.y - ty * 4 + ny * 3.5}`,
                        `${screen.x - tx * 4 - nx * 3.5},${screen.y - ty * 4 - ny * 3.5}`,
                    ].join(" "),
                });
            }
        }
        return (
            <g key={edge.id} data-road-id={edge.id} data-lane-count={roadLaneCount(edge)}>
                <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={selected ? "#38bdf8" : "#52525b"}
                    strokeWidth={roadWidthPx}
                    strokeLinecap="butt"
                />
                {boundaries.map((boundary) => (
                    <line
                        key={`boundary-${boundary.rightOffset}`}
                        data-road-boundary
                        x1={boundary.start.x}
                        y1={boundary.start.y}
                        x2={boundary.end.x}
                        y2={boundary.end.y}
                        stroke="#d4d4d8"
                        strokeWidth={1}
                    />
                ))}
                {dividers.map((divider) => (
                    <line
                        key={`divider-${divider.dividerIndex}`}
                        data-lane-divider={divider.opposing ? "opposing" : "same-direction"}
                        x1={divider.start.x}
                        y1={divider.start.y}
                        x2={divider.end.x}
                        y2={divider.end.y}
                        stroke={divider.opposing ? "#facc15" : "#f4f4f5"}
                        strokeWidth={divider.opposing ? 1.5 : 1}
                        strokeDasharray={divider.opposing ? undefined : "7 6"}
                    />
                ))}
                {arrows.map((arrow) => (
                    <polygon
                        key={`arrow-${arrow.laneIndex}`}
                        data-one-way-arrow
                        points={arrow.points}
                        fill="#f4f4f5"
                        opacity={0.9}
                    />
                ))}
            </g>
        );
    });
}

function RoadConnectors({ documentSnapshot, viewport, size, layers }) {
    if (!layers.roads) return null;
    if (Number(documentSnapshot.roads?.geometryVersion ?? 1) === 2) return null;

    return documentSnapshot.roads.edges.flatMap((edge) => (
        getEdgeIntersectionConnectors(documentSnapshot, edge).map((connector, index) => {
            const arm = worldToScreen(connector.from, viewport, size);
            const center = worldToScreen(connector.to, viewport, size);
            return (
                <line
                    key={`${edge.id}-connector-${connector.nodeId}-${index}`}
                    x1={arm.x}
                    y1={arm.y}
                    x2={center.x}
                    y2={center.y}
                    stroke="#fbbf24"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    opacity={0.95}
                />
            );
        })
    ));
}

function IntersectionNodes({ intersectionNodes, viewport, size, layers, showDetail, mapSelection }) {
    if (!showDetail || !layers.roads) return null;

    return intersectionNodes.map((node) => {
        const screen = worldToScreen(node, viewport, size);
        const sizePx = 10;
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.INTERSECTION
            && mapSelection.id === node.id;
        return (
            <g key={`intersection-${node.id}`}>
                <circle
                    cx={screen.x}
                    cy={screen.y}
                    r={sizePx + (selected ? 7 : 4)}
                    fill={selected ? "rgba(56,189,248,0.15)" : "rgba(245,158,11,0.12)"}
                    stroke={selected ? "rgba(56,189,248,0.5)" : "rgba(245,158,11,0.35)"}
                    strokeWidth={selected ? 2 : 1}
                />
                <rect
                    x={screen.x - sizePx}
                    y={screen.y - sizePx}
                    width={sizePx * 2}
                    height={sizePx * 2}
                    rx={2}
                    fill={selected ? "rgba(56,189,248,0.25)" : "rgba(245,158,11,0.35)"}
                    stroke={selected ? "#38bdf8" : "#f59e0b"}
                    strokeWidth={selected ? 2.5 : 2}
                    transform={`rotate(45 ${screen.x} ${screen.y})`}
                />
                <circle
                    cx={screen.x}
                    cy={screen.y}
                    r={2.5}
                    fill={selected ? "#7dd3fc" : "#fbbf24"}
                    stroke={selected ? "#0c4a6e" : "#78350f"}
                    strokeWidth={0.75}
                />
            </g>
        );
    });
}

function EndpointNodes({ documentSnapshot, endpointNodes, viewport, size, layers, showDetail }) {
    if (!showDetail || !layers.roads) return null;

    return endpointNodes.map((node) => {
        const screen = worldToScreen(node, viewport, size);
        const movable = canMoveNode(documentSnapshot, node.id);
        return (
            <g key={`endpoint-${node.id}`}>
                <circle
                    cx={screen.x}
                    cy={screen.y}
                    r={movable ? 5 : 4}
                    fill={movable ? "#a1a1aa" : "#71717a"}
                    stroke={movable ? "#e4e4e7" : "#27272a"}
                    strokeWidth={movable ? 1.5 : 1}
                />
            </g>
        );
    });
}

function Buildings({ documentSnapshot, viewport, size, layers, mapSelection }) {
    if (!layers.buildings) return null;

    return documentSnapshot.buildings.map((building) => {
        const points = building.footprint
            .map((point) => worldToScreen({ x: point.x, z: point.z }, viewport, size))
            .map((point) => `${point.x},${point.y}`)
            .join(" ");
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.BUILDING
            && mapSelection.id === building.buildingId;
        return (
            <polygon
                key={building.buildingId}
                points={points}
                fill={selected ? "rgba(56,189,248,0.2)" : "rgba(161,161,170,0.25)"}
                stroke={selected ? "#38bdf8" : "#71717a"}
                strokeWidth={selected ? 2 : 1}
            />
        );
    });
}

function Features({ documentSnapshot, viewport, size, layers, showDetail, mapSelection }) {
    if (!showDetail || !layers.props) return null;

    return documentSnapshot.features.map((feature) => {
        const screen = worldToScreen(feature, viewport, size);
        const color = getMapColorForAsset(feature.type);
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.FEATURE
            && mapSelection.id === feature.id;
        return (
            <g key={feature.id}>
                {selected && (
                    <circle
                        cx={screen.x}
                        cy={screen.y}
                        r={9}
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth={2}
                    />
                )}
                <circle
                    cx={screen.x}
                    cy={screen.y}
                    r={selected ? 6 : 5}
                    fill={color}
                    stroke={selected ? "#38bdf8" : "#18181b"}
                    strokeWidth={selected ? 2 : 1}
                />
            </g>
        );
    });
}

function Assets({ documentSnapshot, runtimeAssetBounds, viewport, size, layers, showDetail, mapSelection }) {
    if (!showDetail || !layers.props) return null;
    return (documentSnapshot.objects ?? []).filter(isAssetBackedObject).map((record) => {
        const footprint = assetMapFootprint(record, runtimeAssetBounds?.get?.(String(record.id)) ?? null);
        const points = footprint.map((point) => worldToScreen(point, viewport, size)).map((point) => `${point.x},${point.y}`).join(" ");
        const selected = mapSelection?.type === MAP_SELECTION_TYPES.ASSET && mapSelection.id === String(record.id);
        return (
            <g key={record.id} data-map-asset-id={record.id}>
                <polygon points={points} fill={selected ? "rgba(56,189,248,0.22)" : "rgba(167,139,250,0.2)"} stroke={selected ? "#38bdf8" : "#a78bfa"} strokeWidth={selected ? 2 : 1} />
                {!runtimeAssetBounds?.has?.(String(record.id)) && (() => {
                    const point = worldToScreen(record.components.asset.position, viewport, size);
                    return <circle cx={point.x} cy={point.y} r={3} fill="#a78bfa" />;
                })()}
            </g>
        );
    });
}

function RoadPenDraft({ draft, viewport, size }) {
    if (draft?.type !== "road-stroke" || !draft.points?.length || !draft.cursor) return null;
    const points = [...draft.points, draft.cursor];
    return (
        <polyline
            points={screenPoints(points, viewport, size)}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={2}
            strokeDasharray="6 4"
            opacity={0.8}
        />
    );
}

function BuildingRectDraft({ draft, viewport, size }) {
    if (draft?.type !== "building-rect" || !draft.cornerA || !draft.cornerB) return null;

    const minX = Math.min(draft.cornerA.x, draft.cornerB.x);
    const maxX = Math.max(draft.cornerA.x, draft.cornerB.x);
    const minZ = Math.min(draft.cornerA.z, draft.cornerB.z);
    const maxZ = Math.max(draft.cornerA.z, draft.cornerB.z);
    const corners = [
        { x: minX, z: minZ },
        { x: maxX, z: minZ },
        { x: maxX, z: maxZ },
        { x: minX, z: maxZ },
    ];
    const points = corners
        .map((point) => worldToScreen(point, viewport, size))
        .map((point) => `${point.x},${point.y}`)
        .join(" ");

    return (
        <polygon
            points={points}
            fill="rgba(56,189,248,0.15)"
            stroke="#38bdf8"
            strokeWidth={1.5}
            strokeDasharray="4 3"
        />
    );
}

export function MapSurfaceLayers({
    viewport,
    size,
    layers,
    documentSnapshot,
    mapSelection,
    showDetail,
    draft,
    runtimeAssetBounds,
}) {
    const compiledPlan = useMemo(() => {
        if (Number(documentSnapshot.roads?.geometryVersion ?? 1) !== 2) return null;
        try {
            return planRoadNetworkGeometry(documentSnapshot.roads);
        } catch {
            return null;
        }
    }, [documentSnapshot]);
    const intersectionNodes = useMemo(
        () => getIntersectionNodes(documentSnapshot),
        [documentSnapshot],
    );

    const endpointNodes = useMemo(
        () => getEndpointNodes(documentSnapshot),
        [documentSnapshot],
    );

    return (
        <>
            <rect width={size.width} height={size.height} fill="#09090b" />
            <GridLines viewport={viewport} size={size} visible={viewport.gridVisible} />
            <g data-map-layer="roads">
                <RoadEdges
                    documentSnapshot={documentSnapshot}
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    mapSelection={mapSelection}
                    showDetail={showDetail}
                    compiledPlan={compiledPlan}
                />
            </g>
            <RoadConnectors
                documentSnapshot={documentSnapshot}
                viewport={viewport}
                size={size}
                layers={layers}
            />
            <IntersectionNodes
                intersectionNodes={intersectionNodes}
                viewport={viewport}
                size={size}
                layers={layers}
                showDetail={showDetail}
                mapSelection={mapSelection}
            />
            <EndpointNodes
                documentSnapshot={documentSnapshot}
                endpointNodes={endpointNodes}
                viewport={viewport}
                size={size}
                layers={layers}
                showDetail={showDetail}
            />
            <g data-map-layer="buildings">
                <Buildings
                    documentSnapshot={documentSnapshot}
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    mapSelection={mapSelection}
                />
            </g>
            <g data-map-layer="features">
                <Features
                    documentSnapshot={documentSnapshot}
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    showDetail={showDetail}
                    mapSelection={mapSelection}
                />
            </g>
            <g data-map-layer="assets">
                <Assets
                    documentSnapshot={documentSnapshot}
                    runtimeAssetBounds={runtimeAssetBounds}
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    showDetail={showDetail}
                    mapSelection={mapSelection}
                />
            </g>
            <RoadPenDraft
                documentSnapshot={documentSnapshot}
                draft={draft}
                viewport={viewport}
                size={size}
            />
            <BuildingRectDraft draft={draft} viewport={viewport} size={size} />
        </>
    );
}
