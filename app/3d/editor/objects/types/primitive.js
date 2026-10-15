/**
 * Parametric solids: box, sphere, cylinder, cone, and pyramid. Geometry lives
 * in `document.primitives`. The overlay record only names and parents it.
 */

import { issue, ObjectOptions, enumOf, field, finite, stringList, validateFieldConstraints } from "../ObjectOptions.js";
import { defineObjectType } from "../ObjectTypeRegistry.js";
import { TRANSFORM_ISSUE_CODES, decomposeDelta, multiplyDeltas, normalizeDelta } from "../transformDelta.js";
import {
    DEFAULT_PRIMITIVE_COLOR,
    PRIMITIVE_SHAPES,
    defaultPrimitiveCenter,
    defaultPrimitiveSize,
    normalizePrimitiveRecord,
    primitiveLabel,
} from "../../../../simulation/world/PrimitiveRecords.js";

export const PRIMITIVE_TYPE_ID = "primitive";

const shapeOf = enumOf(PRIMITIVE_SHAPES);

const PRIMITIVE_FIELDS = Object.freeze([
    field({ path: ["shape"], label: "Shape", control: "enum", options: PRIMITIVE_SHAPES, group: "Solid" }),
    field({ path: ["position"], label: "Position", control: "vector3", units: "m", group: "Transform" }),
    field({ path: ["rotationY"], label: "Yaw", control: "number", units: "rad", step: 0.01, group: "Transform" }),
    field({ path: ["size"], label: "Size", control: "vector3", units: "m", group: "Solid" }),
    field({ path: ["color"], label: "Color", control: "color", group: "Appearance" }),
]);

function frameOf(record) {
    return {
        position: { ...record.position },
        rotationY: record.rotationY,
        scale: { ...record.size },
    };
}

function frameDelta(frame) {
    const c = Math.cos(frame.rotationY);
    const s = Math.sin(frame.rotationY);
    const { scale } = frame;
    return { matrix: [
        c * scale.x, 0, -s * scale.x, 0,
        0, scale.y, 0, 0,
        s * scale.z, 0, c * scale.z, 0,
        frame.position.x, frame.position.y, frame.position.z, 1,
    ] };
}

function matricesMatch(left, right, epsilon = 1e-6) {
    const a = normalizeDelta(left).matrix;
    const b = normalizeDelta(right).matrix;
    return a.every((value, index) => Math.abs(value - b[index]) <= epsilon);
}

function circularSection(shape) {
    return shape === "sphere" || shape === "cylinder" || shape === "cone";
}

export class PrimitiveOptions extends ObjectOptions {
    getDefaults() {
        const shape = "box";
        const size = defaultPrimitiveSize(shape);
        return {
            shape,
            position: defaultPrimitiveCenter(shape, size),
            rotationY: 0,
            size,
            color: DEFAULT_PRIMITIVE_COLOR,
            tags: ["unknown"],
        };
    }

    getFields() {
        return PRIMITIVE_FIELDS;
    }

    normalize(value = {}) {
        const source = value ?? {};
        return normalizePrimitiveRecord({
            id: source.id,
            shape: shapeOf(source.shape, "box"),
            position: source.position,
            rotationY: finite(source.rotationY, 0),
            size: source.size,
            color: source.color,
            tags: stringList(source.tags ?? ["unknown"]),
        });
    }

    validate(value = {}) {
        const issues = validateFieldConstraints(PRIMITIVE_FIELDS, value);
        const size = value?.size;
        if (size && ["x", "y", "z"].some((axis) => !(Number(size[axis]) > 0))) {
            issues.push(issue(["size"], "option.min", "Size must be positive on every axis."));
        }
        if (value?.shape === "sphere" && size && (size.x !== size.y || size.y !== size.z)) {
            issues.push(issue(["size"], "option.scale", "Spheres keep a uniform diameter."));
        }
        if ((value?.shape === "cylinder" || value?.shape === "cone") && size && size.x !== size.z) {
            issues.push(issue(["size"], "option.scale", "Cylinders and cones keep a circular section."));
        }
        if (typeof value?.color === "string" && !/^#[0-9a-f]{6}$/.test(value.color)) {
            issues.push(issue(["color"], "option.type", "Color must be a #rrggbb hex value."));
        }
        return issues;
    }

