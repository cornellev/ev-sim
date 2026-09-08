/**
 * Shared projected-capture geometry kernel for preview overlays and VIS-08
 * persistence. Builds a 10-pixel grid mesh from world-position + validity
 * (or an equivalent per-pixel world lookup) with a 1 m camera-depth
 * continuity limit and a 5 mm camera-facing offset.
 */

export const PROJECTED_CAPTURE_CELL_SIZE_PX = 10;
export const PROJECTED_CAPTURE_MAX_TRIANGLE_DEPTH_DELTA = 1;
export const PROJECTED_CAPTURE_SURFACE_OFFSET = 0.005;

export function mat4FromPose(position, rotation) {
    const x = Number(rotation?.x) || 0;
    const y = Number(rotation?.y) || 0;
    const z = Number(rotation?.z) || 0;
    const w = Number(rotation?.w) || 1;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    return [
        1 - (yy + zz), xy + wz, xz - wy, 0,
        xy - wz, 1 - (xx + zz), yz + wx, 0,
        xz + wy, yz - wx, 1 - (xx + yy), 0,
        Number(position?.x) || 0,
        Number(position?.y) || 0,
        Number(position?.z) || 0,
        1,
    ];
}

export function invertAffineMat4(m) {
    const out = new Float64Array(16);
    out[0] = m[0];
    out[1] = m[4];
    out[2] = m[8];
    out[3] = 0;
    out[4] = m[1];
    out[5] = m[5];
    out[6] = m[9];
    out[7] = 0;
    out[8] = m[2];
    out[9] = m[6];
    out[10] = m[10];
    out[11] = 0;
    const tx = m[12];
    const ty = m[13];
    const tz = m[14];
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
    out[15] = 1;
    return out;
}

export function transformPointMat4(m, x, y, z) {
    return {
        x: m[0] * x + m[4] * y + m[8] * z + m[12],
        y: m[1] * x + m[5] * y + m[9] * z + m[13],
        z: m[2] * x + m[6] * y + m[10] * z + m[14],
    };
}

export function cameraDepthOfWorld(invCamera, x, y, z) {
    return -transformPointMat4(invCamera, x, y, z).z;
}

export function offsetTowardCamera(x, y, z, cameraPosition, surfaceOffset) {
    const dx = cameraPosition.x - x;
    const dy = cameraPosition.y - y;
    const dz = cameraPosition.z - z;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 0) || !Number.isFinite(surfaceOffset) || surfaceOffset === 0) {
        return { x, y, z };
    }
    const scale = surfaceOffset / length;
    return {
        x: x + dx * scale,
        y: y + dy * scale,
        z: z + dz * scale,
    };
}

