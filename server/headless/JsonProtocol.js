function bytesToBase64(value) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

/** Convert runner values into an unambiguous JSON representation. */
export function jsonProtocolValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "bigint") return value.toString(10);
    if (typeof value !== "object") return value;
    if (ArrayBuffer.isView(value)) {
        return {
            encoding: "base64",
            type: value.constructor?.name || "Uint8Array",
            data: bytesToBase64(value),
        };
    }
    if (value instanceof ArrayBuffer) {
        return { encoding: "base64", type: "ArrayBuffer", data: Buffer.from(value).toString("base64") };
    }
    if (seen.has(value)) throw new TypeError("Cannot serialize a circular runner value.");
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.map((entry) => jsonProtocolValue(entry, seen));
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, jsonProtocolValue(entry, seen)]),
        );
    } finally {
        seen.delete(value);
    }
}

export function stringifyJsonProtocol(value, space = 0) {
    return JSON.stringify(jsonProtocolValue(value), null, space);
}
