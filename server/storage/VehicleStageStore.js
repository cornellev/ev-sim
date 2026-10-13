import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describeVehicleStageMember } from "../../app/vehicles/model/validateVehicleModel.js";
import { JsonFileStore } from "./JsonFileStore.js";
import { VEHICLE_STAGE_ERROR_CODES, vehicleStorageError } from "./StorageErrors.js";
import { writeExclusiveFile } from "./visual-assets/atomicFs.js";

const STAGE_KIND = "cev-sim.vehicle-stage";
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function stageError(code, message) {
    return vehicleStorageError(code, message);
}

/**
 * Durable upload area for vehicle bytes. It lives beside the manifest and
 * published asset directories so a staged file cannot change a resolved hash.
 */
export class VehicleStageStore {
    constructor(dataDir, { now = () => new Date(), limits = {}, faults = {} } = {}) {
        this.root = path.join(dataDir, "vehicle-stages");
        this.now = now;
        this.limits = { abandonedStageTtlMs: limits.abandonedStageTtlMs ?? DEFAULT_TTL_MS };
        this.faults = faults;
        this._chains = new Map();
        this._stores = new Map();
        this._ready = Promise.resolve();
    }

    recover(referencedStageIds = null) {
        const run = this._ready.catch(() => {}).then(() => this._recover(referencedStageIds));
        this._ready = run;
        return run;
    }

    async createStage() {
        await this.recover();
        const id = randomUUID();
        const createdAt = this.now().toISOString();
        const meta = {
            kind: STAGE_KIND,
            version: 1,
            id,
            phase: "open",
            createdAt,
            expiresAt: new Date(this.now().getTime() + this.limits.abandonedStageTtlMs).toISOString(),
            members: [],
        };
        await this._writeMeta(meta);
        return { stageId: id, expiresAt: meta.expiresAt };
    }

    async putMember(stageId, name, bytes) {
        return this._withStage(stageId, async () => {
            const meta = await this._require(stageId);
            this._assertWritable(meta);
            let described;
            try {
                described = describeVehicleStageMember(name, bytes);
            } catch (error) {
                throw stageError(VEHICLE_STAGE_ERROR_CODES.INVALID, error.message);
            }
            const target = this._memberPath(stageId, described.sha256);
            const written = await writeExclusiveFile(target, bytes, { faults: this.faults });
            if (written.existed) {
                const existing = await fs.readFile(target);
                if (describeVehicleStageMember(name, existing).sha256 !== described.sha256) {
                    throw stageError(VEHICLE_STAGE_ERROR_CODES.CONFLICT, `Staged digest "${described.sha256}" already exists with different bytes.`);
                }
            }
            const members = meta.members.filter((entry) => entry.name !== described.name);
            members.push(described);
            members.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
            meta.members = members;
            await this._writeMeta(meta);
            return described;
        });
    }