export function worldPositionAtPixel(worldPosition, width, height, px, py) {
    if (!worldPosition || width < 1 || height < 1) return null;
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const index = (py * width + px) * 3;
    if (index + 2 >= worldPosition.length) return null;
    const x = worldPosition[index];
    const y = worldPosition[index + 1];
    const z = worldPosition[index + 2];
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

export function pixelIsValid(validity, width, height, px, py) {
    if (!validity) return false;
    if (px < 0 || py < 0 || px >= width || py >= height) return false;
    return validity[py * width + px] !== 0;
}

function gridAxes(length, cell) {
    if (!(length > 0)) return [];
    const values = [];
    for (let value = 0; value < length; value += cell) {
        values.push(Math.min(length - 1, Math.round(value)));
    }
    if (values[values.length - 1] !== length - 1) values.push(length - 1);
    return values;
}

function triangleIsContinuous(meta, a, b, c, maxTriangleDepthDelta) {
    const va = meta[a];
    const vb = meta[b];
    const vc = meta[c];
    if (!va || !vb || !vc) return false;
    if (va.groupId != null && (va.groupId !== vb.groupId || va.groupId !== vc.groupId)) {
        return false;
    }
    const minDepth = Math.min(va.depth, vb.depth, vc.depth);
    const maxDepth = Math.max(va.depth, vb.depth, vc.depth);
    return maxDepth - minDepth <= maxTriangleDepthDelta;
}

/**
 * @returns {{
 *   positions: Float32Array,
 *   uvs: Float32Array,
 *   indices: Uint32Array,
 *   vertexCount: number,
 *   triangleCount: number,
 *   center: { x: number, y: number, z: number },
 *   matrix: number[],
 * } | null}
 */
export function buildProjectedCaptureGeometry({
    width,
    height,
    worldPosition = null,
    validity = null,
    worldAtPixel = null,
    isValid = null,
    cameraMatrix = null,
    pose = null,
    cellSizePx = PROJECTED_CAPTURE_CELL_SIZE_PX,
    maxTriangleDepthDelta = PROJECTED_CAPTURE_MAX_TRIANGLE_DEPTH_DELTA,
    surfaceOffset = PROJECTED_CAPTURE_SURFACE_OFFSET,
} = {}) {
    const imageWidth = Math.max(0, Math.floor(Number(width) || 0));
    const imageHeight = Math.max(0, Math.floor(Number(height) || 0));
    if (!imageWidth || !imageHeight) return null;

    const matrix = cameraMatrix
        ?? (pose ? mat4FromPose(pose.position, pose.rotation) : null);
    if (!matrix) return null;
    const invCamera = invertAffineMat4(matrix);
    const cameraPosition = { x: matrix[12], y: matrix[13], z: matrix[14] };
    const cell = Math.max(1, Math.round(cellSizePx));
    const lookupWorld = typeof worldAtPixel === "function"
        ? worldAtPixel
        : (px, py) => worldPositionAtPixel(worldPosition, imageWidth, imageHeight, px, py);
    const lookupValid = typeof isValid === "function"
        ? isValid
        : (px, py) => pixelIsValid(validity, imageWidth, imageHeight, px, py);

    const columns = gridAxes(imageWidth, cell);
    const rows = gridAxes(imageHeight, cell);
    const vertices = [];
    const uvs = [];
    const vertexMeta = [];
    const vertexByGrid = new Map();
    const denomX = Math.max(1, imageWidth - 1);
    const denomY = Math.max(1, imageHeight - 1);

    for (let yi = 0; yi < rows.length; yi += 1) {
        const py = rows[yi];
        for (let xi = 0; xi < columns.length; xi += 1) {
            const px = columns[xi];
            if (!lookupValid(px, py)) continue;
            const world = lookupWorld(px, py);
            if (!world) continue;
            const depth = cameraDepthOfWorld(invCamera, world.x, world.y, world.z);
            if (!Number.isFinite(depth) || depth <= 0) continue;
            const offset = offsetTowardCamera(
                world.x,
                world.y,
                world.z,
                cameraPosition,
                surfaceOffset,
            );
            const index = vertices.length / 3;
            vertices.push(offset.x, offset.y, offset.z);
            uvs.push(px / denomX, py / denomY);
            vertexMeta.push({
                depth,
                groupId: world.groupId ?? world.buildingId ?? null,
            });
            vertexByGrid.set(`${xi}:${yi}`, index);
        }
    }

    const indices = [];
    for (let yi = 0; yi < rows.length - 1; yi += 1) {
        for (let xi = 0; xi < columns.length - 1; xi += 1) {
            const a = vertexByGrid.get(`${xi}:${yi}`);
            const b = vertexByGrid.get(`${xi + 1}:${yi}`);
            const c = vertexByGrid.get(`${xi}:${yi + 1}`);
            const d = vertexByGrid.get(`${xi + 1}:${yi + 1}`);
            if (
                a !== undefined
                && b !== undefined
                && c !== undefined
                && triangleIsContinuous(vertexMeta, a, b, c, maxTriangleDepthDelta)
            ) {
                indices.push(a, b, c);
            }
            if (
                b !== undefined
                && d !== undefined
                && c !== undefined
                && triangleIsContinuous(vertexMeta, b, d, c, maxTriangleDepthDelta)
            ) {
                indices.push(b, d, c);
            }
        }
    }

    if (!vertices.length || !indices.length) return null;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < vertices.length; index += 3) {
        const x = vertices[index];
        const y = vertices[index + 1];
        const z = vertices[index + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    const center = {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        z: (minZ + maxZ) / 2,
    };
    const local = new Float32Array(vertices.length);
    for (let index = 0; index < vertices.length; index += 3) {
        local[index] = vertices[index] - center.x;
        local[index + 1] = vertices[index + 1] - center.y;
        local[index + 2] = vertices[index + 2] - center.z;
    }

    return {
        positions: local,
        uvs: new Float32Array(uvs),
        indices: Uint32Array.from(indices),
        vertexCount: vertices.length / 3,
        triangleCount: indices.length / 3,
        center,
        matrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            center.x, center.y, center.z, 1,
        ],
    };
}

export function maskedBeautyRgba(beauty, validity, width, height) {
    const pixels = Math.max(0, Math.floor(width) * Math.floor(height));
    const rgba = new Uint8Array(pixels * 4);
    if (!beauty || pixels === 0) return rgba;
    const source = beauty instanceof Uint8Array || beauty instanceof Uint8ClampedArray
        ? beauty
        : new Uint8Array(beauty);
    for (let pixel = 0; pixel < pixels; pixel += 1) {
        const dst = pixel * 4;
        const src = Math.min(source.length - 4, dst);
        rgba[dst] = source[src] ?? 0;
        rgba[dst + 1] = source[src + 1] ?? 0;
        rgba[dst + 2] = source[src + 2] ?? 0;
        const valid = validity ? validity[pixel] !== 0 : source[src + 3] > 0;
        rgba[dst + 3] = valid ? (source[src + 3] || 255) : 0;
    }
    return rgba;
}
