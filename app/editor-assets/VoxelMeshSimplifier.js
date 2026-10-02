/** Deterministic numeric-array voxel clustering shared by asset proxy generators. */

import { canonicalFiniteNumber } from "../simulation/kernel/SimulationHashes.js";

function point(value, label) {
    if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => !Number.isFinite(entry))) {
        throw new TypeError(`${label} must be a finite xyz array.`);
    }
    return value.map(canonicalFiniteNumber);
}

const LONGEST_AXIS_CELLS = 8;
const SHORTEST_AXIS_CELLS = 2;
const MAX_LONGEST_AXIS_CELLS = 64;

/**
 * Cell size for a mesh in the space it will be clustered.
 * About 8 cells on the longest axis. A shorter axis that would otherwise
 * fall inside one of those cells is given 2 cells, unless that would put
 * more than 64 cells on the longest axis. A zero-extent axis is ignored,
 * so a true plane stays a plane.
 */
export function chooseVoxelSize(vertices = []) {
    if (!Array.isArray(vertices) || vertices.length === 0) throw new TypeError("Voxel size requires vertices.");
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < vertices.length; index += 1) {
        const vertex = point(vertices[index], `vertices[${index}]`);
        for (let axis = 0; axis < 3; axis += 1) {
            if (vertex[axis] < min[axis]) min[axis] = vertex[axis];
            if (vertex[axis] > max[axis]) max[axis] = vertex[axis];
        }
    }
    const extents = min.map((value, axis) => max[axis] - value);
    const longest = Math.max(...extents);
    if (!(longest > 0)) throw new TypeError("Voxel size requires a mesh with extent.");
    const target = longest / LONGEST_AXIS_CELLS;
    const realExtents = extents.filter((extent) => extent > longest * 1e-8);
    const shortest = Math.min(...realExtents);
    const fitted = shortest < target ? shortest / SHORTEST_AXIS_CELLS : target;
    const finest = longest / MAX_LONGEST_AXIS_CELLS;
    return fitted < finest ? finest : fitted;
}

export function simplifyVoxelMesh({ vertices = [], triangles = [] } = {}, voxelSize = 0.5) {
    if (!Number.isFinite(voxelSize) || voxelSize <= 0) throw new TypeError("voxelSize must be positive and finite.");
    const sourceVertices = vertices.map((entry, index) => point(entry, `vertices[${index}]`));
    const sourceTriangles = triangles.map((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 3 || entry.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= sourceVertices.length)) {
            throw new TypeError(`triangles[${index}] must contain three in-range indices.`);
        }
        return [...entry];
    });
    const byKey = new Map();
    const vertexToCluster = new Int32Array(sourceVertices.length);
    for (let index = 0; index < sourceVertices.length; index += 1) {
        const vertex = sourceVertices[index];
        const key = vertex.map((axis) => Math.floor(axis / voxelSize)).join(",");
        let cluster = byKey.get(key);
        if (!cluster) {
            cluster = { key, index: byKey.size, sum: [0, 0, 0], count: 0 };
            byKey.set(key, cluster);
        }
        cluster.sum[0] += vertex[0]; cluster.sum[1] += vertex[1]; cluster.sum[2] += vertex[2]; cluster.count += 1;
        vertexToCluster[index] = cluster.index;
    }
    const clusters = [...byKey.values()];
    const outputVertices = clusters.map((cluster) => cluster.sum.map((value) => canonicalFiniteNumber(value / cluster.count)));
    const seen = new Set();
    const outputTriangles = [];
    for (const triangle of sourceTriangles) {
        const mapped = triangle.map((index) => vertexToCluster[index]);
        if (new Set(mapped).size !== 3) continue;
        const identity = [...mapped].sort((a, b) => a - b).join(",");
        if (seen.has(identity)) continue;
        seen.add(identity);
        outputTriangles.push(mapped);
    }
    return { vertices: outputVertices, triangles: outputTriangles };
}

export function meshFromPrimitive(proxy, policy = { sphereLongitude: 24, sphereLatitude: 12, cylinderRadial: 24 }) {
    if (proxy.kind === "mesh" || proxy.kind === "convex") return { vertices: proxy.vertices.map((entry) => [...entry]), triangles: proxy.triangles.map((entry) => [...entry]) };
    if (proxy.kind === "box") {
        const [x, y, z] = proxy.size.map((entry) => entry / 2);
        const vertices = [[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]];
        const triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
        return { vertices, triangles };
    }
    if (proxy.kind === "sphere") {
        const longitude = policy.sphereLongitude;
        const latitude = policy.sphereLatitude;
        const vertices = [[0, proxy.radius, 0]];
        for (let ring = 1; ring < latitude; ring += 1) {
            const phi = Math.PI * ring / latitude;
            for (let segment = 0; segment < longitude; segment += 1) {
                const theta = Math.PI * 2 * segment / longitude;
                vertices.push([proxy.radius * Math.sin(phi) * Math.cos(theta), proxy.radius * Math.cos(phi), proxy.radius * Math.sin(phi) * Math.sin(theta)]);
            }
        }
        const bottom = vertices.length; vertices.push([0, -proxy.radius, 0]);
        const triangles = [];
        for (let segment = 0; segment < longitude; segment += 1) triangles.push([0, 1 + segment, 1 + (segment + 1) % longitude]);
        for (let ring = 0; ring < latitude - 2; ring += 1) for (let segment = 0; segment < longitude; segment += 1) {
            const a = 1 + ring * longitude + segment;
            const b = 1 + ring * longitude + (segment + 1) % longitude;
            const c = a + longitude;
            const d = b + longitude;
            triangles.push([a, c, b], [b, c, d]);
        }
        const start = 1 + (latitude - 2) * longitude;
        for (let segment = 0; segment < longitude; segment += 1) triangles.push([start + segment, bottom, start + (segment + 1) % longitude]);
        return { vertices: vertices.map((entry) => entry.map(canonicalFiniteNumber)), triangles };
    }
    if (proxy.kind === "cylinder") {
        const radial = policy.cylinderRadial;
        const half = proxy.height / 2;
        const vertices = [];
        for (const y of [-half, half]) for (let segment = 0; segment < radial; segment += 1) {
            const theta = Math.PI * 2 * segment / radial;
            vertices.push([proxy.radius * Math.cos(theta), y, proxy.radius * Math.sin(theta)]);
        }
        const bottom = vertices.length; vertices.push([0, -half, 0]);
        const top = vertices.length; vertices.push([0, half, 0]);
        const triangles = [];
        for (let segment = 0; segment < radial; segment += 1) {
            const next = (segment + 1) % radial;
            triangles.push([segment, radial + segment, next], [next, radial + segment, radial + next]);
            triangles.push([bottom, next, segment], [top, radial + segment, radial + next]);
        }
        return { vertices: vertices.map((entry) => entry.map(canonicalFiniteNumber)), triangles };
    }
    throw new TypeError(`Unsupported primitive ${proxy.kind}.`);
}
