/**
 * Browser-native methods such as `fetch` can throw "Illegal invocation" when
 * copied to an object and later called with the wrong `this` value.
 */
export function defaultFetch(...args) {
    if (typeof globalThis.fetch !== "function") {
        throw new Error("No fetch implementation is available.");
    }
    return globalThis.fetch(...args);
}
