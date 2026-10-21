/**
 * Authoring records for scene primitives and the support-plane floor.
 * Kernel-safe: no Three, DOM, or world-description imports. Color is
 * appearance and stays on the authoring record. The hashed solid is built
 * from shape, center, yaw, and size.
 */

export const PRIMITIVE_SHAPES = Object.freeze(["box", "sphere", "cylinder", "cone", "pyramid"]);
export const DEFAULT_PRIMITIVE_COLOR = "#a3a3a3";
export const FLOOR_OBJECT_ID = "floor";
export const FLOOR_PLANE_Y = 0;

/**
 * Null while the floor is off. The collider stays on unless the record says
 * otherwise, and that default is omitted so existing snapshots stay `{ enabled: true }`.
 */
export function normalizeFloor(floor) {
    if (floor?.enabled !== true) return null;
    return floor.collider === false ? { enabled: true, collider: false } : { enabled: true };
}

const SHAPE_SET = new Set(PRIMITIVE_SHAPES);

export function defaultPrimitiveSize(shape) {
    return { x: 1, y: 1, z: 1, ...(SHAPE_SET.has(shape) ? {} : {}) };
}

export function defaultPrimitiveCenter(shape, size = defaultPrimitiveSize(shape)) {
    return { x: 0, y: Number(size.y) * 0.5, z: 0 };
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? (Object.is(number, -0) ? 0 : number) : fallback;
}

function positive(value, fallback) {
    const number = finite(value, fallback);
    return number > 0 ? number : fallback;
}

function hexColor(value, fallback = DEFAULT_PRIMITIVE_COLOR) {
    const text = String(value ?? "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

/**
 * Canonical primitive record. Sphere diameter is uniform. Cylinder and cone
 * keep a circular section, so depth matches width.
 */
export function normalizePrimitiveRecord(record = {}, index = 0) {
    const shape = SHAPE_SET.has(record?.shape) ? record.shape : "box";
    const fallback = defaultPrimitiveSize(shape);
    let size = {
        x: positive(record?.size?.x, fallback.x),
        y: positive(record?.size?.y, fallback.y),
        z: positive(record?.size?.z, fallback.z),
    };
    if (shape === "sphere") size = { x: size.x, y: size.x, z: size.x };
    if (shape === "cylinder" || shape === "cone") size = { x: size.x, y: size.y, z: size.x };
    const tags = [...new Set((Array.isArray(record?.tags) ? record.tags : ["unknown"]).map(String).filter(Boolean))].sort();
    return {
        id: String(record?.id ?? `primitive-${index + 1}`),
        shape,
        position: {
            x: finite(record?.position?.x, 0),
            y: finite(record?.position?.y, size.y * 0.5),
            z: finite(record?.position?.z, 0),
        },
        rotationY: finite(record?.rotationY, 0),
        size,
        color: hexColor(record?.color),
        tags: tags.length > 0 ? tags : ["unknown"],
    };
}

export function primitiveLabel(shape) {
    const name = SHAPE_SET.has(shape) ? shape : "box";
    return name.charAt(0).toUpperCase() + name.slice(1);
}
