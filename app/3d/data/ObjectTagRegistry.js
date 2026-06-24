/** Numeric tag ids packed into object GPU textures. */
export const TAG_IDS = {
    unknown: 0,
    building: 1,
    sign: 2,
    vehicle: 3,
    road: 4,
    barrel: 5,
    tire: 6,
};

export const MAX_TAG_ID = 255;

const NAME_BY_ID = Object.fromEntries(
    Object.entries(TAG_IDS).map(([name, id]) => [id, name])
);

/**
 * Resolve a semantic tag name to its numeric id.
 * @param {string} name
 * @returns {number}
 */
export function resolveTagId(name) {
    if (typeof name !== "string") return TAG_IDS.unknown;
    const normalized = name.trim().toLowerCase();
    return TAG_IDS[normalized] ?? TAG_IDS.unknown;
}

/**
 * @returns {number}
 */
export function getDefaultTagId() {
    return TAG_IDS.unknown;
}

/**
 * @param {number} id
 * @returns {string}
 */
export function tagNameFromId(id) {
    return NAME_BY_ID[id] ?? "unknown";
}

/**
 * Encode a tag id for shader output in the 0-1 range.
 * @param {number} tagId
 * @returns {number}
 */
export function normalizeTagId(tagId) {
    return Math.max(0, Math.min(1, tagId / MAX_TAG_ID));
}

/**
 * Decode a normalized shader tag value back to an integer id.
 * @param {number} normalized
 * @returns {number}
 */
export function denormalizeTagId(normalized) {
    return Math.round(Math.max(0, Math.min(1, normalized)) * MAX_TAG_ID);
}

/**
 * @param {import("./objects/Object").Object} object
 * @param {string[]} [includeTags]
 * @param {string[]} [excludeTags]
 * @returns {boolean}
 */
export function objectMatchesTags(object, includeTags = [], excludeTags = []) {
    if (!object) return true;

    const tags = object.tags || [];
    const tagId = object.tagId ?? TAG_IDS.unknown;
    const tagNames = new Set([
        ...tags.map((tag) => tag.toLowerCase()),
        tagNameFromId(tagId),
    ]);

    if (includeTags.length > 0) {
        const include = includeTags.map((tag) => tag.toLowerCase());
        if (!include.some((tag) => tagNames.has(tag))) {
            return false;
        }
    }

    if (excludeTags.length > 0) {
        const exclude = excludeTags.map((tag) => tag.toLowerCase());
        if (exclude.some((tag) => tagNames.has(tag))) {
            return false;
        }
    }

    return true;
}
