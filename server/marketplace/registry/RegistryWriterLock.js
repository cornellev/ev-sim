import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { REGISTRY_DIRECTORY_MODE } from "./RegistryLayout.js";
import { lstatOrNull, readRegularBytes, removeDirectoryDurable, writeExclusiveDurable } from "./RegistryFs.js";

function conflict(message, owner = null) {
    const error = marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
    if (owner) error.owner = owner;
    return error;
}

function ownerDocument(token, now) {
    return Object.freeze({
        pid: process.pid,
        hostname: os.hostname(),
        token,
        acquiredAt: now().toISOString(),
    });
}

function parseOwner(bytes) {
    const { document } = parseMarketplaceJsonBytes(bytes);
    const keys = document && typeof document === "object" && !Array.isArray(document)
        ? Object.keys(document).sort()
        : [];
    if (!document || typeof document !== "object" || Array.isArray(document)
        || keys.join("\u0000") !== ["acquiredAt", "hostname", "pid", "token"].join("\u0000")
        || !Number.isSafeInteger(document.pid) || document.pid <= 0
        || typeof document.hostname !== "string" || !document.hostname
        || typeof document.token !== "string" || !/^[a-f0-9]{64}$/u.test(document.token)
        || typeof document.acquiredAt !== "string" || Number.isNaN(Date.parse(document.acquiredAt))
        || new Date(document.acquiredAt).toISOString() !== document.acquiredAt) {
        throw conflict("Registry writer ownership is malformed and cannot be reclaimed safely.");
    }
    return document;
}

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === "ESRCH") return false;
        return true;
    }
}

async function readOwner(paths) {
    try {
        const bytes = await readRegularBytes(paths.writerOwner, { maxBytes: 16 * 1024 });
        const owner = parseOwner(bytes);
        if (!Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(owner)))) {
            throw conflict("Registry writer ownership is noncanonical and cannot be reclaimed safely.");
        }
        return owner;
    } catch (error) {
        if (error?.code === MARKETPLACE_ERROR_CODES.CONFLICT) throw error;
        throw conflict("Registry writer ownership is incomplete, malformed, or hostile and cannot be reclaimed safely.");
    }
}

async function createLock(paths, token, now) {
    await fs.mkdir(paths.writerLock, { mode: REGISTRY_DIRECTORY_MODE });
    try {
        await fs.chmod(paths.writerLock, REGISTRY_DIRECTORY_MODE);
        await writeExclusiveDurable(paths.writerOwner, canonicalMarketplaceBytes(ownerDocument(token, now)));
        await fsyncDir(paths.root);
    } catch (error) {
        await fs.rm(paths.writerLock, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

async function reclaimDeadOwner(paths, observed) {
    try {
        await fs.mkdir(paths.writerRecovery, { mode: REGISTRY_DIRECTORY_MODE });
        await fs.chmod(paths.writerRecovery, REGISTRY_DIRECTORY_MODE);
    } catch (error) {
        if (error.code === "EEXIST") throw conflict("Registry writer recovery is already in progress.");
        throw error;
    }
    try {
        const current = await readOwner(paths);
        if (current.token !== observed.token) throw conflict("Registry writer ownership changed during stale-owner recovery.");
        if (current.hostname !== os.hostname() || processAlive(current.pid)) throw conflict("Registry writer owner is still live or is on another host.", current);
        await removeDirectoryDurable(paths.writerLock);
    } finally {
        await removeDirectoryDurable(paths.writerRecovery).catch(() => {});
    }
}

export class RegistryWriterLock {
    #paths;
    #token;
    #closed = false;

    constructor(paths, token) {
        this.#paths = paths;
        this.#token = token;
    }

    static async acquire(paths, { now = () => new Date() } = {}) {
        const token = randomBytes(32).toString("hex");
        try {
            await createLock(paths, token, now);
            return new RegistryWriterLock(paths, token);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        const stat = await lstatOrNull(paths.writerLock);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
            throw conflict("Registry writer lock is not a regular directory.");
        }
        const owner = await readOwner(paths);
        if (owner.hostname !== os.hostname()) throw conflict("Registry writer ownership belongs to another host and is ambiguous.", owner);
        if (processAlive(owner.pid)) throw conflict("Registry already has a live writer.", owner);
        await reclaimDeadOwner(paths, owner);
        await createLock(paths, token, now);
        return new RegistryWriterLock(paths, token);
    }

    get token() {
        return this.#token;
    }

    async assertOwned() {
        const owner = await readOwner(this.#paths);
        if (owner.token !== this.#token || owner.pid !== process.pid || owner.hostname !== os.hostname()) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Registry writer ownership changed during the active operation.");
        }
        return owner;
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        let owner;
        try {
            owner = await readOwner(this.#paths);
        } catch {
            return;
        }
        if (owner.token !== this.#token) return;
        await removeDirectoryDurable(this.#paths.writerLock);
    }
}
