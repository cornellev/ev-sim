const textEncoder = new TextEncoder();

function fnv1a32(value) {
    let hash = 0x811c9dc5;
    for (const byte of textEncoder.encode(String(value))) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** Stable non-zero ID exactly representable by a Float32 LiDAR label channel. */
export function stableInstanceIdFromSource(sourceId) {
    const hash = fnv1a32(String(sourceId ?? "")) & 0x00ffffff;
    return hash === 0 ? 1 : hash;
}

/** Resolve the unlikely 24-bit collisions in canonical UTF-8 source order. */
export function allocateLidarInstanceIds(sourceIds, compare = undefined) {
    const result = new Map();
    const owners = new Map();
    const sorted = [...new Set(sourceIds.map(String))].sort(compare);
    for (const sourceId of sorted) {
        let salt = 0;
        let instanceId = stableInstanceIdFromSource(sourceId);
        while (owners.has(instanceId) && owners.get(instanceId) !== sourceId) {
            salt += 1;
            instanceId = stableInstanceIdFromSource(`${sourceId}#${salt}`);
        }
        owners.set(instanceId, sourceId);
        result.set(sourceId, instanceId);
    }
    return result;
}
