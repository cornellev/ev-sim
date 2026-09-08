/**
 * Three-independent atlas construction: chunk clipping, chart seams, first-fit
 * packing, sample-to-texel mapping, and confidence-ordered fusion.
 */

import {
    canonicalExactStringify,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import {
    chunkKey,
    getChunkBounds,
    getChunkCoordForPoint,
    getCoveredChunkKeysForBounds,
} from "../../editor/chunks/ChunkIndex.js";
import { compareUtf8 } from "./BakeRunCatalog.js";
import { seamCosine } from "./BakeConstructionPolicy.js";
import { quantizeConfidence, quantizeFacing } from "./BakeAtlasContribution.js";

const UV_EPS = 1e-6;
const AREA_EPS = 1e-12;
const PLANE_EPS = 0.02;
const BARY_SLACK = 1e-4;
const QUANT = 1e6;

function atlasError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function q(value) {
    if (!Number.isFinite(value)) return 0;
    const scaled = Math.round(value * QUANT);
    return Object.is(scaled, -0) ? 0 : scaled;
}

function vec(x, y, z) {
    return { x, y, z };
}

function sub(a, b) {
    return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function add(a, b) {
    return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

function scale(a, s) {
    return vec(a.x * s, a.y * s, a.z * s);
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
    return vec(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    );
}

function length(a) {
    return Math.hypot(a.x, a.y, a.z);
}

function normalize(a) {
    const mag = length(a);
    if (!(mag > 0)) return vec(0, 0, 0);
    return scale(a, 1 / mag);
}

function vertex(triangle, index) {
    return {
        p: vec(triangle.positions[index * 3], triangle.positions[index * 3 + 1], triangle.positions[index * 3 + 2]),
        n: vec(triangle.normals[index * 3], triangle.normals[index * 3 + 1], triangle.normals[index * 3 + 2]),
        u: triangle.uvs ? triangle.uvs[index * 2] : 0,
        v: triangle.uvs ? triangle.uvs[index * 2 + 1] : 0,
    };
}

function lerpVertex(a, b, t) {
    const p = add(a.p, scale(sub(b.p, a.p), t));
    const n = normalize(add(a.n, scale(sub(b.n, a.n), t)));
    return {
        p,
        n: length(n) > 0 ? n : a.n,
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
    };
}

function clipAgainstPlane(vertices, inside, intersectT) {
    if (vertices.length < 3) return vertices;
    const output = [];
    for (let index = 0; index < vertices.length; index += 1) {
        const current = vertices[index];
        const previous = vertices[(index + vertices.length - 1) % vertices.length];
        const currentIn = inside(current);
        const previousIn = inside(previous);
        if (currentIn) {
            if (!previousIn) output.push(lerpVertex(previous, current, intersectT(previous, current)));
            output.push(current);
        } else if (previousIn) {
            output.push(lerpVertex(previous, current, intersectT(previous, current)));
        }
    }
    return output;
}

function polygonToTriangles(source, vertices, chunkKeyValue, clipIndex) {
    if (vertices.length < 3) return [];
    const triangles = [];
    for (let index = 1; index < vertices.length - 1; index += 1) {
        const a = vertices[0];
        const b = vertices[index];
        const c = vertices[index + 1];
        const positions = [a.p.x, a.p.y, a.p.z, b.p.x, b.p.y, b.p.z, c.p.x, c.p.y, c.p.z];
        const normals = [a.n.x, a.n.y, a.n.z, b.n.x, b.n.y, b.n.z, c.n.x, c.n.y, c.n.z];
        const uvs = source.uvValid ? [a.u, a.v, b.u, b.v, c.u, c.v] : null;
        triangles.push({
            ...source,
            chunkKey: chunkKeyValue,
            clipIndex: clipIndex + triangles.length,
            positions,
            normals,
            uvs,
            uvValid: Boolean(source.uvValid && uvs && uvs.every(Number.isFinite)),
        });
    }
    return triangles;
}

function triangleNormal(triangle) {
    const a = vertex(triangle, 0).p;
    const b = vertex(triangle, 1).p;
    const c = vertex(triangle, 2).p;
    return normalize(cross(sub(b, a), sub(c, a)));
}

function uvsValid(triangle) {
    if (!triangle.uvs || triangle.uvs.length !== 6) return false;
    if (!triangle.uvs.every(Number.isFinite)) return false;
    const u0 = triangle.uvs[0];
    const v0 = triangle.uvs[1];
    const u1 = triangle.uvs[2];
    const v1 = triangle.uvs[3];
    const u2 = triangle.uvs[4];
    const v2 = triangle.uvs[5];
    const area = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
    return area > AREA_EPS;
}

export function sortAtlasTriangles(triangles) {
    return [...triangles].sort((left, right) => {
        const chunk = compareUtf8(left.chunkKey ?? "", right.chunkKey ?? "");
        if (chunk) return chunk;
        const entity = compareUtf8(left.entityId, right.entityId);
        if (entity) return entity;
        const geometry = compareUtf8(left.geometryDigest, right.geometryDigest);
        if (geometry) return geometry;
        if (left.primitiveIndex !== right.primitiveIndex) return left.primitiveIndex - right.primitiveIndex;
        if (left.triangleIndex !== right.triangleIndex) return left.triangleIndex - right.triangleIndex;
        return (left.clipIndex ?? 0) - (right.clipIndex ?? 0);
    });
}

export function clipTrianglesToChunks(triangles, chunkSize) {
    const clipped = [];
    for (const triangle of triangles) {
        const points = [0, 1, 2].map((index) => vertex(triangle, index).p);
        const bounds = {
            minX: Math.min(points[0].x, points[1].x, points[2].x),
            minZ: Math.min(points[0].z, points[1].z, points[2].z),
            maxX: Math.max(points[0].x, points[1].x, points[2].x),
            maxZ: Math.max(points[0].z, points[1].z, points[2].z),
        };
        const keys = getCoveredChunkKeysForBounds(bounds, chunkSize);
        let clipIndex = 0;
        for (const key of keys.sort(compareUtf8)) {
            const box = getChunkBounds(key, chunkSize);
            const maxX = box.maxX - 1e-9;
            const maxZ = box.maxZ - 1e-9;
            let polygon = [0, 1, 2].map((index) => vertex(triangle, index));
            polygon = clipAgainstPlane(
                polygon,
                (entry) => entry.p.x >= box.minX,
                (a, b) => (box.minX - a.p.x) / (b.p.x - a.p.x),
            );
            polygon = clipAgainstPlane(
                polygon,
                (entry) => entry.p.x <= maxX,
                (a, b) => (maxX - a.p.x) / (b.p.x - a.p.x),
            );
            polygon = clipAgainstPlane(
                polygon,
                (entry) => entry.p.z >= box.minZ,
                (a, b) => (box.minZ - a.p.z) / (b.p.z - a.p.z),
            );
            polygon = clipAgainstPlane(
                polygon,
                (entry) => entry.p.z <= maxZ,
                (a, b) => (maxZ - a.p.z) / (b.p.z - a.p.z),
            );
            const pieces = polygonToTriangles(triangle, polygon, key, clipIndex);
            clipIndex += pieces.length;
            clipped.push(...pieces);
        }
    }
    return sortAtlasTriangles(clipped.map((triangle) => ({
        ...triangle,
        uvValid: uvsValid(triangle),
        faceNormal: triangleNormal(triangle),
    })));
}

function edgeKey(a, b) {
    const left = [q(a.p.x), q(a.p.y), q(a.p.z)];
    const right = [q(b.p.x), q(b.p.y), q(b.p.z)];
    const cmp = left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    return cmp <= 0
        ? `${left.join(":")}|${right.join(":")}`
        : `${right.join(":")}|${left.join(":")}`;
}

function uvContinuous(left, right, a, b) {
    if (!left.uvValid || !right.uvValid) return false;
    const pair = (triangle, pa, pb) => {
        const verts = [0, 1, 2].map((index) => vertex(triangle, index));
        const find = (point) => verts.find((entry) => (
            q(entry.p.x) === q(point.p.x)
            && q(entry.p.y) === q(point.p.y)
            && q(entry.p.z) === q(point.p.z)
        ));
        return [find(pa), find(pb)];
    };
    const [la, lb] = pair(left, a, b);
    const [ra, rb] = pair(right, a, b);
    if (!la || !lb || !ra || !rb) return false;
    return Math.hypot(la.u - ra.u, la.v - ra.v) <= UV_EPS
        && Math.hypot(lb.u - rb.u, lb.v - rb.v) <= UV_EPS;
}

class UnionFind {
    constructor(count) {
        this.parent = Array.from({ length: count }, (_, index) => index);
    }

    find(index) {
        let current = index;
        while (this.parent[current] !== current) {
            this.parent[current] = this.parent[this.parent[current]];
            current = this.parent[current];
        }
        return current;
    }

    union(a, b) {
        const pa = this.find(a);
        const pb = this.find(b);
        if (pa === pb) return;
        if (pa < pb) this.parent[pb] = pa;
        else this.parent[pa] = pb;
    }
}

function dominantAxes(normal) {
    const nx = Math.abs(normal.x);
    const ny = Math.abs(normal.y);
    const nz = Math.abs(normal.z);
    if (nx >= ny && nx >= nz) {
        return { u: vec(0, 1, 0), v: vec(0, 0, normal.x >= 0 ? 1 : -1) };
    }
    if (ny >= nz) {
        return { u: vec(1, 0, 0), v: vec(0, 0, normal.y >= 0 ? -1 : 1) };
    }
    return { u: vec(1, 0, 0), v: vec(0, normal.z >= 0 ? 1 : -1, 0) };
}

function projectChartUvs(triangles) {
    const allValid = triangles.every((triangle) => triangle.uvValid);
    if (allValid) {
        return triangles.map((triangle) => [...triangle.uvs]);
    }
    const normal = normalize(triangles.reduce((sum, triangle) => add(sum, triangle.faceNormal), vec(0, 0, 0)));
    const axes = dominantAxes(length(normal) > 0 ? normal : vec(0, 1, 0));
    return triangles.map((triangle) => {
        const uvs = [];
        for (let index = 0; index < 3; index += 1) {
            const point = vertex(triangle, index).p;
            uvs.push(dot(point, axes.u), dot(point, axes.v));
        }
        return uvs;
    });
}

function chartIdentity(triangles, uvMethod) {
    return {
        chunkKey: triangles[0].chunkKey,
        materialId: triangles[0].materialId,
        uvMethod,
        triangles: triangles.map((triangle) => ({
            entityId: triangle.entityId,
            geometryDigest: triangle.geometryDigest,
            primitiveIndex: triangle.primitiveIndex,
            triangleIndex: triangle.triangleIndex,
            clipIndex: triangle.clipIndex ?? 0,
            positions: triangle.positions.map(q),
            uvs: (triangle.uvs ?? []).map(q),
            normals: triangle.normals.map(q),
        })),
    };
}

function metersPerUv(triangles, uvs) {
    let weighted = 0;
    let weight = 0;
    for (let index = 0; index < triangles.length; index += 1) {
        const triangle = triangles[index];
        const uv = uvs[index];
        for (const [ia, ib] of [[0, 1], [1, 2], [2, 0]]) {
            const pa = vertex(triangle, ia).p;
            const pb = vertex(triangle, ib).p;
            const world = length(sub(pa, pb));
            const du = Math.hypot(uv[ia * 2] - uv[ib * 2], uv[ia * 2 + 1] - uv[ib * 2 + 1]);
            if (du > UV_EPS && world > 0) {
                weighted += world / du;
                weight += 1;
            }
        }
    }
    return weight > 0 ? weighted / weight : 1;
}

export function buildChartsForChunk(triangles, construction) {
    if (!triangles.length) return [];
    const seam = seamCosine(construction);
    const edges = new Map();
    for (let index = 0; index < triangles.length; index += 1) {
        const triangle = triangles[index];
        const verts = [0, 1, 2].map((vertexIndex) => vertex(triangle, vertexIndex));
        for (const [ia, ib] of [[0, 1], [1, 2], [2, 0]]) {
            const key = edgeKey(verts[ia], verts[ib]);
            const list = edges.get(key) ?? [];
            list.push({ triangleIndex: index, a: verts[ia], b: verts[ib] });
            edges.set(key, list);
        }
    }
    const sets = new UnionFind(triangles.length);
    for (const list of edges.values()) {
        if (list.length !== 2) continue;
        const left = triangles[list[0].triangleIndex];
        const right = triangles[list[1].triangleIndex];
        if (left.materialId !== right.materialId) continue;
        if (!uvContinuous(left, right, list[0].a, list[0].b) && left.uvValid && right.uvValid) continue;
        if (left.uvValid !== right.uvValid) continue;
        const cosine = dot(left.faceNormal, right.faceNormal);
        if (!(cosine >= seam - 1e-9)) continue;
        sets.union(list[0].triangleIndex, list[1].triangleIndex);
    }
    const groups = new Map();
    for (let index = 0; index < triangles.length; index += 1) {
        const root = sets.find(index);
        const list = groups.get(root) ?? [];
        list.push(triangles[index]);
        groups.set(root, list);
    }
    const charts = [];
    for (const group of groups.values()) {
        const sorted = sortAtlasTriangles(group);
        const uvMethod = sorted.every((triangle) => triangle.uvValid) ? "source-uv" : "dominant-axis";
        const uvs = projectChartUvs(sorted);
        const chartHash = sha256ExactUtf8(canonicalExactStringify(chartIdentity(sorted, uvMethod)));
        charts.push({
            chartHash,
            chunkKey: sorted[0].chunkKey,
            materialId: sorted[0].materialId,
            uvMethod,
            triangles: sorted,
            uvs,
        });
    }
    return charts.sort((left, right) => compareUtf8(left.chartHash, right.chartHash));
}

function chartPixelSize(chart, construction) {
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const uv of chart.uvs) {
        for (let index = 0; index < uv.length; index += 2) {
            minU = Math.min(minU, uv[index]);
            maxU = Math.max(maxU, uv[index]);
            minV = Math.min(minV, uv[index + 1]);
            maxV = Math.max(maxV, uv[index + 1]);
        }
    }
    const spanU = Math.max(UV_EPS, maxU - minU);
    const spanV = Math.max(UV_EPS, maxV - minV);
    const scale = metersPerUv(chart.triangles, chart.uvs) * construction.texelDensityPerMeter;
    const pixelW = Math.max(1, Math.ceil(spanU * scale));
    const pixelH = Math.max(1, Math.ceil(spanV * scale));
    return {
        minU, minV, maxU, maxV, spanU, spanV, pixelW, pixelH, scale,
    };
}

function tryPlaceOnPage(page, chart, pageSize, padding) {
    if (page.x + chart.pixelW + padding <= pageSize && page.y + chart.pixelH + padding <= pageSize) {
        const x = page.x;
        const y = page.y;
        page.x += chart.pixelW + padding;
        page.rowH = Math.max(page.rowH, chart.pixelH);
        return { x, y };
    }
    const nextY = page.y + page.rowH + padding;
    if (padding + chart.pixelW + padding <= pageSize && nextY + chart.pixelH + padding <= pageSize) {
        page.x = padding + chart.pixelW + padding;
        page.y = nextY;
        page.rowH = chart.pixelH;
        return { x: padding, y: nextY };
    }
    return null;
}

export function packCharts(charts, construction) {
    const pageSize = construction.pageSizePx;
    const padding = construction.paddingPx;
    const usable = pageSize - padding * 2;
    if (usable < 1) {
        throw atlasError("BAKE_ATLAS_LIMIT", "Atlas padding leaves no usable page area.");
    }
    const sized = charts.map((chart) => {
        const size = chartPixelSize(chart, construction);
        if (size.pixelW > usable || size.pixelH > usable) {
            throw atlasError(
                "BAKE_ATLAS_LIMIT",
                `Chart ${chart.chartHash.slice(0, 8)} exceeds the ${pageSize}px page at ${construction.texelDensityPerMeter} texels/m.`,
            );
        }
        return { ...chart, ...size };
    }).sort((left, right) => {
        if (right.pixelH !== left.pixelH) return right.pixelH - left.pixelH;
        if (right.pixelW !== left.pixelW) return right.pixelW - left.pixelW;
        return compareUtf8(left.chartHash, right.chartHash);
    });
    const pages = [];
    const placements = [];
    for (const chart of sized) {
        let placed = null;
        for (const page of pages) {
            placed = tryPlaceOnPage(page, chart, pageSize, padding);
            if (placed) {
                placements.push({ ...chart, pageIndex: page.pageIndex, x: placed.x, y: placed.y });
                break;
            }
        }
        if (placed) continue;
        if (pages.length >= construction.maxPagesPerChunk) {
            throw atlasError(
                "BAKE_ATLAS_LIMIT",
                `Chunk ${chart.chunkKey} needs more than ${construction.maxPagesPerChunk} atlas pages.`,
            );
        }
        const page = {
            pageIndex: pages.length,
            x: padding,
            y: padding,
            rowH: 0,
        };
        pages.push(page);
        placed = tryPlaceOnPage(page, chart, pageSize, padding);
        if (!placed) {
            throw atlasError("BAKE_ATLAS_LIMIT", `Chart ${chart.chartHash.slice(0, 8)} does not fit an empty atlas page.`);
        }
        placements.push({ ...chart, pageIndex: page.pageIndex, x: placed.x, y: placed.y });
    }
    return {
        pageCount: pages.length,
        placements: placements.sort((left, right) => (
            left.pageIndex - right.pageIndex || compareUtf8(left.chartHash, right.chartHash)
        )),
    };
}

export function hashPackedCharts(placements) {
    return sha256ExactUtf8(canonicalExactStringify(placements.map((entry) => ({
        chartHash: entry.chartHash,
        pageIndex: entry.pageIndex,
        x: entry.x,
        y: entry.y,
        pixelW: entry.pixelW,
        pixelH: entry.pixelH,
        uvMethod: entry.uvMethod,
    }))));
}

function atlasUvFor(placement, u, v) {
    const localU = (u - placement.minU) / placement.spanU;
    const localV = (placement.maxV - v) / placement.spanV;
    return {
        x: placement.x + localU * placement.pixelW,
        y: placement.y + localV * placement.pixelH,
    };
}

export function buildAtlasLayout({ triangles, construction }) {
    const clipped = clipTrianglesToChunks(triangles, construction.chunkSizeMeters);
    const byChunk = new Map();
    for (const triangle of clipped) {
        const list = byChunk.get(triangle.chunkKey) ?? [];
        list.push(triangle);
        byChunk.set(triangle.chunkKey, list);
    }
    const chunks = [];
    for (const chunkKeyValue of [...byChunk.keys()].sort(compareUtf8)) {
        const charts = buildChartsForChunk(byChunk.get(chunkKeyValue), construction);
        const packed = packCharts(charts, construction);
        const lookup = [];
        packed.placements.forEach((placement, placementIndex) => {
            placement.triangles.forEach((triangle, triangleIndex) => {
                lookup.push({
                    ...triangle,
                    placementIndex,
                    localTriangleIndex: triangleIndex,
                    pageIndex: placement.pageIndex,
                    uvs2d: placement.uvs[triangleIndex],
                    placement,
                });
            });
        });
        chunks.push({
            chunkKey: chunkKeyValue,
            chartHash: hashPackedCharts(packed.placements),
            pageCount: packed.pageCount,
            placements: packed.placements,
            triangles: lookup,
            index: buildTriangleIndex(lookup, construction.chunkSizeMeters),
        });
    }
    return { chunks, triangles: clipped };
}

function triangleBounds(triangle) {
    const xs = [triangle.positions[0], triangle.positions[3], triangle.positions[6]];
    const ys = [triangle.positions[1], triangle.positions[4], triangle.positions[7]];
    const zs = [triangle.positions[2], triangle.positions[5], triangle.positions[8]];
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        minZ: Math.min(...zs),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        maxZ: Math.max(...zs),
    };
}

export function buildTriangleIndex(triangles, chunkSize = 20) {
    const cell = Math.max(0.25, Number(chunkSize) / 8);
    const cells = new Map();
    triangles.forEach((triangle, index) => {
        const bounds = triangleBounds(triangle);
        const min = getChunkCoordForPoint({ x: bounds.minX, z: bounds.minZ }, cell);
        const max = getChunkCoordForPoint({ x: bounds.maxX, z: bounds.maxZ }, cell);
        for (let cx = min.cx; cx <= max.cx; cx += 1) {
            for (let cz = min.cz; cz <= max.cz; cz += 1) {
                const key = chunkKey(cx, cz);
                const list = cells.get(key) ?? [];
                list.push(index);
                cells.set(key, list);
            }
        }
    });
    return { cell, cells, triangles };
}

function barycentric(point, triangle) {
    const a = vertex(triangle, 0).p;
    const b = vertex(triangle, 1).p;
    const c = vertex(triangle, 2).p;
    const v0 = sub(b, a);
    const v1 = sub(c, a);
    const v2 = sub(point, a);
    const d00 = dot(v0, v0);
    const d01 = dot(v0, v1);
    const d11 = dot(v1, v1);
    const d20 = dot(v2, v0);
    const d21 = dot(v2, v1);
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) <= AREA_EPS) return null;
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    const normal = triangle.faceNormal ?? triangleNormal(triangle);
    const plane = Math.abs(dot(sub(point, a), normal));
    return { u, v, w, plane };
}

