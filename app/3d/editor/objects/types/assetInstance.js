/**
 * Asset instances pin an immutable asset revision from the catalog (ED-06).
 * ED-01 defines the option contract only; instantiation arrives with the
 * asset repository, so `create()` reports the type as not yet implemented.
 */

import { ObjectOptions, field, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import {
    normalizeAssetInstanceComponent,
    validateAssetInstanceComponent,
} from "../../../../editor-assets/EditorAssetContract.js";
import { TRANSFORM_ISSUE_CODES, decomposeDelta, multiplyDeltas, normalizeDelta } from "../transformDelta.js";

export const ASSET_INSTANCE_TYPE_ID = "asset-instance";

const ASSET_INSTANCE_FIELDS = Object.freeze([
    field({ path: ["assetId"], label: "Asset", control: "asset-reference", group: "Asset", readOnly: true }),
    field({ path: ["revision"], label: "Revision", control: "number", min: 1, step: 1, group: "Asset", readOnly: true }),
    field({ path: ["position"], label: "Position", control: "vector3", units: "m", group: "Transform" }),
    field({ path: ["rotationY"], label: "Yaw", control: "number", units: "rad", step: 0.01, group: "Transform" }),
    field({ path: ["scale"], label: "Scale", control: "vector3", group: "Transform" }),
]);

export class AssetInstanceOptions extends ObjectOptions {
    getDefaults() {
        return {
            assetId: "",
            revision: 1,
            position: { x: 0, y: 0, z: 0 },
            rotationY: 0,
            scale: { x: 1, y: 1, z: 1 },
            overrides: {},
        };
    }

    getFields() {
        return ASSET_INSTANCE_FIELDS;
    }

    normalize(value = {}) {
        return normalizeAssetInstanceComponent(value);
    }

    validate(value = {}) {
        const fieldIssues = validateFieldConstraints(ASSET_INSTANCE_FIELDS, value);
        if (typeof value?.assetId !== "string" || !value.assetId.trim()) {
            fieldIssues.push(issue(["assetId"], "option.required", "Asset instances require an asset id."));
        }
        const contractIssues = validateAssetInstanceComponent(value).filter((entry) => (
            entry.code !== "editor-asset.id.invalid"
            || !fieldIssues.some((fieldIssue) => fieldIssue.path?.[0] === "assetId")
        ));
        return [...fieldIssues, ...contractIssues];
    }

    fromLegacy(_legacy, context = {}) {
        const value = context.record?.components?.asset;
        if (!isPlainObject(value)) return value;
        const cloned = structuredClone(value);
        if (!("overrides" in cloned)) cloned.overrides = {};
        return cloned;
    }
}

function instanceFrame(value) {
    return {
        position: { ...value.position },
        rotationY: value.rotationY,
        scale: { ...value.scale },
    };
}

function frameDelta(value) {
    const c = Math.cos(value.rotationY);
    const s = Math.sin(value.rotationY);
    return { matrix: [
        c * value.scale.x, 0, -s * value.scale.x, 0,
        0, value.scale.y, 0, 0,
        s * value.scale.z, 0, c * value.scale.z, 0,
        value.position.x, value.position.y, value.position.z, 1,
    ] };
}

function matricesMatch(left, right, epsilon = 1e-6) {
    const a = normalizeDelta(left).matrix;
    const b = normalizeDelta(right).matrix;
    return a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
}

function transformBinding(record, options) {
    return Object.freeze({
        kind: "asset-instance",
        read(_legacy, context = {}) {
            return instanceFrame(options.normalize((context.record ?? record)?.components?.asset ?? {}));
        },
        plan(delta, context = {}) {
            const current = context.record ?? record;
            const previous = options.normalize(current.components?.asset ?? {});
            try {
                const composed = multiplyDeltas(delta, frameDelta(previous));
                const parts = decomposeDelta(composed);
                const next = {
                    ...previous,
                    position: { ...parts.translation },
                    rotationY: parts.rotationY,
                    scale: { ...parts.scale },
                };
                if (!parts.yawOnly
                    || next.scale.x <= 0 || next.scale.y <= 0 || next.scale.z <= 0
                    || !matricesMatch(composed, frameDelta(next))) {
                    throw new RangeError("Transform is outside the asset-instance transform domain.");
                }
                return { steps: [{ op: "set-object-component", objectId: String(current.id), key: "asset", value: next }], issues: [] };
            } catch {
                return {
                    steps: [],
                    issues: [issue(
                        ["transform"],
                        TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED,
                        "Asset instances support translation, yaw, and positive scale without shear.",
                        { objectId: current.id },
                    )],
                };
            }
        },
    });
}

export function createAssetInstanceType(version = 1) {
    if (version !== 1 && version !== 2) throw new TypeError(`Unsupported asset-instance version ${version}.`);
    const options = new AssetInstanceOptions();
    return defineObjectType({
        typeId: ASSET_INSTANCE_TYPE_ID,
        version,
        label: "Asset instance",
        catalog: { label: "Asset instance", kind: "asset-instance", layer: "props" },
        legacy: null,
        options,
        components: Object.freeze(["asset"]),
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        create(input = {}) {
            const asset = options.normalize(input.asset ?? input);
            return { name: input.name ?? asset.assetId, components: { asset } };
        },
        getTransformBinding(record) {
            return transformBinding(record, options);
        },
        getDependencies(record) {
            return [{ kind: "object", id: record.id }];
        },
        planOptions(record, value) {
            return { steps: [{ op: "set-object-component", objectId: String(record.id), key: "asset", value }], issues: [] };
        },
        compileMetric(record, context = {}) {
            if (version === 1) return null;
            const asset = record.components?.asset;
            return context.assetMetrics?.definitions?.find((entry) => (
                entry.assetId === asset?.assetId && entry.revision === asset?.revision
            )) ?? null;
        },
    });
}
