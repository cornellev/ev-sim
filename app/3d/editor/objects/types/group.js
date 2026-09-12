/**
 * Group objects: hierarchy containers whose `transform` component is a world
 * pivot frame (position, yaw, uniform scale). A group gesture bakes its world
 * delta into descendants' legacy records and composes it into this frame, so
 * the frame follows the group without becoming a second source of truth for
 * child placement. No geometry or metric behavior.
 */

import { ObjectOptions, field, finite, isPlainObject, issue, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, applyDeltaToFrame, decomposeDelta } from "../transformDelta.js";

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

/** Frame binding: reads the pivot component and plans its composition with a delta. */
export function groupFrameBinding(record, options = new GroupOptions()) {
    return Object.freeze({
        kind: "group-frame",
        legacyId: null,
        read(_legacy, context = {}) {
            const frame = options.normalize((context.record ?? record)?.components?.transform ?? {});
            return { position: { ...frame.position }, rotationY: frame.rotationY, scale: frame.scale };
        },
        plan(delta, context = {}) {
            const current = context.record ?? record;
            const parts = decomposeDelta(delta);
            const issues = [];
            if (!parts.yawOnly) {
                issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED, "Groups rotate about the vertical axis only.", { objectId: current.id }));
            }
            if (!parts.uniformScale) {
                issues.push(issue(["transform"], TRANSFORM_ISSUE_CODES.NON_UNIFORM_SCALE, "Groups scale uniformly only.", { objectId: current.id }));
            }
            if (issues.length > 0) return { steps: [], issues };
            const frame = options.normalize(current?.components?.transform ?? {});
            return {
                steps: [{
                    op: "set-object-component",
                    objectId: String(current.id),
                    key: "transform",
                    value: options.normalize(applyDeltaToFrame(delta, frame)),
                }],
                issues: [],
            };
        },
    });
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
        getTransformBinding(record) {
            return groupFrameBinding(record, options);
        },
    });
}