export function locateSample(index, point) {
    if (!index || !point) return null;
    const coord = getChunkCoordForPoint(point, index.cell);
    const candidates = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
            const list = index.cells.get(chunkKey(coord.cx + dx, coord.cz + dz)) ?? [];
            for (const entry of list) candidates.add(entry);
        }
    }
    let best = null;
    for (const triangleIndex of [...candidates].sort((left, right) => left - right)) {
        const triangle = index.triangles[triangleIndex];
        const bary = barycentric(point, triangle);
        if (!bary) continue;
        if (bary.u < -BARY_SLACK || bary.v < -BARY_SLACK || bary.w < -BARY_SLACK) continue;
        if (bary.plane > PLANE_EPS) continue;
        if (
            !best
            || bary.plane < best.plane - 1e-9
            || (Math.abs(bary.plane - best.plane) <= 1e-9 && triangleIndex < best.triangleIndex)
        ) {
            best = { triangleIndex, triangle, ...bary };
        }
    }
    return best;
}

function interpolateUv(triangle, bary) {
    const uv = triangle.uvs2d ?? triangle.uvs;
    if (!uv) return null;
    return {
        u: uv[0] * bary.u + uv[2] * bary.v + uv[4] * bary.w,
        v: uv[1] * bary.u + uv[3] * bary.v + uv[5] * bary.w,
    };
}

