/**
 * Drive-area objects overlay flat paved polygons. Elevation, width, and depth
 * are options. Width and depth rewrite the footprint. Rotation is rejected.
 */

import { ObjectOptions, field, finite, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToPoint, decomposeDelta } from "../transformDelta.js";
import { driveAreaResizeError, measureDriveArea, resizeDriveAreaFootprint } from "../../../../simulation/world/DriveAreas.js";

export const DRIVE_AREA_TYPE_ID = "drive-area";

const SIZE_EPS = 1e-6;

const DRIVE_AREA_FIELDS = Object.freeze([
    field({ path: ["y"], label: "Elevation", control: "number", units: "m", step: 0.1, group: "Surface" }),
    field({ path: ["width"], label: "Width", control: "number", units: "m", step: 0.1, group: "Surface" }),
    field({ path: ["depth"], label: "Depth", control: "number", units: "m", step: 0.1, group: "Surface" }),
]);

export class DriveAreaOptions extends ObjectOptions {
    getDefaults() {
        return { y: 0, width: 2, depth: 2 };
    }

    getFields() {
        return DRIVE_AREA_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        return {
            y: finite(source.y, 0),
            width: finite(source.width, 0),
            depth: finite(source.depth, 0),
        };
    }

    validate(value = {}) {
        return validateFieldConstraints(DRIVE_AREA_FIELDS, value);
    }

    fromLegacy(area) {
        const measured = measureDriveArea(area);
        return {
            y: finite(area?.y, 0),
            width: measured.width,
            depth: measured.depth,
        };
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
            const nextFootprint = footprint.map((point) => {
                const moved = applyDeltaToPoint(delta, { x: finite(point.x, 0), y: 0, z: finite(point.z, 0) });
                return { x: moved.x, z: moved.z };
            });
            const sizeError = driveAreaResizeError(footprint, nextFootprint);
            if (sizeError) {
                return {
                    steps: [],
                    issues: [issue(["transform"], "option.range", sizeError, { objectId: record.id })],
                };
            }
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
        planOptions(record, value, context = {}) {
            const area = context.legacy ?? null;
            const measured = measureDriveArea(area);
            const width = finite(value?.width, measured.width);
            const depth = finite(value?.depth, measured.depth);
            if (Math.abs(width - measured.width) > SIZE_EPS || Math.abs(depth - measured.depth) > SIZE_EPS) {
                try {
                    const footprint = resizeDriveAreaFootprint(area?.footprint, { width, depth });
                    return {
                        steps: [
                            { op: "set-drive-area-footprint", driveAreaId: String(record.id), footprint },
                            { op: "set-drive-area-elevation", driveAreaId: String(record.id), y: value.y },
                        ],
                        issues: [],
                    };
                } catch (error) {
                    return {
                        steps: [],
                        issues: [issue(["width"], "option.range", error.message, { objectId: record.id })],
                    };
                }
            }
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