    async readMember(stageId, name) {
        const meta = await this._require(stageId);
        const member = meta.members.find((entry) => entry.name === name);
        if (!member) {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.NOT_FOUND, `Staged member "${name}" does not exist.`);
        }
        const bytes = await fs.readFile(this._memberPath(stageId, member.sha256));
        const described = describeVehicleStageMember(name, bytes);
        if (described.sha256 !== member.sha256 || described.size !== member.size) {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.CONFLICT, `Staged member "${name}" does not match its recorded digest.`);
        }
        return { ...described, bytes };
    }

    async renewStage(stageId) {
        return this._withStage(stageId, async () => {
            const meta = await this._require(stageId);
            if (meta.phase === "publishing") {
                throw stageError(VEHICLE_STAGE_ERROR_CODES.CONFLICT, `Vehicle stage "${stageId}" is being published.`);
            }
            meta.phase = "open";
            meta.expiresAt = new Date(this.now().getTime() + this.limits.abandonedStageTtlMs).toISOString();
            await this._writeMeta(meta);
            return { stageId, expiresAt: meta.expiresAt };
        });
    }

    async abandonStage(stageId) {
        return this._withStage(stageId, async () => {
            const meta = await this._readMeta(stageId);
            if (!meta) return false;
            if (meta.phase === "publishing") {
                throw stageError(VEHICLE_STAGE_ERROR_CODES.CONFLICT, `Vehicle stage "${stageId}" is being published.`);
            }
            await this._remove(stageId);
            return true;
        });
    }

    async markPublishing(stageId) {
        return this._withStage(stageId, async () => {
            const meta = await this._require(stageId);
            this._assertWritable(meta, { allowPublishing: true });
            meta.phase = "publishing";
            await this._writeMeta(meta);
            return meta;
        });
    }

    async markOpen(stageId) {
        return this._withStage(stageId, async () => {
            const meta = await this._readMeta(stageId);
            if (!meta || meta.phase !== "publishing") return meta;
            meta.phase = "open";
            await this._writeMeta(meta);
            return meta;
        });
    }

    async requireMeta(stageId) {
        return this._require(stageId);
    }

    async _recover(referencedStageIds) {
        await fs.mkdir(this.root, { recursive: true });
        const ids = await fs.readdir(this.root).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
        const releaseUnreferenced = referencedStageIds instanceof Set;
        for (const id of ids) {
            if (!/^[0-9a-f-]{36}$/i.test(id)) {
                await fs.rm(path.join(this.root, id), { recursive: true, force: true });
                continue;
            }
            const meta = await this._readMeta(id);
            if (!meta || meta.kind !== STAGE_KIND) {
                await this._remove(id);
                continue;
            }
            if (meta.phase === "publishing") {
                if (releaseUnreferenced && !referencedStageIds.has(id)) {
                    meta.phase = "open";
                    await this._writeMeta(meta);
                }
                continue;
            }
            if (this._expired(meta)) await this._remove(id);
        }
    }

    _assertWritable(meta, { allowPublishing = false } = {}) {
        if (meta.phase === "publishing" && !allowPublishing) {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.CONFLICT, `Vehicle stage "${meta.id}" is being published.`);
        }
        if (this._expired(meta) && meta.phase !== "publishing") {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.EXPIRED, `Vehicle stage "${meta.id}" has expired.`);
        }
    }

    _expired(meta) {
        const expires = Date.parse(meta?.expiresAt);
        return !Number.isFinite(expires) || expires <= this.now().getTime();
    }

    async _require(stageId) {
        const meta = await this._readMeta(stageId);
        if (!meta) throw stageError(VEHICLE_STAGE_ERROR_CODES.NOT_FOUND, `Vehicle stage "${stageId}" does not exist.`);
        return meta;
    }

    async _readMeta(stageId) {
        this._assertId(stageId);
        return this._store(stageId).read();
    }

    async _writeMeta(meta) {
        this._assertId(meta.id);
        return this._store(meta.id).write(meta);
    }

    _store(stageId) {
        const filePath = this._metaPath(stageId);
        let store = this._stores.get(filePath);
        if (!store) {
            store = new JsonFileStore(filePath, { fallback: null });
            this._stores.set(filePath, store);
        }
        return store;
    }

    _withStage(stageId, operation) {
        this._assertId(stageId);
        const previous = this._chains.get(stageId) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this._chains.set(stageId, current);
        current.finally(() => {
            if (this._chains.get(stageId) === current) this._chains.delete(stageId);
        }).catch(() => {});
        return current;
    }

    _assertId(stageId) {
        const text = String(stageId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(text)) {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.INVALID, `Invalid vehicle stage id ${JSON.stringify(stageId)}.`);
        }
    }

    _metaPath(stageId) {
        return path.join(this.root, stageId, "meta.json");
    }

    _memberPath(stageId, sha256) {
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
            throw stageError(VEHICLE_STAGE_ERROR_CODES.INVALID, "Staged member digest is invalid.");
        }
        return path.join(this.root, stageId, "members", sha256);
    }

    async _remove(stageId) {
        const filePath = this._metaPath(stageId);
        this._stores.get(filePath)?.invalidate();
        this._stores.delete(filePath);
        await fs.rm(path.join(this.root, stageId), { recursive: true, force: true });
    }
}
