/**
 * Asset instances pin an immutable asset revision from the catalog (ED-06).
 * ED-01 defines the option contract only; instantiation arrives with the
 * asset repository, so `create()` reports the type as not yet implemented.
 */

import { ObjectOptions, field, finite, isPlainObject, issue, text, validateFieldConstraints } from "../ObjectOptions.js";
import { ObjectTypeError, OBJECT_TYPE_ERROR_CODES, defineObjectType } from "../ObjectTypeRegistry.js";

export const ASSET_INSTANCE_TYPE_ID = "asset-instance";

const ASSET_INSTANCE_FIELDS = Object.freeze([
    field({ path: ["assetId"], label: "Asset", control: "asset-reference", group: "Asset" }),
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
        };
    }

    getFields() {
        return ASSET_INSTANCE_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        const position = isPlainObject(source.position) ? source.position : {};
        const scale = isPlainObject(source.scale) ? source.scale : {};
        return {
            assetId: text(source.assetId),
            revision: Number.isInteger(source.revision) && source.revision > 0 ? source.revision : 1,
            position: { x: finite(position.x, 0), y: finite(position.y, 0), z: finite(position.z, 0) },
            rotationY: finite(source.rotationY, 0),
            scale: { x: finite(scale.x, 1), y: finite(scale.y, 1), z: finite(scale.z, 1) },
        };
    }

    validate(value = {}) {
        const issues = validateFieldConstraints(ASSET_INSTANCE_FIELDS, value);
        if (typeof value?.assetId === "string" && !value.assetId.trim()) {
            issues.push(issue(["assetId"], "option.required", "Asset instances require an asset id."));
        }
        return issues;
    }

    fromLegacy(_legacy, context = {}) {
        return this.normalize(context.record?.components?.asset ?? {});
    }
}

export function createAssetInstanceType() {
    const options = new AssetInstanceOptions();
    return defineObjectType({
        typeId: ASSET_INSTANCE_TYPE_ID,
        version: 1,
        label: "Asset instance",
        catalog: { label: "Asset instance", kind: "asset-instance", layer: "props" },
        legacy: null,
        options,
        components: Object.freeze(["asset"]),
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        create() {
            throw new ObjectTypeError(
                OBJECT_TYPE_ERROR_CODES.NOT_IMPLEMENTED,
                "Asset instances require the asset catalog (ED-06).",
                { typeId: ASSET_INSTANCE_TYPE_ID },
            );
        },
    });
}
