import { promises as fs } from "node:fs";
import path from "node:path";

import { writeExclusiveUtf8 } from "./exclusiveUtf8.js";

import {
    assertVisualLayer,
    canonicalExactStringify,
    hashVisualLayer,
    parseExactJson,
} from "../../app/simulation/visual/VisualLayer.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Internal content-addressed store for immutable visual-layer descriptors.
 * Binary assets, public CAS routes, quotas, and GC are owned by VisualAssetStore.
 */
export class VisualLayerDescriptorStore {
    constructor(dataDir) {
        this.rootDir = path.join(dataDir, "visual-layer-descriptors", "sha256");
    }

    pathFor(digest) {
        if (!DIGEST_PATTERN.test(digest)) {
            throw new Error("Visual layer descriptor digest must be a lowercase SHA-256 hash.");
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
        assertVisualLayer(parsed);
        const hash = hashVisualLayer(parsed);
        if (hash !== digest) {
            throw new Error(`Visual layer descriptor ${digest} does not match its canonical digest ${hash}.`);
        }
        return parsed;
    }

    async put(descriptor) {
        assertVisualLayer(descriptor);
        const digest = hashVisualLayer(descriptor);
        const bytes = canonicalExactStringify(descriptor);
        await writeExclusiveUtf8(
            this.pathFor(digest),
            bytes,
            (name) => `Visual layer digest collision at ${name}.`,
        );
        return digest;
    }
}

