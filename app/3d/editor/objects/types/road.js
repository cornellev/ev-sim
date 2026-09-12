/**
 * Road objects reference edges in the canonical road topology table. Options
 * are projected from the edge record. The transform binding reads the edge
 * midpoint and plans node moves for both endpoints; a planner dedupes nodes
 * shared with other edges so each moves exactly once. Curve handles arrive
 * with ED-04; explicit lanes with ED-05 (`edge.lanes`), which make the lane
 * count and travel-direction fields derived.
 */

import { ObjectOptions, boolean, enumOf, field, finite, integer, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { applyDeltaToPoint, applyDeltaToVector, decomposeDelta } from "../transformDelta.js";
import { TRANSFORM_ISSUE_CODES } from "../transformDelta.js";
import { ROAD_MARKINGS, cloneRoadLanes, scaleRoadLanesToWidth, validateRoadLaneLayout } from "../../../../roads/RoadLaneModel.js";

export const ROAD_TYPE_ID = "road";
export const ROAD_BORDER_MARKINGS = ROAD_MARKINGS;
export const ROAD_OPTION_ISSUE_CODES = Object.freeze({ LANE_LAYOUT: "option.lane-layout" });

/** Fields derived from explicit lane records; hidden and read-only once lanes are authored. */
const LANE_DERIVED_FIELDS = new Set(["laneCount", "bidirectional", "direction"]);

const ROAD_FIELDS = Object.freeze([
    field({ path: ["width"], label: "Width", control: "number", units: "m", min: 0.5, step: 0.1, group: "Cross-section" }),
    field({ path: ["laneCount"], label: "Lanes", control: "number", min: 1, max: 8, step: 1, group: "Cross-section" }),
    field({ path: ["shoulderWidth"], label: "Shoulder", control: "number", units: "m", min: 0, step: 0.1, group: "Cross-section" }),
    field({ path: ["bidirectional"], label: "Two-way", control: "toggle", group: "Direction" }),
    field({ path: ["direction"], label: "One-way direction", control: "number", min: -1, max: 1, step: 2, group: "Direction", advanced: true }),
    field({ path: ["borderLeft"], label: "Left border", control: "enum", options: ROAD_BORDER_MARKINGS, group: "Markings" }),
    field({ path: ["borderRight"], label: "Right border", control: "enum", options: ROAD_BORDER_MARKINGS, group: "Markings" }),
]);

export function hasExplicitLaneValue(value) {
    return Array.isArray(value?.lanes);
}

export class RoadOptions extends ObjectOptions {
    getDefaults() {
        return { width: 7, laneCount: 2, shoulderWidth: 0, bidirectional: true, direction: 1, borderLeft: "solid_white", borderRight: "solid_white" };
    }

    /**
     * All fields without a value; with an explicit-lane value the derived
     * lane-count and direction fields are hidden so the lane diagram is the
     * single place that edits them.
     */
    getFields(context = {}) {
        if (!hasExplicitLaneValue(context?.value)) return ROAD_FIELDS;
        return ROAD_FIELDS.filter((descriptor) => !LANE_DERIVED_FIELDS.has(descriptor.path[0]));
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        return {
            width: finite(source.width, 7),
            laneCount: integer(source.laneCount, 2),
            shoulderWidth: finite(source.shoulderWidth ?? 0, 0),
            bidirectional: boolean(source.bidirectional, source.oneWay === true ? false : true),
            direction: Number(source.direction ?? source.oneWayDirection ?? 1) === -1 ? -1 : 1,
            borderLeft: enumOf(ROAD_BORDER_MARKINGS)(source.borderLeft, "solid_white"),
            borderRight: enumOf(ROAD_BORDER_MARKINGS)(source.borderRight, "solid_white"),
            ...(Array.isArray(source.lanes) ? { lanes: cloneRoadLanes(source.lanes) } : {}),
        };
    }

    /**
     * Field constraints plus the lane-layout rules, so an illegal layout is a
     * field-level issue in the inspector rather than a late bus rejection.
     */
    validate(value = {}) {
        const issues = validateFieldConstraints(ROAD_FIELDS, value);
        if (value?.direction !== undefined && value.direction !== 1 && value.direction !== -1) {
            issues.push(issue(["direction"], "option.enum", "One-way direction must be 1 or -1."));
        }
        // A Width edit on an explicit-lane road scales the lanes to the new
        // total when applied, so validate the scaled layout rather than the
        // stale sum.
        const candidate = hasExplicitLaneValue(value)
            ? { ...value, lanes: scaleRoadLanesToWidth(value.lanes, value.width) }
            : value ?? {};
        const layout = validateRoadLaneLayout(candidate);
        for (const entry of layout.issues) {
            issues.push(issue(entry.path.length > 0 ? entry.path : ["laneCount"], ROAD_OPTION_ISSUE_CODES.LANE_LAYOUT, entry.message));
        }
        return issues;
    }
}

export function edgeTransformBinding(record) {
    return Object.freeze({
        kind: "legacy-road-edge",
        legacyId: record.id,
        read(edge, context = {}) {
            const start = context.nodes?.get?.(edge?.startNodeId) ?? null;
            const end = context.nodes?.get?.(edge?.endNodeId) ?? null;
            if (!start || !end) return null;
            return {
                position: {
                    x: (finite(start.x, 0) + finite(end.x, 0)) / 2,
                    y: (finite(start.y, 0) + finite(end.y, 0)) / 2,
                    z: (finite(start.z, 0) + finite(end.z, 0)) / 2,
                },
                rotationY: Math.atan2(-(finite(end.z, 0) - finite(start.z, 0)), finite(end.x, 0) - finite(start.x, 0)),
            };
        },
        /** Plan `move-node` steps for both endpoints; any affine delta is a valid point map. */
        plan(delta, context = {}) {
            const edge = context.legacy ?? null;
            const start = context.nodes?.get?.(edge?.startNodeId) ?? null;
            const end = context.nodes?.get?.(edge?.endNodeId) ?? null;
            if (!edge || !start || !end) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Road "${record.id}" is missing its nodes.`, { objectId: record.id })],
                };
            }
            const steps = [
                    { op: "move-node", nodeId: String(edge.startNodeId), position: applyDeltaToPoint(delta, start) },
                    { op: "move-node", nodeId: String(edge.endNodeId), position: applyDeltaToPoint(delta, end) },
                ];
            if (edge.geometry) {
                const geometry = structuredClone(edge.geometry);
                for (const knot of geometry.knots ?? []) {
                    if (knot.position) knot.position = applyDeltaToPoint(delta, knot.position);
                    if (knot.handleIn) knot.handleIn = applyDeltaToVector(delta, knot.handleIn);
                    if (knot.handleOut) knot.handleOut = applyDeltaToVector(delta, knot.handleOut);
                }
                const parts = decomposeDelta(delta);
                steps.push({
                    op: "set-road-geometry",
                    edgeId: String(edge.id),
                    geometry,
                    ...(parts.hasScale && parts.uniformScale ? {
                        width: edge.width * parts.scale.x,
                        shoulderWidth: Number(edge.shoulderWidth ?? 0) * parts.scale.x,
                    } : {}),
                });
            }
            return { steps, issues: [] };
        },
    });
}

export function createRoadType() {
    const options = new RoadOptions();
    return defineObjectType({
        typeId: ROAD_TYPE_ID,
        version: 1,
        label: "Road",
        catalog: { label: "Road", kind: "road", layer: "roads" },
        legacy: { domain: "roads.edges", idField: "id" },
        options,
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        getTransformBinding(record) {
            return edgeTransformBinding(record);
        },
        /**
         * Cross-section and direction edits patch the canonical edge record.
         * With explicit lanes only width, shoulder, and borders are written;
         * the edge mutation scales lane widths to the new total.
         */
        planOptions(record, value) {
            const explicit = hasExplicitLaneValue(value);
            return {
                steps: [{
                    op: "set-edge-options",
                    edgeId: String(record.id),
                    patch: {
                        width: value.width,
                        shoulderWidth: value.shoulderWidth,
                        borderLeft: value.borderLeft,
                        borderRight: value.borderRight,
                        ...(explicit ? {} : {
                            laneCount: value.laneCount,
                            bidirectional: value.bidirectional,
                            direction: value.bidirectional ? null : value.direction,
                        }),
                    },
                }],
                issues: [],
            };
        },
        getDependencies(record, context = {}) {
            const edge = context.legacy ?? null;
            const dependencies = [{ kind: "road-edge", id: record.id }];
            if (edge?.startNodeId) dependencies.push({ kind: "road-node", id: String(edge.startNodeId) });
            if (edge?.endNodeId) dependencies.push({ kind: "road-node", id: String(edge.endNodeId) });
            return dependencies;
        },
    });
}
