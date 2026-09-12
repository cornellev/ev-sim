/**
 * Built-in prop catalog: the single table behind the placement catalog, the
 * world compiler's feature geometry, editor collision radii, LiDAR semantic
 * labels, and the `builtin-prop` object type.
 *
 * This file is a leaf. Kernel consumers (`WorldDescription`, `LidarGeometry`)
 * import the frozen tables below and never the registry, so `worldHash`
 * depends on static data rather than on registration order. Values are the
 * verbatim contents of the tables these replaced; changing them is a metric
 * contract change.
 */

import {
    issue,
    ObjectOptions,
    enumOf,
    field,
    finite,
    integer,
    stringList,
    validateFieldConstraints,
} from "../ObjectOptions.js";
import { defineObjectType, NO_TRANSFORM_BINDING } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToPoint, decomposeDelta } from "../transformDelta.js";

export const BUILTIN_PROP_TYPE_ID = "builtin-prop";
export const DEFAULT_MAP_COLOR = "#a1a1aa";
export const DEFAULT_FEATURE_RADIUS = 0.6;

export const BUILTIN_PROP_ASSETS = Object.freeze([
    Object.freeze({
        id: "stop-sign",
        label: "Stop Sign",
        kind: "sign",
        layer: "props",
        mapColor: "#ef4444",
        constructorName: "StopSign",
        metric: Object.freeze({
            size: Object.freeze({ x: 0.0508, y: 2.1336, z: 0.9144 }),
            centerY: 1.0668,
            directional: true,
            collisionRadius: 0.4,
            semanticLabel: "sign",
        }),
    }),
    Object.freeze({
        id: "one-way-sign",
        label: "One Way",
        kind: "sign",
        layer: "props",
        mapColor: "#38bdf8",
        constructorName: "OneWaySign",
        metric: Object.freeze({
            size: Object.freeze({ x: 0.0254, y: 0.3048, z: 0.6096 }),
            centerY: 1.9812,
            directional: true,
            collisionRadius: 0.4,
            semanticLabel: "sign",
        }),
    }),
    Object.freeze({
        id: "barrel",
        label: "Barrel",
        kind: "barrel",
        layer: "props",
        mapColor: "#f97316",
        constructorName: "Barrel",
        metric: Object.freeze({
            size: Object.freeze({ x: 0.75, y: 1, z: 0.75 }),
            centerY: 0.5,
            directional: false,
            collisionRadius: 0.5,
            semanticLabel: null,
        }),
    }),
    Object.freeze({
        id: "tire",
        label: "Tire",
        kind: "tire",
        layer: "props",
        mapColor: "#71717a",
        constructorName: "Tire",
        metric: Object.freeze({
            size: Object.freeze({ x: 0.44, y: 0.12, z: 0.44 }),
            centerY: 0.06,
            directional: false,
            collisionRadius: 0.3,
            semanticLabel: null,
        }),
    }),
    Object.freeze({
        id: "cone",
        label: "Cone",
        kind: "cone",
        layer: "props",
        mapColor: "#f97316",
        constructorName: "Cone",
        metric: Object.freeze({
            size: Object.freeze({ x: 0.36, y: 0.7, z: 0.36 }),
            centerY: 0.35,
            directional: false,
            collisionRadius: 0.25,
            semanticLabel: null,
        }),
    }),
]);

export const BUILTIN_PROP_IDS = Object.freeze(BUILTIN_PROP_ASSETS.map((asset) => asset.id));

const ASSETS_BY_ID = new Map(BUILTIN_PROP_ASSETS.map((asset) => [asset.id, asset]));

export function getBuiltinPropAsset(assetId) {
    return ASSETS_BY_ID.get(assetId) ?? null;
}

function tableOf(project) {
    return Object.freeze(Object.fromEntries(BUILTIN_PROP_ASSETS.map((asset) => [asset.id, project(asset)])));
}

/** World-description feature geometry: `{ size, centerY, directional? }` per prop id. */
export const FEATURE_GEOMETRY_BY_TYPE = tableOf((asset) => Object.freeze({
    size: asset.metric.size,
    centerY: asset.metric.centerY,
    ...(asset.metric.directional ? { directional: true } : {}),
}));

/** Editor collision radius per prop id (metres). */
export const FEATURE_RADIUS_BY_TYPE = tableOf((asset) => asset.metric.collisionRadius);

/** LiDAR semantic label override per prop id; `null` falls back to tags. */
export const FEATURE_SEMANTIC_LABEL_BY_TYPE = tableOf((asset) => asset.metric.semanticLabel);

export function featureSemanticLabel(sourceType) {
    return FEATURE_SEMANTIC_LABEL_BY_TYPE[sourceType] ?? null;
}

const assetIdOf = enumOf(BUILTIN_PROP_IDS);

export class BuiltinPropOptions extends ObjectOptions {
    getDefaults() {
        return { assetId: BUILTIN_PROP_IDS[0], x: 0, z: 0, dir: 0, rotationY: 0, tags: [] };
    }

    getFields() {
        return BUILTIN_PROP_FIELDS;
    }

