/**
 * The single Floor object. Its metric value is the document scalar
 * `document.floor`, omitted while disabled so untouched worlds stay unchanged.
 * `collider: false` is stored only when the Rapier plane is off.
 */

import { ObjectOptions, field, validateFieldConstraints } from "../ObjectOptions.js";
import { FLOOR_OBJECT_ID } from "../../../../simulation/world/PrimitiveRecords.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";

export const FLOOR_TYPE_ID = "floor";

const FLOOR_FIELDS = Object.freeze([
    field({ path: ["enabled"], label: "Enabled", control: "toggle", group: "Floor" }),
    field({ path: ["collider"], label: "Collider", control: "toggle", group: "Floor" }),
]);

export class FloorOptions extends ObjectOptions {
    getDefaults() {
        return { enabled: false, collider: true };
    }

    getFields() {
        return FLOOR_FIELDS;
    }

    normalize(value = {}) {
        const enabled = value?.enabled === true;
        return { enabled, collider: enabled && value?.collider !== false };
    }

    validate(value = {}) {
        return validateFieldConstraints(FLOOR_FIELDS, value);
    }

    fromLegacy(floor) {
        return this.normalize(floor ?? { enabled: false });
    }
}

export function createFloorType() {
    const options = new FloorOptions();
    return defineObjectType({
        typeId: FLOOR_TYPE_ID,
        version: 1,
        label: "Floor",
        catalog: { label: "Floor", kind: "floor", layer: "environment" },
        legacy: { domain: "floor", idField: "id" },
        options,
        singleton: FLOOR_OBJECT_ID,
        capabilities: { selectable: true, transformable: false, deletable: false, groupable: false, hasOptions: true },
        create() {
            return { id: FLOOR_OBJECT_ID, name: "Floor" };
        },
        planOptions(_record, value) {
            const enabled = value.enabled === true;
            return {
                steps: [{ op: "set-floor", enabled, collider: enabled && value.collider !== false }],
                issues: [],
            };
        },
    });
}
