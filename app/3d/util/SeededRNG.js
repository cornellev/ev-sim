/**
 * Deterministic pseudo-random number generator (mulberry32).
 */
export class SeededRNG {
    /**
     * @param {number|string} seed
     */
    constructor(seed = 1) {
        this._state = SeededRNG.hashSeed(seed);
    }

    /**
     * @param {number|string} value
     * @returns {number}
     */
    static hashSeed(value) {
        const text = String(value);
        let hash = 1779033703;
        for (let i = 0; i < text.length; i += 1) {
            hash = Math.imul(hash ^ text.charCodeAt(i), 3432918353);
            hash = (hash << 13) | (hash >>> 19);
        }
        return hash >>> 0;
    }

    /**
     * @returns {number} value in [0, 1)
     */
    next() {
        let t = (this._state += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    range(min, max) {
        return min + (max - min) * this.next();
    }

    /**
     * @param {number} max exclusive upper bound
     * @returns {number}
     */
    int(max) {
        return Math.floor(this.next() * max);
    }

    /**
     * @param {number} min inclusive
     * @param {number} max inclusive
     * @returns {number}
     */
    intRange(min, max) {
        return min + this.int(max - min + 1);
    }

    /**
     * @param {ReadonlyArray<unknown>} items
     * @returns {unknown}
     */
    pick(items) {
        if (!items.length) return undefined;
        return items[this.int(items.length)];
    }

    /**
     * @param {string} label
     * @returns {SeededRNG}
     */
    fork(label) {
        return new SeededRNG(SeededRNG.hashSeed(`${this._state}:${label}`));
    }
}

/**
 * @param {string} runId
 * @param {string} buildingId
 * @param {number} revision
 * @param {number} sliceIndex
 * @returns {number}
 */
export function deriveModelSeed(runId, buildingId, revision = 0, sliceIndex = 0) {
    return SeededRNG.hashSeed(`${runId}:${buildingId}:${revision}:${sliceIndex}`);
}
