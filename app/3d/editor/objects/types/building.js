/**
 * Building objects overlay extruded-footprint building records.
 */

import { ObjectOptions, field, finite, integer, isPlainObject, issue, stringList, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToPoint, decomposeDelta } from "../transformDelta.js";

export const BUILDING_TYPE_ID = "building";

const BUILDING_FIELDS = Object.freeze([
    field({ path: ["height"], label: "Height", control: "number", units: "m", min: 0.5, step: 0.5, group: "Shape" }),
    field({ path: ["textureId"], label: "Texture", control: "number", min: 0, step: 1, group: "Appearance", advanced: true }),
]);

export class BuildingOptions extends ObjectOptions {
    getDefaults() {
        return { height: 8, textureId: 0, footprint: [], tags: ["building"] };
    }

    getFields() {
        return BUILDING_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        const footprint = Array.isArray(source.footprint) ? source.footprint : [];
        return {
            height: finite(source.height, 8),
            textureId: integer(source.textureId, 0),
            footprint: footprint
                .filter((point) => isPlainObject(point))
                .map((point) => ({ x: finite(point.x, 0), y: finite(point.y, 0), z: finite(point.z, 0) })),
            tags: stringList(source.tags ?? ["building"]),
        };
    }

    validate(value = {}) {
        const issues = validateFieldConstraints(BUILDING_FIELDS, value);
        if (Array.isArray(value?.footprint) && value.footprint.length > 0 && value.footprint.length < 3) {
            issues.push(issue(["footprint"], "option.range", "Building footprints need at least three points."));
        }
        return issues;
    }
}

export function buildingTransformBinding(record) {
    return Object.freeze({
        kind: "legacy-building",
        legacyId: record.id,
        read(building) {
            const footprint = Array.isArray(building?.footprint) ? building.footprint : [];
            if (footprint.length === 0) return null;
            const sum = footprint.reduce((acc, point) => ({
                x: acc.x + finite(point.x, 0),
                z: acc.z + finite(point.z, 0),
            }), { x: 0, z: 0 });
            return {
                position: { x: sum.x / footprint.length, y: 0, z: sum.z / footprint.length },
                rotationY: 0,
            };
        },
        /**
         * Buildings are ground-authored polygons: yaw, planar translation, and
         * scale bake into the footprint; height follows the Y scale. Pitch or
         * roll is rejected; Y translation is ignored.
         */
        plan(delta, context = {}) {
            const building = context.legacy ?? null;
            const footprint = Array.isArray(building?.footprint) ? building.footprint : [];
            if (footprint.length === 0) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Building "${record.id}" has no footprint.`, { objectId: record.id })],
                };
            }
            const parts = decomposeDelta(delta);
            if (!parts.yawOnly) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED, "Buildings rotate about the vertical axis only.", { objectId: record.id })],
                };
            }
            const nextFootprint = footprint.map((point) => {
                const moved = applyDeltaToPoint(delta, { x: finite(point.x, 0), y: 0, z: finite(point.z, 0) });
                return { x: moved.x, y: finite(point.y, 0), z: moved.z };
            });
            const height = finite(building.height, 0) * (parts.scale.y > 0 ? parts.scale.y : 1);
            return {
                steps: [{ op: "set-building-footprint", buildingId: String(record.id), footprint: nextFootprint, height }],
                issues: [],
            };
        },
    });
}

export function createBuildingType() {
    const options = new BuildingOptions();
    return defineObjectType({
        typeId: BUILDING_TYPE_ID,
        version: 1,
        label: "Building",
        catalog: { label: "Building", kind: "building", layer: "buildings" },
        legacy: { domain: "buildings", idField: "buildingId" },
        options,
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        getTransformBinding(record) {
            return buildingTransformBinding(record);
        },
        /** Height and texture edits patch the building record; footprints go through transforms. */
        planOptions(record, value) {
            return {
                steps: [{ op: "set-building-record", buildingId: String(record.id), patch: { height: value.height, textureId: value.textureId } }],
                issues: [],
            };
        },
        getDependencies(record) {
            return [{ kind: "building", id: record.id }];
        },
    });
}
