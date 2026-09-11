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
    laneCenterPoint,
    laneDividerDescriptors,
    offsetRoadPoint,
    roadIsBidirectional,
    roadIsReversed,
    roadLaneCount,
} from "../../../roads/RoadLaneModel.js";

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

function RoadEdges({ documentSnapshot, viewport, size, layers, mapSelection, showDetail }) {
    if (!layers.roads) return null;

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

function RoadPenDraft({ documentSnapshot, draft, viewport, size }) {
    if (draft?.type !== "road-pen" || !draft.activeNodeId || !draft.cursor) return null;

    const start = documentSnapshot.roads.nodes.find((node) => node.id === draft.activeNodeId);
    if (!start) return null;

    const a = worldToScreen(start, viewport, size);
    const b = worldToScreen(draft.cursor, viewport, size);
    return (
        <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
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
}) {
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
