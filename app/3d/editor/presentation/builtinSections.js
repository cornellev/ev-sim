/**
 * Inspector sections for built-in types beyond the generic fields: the
 * intersection turn-rule matrix, road endpoint elevations, and the sky
 * runtime/local-preview block. Pure descriptors; the React inspector maps
 * `kind` to a component. Registered together with the icons by the browser
 * (`overlay/presentation/builtinPresentations.js`).
 */

import { getIntersectionMovements, getNodeDegree } from "../document/documentMutations.js";
import { INTERSECTION_TYPE_ID } from "../objects/types/intersection.js";
import { ROAD_TYPE_ID } from "../objects/types/road.js";
import { SKYBOX_TYPE_ID } from "../objects/types/skybox.js";
import {
    hasExplicitRoadLanes,
    laneCenterRightOffset,
    laneDividerDescriptors,
    roadLanes,
    roadWidth,
} from "../../../roads/RoadLaneModel.js";

export const SECTION_KINDS = Object.freeze({
    TURN_RULES: "turn-rules",
    ROAD_ENDPOINTS: "road-endpoints",
    ROAD_GEOMETRY: "road-geometry",
    ROAD_DISPLAY: "road-display",
    SKY_PREVIEW: "sky-local-preview",
});

/**
 * Pure cross-section model for the ED-05 `RoadDisplay` lane diagram: lanes
 * right to left (physical index 0 first) with their centre offsets, interior
 * dividers with resolved markings, and the road borders.
 */
export function roadDisplayModel(edge) {
    const lanes = roadLanes(edge).map((lane, index) => ({ ...lane, index, offset: laneCenterRightOffset(edge, index) }));
    return {
        edgeId: String(edge.id),
        explicit: hasExplicitRoadLanes(edge),
        geometryVersion: null,
        width: roadWidth(edge),
        shoulderWidth: Math.max(0, Number(edge.shoulderWidth ?? 0) || 0),
        lanes,
        dividers: laneDividerDescriptors(edge),
        borders: { left: edge.borderLeft ?? null, right: edge.borderRight ?? null },
    };
}

function nodeOf(document, nodeId) {
    return document?.getNode?.(nodeId) ?? document?.roads?.nodes?.find?.((node) => node.id === nodeId) ?? null;
}

export function intersectionSections(ctx, defaults) {
    const { record, document } = ctx ?? {};
    if (!record || !document) return defaults;
    const degree = getNodeDegree(document, record.id);
    const movements = getIntersectionMovements(document, record.id);
    const sections = [...defaults];
    if (movements?.incident?.length > 0) {
        sections.push({
            id: "turn-rules",
            title: "Allowed movements",
            kind: SECTION_KINDS.TURN_RULES,
            nodeId: String(record.id),
            connectedRoads: degree,
            movements,
        });
    }
    return sections;
}

export function roadSections(ctx, defaults) {
    const { record, document } = ctx ?? {};
    const edge = record && document ? document.getEdge?.(record.id) ?? null : null;
    if (!edge) return defaults;
    const start = nodeOf(document, edge.startNodeId);
    const end = nodeOf(document, edge.endNodeId);
    return [
        ...defaults,
        {
            id: "road-display",
            title: "Lanes",
            kind: SECTION_KINDS.ROAD_DISPLAY,
            ...roadDisplayModel(edge),
            geometryVersion: Number(document.roads?.geometryVersion ?? 1),
        },
        {
            id: "road-endpoints",
            title: "Endpoints",
            kind: SECTION_KINDS.ROAD_ENDPOINTS,
            edgeId: String(record.id),
            start: start ? { id: String(start.id), y: Number(start.y) || 0, junction: start.kind === "intersection" || getNodeDegree(document, start.id) > 1 } : null,
            end: end ? { id: String(end.id), y: Number(end.y) || 0, junction: end.kind === "intersection" || getNodeDegree(document, end.id) > 1 } : null,
        },
        {
            id: "road-geometry",
            title: "Geometry",
            kind: SECTION_KINDS.ROAD_GEOMETRY,
            edgeId: String(record.id),
        },
    ];
}

export function skyboxSections(ctx, defaults) {
    return [...defaults, { id: "sky-local-preview", title: "Runtime", kind: SECTION_KINDS.SKY_PREVIEW }];
}

/** `typeId → getInspectorSections(ctx, defaults)` for the built-in types with extra sections. */
export const BUILTIN_SECTION_PROVIDERS = Object.freeze({
    [INTERSECTION_TYPE_ID]: intersectionSections,
    [ROAD_TYPE_ID]: roadSections,
    [SKYBOX_TYPE_ID]: skyboxSections,
});
