/** World-space triangle bounds for a glTF binary, from accessor min/max. */

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function viewOf(bytes) {
    if (bytes instanceof DataView) return bytes;
    if (bytes instanceof ArrayBuffer) return new DataView(bytes);
    if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new TypeError("GLB bounds require binary bytes.");
}

function multiplyMatrices(left, right) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            for (let inner = 0; inner < 4; inner += 1) {
                result[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
            }
        }
    }
    return result;
}

function trsMatrix(translation, rotation, scale) {
    const [x, y, z, w] = rotation;
    const [sx, sy, sz] = scale;
    const [tx, ty, tz] = translation;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
        (1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0,
        (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0,
        (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

function finiteVector(value, size, label) {
    if (!Array.isArray(value) || value.length !== size || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
        throw new TypeError(`${label} must be ${size} finite numbers.`);
    }
    return value;
}

function nodeLocalMatrix(node) {
    if (Array.isArray(node?.matrix)) return finiteVector(node.matrix, 16, "glTF node matrix");
    const translation = node?.translation ? finiteVector(node.translation, 3, "glTF node translation") : [0, 0, 0];
    const rotation = node?.rotation ? finiteVector(node.rotation, 4, "glTF node rotation") : [0, 0, 0, 1];
    const scale = node?.scale ? finiteVector(node.scale, 3, "glTF node scale") : [1, 1, 1];
    return trsMatrix(translation, rotation, scale);
}

function applyMatrix(matrix, point) {
    const [x, y, z] = point;
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
}

function expand(bounds, point) {
    for (let index = 0; index < 3; index += 1) {
        bounds.min[index] = Math.min(bounds.min[index], point[index]);
        bounds.max[index] = Math.max(bounds.max[index], point[index]);
    }
}

function worldMatrices(json) {
    const nodes = json.nodes ?? [];
    const scene = json.scenes?.[json.scene ?? 0];
    const worlds = new Map();
    const visit = (index, parent, stack) => {
        if (!Number.isInteger(index) || index < 0 || index >= nodes.length) {
            throw new TypeError("glTF scene references a missing node.");
        }
        if (stack.has(index)) throw new TypeError("glTF node hierarchy contains a cycle.");
        stack.add(index);
        const world = multiplyMatrices(parent, nodeLocalMatrix(nodes[index]));
        if (!worlds.has(index)) worlds.set(index, world);
        for (const child of nodes[index].children ?? []) visit(child, world, stack);
        stack.delete(index);
    };
    for (const root of scene?.nodes ?? []) visit(root, IDENTITY, new Set());
    return worlds;
}

function glbJson(bytes) {
    const view = viewOf(bytes);
    if (view.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
        throw new TypeError("Mesh bounds require a glTF 2.0 binary.");
    }
    const length = view.getUint32(8, true);
    if (length > view.byteLength) throw new TypeError("GLB length exceeds the file.");
    let offset = 12;
    while (offset + 8 <= length) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const start = offset + 8;
        if (chunkLength < 0 || start + chunkLength > length) throw new TypeError("GLB chunk exceeds the file.");
        if (chunkType === JSON_CHUNK) {
            const text = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + start, chunkLength));
            return JSON.parse(text);
        }
        offset = start + chunkLength;
    }
    throw new TypeError("GLB is missing a JSON chunk.");
}

/**
 * Axis-aligned bounds of in-scene triangle positions, in the GLB's scene space.
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @returns {{ min: number[], max: number[] } | null}
 */
export function glbTriangleBounds(bytes) {
    const json = glbJson(bytes);
    const worlds = worldMatrices(json);
    const meshes = json.meshes ?? [];
    const accessors = json.accessors ?? [];
    const bounds = {
        min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    };
    let found = false;
    for (const [index, node] of (json.nodes ?? []).entries()) {
        if (!Number.isInteger(node?.mesh) || !worlds.has(index)) continue;
        const mesh = meshes[node.mesh];
        if (!mesh) throw new TypeError("glTF node references a missing mesh.");
        const world = worlds.get(index);
        for (const primitive of mesh.primitives ?? []) {
            const accessorIndex = primitive?.attributes?.POSITION;
            if (!Number.isInteger(accessorIndex)) continue;
            const accessor = accessors[accessorIndex];
            if (!accessor || accessor.type !== "VEC3" || !accessor.min || !accessor.max) {
                throw new TypeError("In-scene POSITION accessors require VEC3 min and max bounds.");
            }
            const min = finiteVector(accessor.min, 3, "POSITION min");
            const max = finiteVector(accessor.max, 3, "POSITION max");
            for (const x of [min[0], max[0]]) {
                for (const y of [min[1], max[1]]) {
                    for (const z of [min[2], max[2]]) expand(bounds, applyMatrix(world, [x, y, z]));
                }
            }
            found = true;
        }
    }
    return found ? bounds : null;
}

/** Transform an axis-aligned box by a column-major affine matrix. */
export function transformAabb(matrix, bounds) {
    const source = finiteVector(matrix, 16, "instance matrix");
    const min = finiteVector(bounds?.min, 3, "mesh bounds min");
    const max = finiteVector(bounds?.max, 3, "mesh bounds max");
    if (min.some((value, index) => value > max[index])) {
        throw new TypeError("Mesh bounds min must not exceed max.");
    }
    const result = {
        min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
    };
    for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
            for (const z of [min[2], max[2]]) expand(result, applyMatrix(source, [x, y, z]));
        }
    }
    return result;
}
