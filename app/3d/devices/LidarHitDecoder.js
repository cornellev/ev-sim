import { denormalizeTagId, tagNameFromId } from "../data/ObjectTagRegistry.js";

/** @typedef {{ distance: number, incidence: number, semanticId: number, instanceId: number, tagId: number, tagName: string, objectKind: null, objectIndex: number, hit: boolean }} LidarHit */

/**
 * @param {Float32Array} buffer
 * @param {number} range
 * @returns {LidarHit[]}
 */
export function parseLidarHits(buffer, range, { encoding = "metric-v2" } = {}) {
    if (!buffer) return [];

    const hits = [];
    for (let i = 0; i < buffer.length; i += 4) {
        const legacy = encoding === "legacy-normalized";
        const hit = legacy ? buffer[i + 3] > 0.5 : buffer[i] > 0 && buffer[i + 3] > 0;
        const distance = hit
            ? (legacy ? (1.0 - buffer[i]) * range : buffer[i])
            : range;
        const incidence = hit ? (legacy ? buffer[i] : buffer[i + 1]) : 0;
        const tagId = legacy ? denormalizeTagId(buffer[i + 1]) : Math.round(buffer[i + 2]);
        const instanceId = hit ? (legacy ? 0 : Math.round(buffer[i + 3]) >>> 0) : 0;

        hits.push({
            distance,
            incidence,
            semanticId: tagId,
            instanceId,
            tagId,
            tagName: tagNameFromId(tagId),
            objectKind: null,
            objectIndex: -1,
            hit,
        });
    }

    return hits;
}

/**
 * Decode object kind from the shader B channel.
 * @param {number} objectKindValue
 * @returns {"triangle"|"box"|null}
 */
export function decodeObjectKind(objectKindValue) {
    if (objectKindValue < 0.5) return "triangle";
    if (objectKindValue < 1.5) return "box";
    return null;
}

/**
 * @param {LidarHit[]} hits
 * @param {string|string[]} tagNames
 * @returns {LidarHit[]}
 */
export function filterHitsByTag(hits, tagNames) {
    const wanted = (Array.isArray(tagNames) ? tagNames : [tagNames]).map((tag) => tag.toLowerCase());
    return hits.filter((hit) => wanted.includes(hit.tagName));
}
