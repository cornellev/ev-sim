import {
    BufferGeometry,
    DoubleSide,
    Float32BufferAttribute,
    Ray,
    Vector3,
} from "three";
import { MeshBVH } from "three-mesh-bvh";

export const COVERAGE_SHELL_WIDTH = 360;
export const COVERAGE_SHELL_HEIGHT = 180;
export const COVERAGE_GROUND_DISC_SIZE = 256;
export const COVERAGE_CHUNK_RAYS = 4000;
export const COVERAGE_CHUNK_THRESHOLD = 8000;
const DEFAULT_SHELL_RADIUS_M = 5;
const DEFAULT_AZIMUTH_BINS = 360;

/**
 * Triangle mesh the coverage pass raycasts against. An empty mesh is null.
 * Vertices are a flat xyz list or an array of triples. Triangles index that list.
 * @param {Float32Array|number[]|number[][]} vertices
 * @param {number[][]|number[]} triangles
 */
export function buildCoverageOccluder(vertices, triangles) {
    const flat = flattenVertices(vertices);
    const faces = normalizeTriangles(triangles, flat.length / 3);
    if (faces.length === 0) return null;
    const positions = new Float32Array(faces.length * 9);
    faces.forEach((face, index) => {
        const offset = index * 9;
        for (let corner = 0; corner < 3; corner += 1) {
            const vertex = face[corner] * 3;
            positions[offset + corner * 3] = flat[vertex];
            positions[offset + corner * 3 + 1] = flat[vertex + 1];
            positions[offset + corner * 3 + 2] = flat[vertex + 2];
        }
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const bvh = new MeshBVH(geometry, { indirect: true });
    return { geometry, bvh, vertices: flat };
}

export function disposeCoverageOccluder(occluder) {
    occluder?.geometry?.dispose?.();
}

/**
 * Lowest wheel contact, otherwise the lowest occluder vertex, otherwise 0.
 * @param {object[]} [wheels]
 * @param {Float32Array|number[]|null} [occluderVertices]
 */
export function coverageGroundY(wheels, occluderVertices = null) {
    let min = Infinity;
    for (const wheel of wheels ?? []) {
        const y = Number(wheel?.position?.y);
        const radius = Number(wheel?.radius);
        if (Number.isFinite(y) && Number.isFinite(radius)) min = Math.min(min, y - radius);
    }
    if (Number.isFinite(min)) return min;
    const flat = occluderVertices ? flattenVertices(occluderVertices) : null;
    if (flat) {
        for (let index = 1; index < flat.length; index += 3) min = Math.min(min, flat[index]);
    }
    return Number.isFinite(min) ? min : 0;
}

/** Max horizontal distance of occluder vertices from the vehicle origin. */
export function bodyFootprintRadius(vertices) {
    const flat = flattenVertices(vertices);
    let radius = 0;
    for (let index = 0; index < flat.length; index += 3) {
        radius = Math.max(radius, Math.hypot(flat[index], flat[index + 2]));
    }
    return radius;
}

/**
 * Classify every ray and build the distance report.
 * @param {object[]} rays
 * @param {{ bvh: import("three-mesh-bvh").MeshBVH }|null} occluder
 * @param {object} [options]
 */
export function measureSensorCoverage(rays, occluder, options = {}) {
    const pass = new CoverageMeasurement(rays, occluder, options);
    pass.step(rays.length);
    return pass.report();
}

/**
 * Incremental pass used by the studio frame loop. `step` classifies the next
 * slice. `report` rebuilds the shell from rays already classified.
 */
export class CoverageMeasurement {
    constructor(rays, occluder, options = {}) {
        this.rays = rays ?? [];
        this.occluder = occluder ?? null;
        this.options = options;
        this.cursor = 0;
        this.samples = [];
        this._ray = new Ray(new Vector3(), new Vector3());
    }

    get complete() {
        return this.cursor >= this.rays.length;
    }

    step(count = COVERAGE_CHUNK_RAYS) {
        const end = Math.min(this.rays.length, this.cursor + Math.max(0, count));
        const groundY = finite(this.options.groundY, 0);
        for (let index = this.cursor; index < end; index += 1) {
            this.samples.push(sampleRay(this.rays[index], this.occluder, groundY, this._ray));
        }
        this.cursor = end;
        return this.report();
    }

    report(overrides = {}) {
        return reportFromSamples(this.samples, {
            ...this.options,
            ...overrides,
            rayCount: this.rays.length,
            processed: this.cursor,
        });
    }
}

function sampleRay(ray, occluder, groundY, scratch) {
    const origin = vector(ray.origin);
    const direction = vector(ray.direction);
    if (direction.lengthSq() === 0) direction.set(1, 0, 0);
    direction.normalize();
    const minRangeM = finite(ray.minRangeM, 0);
    const maxRangeM = finite(ray.maxRangeM, 0);
    scratch.origin.copy(origin);
    scratch.direction.copy(direction);
    let blocked = false;
    if (occluder?.bvh && maxRangeM > minRangeM) {
        const hits = occluder.bvh.raycast(scratch, DoubleSide, minRangeM, maxRangeM) ?? [];
        blocked = hits.some((hit) => hit.distance >= minRangeM && hit.distance < maxRangeM);
    }
    const clear = !blocked && maxRangeM > minRangeM;
    if (!clear) blocked = true;
    const nearestSampleM = clear ? segmentOriginDistance(origin, direction, minRangeM, maxRangeM) : null;
    const ground = clear ? groundHit(origin, direction, minRangeM, maxRangeM, groundY) : null;
    return {
        sensorId: ray.sensorId,
        sensorType: ray.sensorType,
        family: ray.family,
        blocked,
        clear,
        nearestSampleM,
        groundRadiusM: ground?.radius ?? null,
        groundX: ground?.x ?? null,
        groundZ: ground?.z ?? null,
        origin: { x: origin.x, y: origin.y, z: origin.z },
        direction: { x: direction.x, y: direction.y, z: direction.z },
        minRangeM,
        maxRangeM,
    };
}

function reportFromSamples(samples, options) {
    const shellRadiusM = positive(options.shellRadiusM, DEFAULT_SHELL_RADIUS_M);
    const azimuthBins = Math.max(1, Math.floor(positive(options.azimuthBins, DEFAULT_AZIMUTH_BINS)));
    const groundY = finite(options.groundY, 0);
    const bodyFootprintRadiusM = Math.max(0, finite(options.bodyFootprintRadiusM, 0));
    const rayCount = options.rayCount ?? samples.length;
    let blockedCount = 0;
    let clearCount = 0;
    let nearestSampleM = null;
    let groundBlindRadiusM = null;
    let groundOuterM = null;
    let discRadiusM = 1;
    const sensors = new Map();
    const shellCounts = new Uint16Array(COVERAGE_SHELL_WIDTH * COVERAGE_SHELL_HEIGHT);
    const coveredBins = new Uint8Array(azimuthBins);
    let shellHits = 0;

    for (const sample of samples) {
        if (sample.blocked) blockedCount += 1;
        if (sample.clear) clearCount += 1;
        discRadiusM = Math.max(discRadiusM, sample.maxRangeM || 0);
        const row = sensorRow(sensors, sample);
        row.rayCount += 1;
        if (sample.blocked) row.blockedCount += 1;
        if (sample.clear) row.clearCount += 1;
        if (sample.nearestSampleM != null) {
            nearestSampleM = minNullable(nearestSampleM, sample.nearestSampleM);
            row.nearestSampleM = minNullable(row.nearestSampleM, sample.nearestSampleM);
        }
        if (sample.groundRadiusM != null) {
            groundBlindRadiusM = minNullable(groundBlindRadiusM, sample.groundRadiusM);
            groundOuterM = groundOuterM == null ? sample.groundRadiusM : Math.max(groundOuterM, sample.groundRadiusM);
            row.nearestGroundM = minNullable(row.nearestGroundM, sample.groundRadiusM);
            row.farthestGroundM = row.farthestGroundM == null
                ? sample.groundRadiusM
                : Math.max(row.farthestGroundM, sample.groundRadiusM);
        }
        if (!sample.clear) continue;
        const hit = shellIntersection(sample, shellRadiusM);
        if (!hit) continue;
        shellHits += 1;
        const uv = shellUv(hit.x, hit.y, hit.z);
        const texelX = clampIndex(Math.floor(uv.u * COVERAGE_SHELL_WIDTH), COVERAGE_SHELL_WIDTH);
        const texelY = clampIndex(Math.floor(uv.v * COVERAGE_SHELL_HEIGHT), COVERAGE_SHELL_HEIGHT);
        const texel = texelY * COVERAGE_SHELL_WIDTH + texelX;
        if (shellCounts[texel] < 65535) shellCounts[texel] += 1;
        const azimuth = azimuthDegrees(hit.z, hit.x);
        coveredBins[azimuthBin(azimuth, azimuthBins)] = 1;
    }

    const groundGapM = groundBlindRadiusM == null
        ? null
        : Math.max(0, groundBlindRadiusM - bodyFootprintRadiusM);
    // The texture spans the near field around the unseen radius. Painting out to a
    // 150 m sensor range hides the zone around the vehicle.
    const groundWindowM = Math.min(
        discRadiusM,
        Math.max(8, (groundBlindRadiusM ?? 2) * 4, bodyFootprintRadiusM * 3),
    );
    return {
        occluderSource: options.occluderSource ?? (options.occluder ? "model" : "none"),
        groundY,
        bodyFootprintRadiusM,
        rayCount,
        blockedCount,
        clearCount,
        complete: blockedCount + clearCount === rayCount,
        skipped: options.skipped ?? [],
        sensors: [...sensors.values()],
        nearestSampleM,
        groundBlindRadiusM,
        groundGapM,
        groundOuterM,
        horizonGap: horizonGap(coveredBins, shellHits),
        shell: {
            radiusM: shellRadiusM,
            width: COVERAGE_SHELL_WIDTH,
            height: COVERAGE_SHELL_HEIGHT,
            rgba: paintShell(shellCounts),
        },
        groundDisc: {
            radiusM: groundWindowM,
            size: COVERAGE_GROUND_DISC_SIZE,
            rgba: paintGroundDisc(samples, groundWindowM),
        },
    };
}

function sensorRow(sensors, sample) {
    let row = sensors.get(sample.sensorId);
    if (row) return row;
    row = {
        id: sample.sensorId,
        type: sample.sensorType,
        family: sample.family,
        rayCount: 0,
        blockedCount: 0,
        clearCount: 0,
        nearestSampleM: null,
        nearestGroundM: null,
        farthestGroundM: null,
    };
    sensors.set(sample.sensorId, row);
    return row;
}

/**
 * One position per clear sample. Texture bins merge rays that share a texel;
 * these buffers do not.
 * @param {object[]} samples
 * @param {{ shellRadiusM?: number, groundY?: number }} [options]
 */
export function coveragePointPositions(samples, options = {}) {
    const shellRadiusM = positive(options.shellRadiusM, DEFAULT_SHELL_RADIUS_M);
    const groundY = finite(options.groundY, 0);
    const shell = [];
    const ground = [];
    for (const sample of samples ?? []) {
        if (!sample?.clear) continue;
        const hit = shellIntersection(sample, shellRadiusM);
        if (hit) shell.push(hit.x, hit.y, hit.z);
        if (sample.groundX != null && sample.groundZ != null) {
            ground.push(sample.groundX, groundY, sample.groundZ);
        }
    }
    return {
        shell: Float32Array.from(shell),
        ground: Float32Array.from(ground),
    };
}

export function shellUv(x, y, z) {
    const length = Math.hypot(x, y, z) || 1;
    const nx = x / length;
    const ny = Math.min(1, Math.max(-1, y / length));
    const nz = z / length;
    return {
        u: Math.atan2(nz, nx) / (2 * Math.PI) + 0.5,
        v: Math.asin(ny) / Math.PI + 0.5,
    };
}

function shellIntersection(sample, radius) {
    const origin = sample.origin;
    const direction = sample.direction;
    const b = origin.x * direction.x + origin.y * direction.y + origin.z * direction.z;
    const originLengthSq = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z;
    const discriminant = b * b - (originLengthSq - radius * radius);
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const nearer = -b - root;
    const farther = -b + root;
    const t = pickRange(nearer, sample.minRangeM, sample.maxRangeM)
        ?? pickRange(farther, sample.minRangeM, sample.maxRangeM);
    if (t == null) return null;
    return {
        x: origin.x + t * direction.x,
        y: origin.y + t * direction.y,
        z: origin.z + t * direction.z,
    };
}

function pickRange(t, min, max) {
    return t >= min && t <= max ? t : null;
}

function groundHit(origin, direction, minRange, maxRange, groundY) {
    if (Math.abs(direction.y) < 1e-8) return null;
    const t = (groundY - origin.y) / direction.y;
    if (t < minRange || t > maxRange) return null;
    const x = origin.x + t * direction.x;
    const z = origin.z + t * direction.z;
    return { x, z, radius: Math.hypot(x, z) };
}

function segmentOriginDistance(origin, direction, t0, t1) {
    const dot = origin.x * direction.x + origin.y * direction.y + origin.z * direction.z;
    let t = -dot;
    if (t < t0) t = t0;
    else if (t > t1) t = t1;
    return Math.hypot(
        origin.x + t * direction.x,
        origin.y + t * direction.y,
        origin.z + t * direction.z,
    );
}

function paintShell(counts) {
    let max = 1;
    for (let index = 0; index < counts.length; index += 1) max = Math.max(max, counts[index]);
    const rgba = new Uint8Array(counts.length * 4);
    for (let index = 0; index < counts.length; index += 1) {
        const count = counts[index];
        if (count === 0) continue;
        const heat = count / max;
        const offset = index * 4;
        rgba[offset] = 255;
        rgba[offset + 1] = Math.round(70 + 140 * heat);
        rgba[offset + 2] = Math.round(40 * (1 - heat));
        rgba[offset + 3] = Math.round(90 + 165 * Math.min(1, heat));
    }
    return rgba;
}

function paintGroundDisc(samples, discRadius) {
    const size = COVERAGE_GROUND_DISC_SIZE;
    const nearest = new Float32Array(size * size);
    nearest.fill(Number.POSITIVE_INFINITY);
    for (const sample of samples) {
        if (sample.groundRadiusM == null || sample.groundX == null) continue;
        const u = (sample.groundX / discRadius + 1) / 2;
        const v = (sample.groundZ / discRadius + 1) / 2;
        if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
        const x = clampIndex(Math.floor(u * size), size);
        const y = clampIndex(Math.floor(v * size), size);
        const texel = y * size + x;
        if (sample.groundRadiusM < nearest[texel]) nearest[texel] = sample.groundRadiusM;
    }
    const rgba = new Uint8Array(size * size * 4);
    for (let index = 0; index < nearest.length; index += 1) {
        const radius = nearest[index];
        if (!Number.isFinite(radius)) continue;
        const heat = 1 - Math.min(1, radius / discRadius);
        const offset = index * 4;
        rgba[offset] = Math.round(40 + 215 * heat);
        rgba[offset + 1] = Math.round(90 + 80 * (1 - heat));
        rgba[offset + 2] = Math.round(40 + 160 * (1 - heat));
        rgba[offset + 3] = 150;
    }
    return rgba;
}

function horizonGap(coveredBins, shellHits) {
    const bins = coveredBins.length;
    let covered = 0;
    for (let index = 0; index < bins; index += 1) covered += coveredBins[index];
    if (shellHits === 0 || covered === 0 || covered === bins) return null;
    let best = 0;
    let bestStart = 0;
    let run = 0;
    let runStart = 0;
    for (let index = 0; index < bins * 2; index += 1) {
        if (coveredBins[index % bins] === 0) {
            if (run === 0) runStart = index;
            run += 1;
            if (run > best && run <= bins) {
                best = run;
                bestStart = runStart;
            }
        } else {
            run = 0;
        }
    }
    if (best === 0) return null;
    const binWidth = 360 / bins;
    const startDeg = (bestStart % bins) * binWidth - 180;
    const spanDeg = best * binWidth;
    let centerDeg = startDeg + spanDeg / 2;
    centerDeg = ((centerDeg + 180) % 360 + 360) % 360 - 180;
    return { startDeg, spanDeg, centerDeg };
}

function azimuthDegrees(z, x) {
    let degrees = Math.atan2(z, x) * 180 / Math.PI;
    if (degrees === 180) degrees = -180;
    return degrees;
}

function azimuthBin(degrees, bins) {
    const width = 360 / bins;
    const index = Math.floor((degrees + 180) / width);
    return Math.min(bins - 1, Math.max(0, index));
}

function flattenVertices(vertices) {
    if (!vertices) return new Float32Array();
    if (vertices instanceof Float32Array && !Array.isArray(vertices[0])) return vertices;
    if (Array.isArray(vertices) && Array.isArray(vertices[0])) {
        const flat = new Float32Array(vertices.length * 3);
        vertices.forEach((vertex, index) => {
            flat[index * 3] = Number(vertex[0]) || 0;
            flat[index * 3 + 1] = Number(vertex[1]) || 0;
            flat[index * 3 + 2] = Number(vertex[2]) || 0;
        });
        return flat;
    }
    return Float32Array.from(vertices, (value) => Number(value) || 0);
}

function normalizeTriangles(triangles, vertexCount) {
    if (!triangles) return [];
    const faces = [];
    if (Array.isArray(triangles[0])) {
        for (const face of triangles) {
            if (faceInRange(face?.[0], face?.[1], face?.[2], vertexCount)) faces.push([face[0], face[1], face[2]]);
        }
        return faces;
    }
    for (let index = 0; index + 2 < triangles.length; index += 3) {
        const face = [triangles[index], triangles[index + 1], triangles[index + 2]];
        if (faceInRange(face[0], face[1], face[2], vertexCount)) faces.push(face);
    }
    return faces;
}

function faceInRange(a, b, c, vertexCount) {
    return Number.isInteger(a) && Number.isInteger(b) && Number.isInteger(c)
        && a >= 0 && b >= 0 && c >= 0
        && a < vertexCount && b < vertexCount && c < vertexCount
        && a !== b && b !== c && a !== c;
}

function vector(value) {
    return new Vector3(finite(value?.x, 0), finite(value?.y, 0), finite(value?.z, 0));
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback) {
    const number = Number(value);
    return number > 0 ? number : fallback;
}

function minNullable(current, next) {
    return current == null ? next : Math.min(current, next);
}

function clampIndex(index, size) {
    if (index < 0) return 0;
    if (index >= size) return size - 1;
    return index;
}
