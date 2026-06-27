export const DEFAULT_CHUNK_SIZE = 20;

function toPoint(value) {
    if (!value) return { x: 0, z: 0 };
    return {
        x: Number(value.x ?? 0),
        z: Number(value.z ?? 0),
    };
}

export function chunkKey(cx, cz) {
    return `${cx},${cz}`;
}

export function parseChunkKey(key) {
    const [cx, cz] = String(key).split(",").map((part) => Number.parseInt(part, 10));
    return {
        cx: Number.isFinite(cx) ? cx : 0,
        cz: Number.isFinite(cz) ? cz : 0,
    };
}

export function getChunkCoordForPoint(point, chunkSize = DEFAULT_CHUNK_SIZE) {
    const safeSize = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
    const p = toPoint(point);
    return {
        cx: Math.floor(p.x / safeSize),
        cz: Math.floor(p.z / safeSize),
    };
}

export function getChunkKeyForPoint(point, chunkSize = DEFAULT_CHUNK_SIZE) {
    const coord = getChunkCoordForPoint(point, chunkSize);
    return chunkKey(coord.cx, coord.cz);
}

export function getChunkBounds(keyOrCoord, chunkSize = DEFAULT_CHUNK_SIZE) {
    const coord = typeof keyOrCoord === "string" ? parseChunkKey(keyOrCoord) : keyOrCoord;
    const safeSize = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;

    return {
        minX: coord.cx * safeSize,
        minZ: coord.cz * safeSize,
        maxX: (coord.cx + 1) * safeSize,
        maxZ: (coord.cz + 1) * safeSize,
    };
}

export function boundsFromPoints(points = []) {
    if (!points.length) {
        return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
    }

    return points.reduce((bounds, point) => {
        const p = toPoint(point);
        return {
            minX: Math.min(bounds.minX, p.x),
            minZ: Math.min(bounds.minZ, p.z),
            maxX: Math.max(bounds.maxX, p.x),
            maxZ: Math.max(bounds.maxZ, p.z),
        };
    }, {
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
    });
}

export function getCoveredChunkKeysForBounds(bounds, chunkSize = DEFAULT_CHUNK_SIZE) {
    const safeSize = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
    const min = getChunkCoordForPoint({ x: bounds.minX, z: bounds.minZ }, safeSize);
    const max = getChunkCoordForPoint({ x: bounds.maxX, z: bounds.maxZ }, safeSize);
    const keys = [];

    for (let cx = min.cx; cx <= max.cx; cx += 1) {
        for (let cz = min.cz; cz <= max.cz; cz += 1) {
            keys.push(chunkKey(cx, cz));
        }
    }

    return keys;
}

export function getCoveredChunkKeysForPoints(points, chunkSize = DEFAULT_CHUNK_SIZE) {
    return getCoveredChunkKeysForBounds(boundsFromPoints(points), chunkSize);
}

export class ChunkIndex {
    constructor(options = {}) {
        this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
        this.chunks = new Map();
        this.objectChunks = new Map();
    }

    ensureChunk(key) {
        if (!this.chunks.has(key)) {
            this.chunks.set(key, {
                key,
                bounds: getChunkBounds(key, this.chunkSize),
                objectIds: new Set(),
                loaded: true,
                dirty: false,
            });
        }

        return this.chunks.get(key);
    }

    assignObject(objectId, boundsOrPoints) {
        if (!objectId) return null;

        const bounds = Array.isArray(boundsOrPoints)
            ? boundsFromPoints(boundsOrPoints)
            : boundsOrPoints;
        const coveredChunks = getCoveredChunkKeysForBounds(bounds, this.chunkSize);
        const center = {
            x: (bounds.minX + bounds.maxX) / 2,
            z: (bounds.minZ + bounds.maxZ) / 2,
        };
        const primaryChunk = getChunkKeyForPoint(center, this.chunkSize);

        this.removeObject(objectId);

        coveredChunks.forEach((key) => {
            const chunk = this.ensureChunk(key);
            chunk.objectIds.add(objectId);
            chunk.dirty = true;
        });

        this.objectChunks.set(objectId, {
            primaryChunk,
            coveredChunks: [...coveredChunks],
            bounds: { ...bounds },
        });

        return this.objectChunks.get(objectId);
    }

    removeObject(objectId) {
        const membership = this.objectChunks.get(objectId);
        if (!membership) return;

        membership.coveredChunks.forEach((key) => {
            const chunk = this.chunks.get(key);
            chunk?.objectIds.delete(objectId);
            if (chunk) chunk.dirty = true;
        });

        this.objectChunks.delete(objectId);
    }

    markDirty(key) {
        this.ensureChunk(key).dirty = true;
    }

    setLoaded(key, loaded) {
        this.ensureChunk(key).loaded = Boolean(loaded);
    }

    getObjectMembership(objectId) {
        const membership = this.objectChunks.get(objectId);
        return membership
            ? {
                primaryChunk: membership.primaryChunk,
                coveredChunks: [...membership.coveredChunks],
                bounds: { ...membership.bounds },
            }
            : null;
    }

    listChunks() {
        return [...this.chunks.values()].map((chunk) => ({
            key: chunk.key,
            bounds: { ...chunk.bounds },
            objectIds: [...chunk.objectIds],
            loaded: chunk.loaded,
            dirty: chunk.dirty,
        }));
    }
}