export function compareObservations(left, right) {
    if (left.confidenceQ !== right.confidenceQ) return right.confidenceQ - left.confidenceQ;
    if (left.facingQ !== right.facingQ) return right.facingQ - left.facingQ;
    if (left.distance !== right.distance) return left.distance - right.distance;
    const unit = compareUtf8(left.unitId, right.unitId);
    if (unit) return unit;
    return left.pixelIndex - right.pixelIndex;
}

export function mapCaptureToContributions({
    layout,
    beauty,
    worldPosition,
    geometricNormal,
    confidence,
    validity,
    width,
    height,
    cameraPosition,
    unitId,
}) {
    const records = [];
    const pixels = width * height;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
        if (validity && validity[pixel] === 0) continue;
        const wx = worldPosition[pixel * 3];
        const wy = worldPosition[pixel * 3 + 1];
        const wz = worldPosition[pixel * 3 + 2];
        if (![wx, wy, wz].every(Number.isFinite)) continue;
        const point = vec(wx, wy, wz);
        let hit = null;
        for (const chunk of layout.chunks) {
            const located = locateSample(chunk.index, point);
            if (!located) continue;
            if (!hit || located.plane < hit.plane - 1e-9) {
                hit = { ...located, chunk };
            }
        }
        if (!hit) continue;
        const uv = interpolateUv(hit.triangle, hit);
        if (!uv) continue;
        const atlas = atlasUvFor(hit.triangle.placement, uv.u, uv.v);
        const texelX = Math.floor(atlas.x);
        const texelY = Math.floor(atlas.y);
        const placement = hit.triangle.placement;
        if (
            texelX < placement.x
            || texelY < placement.y
            || texelX >= placement.x + placement.pixelW
            || texelY >= placement.y + placement.pixelH
        ) continue;
        const nx = geometricNormal?.[pixel * 3] ?? hit.triangle.faceNormal.x;
        const ny = geometricNormal?.[pixel * 3 + 1] ?? hit.triangle.faceNormal.y;
        const nz = geometricNormal?.[pixel * 3 + 2] ?? hit.triangle.faceNormal.z;
        const toward = normalize(sub(cameraPosition, point));
        const facing = dot(normalize(vec(nx, ny, nz)), toward);
        const distance = length(sub(cameraPosition, point));
        const conf = confidence ? confidence[pixel] : 1;
        records.push({
            chunkKey: hit.chunk.chunkKey,
            pageIndex: hit.triangle.pageIndex,
            texelX,
            texelY,
            rgba: [
                beauty[pixel * 4] ?? 0,
                beauty[pixel * 4 + 1] ?? 0,
                beauty[pixel * 4 + 2] ?? 0,
                beauty[pixel * 4 + 3] ?? 255,
            ],
            confidence: Number.isFinite(conf) ? conf : 0,
            facing: Number.isFinite(facing) ? facing : -1,
            distance: Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY,
            pixelIndex: pixel,
            triangleIndex: hit.triangle.triangleIndex,
            unitId,
        });
    }
    return records;
}

