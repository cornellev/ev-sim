/**
 * Drive-area objects overlay flat paved polygons. Elevation is an option;
 * rotation and scale are rejected.
 */

import { ObjectOptions, field, finite, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToPoint, decomposeDelta } from "../transformDelta.js";

export const DRIVE_AREA_TYPE_ID = "drive-area";

const DRIVE_AREA_FIELDS = Object.freeze([
    field({ path: ["y"], label: "Elevation", control: "number", units: "m", step: 0.1, group: "Surface" }),
]);

export class DriveAreaOptions extends ObjectOptions {
    getDefaults() {
        return { y: 0 };
    }

    getFields() {
        return DRIVE_AREA_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        return { y: finite(source.y, 0) };
    }

    validate(value = {}) {
        return validateFieldConstraints(DRIVE_AREA_FIELDS, value);
    }
}

export function driveAreaTransformBinding(record) {
    return Object.freeze({
        kind: "legacy-drive-area",
        legacyId: record.id,
        read(area) {
            const footprint = Array.isArray(area?.footprint) ? area.footprint : [];
            if (footprint.length === 0) return null;
            const sum = footprint.reduce((acc, point) => ({
                x: acc.x + finite(point.x, 0),
                z: acc.z + finite(point.z, 0),
            }), { x: 0, z: 0 });
            return {
                position: { x: sum.x / footprint.length, y: finite(area?.y, 0), z: sum.z / footprint.length },
                rotationY: 0,
            };
        },
        plan(delta, context = {}) {
            const area = context.legacy ?? null;
            const footprint = Array.isArray(area?.footprint) ? area.footprint : [];
            if (footprint.length === 0) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Drive area "${record.id}" has no footprint.`, { objectId: record.id })],
                };
            }
            const parts = decomposeDelta(delta);
            if (parts.hasRotation) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED, "Drive areas cannot rotate.", { objectId: record.id })],
                };
            }
            if (parts.hasScale) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.SCALE_UNSUPPORTED, "Drive areas cannot scale.", { objectId: record.id })],
                };
            }
            const nextFootprint = footprint.map((point) => {
                const moved = applyDeltaToPoint(delta, { x: finite(point.x, 0), y: 0, z: finite(point.z, 0) });
                return { x: moved.x, z: moved.z };
            });
            return {
                steps: [{ op: "set-drive-area-footprint", driveAreaId: String(record.id), footprint: nextFootprint }],
                issues: [],
            };
        },
    });
}

export function createDriveAreaType() {
    const options = new DriveAreaOptions();
    return defineObjectType({
        typeId: DRIVE_AREA_TYPE_ID,
        version: 1,
        label: "Drive area",
        catalog: { label: "Drive area", kind: "drive-area", layer: "roads" },
        legacy: { domain: "driveAreas", idField: "id" },
        options,
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        getTransformBinding(record) {
            return driveAreaTransformBinding(record);
        },
        planOptions(record, value) {
            return {
                steps: [{ op: "set-drive-area-elevation", driveAreaId: String(record.id), y: value.y }],
                issues: [],
            };
        },
        getDependencies(record) {
            return [{ kind: "drive-area", id: record.id }];
        },
    });
}