    normalize(value = {}) {
        const source = value ?? {};
        return {
            assetId: assetIdOf(source.assetId ?? source.type, BUILTIN_PROP_IDS[0]),
            x: finite(source.x, 0),
            z: finite(source.z, 0),
            dir: integer(source.dir, 0),
            rotationY: finite(source.rotationY, 0),
            tags: stringList(source.tags),
        };
    }

    validate(value = {}) {
        return validateFieldConstraints(BUILTIN_PROP_FIELDS, value);
    }

    /** Legacy features store the asset id in `type`. */
    fromLegacy(feature) {
        return this.normalize({ ...feature, assetId: feature?.type });
    }
}

export const BUILTIN_PROP_FIELDS = Object.freeze([
    field({ path: ["assetId"], label: "Asset", control: "enum", options: BUILTIN_PROP_IDS, group: "Prop" }),
    field({ path: ["x"], label: "X", control: "number", units: "m", step: 0.1, group: "Placement" }),
    field({ path: ["z"], label: "Z", control: "number", units: "m", step: 0.1, group: "Placement" }),
    field({ path: ["rotationY"], label: "Yaw", control: "number", units: "rad", step: 0.01, group: "Placement" }),
    field({ path: ["dir"], label: "Facing", control: "number", min: 0, max: 3, step: 1, group: "Placement", advanced: true }),
]);

/** Transform binding over a legacy feature record. */
export function featureTransformBinding(record) {
    return Object.freeze({
        kind: "legacy-feature",
        legacyId: record.id,
        read(feature) {
            if (!feature) return null;
            return {
                position: { x: finite(feature.x, 0), y: 0, z: finite(feature.z, 0) },
                rotationY: finite(feature.rotationY, 0),
            };
        },
        /**
         * Props accept yaw and planar translation. Scale is rejected (props
         * have no scale field); Y translation is ignored (ground-authored).
         */
        plan(delta, context = {}) {
            const feature = context.legacy ?? null;
            if (!feature) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Prop "${record.id}" has no feature record.`, { objectId: record.id })],
                };
            }
            const parts = decomposeDelta(delta);
            const issues = [];
            if (!parts.yawOnly) {
                issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED, "Props rotate about the vertical axis only.", { objectId: record.id }));
            }
            if (parts.hasScale) {
                issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.SCALE_UNSUPPORTED, "Props cannot be scaled.", { objectId: record.id }));
            }
            if (issues.length > 0) return { steps: [], issues };
            const moved = applyDeltaToPoint(delta, { x: finite(feature.x, 0), y: 0, z: finite(feature.z, 0) });
            return {
                steps: [{
                    op: "set-feature-transform",
                    featureId: String(record.id),
                    x: moved.x,
                    z: moved.z,
                    rotationY: finite(feature.rotationY, 0) + parts.rotationY,
                }],
                issues: [],
            };
        },
    });
}

export function createBuiltinPropType() {
    const options = new BuiltinPropOptions();
    return defineObjectType({
        typeId: BUILTIN_PROP_TYPE_ID,
        version: 1,
        label: "Prop",
        catalog: { label: "Prop", kind: "prop", layer: "props" },
        legacy: { domain: "features", idField: "id" },
        options,
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        create(input = {}) {
            const requestedAssetId = input.assetId ?? input.type;
            if (requestedAssetId !== undefined && !ASSETS_BY_ID.has(requestedAssetId)) {
                const error = new TypeError(`Unknown prop asset "${requestedAssetId}". Valid: ${BUILTIN_PROP_IDS.join(", ")}.`);
                error.issues = [{ path: ["assetId"], code: "option.enum", message: error.message, severity: "error" }];
                throw error;
            }
            const normalized = options.normalize(input);
            const issues = options.validate(normalized);
            if (issues.some((entry) => entry.severity === "error")) {
                const error = new TypeError(issues[0].message);
                error.issues = issues;
                throw error;
            }
            const asset = getBuiltinPropAsset(normalized.assetId);
            return {
                legacy: {
                    id: input.id,
                    type: normalized.assetId,
                    x: normalized.x,
                    z: normalized.z,
                    dir: normalized.dir,
                    rotationY: normalized.rotationY,
                    tags: normalized.tags.length > 0 ? normalized.tags : [normalized.assetId],
                },
                name: input.name ?? asset.label,
            };
        },
        getTransformBinding(record) {
            return record ? featureTransformBinding(record) : NO_TRANSFORM_BINDING;
        },
        /** Asset, placement, and facing edits patch the feature record (`type` is the asset id). */
        planOptions(record, value) {
            return {
                steps: [{
                    op: "set-feature-record",
                    featureId: String(record.id),
                    patch: { type: value.assetId, x: value.x, z: value.z, rotationY: value.rotationY, dir: value.dir },
                }],
                issues: [],
            };
        },
        getDependencies(record) {
            return [{ kind: "feature", id: record.id }];
        },
        compileMetric(record, context = {}) {
            const feature = context.legacy ?? null;
            const asset = getBuiltinPropAsset(feature?.type);
            return asset ? { ...asset.metric } : null;
        },
    });
}
