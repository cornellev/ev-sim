/**
 * Sorted-key JSON using JavaScript's UTF-16 code-unit key order.
 * Episode and world hashes use UTF-8 order in SimulationHashes instead.
 * Changing this sort would change resolved-run hashes.
 */

export function canonicalStringify(value) {
    const normalize = (entry) => {
        if (Array.isArray(entry)) return entry.map(normalize);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(
            Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]),
        );
    };
    return JSON.stringify(normalize(value));
}
