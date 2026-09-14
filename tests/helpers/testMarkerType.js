/**
 * Test-only overlay object type used by ED-01/ED-02 demos and the ED-09
 * extension demonstration. Production code must not import this module.
 */

import { ObjectOptions, defineObjectType, field, validateFieldConstraints } from "../../app/3d/editor/objects/index.js";

export const TEST_MARKER_TYPE_ID = "test.marker";

export class TestMarkerOptions extends ObjectOptions {
    getDefaults() {
        return { label: "marker", radius: 1 };
    }

    getFields() {
        return TEST_MARKER_FIELDS;
    }

    normalize(value = {}) {
        return {
            label: typeof value?.label === "string" ? value.label : "marker",
            radius: Number.isFinite(value?.radius) ? value.radius : 1,
        };
    }

    validate(value) {
        return validateFieldConstraints(TEST_MARKER_FIELDS, value);
    }

    fromLegacy(_legacy, context = {}) {
        return this.normalize(context.record?.components?.marker ?? {});
    }
}

export const TEST_MARKER_FIELDS = Object.freeze([
    field({ path: ["label"], label: "Label", control: "text" }),
    field({ path: ["radius"], label: "Radius", control: "number", units: "m", min: 0.1, max: 10 }),
]);

export function createTestMarkerType({
    typeId = TEST_MARKER_TYPE_ID,
    label = "Marker",
    capabilities = {},
    singleton = false,
    getCapabilities = null,
    compileMetric = null,
    create = null,
} = {}) {
    const options = new TestMarkerOptions();
    return defineObjectType({
        typeId,
        version: 1,
        label,
        catalog: { label, kind: "marker", layer: "props" },
        legacy: null,
        options,
        components: Object.freeze(["marker"]),
        singleton,
        capabilities: { selectable: true, deletable: true, groupable: true, hasOptions: true, ...capabilities },
        ...(getCapabilities ? { getCapabilities } : {}),
        create: create ?? ((input = {}) => {
            return {
                name: input.name ?? label,
                components: { marker: options.normalize(input) },
            };
        }),
        planOptions(record, value) {
            return {
                steps: [{
                    op: "set-object-component",
                    objectId: String(record.id),
                    key: "marker",
                    value: options.normalize(value),
                }],
                issues: [],
            };
        },
        compileMetric: compileMetric ?? ((record) => {
            return { shape: "sphere", radius: record.components.marker?.radius ?? 1 };
        }),
    });
}
