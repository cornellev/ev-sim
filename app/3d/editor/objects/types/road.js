/**
 * Road objects reference edges in the canonical road topology table. Options
 * are projected from the edge record. The transform binding reads the edge
 * midpoint and plans node moves for both endpoints; a planner dedupes nodes
 * shared with other edges so each moves exactly once. Curve handles arrive
 * with ED-04.
 */

import { ObjectOptions, boolean, field, finite, integer, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { applyDeltaToPoint } from "../transformDelta.js";
import { TRANSFORM_ISSUE_CODES } from "../transformDelta.js";

export const ROAD_TYPE_ID = "road";

const ROAD_FIELDS = Object.freeze([
    field({ path: ["width"], label: "Width", control: "number", units: "m", min: 0.5, step: 0.1, group: "Cross-section" }),
    field({ path: ["laneCount"], label: "Lanes", control: "number", min: 1, max: 8, step: 1, group: "Cross-section" }),
    field({ path: ["shoulderWidth"], label: "Shoulder", control: "number", units: "m", min: 0, step: 0.1, group: "Cross-section" }),
    field({ path: ["bidirectional"], label: "Two-way", control: "toggle", group: "Direction" }),
    field({ path: ["direction"], label: "One-way direction", control: "number", min: -1, max: 1, step: 2, group: "Direction", advanced: true }),
]);

export class RoadOptions extends ObjectOptions {
    getDefaults() {
        return { width: 7, laneCount: 2, shoulderWidth: 0, bidirectional: true, direction: 1 };
    }

    getFields() {
        return ROAD_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        return {
            width: finite(source.width, 7),
            laneCount: integer(source.laneCount, 2),
            shoulderWidth: finite(source.shoulderWidth ?? 0, 0),
            bidirectional: boolean(source.bidirectional, source.oneWay === true ? false : true),
            direction: Number(source.direction ?? source.oneWayDirection ?? 1) === -1 ? -1 : 1,
        };
    }

    validate(value = {}) {
        const issues = validateFieldConstraints(ROAD_FIELDS, value);
        if (value?.direction !== undefined && value.direction !== 1 && value.direction !== -1) {
            issues.push(issue(["direction"], "option.enum", "One-way direction must be 1 or -1."));
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
            return {
                steps: [
                    { op: "move-node", nodeId: String(edge.startNodeId), position: applyDeltaToPoint(delta, start) },
                    { op: "move-node", nodeId: String(edge.endNodeId), position: applyDeltaToPoint(delta, end) },
                ],
                issues: [],
            };
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
        /** Cross-section and direction edits patch the canonical edge record. */
        planOptions(record, value) {
            return {
                steps: [{
                    op: "set-edge-options",
                    edgeId: String(record.id),
                    patch: {
                        width: value.width,
                        laneCount: value.laneCount,
                        shoulderWidth: value.shoulderWidth,
                        bidirectional: value.bidirectional,
                        direction: value.bidirectional ? null : value.direction,
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
