/**
 * Intersection objects reference junction nodes in the road topology table.
 * A node is a junction when it is marked `kind: "intersection"` or joins more
 * than one edge — the same rule the world compiler uses for intersection discs.
 */

import { ObjectOptions, field, finite, isPlainObject, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";

export const INTERSECTION_TYPE_ID = "intersection";

const INTERSECTION_FIELDS = Object.freeze([
    field({ path: ["x"], label: "X", control: "number", units: "m", step: 0.1, group: "Position", readOnly: true }),
    field({ path: ["y"], label: "Elevation", control: "number", units: "m", step: 0.05, group: "Position" }),
    field({ path: ["z"], label: "Z", control: "number", units: "m", step: 0.1, group: "Position", readOnly: true }),
]);

export class IntersectionOptions extends ObjectOptions {
    getDefaults() {
        return { x: 0, y: 0, z: 0 };
    }

    getFields() {
        return INTERSECTION_FIELDS;
    }

    normalize(value = {}) {
        const source = isPlainObject(value) ? value : {};
        return { x: finite(source.x, 0), y: finite(source.y, 0), z: finite(source.z, 0) };
    }

    validate(value = {}) {
        return validateFieldConstraints(INTERSECTION_FIELDS, value);
    }
}

export function nodeTransformBinding(record) {
    return Object.freeze({
        kind: "legacy-road-node",
        legacyId: record.id,
        read(node) {
            if (!node) return null;
            return {
                position: { x: finite(node.x, 0), y: finite(node.y, 0), z: finite(node.z, 0) },
                rotationY: 0,
            };
        },
    });
}

export function isJunctionNode(node, degree) {
    return node?.kind === "intersection" || (degree ?? 0) > 1;
}

export function createIntersectionType() {
    const options = new IntersectionOptions();
    return defineObjectType({
        typeId: INTERSECTION_TYPE_ID,
        version: 1,
        label: "Intersection",
        catalog: { label: "Intersection", kind: "intersection", layer: "roads" },
        legacy: { domain: "roads.nodes", idField: "id" },
        options,
        capabilities: { selectable: true, transformable: false, deletable: false, groupable: true, hasOptions: true },
        getTransformBinding(record) {
            return nodeTransformBinding(record);
        },
        getDependencies(record) {
            return [{ kind: "road-node", id: record.id }];
        },
    });
}
