import { promises as fs } from "node:fs";
import path from "node:path";

import { writeExclusiveUtf8 } from "./exclusiveUtf8.js";

import { canonicalExactStringify, parseExactJson } from "../../app/simulation/visual/VisualLayer.js";
import {
    assertBakeMaterialProposalSet,
    hashBakeMaterialProposalSet,
} from "../../app/3d/environment/visual/BakeMaterialProposals.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Content-addressed store for immutable VIS-10b proposal provenance. */
export class BakeMaterialProposalStore {
    constructor(dataDir) {
        this.rootDir = path.join(dataDir, "bake-material-proposals", "sha256");
    }

    pathFor(digest) {
        if (!DIGEST_PATTERN.test(digest)) throw new Error("Material proposal digest must be a lowercase SHA-256 hash.");
        return path.join(this.rootDir, `${digest}.json`);
    }

    async get(digest) {
        let body;
        try {
            body = await fs.readFile(this.pathFor(digest), "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const parsed = parseExactJson(body);
        assertBakeMaterialProposalSet(parsed);
        const actual = hashBakeMaterialProposalSet(parsed);
        if (actual !== digest) throw new Error(`Material proposal ${digest} does not match its canonical digest ${actual}.`);
        return parsed;
    }

    async put(proposalSet) {
        assertBakeMaterialProposalSet(proposalSet);
        const digest = hashBakeMaterialProposalSet(proposalSet);
        const body = canonicalExactStringify(proposalSet);
        await writeExclusiveUtf8(
            this.pathFor(digest),
            body,
            (name) => `Material proposal digest collision at ${name}.`,
        );
        return digest;
    }
}

