import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * JsonFileStore persists a single JSON value to a single file on disk.
 *
 * Design goals (kept deliberately simple - no database, no dependencies):
 *   - Reads are served from an in-memory cache after the first load, so the
 *     hot path never touches the disk.
 *   - Writes update the cache immediately and then flush to disk atomically
 *     (write to a temp file, then rename) so a crash mid-write can never leave
 *     a half-written / corrupt JSON file behind.
 *   - Writes are serialized through a promise chain so two concurrent writes
 *     can't race on the same temp file or rename.
 *
 * One instance owns exactly one file. Collections that span many files
 * (e.g. one file per script) create one JsonFileStore per file - see
 * StorageService.
 */
export class JsonFileStore {
    /**
     * @param {string} filePath Absolute path to the backing .json file.
     * @param {{ fallback?: unknown }} [options] `fallback` is returned by read()
     *   when the file does not exist yet.
     */
    constructor(filePath, { fallback = null } = {}) {
        this.filePath = filePath;
        this.fallback = fallback;
        // `undefined` means "not loaded yet"; `null` is a valid stored value.
        this._cache = undefined;
        // Serializes writes so renames never overlap.
        this._writeChain = Promise.resolve();
        this._readPromise = null;
    }

    /**
     * Returns the stored value (a deep copy so callers can't mutate the cache).
     * Falls back to the configured default when the file doesn't exist.
     */
    async read() {
        if (this._cache === undefined) {
            if (!this._readPromise) {
                this._readPromise = (async () => {
                    let loaded;
                    try {
                        const text = await fs.readFile(this.filePath, "utf8");
                        loaded = JSON.parse(text);
                    } catch (error) {
                        if (error.code === "ENOENT") {
                            loaded = clone(this.fallback);
                        } else {
                            throw error;
                        }
                    }
                    // A concurrent write owns the newer cache value.
                    if (this._cache === undefined) this._cache = loaded;
                })().finally(() => {
                    this._readPromise = null;
                });
            }
            await this._readPromise;
            if (this._cache === undefined) {
                // Defensive fallback for an invalidated store during a read.
                this._cache = clone(this.fallback);
            }
        }
        return clone(this._cache);
    }

    /**
     * Stores `value`: updates the in-memory cache right away and flushes it to
     * disk atomically. Returns a copy of what was stored.
     */
    async write(value) {
        const snapshot = clone(value);
        this._cache = snapshot;
        // Recover the queue after a prior filesystem error. The failed caller
        // still receives its rejection, while later writes get a fresh attempt.
        this._writeChain = this._writeChain
            .catch(() => {})
            .then(() => flushToDisk(this.filePath, snapshot));
        await this._writeChain;
        return clone(snapshot);
    }

    /** Forgets the in-memory cache (used after the underlying file is deleted). */
    invalidate() {
        this._cache = undefined;
    }
}

/** Deep copy via JSON. Safe here because every stored value is JSON already. */
function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Atomically replace the file contents: write a temp file, then rename it. */
async function flushToDisk(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
}
