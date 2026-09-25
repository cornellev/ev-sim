import { promises as fs } from "node:fs";
import path from "node:path";

import { writeExclusiveUtf8 } from "./exclusiveUtf8.js";

import {
    assertVisualLayerAccess,
    canonicalExactStringify,
    hashVisualLayerAccess,
    parseExactJson,
} from "../../app/simulation/visual/VisualLayer.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Internal content-addressed store for immutable visual-layer access sidecars.
 * Access hashes stay outside visualLayerHash, worldHash, and episode identity.
 */
export class VisualLayerAccessStore {
    constructor(dataDir) {
        this.rootDir = path.join(dataDir, "visual-layer-access", "sha256");
    }

    pathFor(digest) {
        if (!DIGEST_PATTERN.test(digest)) {
            throw new Error("Visual layer access digest must be a lowercase SHA-256 hash.");
        }
        return path.join(this.rootDir, `${digest}.json`);
    }

    async get(digest) {
        let text;
        try {
            text = await fs.readFile(this.pathFor(digest), "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const parsed = parseExactJson(text);
        assertVisualLayerAccess(parsed);
        const hash = hashVisualLayerAccess(parsed);
        if (hash !== digest) {
            throw new Error(`Visual layer access ${digest} does not match its canonical digest ${hash}.`);
        }
        return parsed;
    }

    async put(access) {
        assertVisualLayerAccess(access);
        const digest = hashVisualLayerAccess(access);
        const bytes = canonicalExactStringify(access);
        await writeExclusiveUtf8(
            this.pathFor(digest),
            bytes,
            (name) => `Visual layer access digest collision at ${name}.`,
        );
        return digest;
    }
}

