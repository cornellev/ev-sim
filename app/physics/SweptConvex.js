/** Continuous 3D SAT for a translating AABB against a static convex mesh. */

const EPSILON = 1e-12;

function dot(point, axis) {
    return point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2];
}

function cross(left, right) {
    return [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ];
}

function subtract(left, right) {
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function canonicalAxis(axis) {
    const length = Math.hypot(...axis);
    if (length <= EPSILON) return null;
    const normalized = axis.map((value) => value / length);
    const first = normalized.find((value) => Math.abs(value) > EPSILON) ?? 0;
    const directed = first < 0 ? normalized.map((value) => -value) : normalized;
    return directed.map((value) => Math.round(value * 1e12) / 1e12);
}

function axesFor(vertices, triangles) {
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const edges = new Map();
    for (const triangle of triangles) {
        const points = triangle.map((index) => vertices[index]);
        axes.push(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
        for (let offset = 0; offset < 3; offset += 1) {
            const a = triangle[offset];
            const b = triangle[(offset + 1) % 3];
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (!edges.has(key)) edges.set(key, subtract(vertices[b], vertices[a]));
        }
    }
    const boxAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (const edge of [...edges.entries()].sort(([a], [b]) => a.localeCompare(b)).map((entry) => entry[1])) {
        for (const boxAxis of boxAxes) axes.push(cross(boxAxis, edge));
    }
    const unique = new Map();
    for (const value of axes) {
        const axis = canonicalAxis(value);
        if (axis) unique.set(axis.join(","), axis);
    }
    return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map((entry) => entry[1]);
}

function sweptBounds(start, end, half) {
    return {
        min: { x: Math.min(start.x, end.x) - half.x, y: Math.min(start.y, end.y) - half.y, z: Math.min(start.z, end.z) - half.z },
        max: { x: Math.max(start.x, end.x) + half.x, y: Math.max(start.y, end.y) + half.y, z: Math.max(start.z, end.z) + half.z },
    };
}

function intersects(left, right) {
    return left.min.x <= right.max.x && left.max.x >= right.min.x
        && left.min.y <= right.max.y && left.max.y >= right.min.y
        && left.min.z <= right.max.z && left.max.z >= right.min.z;
}

export function sweepAabbConvex(start, end, half, convex) {
    const vertices = convex?.vertices;
    const triangles = convex?.triangles;
    if (!Array.isArray(vertices) || !Array.isArray(triangles) || vertices.length < 4 || triangles.length === 0) {
        throw new TypeError("Swept convex collision requires indexed convex geometry.");
    }
    const targetBounds = convex.bounds ?? {
        min: { x: Math.min(...vertices.map((point) => point[0])), y: Math.min(...vertices.map((point) => point[1])), z: Math.min(...vertices.map((point) => point[2])) },
        max: { x: Math.max(...vertices.map((point) => point[0])), y: Math.max(...vertices.map((point) => point[1])), z: Math.max(...vertices.map((point) => point[2])) },
    };
    if (!intersects(sweptBounds(start, end, half), targetBounds)) return null;
    const startCenter = [start.x, start.y, start.z];
    const delta = [end.x - start.x, end.y - start.y, end.z - start.z];
    let entry = -Infinity;
    let exit = Infinity;
    for (const axis of axesFor(vertices, triangles)) {
        const projections = vertices.map((point) => dot(point, axis));
        const targetMin = Math.min(...projections);
        const targetMax = Math.max(...projections);
        const center = dot(startCenter, axis);
        const velocity = dot(delta, axis);
        const radius = Math.abs(axis[0]) * half.x + Math.abs(axis[1]) * half.y + Math.abs(axis[2]) * half.z;
        if (Math.abs(velocity) <= EPSILON) {
            if (center + radius < targetMin || center - radius > targetMax) return null;
            continue;
        }
        const first = (targetMin - (center + radius)) / velocity;
        const second = (targetMax - (center - radius)) / velocity;
        entry = Math.max(entry, Math.min(first, second));
        exit = Math.min(exit, Math.max(first, second));
        if (entry > exit) return null;
    }
    if (exit < 0 || entry > 1) return null;
    return Math.max(0, entry);
}
