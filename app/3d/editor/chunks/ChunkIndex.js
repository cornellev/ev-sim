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

export const CHUNK_MUTATION_TYPES = Object.freeze({
    insert: "insert",
    delete: "delete",
    move: "move",
    material: "material",
    visibility: "visibility",
    entityId: "entity-id",
});

function uniqueKeys(keys) {
    return [...new Set(keys)];
}

export class ChunkIndex {
    constructor(options = {}) {
        this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
        this.chunks = new Map();
        this.objectChunks = new Map();
        this.semanticGeneration = 0;
        this.mutations = [];
    }

    ensureChunk(key) {
        if (!this.chunks.has(key)) {
            this.chunks.set(key, {
                key,
                bounds: getChunkBounds(key, this.chunkSize),
                objectIds: new Set(),
                loaded: true,
                prefetch: false,
                eviction: false,
                dirty: false,
            });
        }

        return this.chunks.get(key);
    }

    assignObject(objectId, boundsOrPoints, { mutationType = null } = {}) {
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
        const previous = this.objectChunks.get(objectId)
            ? {
                primaryChunk: this.objectChunks.get(objectId).primaryChunk,
                coveredChunks: [...this.objectChunks.get(objectId).coveredChunks],
                bounds: { ...this.objectChunks.get(objectId).bounds },
            }
            : null;

        this._detachObject(objectId);

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
        const membership = this.objectChunks.get(objectId);
        const type = mutationType
            ?? (previous ? CHUNK_MUTATION_TYPES.move : CHUNK_MUTATION_TYPES.insert);
        this._recordMutation({
            type,
            objectId,
            before: previous,
            after: {
                primaryChunk,
                coveredChunks: [...coveredChunks],
                bounds: { ...bounds },
            },
            affectedChunks: uniqueKeys([
                ...(previous?.coveredChunks ?? []),
                ...coveredChunks,
            ]),
        });
        return membership;
    }

    removeObject(objectId) {
        const previous = this.objectChunks.get(objectId);
        if (!previous) return null;
        const evidence = {
            type: CHUNK_MUTATION_TYPES.delete,
            objectId,
            before: {
                primaryChunk: previous.primaryChunk,
                coveredChunks: [...previous.coveredChunks],
                bounds: { ...previous.bounds },
            },
            after: null,
            affectedChunks: [...previous.coveredChunks],
        };
        this._detachObject(objectId);
        this._recordMutation(evidence);
        return evidence;
    }

    _detachObject(objectId) {
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

    recordCoverageMutation(objectId, type = CHUNK_MUTATION_TYPES.material) {
        const membership = this.getObjectMembership(objectId);
        if (!membership) return null;
        membership.coveredChunks.forEach((key) => this.markDirty(key));
        return this._recordMutation({
            type,
            objectId,
            before: membership,
            after: membership,
            affectedChunks: [...membership.coveredChunks],
        });
    }

    _recordMutation(evidence) {
        this.semanticGeneration += 1;
        const record = {
            ...evidence,
            semanticGeneration: this.semanticGeneration,
        };
        this.mutations.push(record);
        return record;
    }

    setLoaded(key, loaded) {
        const chunk = this.ensureChunk(key);
        chunk.loaded = Boolean(loaded);
        if (!loaded) chunk.prefetch = false;
    }

    setPrefetch(key, prefetch) {
        this.ensureChunk(key).prefetch = Boolean(prefetch);
    }

    setEviction(key, eviction) {
        this.ensureChunk(key).eviction = Boolean(eviction);
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

    queryKeysInRadius(point, radius) {
        const origin = toPoint(point);
        const safeRadius = Number(radius);
        if (!Number.isFinite(safeRadius) || safeRadius < 0) return [];
        return this.listChunks()
            .filter((chunk) => circleIntersectsBounds(origin, safeRadius, chunk.bounds))
            .map((chunk) => chunk.key);
    }

    queryKeysInBounds(bounds) {
        const box = normalizeBounds(bounds);
        return this.listChunks()
            .filter((chunk) => boundsIntersect(box, chunk.bounds))
            .map((chunk) => chunk.key);
    }

    queryObjectsInRadius(point, radius) {
        const keys = this.queryKeysInRadius(point, radius);
        return this._objectsForKeys(keys);
    }

    queryObjectsInBounds(bounds) {
        const keys = this.queryKeysInBounds(bounds);
        return this._objectsForKeys(keys);
    }

    _objectsForKeys(keys) {
        const ids = new Set();
        for (const key of keys) {
            const chunk = this.chunks.get(key);
            if (!chunk) continue;
            for (const objectId of chunk.objectIds) ids.add(objectId);
        }
        return [...ids].sort();
    }

    listChunks() {
        return [...this.chunks.values()].map((chunk) => ({
            key: chunk.key,
            bounds: { ...chunk.bounds },
            objectIds: [...chunk.objectIds],
            loaded: chunk.loaded,
            prefetch: chunk.prefetch,
            eviction: chunk.eviction,
            dirty: chunk.dirty,
        }));
    }
}

function normalizeBounds(bounds = {}) {
    return {
        minX: Number(bounds.minX ?? 0),
        minZ: Number(bounds.minZ ?? 0),
        maxX: Number(bounds.maxX ?? 0),
        maxZ: Number(bounds.maxZ ?? 0),
    };
}

function boundsIntersect(left, right) {
    return left.minX <= right.maxX
        && left.maxX >= right.minX
        && left.minZ <= right.maxZ
        && left.maxZ >= right.minZ;
}

function circleIntersectsBounds(point, radius, bounds) {
    const nearestX = Math.min(Math.max(point.x, bounds.minX), bounds.maxX);
    const nearestZ = Math.min(Math.max(point.z, bounds.minZ), bounds.maxZ);
    const dx = point.x - nearestX;
    const dz = point.z - nearestZ;
    return (dx * dx) + (dz * dz) <= radius * radius;
}
