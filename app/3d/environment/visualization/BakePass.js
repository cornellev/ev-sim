/**
 * Describes one render or mask output for a bake sample.
 *
 * @typedef {Object} BakePassDescriptor
 * @property {string} id - Unique pass id used in filenames and metadata.
 * @property {"render"|"mask"|"depth"} kind - Beauty RGB layer, binary tag mask, or depth.
 * @property {string[]} [includeTags] - Objects that must match at least one tag.
 * @property {string[]} [excludeTags] - Objects to hide from this pass.
 * @property {boolean} [upload=true] - Whether this pass should be uploaded.
 * @property {string} [buildingId] - Restrict mask to one stable building id.
 * @property {string[]} [maskTags] - Semantic tags sent to the model server.
 * @property {string} [processTag] - Model prompt routing tag.
 * @property {string} [modelSeedKey] - Key used to derive deterministic model seed.
 * @property {boolean} [chainProcess=false] - Allow chained model processing for this pass.
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
        id: "mask_building",
        kind: "mask",
        includeTags: ["building"],
        excludeTags: [],
        upload: true,
    },
    {
        id: "mask_no_road_building",
        kind: "mask",
        includeTags: [],
        excludeTags: ["road", "building"],
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
    if (pass.kind === "mask") return "mask";
    if (pass.kind === "depth") return "depth";
    if (pass.kind === "lidar") return "lidar";
    return "render";
}
