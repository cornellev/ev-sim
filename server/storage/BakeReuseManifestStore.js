import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalExactStringify, parseExactJson } from "../../app/simulation/visual/VisualLayer.js";
import {
    assertBakeReuseManifest,
    hashBakeReuseManifest,
} from "../../app/3d/environment/visual/BakeReuseContracts.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Content-addressed store for immutable cev-sim.bake-reuse-manifest@1 documents.
 */
export class BakeReuseManifestStore {
    constructor(dataDir) {
        this.rootDir = path.join(dataDir, "bake-reuse-manifests", "sha256");
    }

    pathFor(digest) {
        if (!DIGEST_PATTERN.test(digest)) {
            throw new Error("Bake reuse manifest digest must be a lowercase SHA-256 hash.");
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
        assertBakeReuseManifest(parsed);
        const hash = hashBakeReuseManifest(parsed);
        if (hash !== digest) {
            throw new Error(`Bake reuse manifest ${digest} does not match its canonical digest ${hash}.`);
        }
        return parsed;
    }

    async put(manifest) {
        assertBakeReuseManifest(manifest);
        const digest = hashBakeReuseManifest(manifest);
        const bytes = canonicalExactStringify(manifest);
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
            throw new Error(`Bake reuse manifest digest collision at ${path.basename(filePath)}.`);
        }
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}