export function fuseChunkPages({ chunk, contributions, construction, intrinsicByTexel = null }) {
    const pageSize = construction.pageSizePx;
    const pages = [];
    for (let pageIndex = 0; pageIndex < chunk.pageCount; pageIndex += 1) {
        const radiance = new Uint8Array(pageSize * pageSize * 4);
        const confidence = new Uint8Array(pageSize * pageSize * 4);
        const winners = new Map();
        const seen = new Map();
        for (const record of contributions) {
            if (record.pageIndex !== pageIndex) continue;
            const key = `${record.texelX}:${record.texelY}`;
            const observation = {
                ...record,
                confidenceQ: record.confidenceQ ?? quantizeConfidence(record.confidence),
                facingQ: record.facingQ ?? quantizeFacing(record.facing),
            };
            const count = (seen.get(key) ?? 0) + 1;
            seen.set(key, count);
            const current = winners.get(key);
            if (!current || compareObservations(observation, current) < 0) {
                winners.set(key, observation);
            }
        }
        let coverageCount = 0;
        let conflictCount = 0;
        for (const [key, record] of winners) {
            const offset = (record.texelY * pageSize + record.texelX) * 4;
            radiance[offset] = record.rgba[0];
            radiance[offset + 1] = record.rgba[1];
            radiance[offset + 2] = record.rgba[2];
            radiance[offset + 3] = record.rgba[3] || 255;
            confidence[offset] = Math.round((record.confidenceQ / 65535) * 255);
            confidence[offset + 1] = 255;
            confidence[offset + 2] = (seen.get(key) ?? 1) > 1 ? 255 : 0;
            confidence[offset + 3] = 255;
            coverageCount += 1;
            if ((seen.get(key) ?? 1) > 1) conflictCount += 1;
            if (intrinsicByTexel) {
                const extra = intrinsicByTexel.get(`${pageIndex}:${key}`);
                if (extra) {
                    radiance[offset] = extra[0];
                    radiance[offset + 1] = extra[1];
                    radiance[offset + 2] = extra[2];
                    radiance[offset + 3] = extra[3];
                }
            }
        }
        const positions = [];
        const uvs = [];
        const indices = [];
        for (const placement of chunk.placements) {
            if (placement.pageIndex !== pageIndex) continue;
            placement.triangles.forEach((triangle, triangleIndex) => {
                const base = positions.length / 3;
                const uv = placement.uvs[triangleIndex];
                for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
                    positions.push(
                        triangle.positions[vertexIndex * 3],
                        triangle.positions[vertexIndex * 3 + 1],
                        triangle.positions[vertexIndex * 3 + 2],
                    );
                    const atlas = atlasUvFor(placement, uv[vertexIndex * 2], uv[vertexIndex * 2 + 1]);
                    uvs.push(atlas.x / pageSize, atlas.y / pageSize);
                }
                indices.push(base, base + 1, base + 2);
            });
        }
        pages.push({
            pageIndex,
            radiance,
            confidence,
            coverageCount,
            conflictCount,
            positions: Float32Array.from(positions),
            uvs: Float32Array.from(uvs),
            indices: Uint32Array.from(indices),
        });
    }
    return pages;
}

function asVec(value) {
    if (Array.isArray(value)) return vec(value[0], value[1], value[2]);
    return vec(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}

export function shadeUnlit(albedo) {
    return [...albedo];
}

export function shadeLambert(albedo, normal, lights) {
    const n = normalize(asVec(normal));
    const rgb = [0, 0, 0];
    for (const light of lights) {
        const ndotl = Math.max(0, dot(n, normalize(asVec(light.direction))));
        rgb[0] += albedo[0] * light.color[0] * ndotl;
        rgb[1] += albedo[1] * light.color[1] * ndotl;
        rgb[2] += albedo[2] * light.color[2] * ndotl;
    }
    return rgb.map((entry) => Math.max(0, Math.min(255, Math.round(entry))));
}
