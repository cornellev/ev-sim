import { promises as fs } from "node:fs";
import { constants } from "node:fs";

import {
    normalizeVisualSourceRegistry,
    parseExactJson,
} from "../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "./StorageErrors.js";

export class VisualSourceRegistryFile {
    constructor(filePath) {
        this.filePath = filePath;
    }

    async load() {
        let lstat;
        try {
            lstat = await fs.lstat(this.filePath);
        } catch (error) {
            if (error.code === "ENOENT") {
                return normalizeVisualSourceRegistry({
                    kind: "cev-sim.visual-source-registry",
                    version: 1,
                    sources: [],
                });
            }
            throw error;
        }
        if (lstat.isSymbolicLink()) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.SYMLINK,
                "The visual source registry must be a regular operator-controlled file.",
            );
        }
        const handle = await fs.open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const text = await handle.readFile("utf8");
            return normalizeVisualSourceRegistry(parseExactJson(text));
        } catch (error) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
                `Visual source registry is missing or invalid: ${error.message}`,
            );
        } finally {
            await handle.close();
        }
    }

    async policyMap() {
        const document = await this.load();
        return new Map(document.sources.map((entry) => [entry.id, entry]));
    }
}
