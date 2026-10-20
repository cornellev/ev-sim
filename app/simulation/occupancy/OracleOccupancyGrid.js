import { OCCUPANCY_CELLS, OCCUPANCY_RESOLUTION_M, OCCUPANCY_TILE_CELLS } from "./constants.js";

const INTERSECTION_SEGMENTS = 64;

function cross(ax, az, bx, bz) {
    return ax * bz - az * bx;
}

function pointInTriangle(x, z, triangle) {
    const [ax, az, bx, bz, cx, cz] = triangle;
    const area = cross(bx - ax, bz - az, cx - ax, cz - az);
    if (Math.abs(area) <= 1e-12) return false;
    const left = cross(bx - ax, bz - az, x - ax, z - az);
    const right = cross(cx - bx, cz - bz, x - bx, z - bz);
    const back = cross(ax - cx, az - cz, x - cx, z - cz);
    if (area > 0) return left >= -1e-9 && right >= -1e-9 && back >= -1e-9;
    return left <= 1e-9 && right <= 1e-9 && back <= 1e-9;
}

function pointInRing(x, z, ring) {
    let inside = false;
    let previous = ring.length - 1;
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const prior = ring[previous];
        const span = prior[1] - current[1];
        const intersects = ((current[1] > z) !== (prior[1] > z))
            && (x < ((prior[0] - current[0]) * (z - current[1])) / span + current[0]);
        if (intersects) inside = !inside;
        previous = index;
    }
    return inside;
}

function finitePair(point, meshVertex) {
    if (Array.isArray(point)) {
        const x = Number(point[0]);
        const z = Number(meshVertex ? point[2] : point[1]);
        return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
    }
    const x = Number(point?.x);
    const z = Number(point?.z);
    return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
}

function footprintPoints(points) {
    const rows = [];
    for (const point of points || []) {
        const pair = finitePair(point, false);
        if (pair) rows.push(pair);
    }
    return rows;
}