    fromLegacy(primitive) {
        return this.normalize(primitive ?? {});
    }
}

export function primitiveTransformBinding(record) {
    const options = new PrimitiveOptions();
    return Object.freeze({
        kind: "primitive",
        legacyId: record.id,
        read(primitive) {
            if (!primitive) return null;
            const normalized = options.normalize(primitive);
            return { position: { ...normalized.position }, rotationY: normalized.rotationY };
        },
        plan(delta, context = {}) {
            const primitive = context.legacy ?? null;
            if (!primitive) {
                return {
                    steps: [],
                    issues: [issue(["transform"], TRANSFORM_ISSUE_CODES.MISSING, `Primitive "${record.id}" has no solid record.`, { objectId: record.id })],
                };
            }
            const current = options.normalize(primitive);
            try {
                const composed = multiplyDeltas(delta, frameDelta(frameOf(current)));
                const parts = decomposeDelta(composed);
                const next = options.normalize({
                    ...current,
                    position: parts.translation,
                    rotationY: parts.rotationY,
                    size: parts.scale,
                });
                const section = circularSection(next.shape);
                if (!parts.yawOnly
                    || next.size.x <= 0 || next.size.y <= 0 || next.size.z <= 0
                    || (next.shape === "sphere" && !parts.uniformScale)
                    || (section && Math.abs(parts.scale.x - parts.scale.z) > 1e-6)
                    || !matricesMatch(composed, frameDelta(frameOf(next)))) {
                    throw new RangeError("Transform is outside the primitive domain.");
                }
                return {
                    steps: [{
                        op: "set-primitive-record",
                        primitiveId: String(record.id),
                        record: next,
                    }],
                    issues: [],
                };
            } catch {
                return {
                    steps: [],
                    issues: [issue(
                        ["transform"],
                        nextShapeIssue(current.shape),
                        current.shape === "sphere"
                            ? "Spheres support translation, yaw, and uniform scale."
                            : "Primitives support translation, yaw, and positive scale without shear.",
                        { objectId: record.id },
                    )],
                };
            }
        },
    });
}

function nextShapeIssue(shape) {
    return shape === "sphere" ? TRANSFORM_ISSUE_CODES.NON_UNIFORM_SCALE : TRANSFORM_ISSUE_CODES.ROTATION_UNSUPPORTED;
}

export function createPrimitiveType() {
    const options = new PrimitiveOptions();
    return defineObjectType({
        typeId: PRIMITIVE_TYPE_ID,
        version: 1,
        label: "Primitive",
        catalog: { label: "Primitive", kind: "primitive", layer: "props" },
        legacy: { domain: "primitives", idField: "id" },
        options,
        capabilities: { selectable: true, transformable: true, deletable: true, groupable: true, hasOptions: true },
        create(input = {}) {
            const normalized = options.normalize({
                ...input,
                shape: input.shape ?? input.id,
                position: input.position ?? {
                    x: finite(input.x, 0),
                    y: input.y,
                    z: finite(input.z, 0),
                },
            });
            const issues = options.validate(normalized);
            if (issues.some((entry) => entry.severity !== "warning")) {
                const error = new TypeError(issues[0]?.message ?? "Primitive is invalid.");
                error.issues = issues;
                throw error;
            }
            return {
                legacy: { ...normalized, id: input.id },
                name: input.name ?? primitiveLabel(normalized.shape),
            };
        },
        getTransformBinding(record) {
            return primitiveTransformBinding(record);
        },
        planOptions(record, value) {
            return {
                steps: [{
                    op: "set-primitive-record",
                    primitiveId: String(record.id),
                    record: { ...options.normalize(value), id: String(record.id) },
                }],
                issues: [],
            };
        },
        getDependencies(record) {
            return [{ kind: "primitive", id: record.id }];
        },
        compileMetric(_record, context = {}) {
            return context.legacy ? { shape: context.legacy.shape, size: context.legacy.size } : null;
        },
    });
}
