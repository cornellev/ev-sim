/**
 * Describes one render or mask output for a bake sample.
 *
 * @typedef {Object} BakePassDescriptor
 * @property {string} id - Unique pass id used in filenames and metadata.
 * @property {"render"|"mask"} kind - Beauty RGB layer or binary tag mask.
 * @property {string[]} [includeTags] - Objects that must match at least one tag.
 * @property {string[]} [excludeTags] - Objects to hide from this pass.
 * @property {boolean} [upload=true] - Whether this pass should be uploaded.
 */

/** @type {BakePassDescriptor} */
export const DEFAULT_BEAUTY_PASS = {
    id: "beauty",
    kind: "render",
    includeTags: [],
    excludeTags: ["sign", "vehicle"],
    upload: true,
};

/** @type {BakePassDescriptor[]} */
export const DEFAULT_MASK_PASSES = [
    {
        id: "mask_road",
        kind: "mask",
        includeTags: ["road"],
        excludeTags: [],
        upload: true,
    },
    {
        id: "mask_building",
        kind: "mask",
        includeTags: ["building"],
        excludeTags: [],
        upload: true,
    },
];

/**
 * @param {BakePassDescriptor[]} [passes]
 * @returns {BakePassDescriptor[]}
 */
export function resolveViewPasses(passes) {
    if (Array.isArray(passes) && passes.length > 0) {
        return passes.map((pass) => ({ ...pass }));
    }

    return [DEFAULT_BEAUTY_PASS, ...DEFAULT_MASK_PASSES];
}

/**
 * @param {string} runId
 * @param {number} frameIndex
 * @returns {string}
 */
export function buildSampleId(runId, frameIndex) {
    return `${runId}:${frameIndex}`;
}

/**
 * @param {BakePassDescriptor} pass
 * @returns {string}
 */
export function passFileRole(pass) {
    return pass.kind === "mask" ? "mask" : "render";
}
