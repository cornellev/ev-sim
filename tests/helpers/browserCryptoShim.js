import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function createHash(algorithm) {
    if (String(algorithm).toLowerCase() !== "sha256") {
        throw new Error(`Unsupported browser test hash ${algorithm}.`);
    }
    const hash = sha256.create();
    return {
        update(value) {
            hash.update(typeof value === "string" ? new TextEncoder().encode(value) : value);
            return this;
        },
        digest(encoding) {
            const result = hash.digest();
            if (encoding === "hex") return bytesToHex(result);
            return result;
        },
    };
}
