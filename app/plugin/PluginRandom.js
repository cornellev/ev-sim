import { comparePluginText } from "./PluginSelection.js";

function hashSeed(value) {
    const text = String(value);
    let hash = 1779033703;
    for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
        hash = (hash << 13) | (hash >>> 19);
    }
    return hash >>> 0;
}

class RandomStream {
    constructor(seed) {
        this.initialState = hashSeed(seed);
        this.state = this.initialState;
    }

    next() {
        let value = (this.state += 0x6d2b79f5) >>> 0;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    }
}

export class PluginRandom {
    constructor(resetSeed = "0") {
        this.resetSeed = String(resetSeed);
        this.streams = new Map();
    }

    stream(key) {
        const normalized = String(key);
        let stream = this.streams.get(normalized);
        if (!stream) {
            stream = new RandomStream(`${this.resetSeed}\u0000${normalized}`);
            this.streams.set(normalized, stream);
        }
        return stream;
    }

    next(key) {
        return this.stream(key).next();
    }

    snapshot() {
        return Object.fromEntries([...this.streams.entries()]
            .sort(([left], [right]) => comparePluginText(left, right))
            .map(([key, stream]) => [key, stream.state >>> 0]));
    }

    restore(snapshot = {}) {
        const keys = new Set(Object.keys(snapshot));
        for (const key of [...this.streams.keys()]) {
            if (!keys.has(key)) this.streams.delete(key);
        }
        for (const [key, state] of Object.entries(snapshot)) {
            const stream = this.stream(key);
            stream.state = Number(state) >>> 0;
        }
    }

    reset(resetSeed = this.resetSeed) {
        this.resetSeed = String(resetSeed);
        this.streams.clear();
    }
}
