import { SeededRNG } from "../../util/SeededRNG.js";

/**
 * @param {{ x: number, y: number, z: number }[]} footprint
 * @param {number} index
 * @returns {string}
 */
export function buildingIdFromFootprint(footprint, index = 0) {
    const key = footprint
        .map((point) => `${point.x.toFixed(3)},${point.z.toFixed(3)}`)
        .join("|");
    const hash = SeededRNG.hashSeed(`${key}:${index}`);
    return `bldg-${hash.toString(16).padStart(8, "0")}`;
}
