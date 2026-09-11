/**
 * Group objects: pure hierarchy containers. ED-01 persists an identity local
 * transform component so ED-02 can attach nested transforms without a schema
 * change; no geometry or metric behavior.
 */

import { ObjectOptions, field, finite, isPlainObject, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";

export const GROUP_TYPE_ID = "group";

export const IDENTITY_TRANSFORM = Object.freeze({
    position: Object.freeze({ x: 0, y: 0, z: 0 }),
    rotationY: 0,
    scale: 1,
});

const GROUP_FIELDS = Object.freeze([
    field({ path: ["position"], label: "Position", control: "vector3", units: "m", group: "Transform" }),
    field({ path: ["rotationY"], label: "Yaw", control: "number", units: "rad", step: 0.01, group: "Transform" }),
    field({ path: ["scale"], label: "Uniform scale", control: "number", min: 0.01, step: 0.01, group: "Transform" }),
]);

export class GroupOptions extends ObjectOptions {
    getDefaults() {
        return structuredClone(IDENTITY_TRANSFORM);
    }

    getFields() {
        return GROUP_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        const position = isPlainObject(source.position) ? source.position : {};
        return {
            position: {
                x: finite(position.x, 0),
                y: finite(position.y, 0),
                z: finite(position.z, 0),
            },
            rotationY: finite(source.rotationY, 0),
            scale: finite(source.scale, 1),
        };
    }

    validate(value = {}) {
        return validateFieldConstraints(GROUP_FIELDS, value);
    }

    /** Groups have no legacy record; the option value lives in `components.transform`. */
    fromLegacy(_legacy, context = {}) {
        return this.normalize(context.record?.components?.transform ?? {});
    }
}

export function createGroupType() {
    const options = new GroupOptions();
    return defineObjectType({
        typeId: GROUP_TYPE_ID,
        version: 1,
        label: "Group",
        catalog: { label: "Group", kind: "group", layer: "environment" },
        legacy: null,
        options,
        components: Object.freeze(["transform"]),
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        create(input = {}) {
            return {
                name: input.name ?? "Group",
                components: { transform: options.normalize(input.transform) },
            };
        },
    });
}
