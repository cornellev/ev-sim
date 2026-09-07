import { promises as fs } from "node:fs";
import path from "node:path";

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
        await writeExclusiveUtf8(this.pathFor(digest), bytes);
        return digest;
    }
}

async function writeExclusiveUtf8(filePath, bytes) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, bytes, "utf8");
    try {
        await fs.link(tempPath, filePath);
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.readFile(filePath, "utf8");
        if (existing !== bytes) {
            throw new Error(`Visual layer access digest collision at ${path.basename(filePath)}.`);
        }
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}