/** Six-decimal monotone chain, matching Python `_convex_hull_xz`. */
export function convexHullXZ(vertices) {
    const seen = new Set();
    const unique = [];
    for (const point of vertices || []) {
        const pair = finitePair(point, true);
        if (!pair) continue;
        const key = `${pair[0].toFixed(6)},${pair[1].toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push([Number(pair[0].toFixed(6)), Number(pair[1].toFixed(6))]);
    }
    unique.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    if (unique.length < 3) return [];
    const turn = (origin, left, right) => (
        (left[0] - origin[0]) * (right[1] - origin[1]) - (left[1] - origin[1]) * (right[0] - origin[0])
    );
    const chain = (points) => {
        const built = [];
        for (const point of points) {
            while (built.length >= 2 && turn(built[built.length - 2], built[built.length - 1], point) <= 0) built.pop();
            built.push(point);
        }
        return built;
    };
    const hull = chain(unique).slice(0, -1).concat(chain([...unique].reverse()).slice(0, -1));
    return hull.length >= 3 ? hull : [];
}

function fanTriangles(vertices) {
    const triangles = [];
    for (let index = 1; index < vertices.length - 1; index += 1) {
        const a = vertices[0];
        const b = vertices[index];
        const c = vertices[index + 1];
        triangles.push([a[0], a[1], b[0], b[1], c[0], c[1]]);
    }
    return triangles;
}

function indexedTriangles(vertices, indices) {
    const triangles = [];
    const triples = [];
    if (Array.isArray(indices?.[0])) triples.push(...indices);
    else if (indices?.length >= 3) {
        for (let index = 0; index + 2 < indices.length; index += 3) {
            triples.push([indices[index], indices[index + 1], indices[index + 2]]);
        }
    }
    for (const triple of triples) {
        const a = vertices[triple[0]];
        const b = vertices[triple[1]];
        const c = vertices[triple[2]];
        if (!a || !b || !c) continue;
        triangles.push([a[0], a[1], b[0], b[1], c[0], c[1]]);
    }
    return triangles;
}

function withBounds(triangle) {
    const xs = [triangle[0], triangle[2], triangle[4]];
    const zs = [triangle[1], triangle[3], triangle[5]];
    return {
        triangle,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
    };
}

function ringBounds(points) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of points) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
    }
    return { points, minX, maxX, minZ, maxZ };
}

function surfaceTriangles(surface) {
    if (surface?.kind === "intersection-disc" && surface.center && Number(surface.radius) > 0) {
        const cx = Number(surface.center.x) || 0;
        const cz = Number(surface.center.z) || 0;
        const radius = Number(surface.radius);
        const triangles = [];
        for (let index = 0; index < INTERSECTION_SEGMENTS; index += 1) {
            const start = index * Math.PI * 2 / INTERSECTION_SEGMENTS;
            const end = (index + 1) * Math.PI * 2 / INTERSECTION_SEGMENTS;
            triangles.push(withBounds([
                cx, cz,
                cx + Math.cos(start) * radius, cz + Math.sin(start) * radius,
                cx + Math.cos(end) * radius, cz + Math.sin(end) * radius,
            ]));
        }
        return triangles;
    }
    const source = surface?.vertices?.length ? surface.vertices : surface?.footprint;
    const vertices = footprintPoints(source);
    if (vertices.length < 3) return [];
    const indices = surface?.indices || surface?.triangles;
    const raw = indices?.length ? indexedTriangles(vertices, indices) : fanTriangles(vertices);
    return raw.map(withBounds);
}

function obstacleRings(description) {
    const rings = [];
    for (const obstacle of description?.obstacles || []) {
        const points = footprintPoints(obstacle?.footprint);
        if (points.length >= 3) rings.push(ringBounds(points));
    }
    for (const proxy of description?.assetProxies || []) {
        for (const mesh of proxy?.collision || []) {
            const hull = convexHullXZ(mesh?.vertices);
            if (hull.length >= 3) rings.push(ringBounds(hull));
        }
    }
    for (const solid of description?.primitives || []) {
        const hull = convexHullXZ(solid?.vertices);
        if (hull.length >= 3) rings.push(ringBounds(hull));
    }
    return rings;
}

export function snapWindowOrigin(x, z, resolution = OCCUPANCY_RESOLUTION_M, cells = OCCUPANCY_CELLS) {
    const half = cells * resolution * 0.5;
    const originCol = Math.floor((x - half) / resolution + 1e-9);
    const originRow = Math.floor((z - half) / resolution + 1e-9);
    return {
        originX: originCol * resolution,
        originZ: originRow * resolution,
        originCol,
        originRow,
    };
}

function fillBlocked(tile, originCol, originRow, resolution, bounds, triangles, rings) {
    tile.fill(1);
    const tileSpan = OCCUPANCY_TILE_CELLS;
    const x0 = originCol * resolution;
    const z0 = originRow * resolution;
    const x1 = (originCol + tileSpan) * resolution;
    const z1 = (originRow + tileSpan) * resolution;
    const localTriangles = triangles.filter((entry) => (
        entry.maxX >= x0 && entry.minX <= x1 && entry.maxZ >= z0 && entry.minZ <= z1
    ));
    if (localTriangles.length === 0) return tile;
    const localRings = rings.filter((entry) => (
        entry.maxX >= x0 && entry.minX <= x1 && entry.maxZ >= z0 && entry.minZ <= z1
    ));
    for (let row = 0; row < tileSpan; row += 1) {
        const z = (originRow + row + 0.5) * resolution;
        if (bounds && (z < bounds.minZ || z > bounds.maxZ)) continue;
        for (let col = 0; col < tileSpan; col += 1) {
            const x = (originCol + col + 0.5) * resolution;
            if (bounds && (x < bounds.minX || x > bounds.maxX)) continue;
            let inside = false;
            for (const entry of localTriangles) {
                if (x < entry.minX || x > entry.maxX || z < entry.minZ || z > entry.maxZ) continue;
                if (pointInTriangle(x, z, entry.triangle)) {
                    inside = true;
                    break;
                }
            }
            if (!inside) continue;
            let blocked = false;
            for (const ring of localRings) {
                if (x < ring.minX || x > ring.maxX || z < ring.minZ || z > ring.maxZ) continue;
                if (pointInRing(x, z, ring.points)) {
                    blocked = true;
                    break;
                }
            }
            if (!blocked) tile[row * tileSpan + col] = 0;
        }
    }
    return tile;
}

function stampActor(window, originCol, originRow, cells, resolution, actor) {
    const yaw = Number(actor.yaw) || 0;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const centerX = actor.x + (Number(actor.centerX) || 0) * cosine + (Number(actor.centerZ) || 0) * sine;
    const centerZ = actor.z - (Number(actor.centerX) || 0) * sine + (Number(actor.centerZ) || 0) * cosine;
    const halfLength = (Number(actor.length) || 0) * 0.5;
    const halfWidth = (Number(actor.width) || 0) * 0.5;
    if (!(halfLength > 0) || !(halfWidth > 0)) return;
    const corners = [
        [-halfLength, -halfWidth],
        [halfLength, -halfWidth],
        [halfLength, halfWidth],
        [-halfLength, halfWidth],
    ].map(([localX, localZ]) => ({
        x: centerX + localX * cosine + localZ * sine,
        z: centerZ - localX * sine + localZ * cosine,
    }));
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const corner of corners) {
        minX = Math.min(minX, corner.x);
        maxX = Math.max(maxX, corner.x);
        minZ = Math.min(minZ, corner.z);
        maxZ = Math.max(maxZ, corner.z);
    }
    const col0 = Math.max(0, Math.floor(minX / resolution) - originCol);
    const col1 = Math.min(cells, Math.floor(maxX / resolution) - originCol + 1);
    const row0 = Math.max(0, Math.floor(minZ / resolution) - originRow);
    const row1 = Math.min(cells, Math.floor(maxZ / resolution) - originRow + 1);
    for (let row = row0; row < row1; row += 1) {
        const z = (originRow + row + 0.5) * resolution;
        for (let col = col0; col < col1; col += 1) {
            const x = (originCol + col + 0.5) * resolution;
            const dx = x - centerX;
            const dz = z - centerZ;
            const localX = dx * cosine - dz * sine;
            const localZ = dx * sine + dz * cosine;
            if (Math.abs(localX) <= halfLength && Math.abs(localZ) <= halfWidth) {
                window[row * cells + col] = 1;
            }
        }
    }
}

/**
 * Static drivable costmap. 0 is clear, 1 is blocked. Tiles are built when a
 * window first touches them and kept for the run. The ego box is not stamped.
 */
export class OracleOccupancyGrid {
    constructor(description, {
        resolutionM = OCCUPANCY_RESOLUTION_M,
        cells = OCCUPANCY_CELLS,
    } = {}) {
        if (!(resolutionM > 0) || !Number.isInteger(cells) || cells < 1) {
            throw new TypeError("Occupancy grid requires a positive resolution and a positive cell count.");
        }
        this.resolution = resolutionM;
        this.cells = cells;
        this.window = new Uint8Array(cells * cells);
        this.staticTiles = new Map();
        this.overlayTiles = new Map();
        this.overlaySignature = "";
        this.overlayRings = [];
        this.triangles = [];
        for (const surface of description?.drivableSurfaces || []) {
            this.triangles.push(...surfaceTriangles(surface));
        }
        this.rings = obstacleRings(description);
        const bounds = description?.bounds;
        this.bounds = bounds?.min && bounds?.max
            ? {
                minX: Number(bounds.min.x),
                maxX: Number(bounds.max.x),
                minZ: Number(bounds.min.z),
                maxZ: Number(bounds.max.z),
            }
            : null;
    }

    setOverlay(obstacles = []) {
        const signature = (obstacles || []).map((obstacle) => (
            `${obstacle?.id || ""}:${footprintPoints(obstacle?.footprint).map((point) => point.join(",")).join(";")}`
        )).join("|");
        if (signature === this.overlaySignature) return;
        this.overlaySignature = signature;
        this.overlayRings = (obstacles || [])
            .map((obstacle) => footprintPoints(obstacle?.footprint))
            .filter((points) => points.length >= 3)
            .map(ringBounds);
        this.overlayTiles.clear();
    }

    staticTile(tileCol, tileRow) {
        const key = `${tileCol}:${tileRow}`;
        const cached = this.staticTiles.get(key);
        if (cached) return cached;
        const tile = fillBlocked(
            new Uint8Array(OCCUPANCY_TILE_CELLS * OCCUPANCY_TILE_CELLS),
            tileCol * OCCUPANCY_TILE_CELLS,
            tileRow * OCCUPANCY_TILE_CELLS,
            this.resolution,
            this.bounds,
            this.triangles,
            this.rings,
        );
        this.staticTiles.set(key, tile);
        return tile;
    }

    overlayTile(tileCol, tileRow) {
        if (this.overlayRings.length === 0) return null;
        const key = `${tileCol}:${tileRow}`;
        const cached = this.overlayTiles.get(key);
        if (cached) return cached;
        const tile = new Uint8Array(OCCUPANCY_TILE_CELLS * OCCUPANCY_TILE_CELLS);
        const originCol = tileCol * OCCUPANCY_TILE_CELLS;
        const originRow = tileRow * OCCUPANCY_TILE_CELLS;
        const x0 = originCol * this.resolution;
        const z0 = originRow * this.resolution;
        const x1 = (originCol + OCCUPANCY_TILE_CELLS) * this.resolution;
        const z1 = (originRow + OCCUPANCY_TILE_CELLS) * this.resolution;
        const rings = this.overlayRings.filter((ring) => (
            ring.maxX >= x0 && ring.minX <= x1 && ring.maxZ >= z0 && ring.minZ <= z1
        ));
        if (rings.length === 0) {
            this.overlayTiles.set(key, tile);
            return tile;
        }
        for (let row = 0; row < OCCUPANCY_TILE_CELLS; row += 1) {
            const z = (originRow + row + 0.5) * this.resolution;
            for (let col = 0; col < OCCUPANCY_TILE_CELLS; col += 1) {
                const x = (originCol + col + 0.5) * this.resolution;
                for (const ring of rings) {
                    if (x < ring.minX || x > ring.maxX || z < ring.minZ || z > ring.maxZ) continue;
                    if (pointInRing(x, z, ring.points)) {
                        tile[row * OCCUPANCY_TILE_CELLS + col] = 1;
                        break;
                    }
                }
            }
        }
        this.overlayTiles.set(key, tile);
        return tile;
    }

    /**
     * Copy cached static tiles into the reused window, then restamp every
     * non-ego actor. The copy erases the previous sample's stamps.
     */
    sample({ x, z, actors = [] } = {}) {
        const snapped = snapWindowOrigin(x, z, this.resolution, this.cells);
        const { originCol, originRow } = snapped;
        const tileSpan = OCCUPANCY_TILE_CELLS;
        const firstTileCol = Math.floor(originCol / tileSpan);
        const firstTileRow = Math.floor(originRow / tileSpan);
        const lastTileCol = Math.floor((originCol + this.cells - 1) / tileSpan);
        const lastTileRow = Math.floor((originRow + this.cells - 1) / tileSpan);
        this.window.fill(1);
        for (let tileRow = firstTileRow; tileRow <= lastTileRow; tileRow += 1) {
            for (let tileCol = firstTileCol; tileCol <= lastTileCol; tileCol += 1) {
                const tile = this.staticTile(tileCol, tileRow);
                const overlay = this.overlayTile(tileCol, tileRow);
                const tileOriginCol = tileCol * tileSpan;
                const tileOriginRow = tileRow * tileSpan;
                const col0 = Math.max(0, tileOriginCol - originCol);
                const row0 = Math.max(0, tileOriginRow - originRow);
                const col1 = Math.min(this.cells, tileOriginCol + tileSpan - originCol);
                const row1 = Math.min(this.cells, tileOriginRow + tileSpan - originRow);
                for (let row = row0; row < row1; row += 1) {
                    const sourceRow = row + originRow - tileOriginRow;
                    for (let col = col0; col < col1; col += 1) {
                        const sourceIndex = sourceRow * tileSpan + (col + originCol - tileOriginCol);
                        const blocked = tile[sourceIndex] === 1 || overlay?.[sourceIndex] === 1;
                        if (!blocked) this.window[row * this.cells + col] = 0;
                    }
                }
            }
        }
        for (const actor of actors) stampActor(this.window, originCol, originRow, this.cells, this.resolution, actor);
        return {
            cells: this.window,
            originX: snapped.originX,
            originZ: snapped.originZ,
            originCol,
            originRow,
            resolutionM: this.resolution,
        };
    }
}
