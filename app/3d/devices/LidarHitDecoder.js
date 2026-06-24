import { denormalizeTagId, tagNameFromId } from "../data/ObjectTagRegistry.js";

/** @typedef {{ distance: number, tagId: number, tagName: string, objectKind: "triangle"|"box"|null, objectIndex: number, hit: boolean }} LidarHit */

/**
 * @param {Float32Array} buffer
 * @param {number} range
 * @returns {LidarHit[]}
 */
export function parseLidarHits(buffer, range) {
    if (!buffer) return [];

    const hits = [];
    for (let i = 0; i < buffer.length; i += 4) {
        const intensity = buffer[i];
        const normalizedTag = buffer[i + 1];
        const objectKindValue = buffer[i + 2];
        const hitFlag = buffer[i + 3];

        const hit = hitFlag > 0.5;
        const distance = hit ? (1.0 - intensity) * range : range;
        const tagId = denormalizeTagId(normalizedTag);
        const objectKind = hit ? decodeObjectKind(objectKindValue) : null;

        hits.push({
            distance,
            tagId,
            tagName: tagNameFromId(tagId),
            objectKind,
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
