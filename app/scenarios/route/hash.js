import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";

/**
 * JSON-compatible stable serialization used by scenario route hashes.
 * Object keys and Map entries are sorted; array order remains significant.
 */
export function stableStringify(value) {
    const seen = new WeakSet();
    const compareText = (left, right) => {
        const a = String(left);
        const b = String(right);
        return a < b ? -1 : a > b ? 1 : 0;
    };

    const normalize = (item) => {
        if (item === null || typeof item !== "object") {
            if (typeof item === "number" && !Number.isFinite(item)) return null;
            if (typeof item === "number") return canonicalFiniteNumber(item);
            return item;
        }

        if (seen.has(item)) {
            throw new TypeError("Cannot hash a circular value.");
        }
        seen.add(item);

        let normalized;
        if (Array.isArray(item)) {
            normalized = item.map(normalize);
        } else if (item instanceof Map) {
            normalized = [...item.entries()]
                .sort(([left], [right]) => compareText(left, right))
                .map(([key, entry]) => [key, normalize(entry)]);
        } else if (item instanceof Set) {
            normalized = [...item].map(normalize).sort((left, right) => compareText(
                JSON.stringify(left),
                JSON.stringify(right),
            ));
        } else {
            normalized = {};
            for (const key of Object.keys(item).sort()) {
                const entry = item[key];
                if (entry !== undefined && typeof entry !== "function") {
                    normalized[key] = normalize(entry);
                }
            }
        }

        seen.delete(item);
        return normalized;
    };

    return JSON.stringify(normalize(value));
}

function fnv1a32(text, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        hash ^= code & 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= code >>> 8;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/**
 * Small synchronous content hash suitable for browser and server code.
 * This is an identity/checksum hash, not a cryptographic signature.
 */
export function deterministicHash(value) {
    const text = typeof value === "string" ? value : stableStringify(value);
    return `hash-v1-${fnv1a32(text, 0x811c9dc5)}${fnv1a32(text, 0x9e3779b9)}`;
}
