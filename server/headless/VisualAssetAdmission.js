import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { canonicalExactStringify } from "../../app/simulation/visual/VisualLayer.js";
import { RUN_PACKAGE_ERROR_CODES, VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../storage/StorageErrors.js";
import { VisualAssetStore } from "../storage/VisualAssetStore.js";
import { createMutex } from "../storage/visual-assets/semaphore.js";
import { fsyncDir, maybeFault, openRegularFile, writeExclusiveFile } from "../storage/visual-assets/atomicFs.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";
import {
    createPackageStagingDir,
    evaluatePackageRights,
    mapRunPackageError,
    recoverPackageStaging,
    RUN_PACKAGE_RUNTIME_LIMITS,
    sortUsesForPublish,
    verifyRunPackageArchive,
} from "./VisualAssetPack.js";

export const RUN_PACKAGE_ADMISSION_PROFILE = "cev-sim.run-package@1";
export const RUN_PACKAGE_ADMISSION_OPERATIONS = Object.freeze([
    "display",
    "machine-interpretation",
    "persistent-cache",
    "retention",
    "worker-access",
]);

const STAGING_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HANDLE = /^[a-f0-9]{64}$/;

async function writeAtomic(filePath, bytes, mode = 0o600) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle = null;
    try {
        handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
        const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        let offset = 0;
        while (offset < content.length) {
            const written = await handle.write(content, offset, content.length - offset, offset);
            if (written.bytesWritten <= 0) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Admission metadata write made no progress.");
            offset += written.bytesWritten;
        }
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, filePath);
        await fsyncDir(path.dirname(filePath));
    } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}

async function readBounded(filePath, maxBytes) {
    const opened = await openRegularFile(filePath);
    if (!opened) return null;
    try {
        if (opened.stat.size > maxBytes) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Admission metadata exceeds its byte ceiling.");
        const chunks = [];
        let size = 0;
        for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > maxBytes) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Admission metadata exceeds its byte ceiling.");
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
    } finally {
        await opened.handle.close();
    }
}

async function readJson(filePath) {
    const bytes = await readBounded(filePath, RUN_PACKAGE_RUNTIME_LIMITS.bundleBytes * 3);
    return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}

function admissionOwner(handle) {
    return `asset-admission:${handle}`;
}

function bundleClosureIdentity(bundle) {
    const uses = bundle?.resolved?.evidence?.visualAssets?.uses ?? [];
    return {
        assetClosureHash: bundle?.resolved?.evidence?.visualAssets?.assetClosureHash ?? null,
        useHashes: [...new Set(uses.map((entry) => entry.useHash))].sort(),
        digestUses: Object.fromEntries(uses.map((entry) => [entry.use.asset.sha256, entry.useHash])),
    };
}

function recordShape(record) {
    return {
        kind: "cev-sim.asset-admission",
        version: 1,
        handle: record.handle,
        bundleBytesHash: record.bundleBytesHash,
        bundleCanonicalHash: record.bundleCanonicalHash,
        canonicalBundle: record.canonicalBundle,
        packageManifestHash: record.packageManifestHash,
        archiveHash: record.archiveHash,
        resolvedHash: record.resolvedHash,
        simulationSemanticHash: record.simulationSemanticHash,
        identityVersion: record.identityVersion,
        assetClosureHash: record.assetClosureHash ?? null,
        useHashes: record.useHashes,
        digestUses: record.digestUses,
        rootGeneration: record.rootGeneration,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        expiresAt: record.expiresAt,
        released: Boolean(record.released),
        batchPins: Number(record.batchPins || 0),
    };
}

export class VisualAssetAdmissionManager {
    constructor(config, { now = () => new Date(), faults = {} } = {}) {
        this.config = config;
        this.enabled = config?.enabled === true;
        this.inboxDir = config?.inboxDir ?? "";
        this.storageDir = config?.storageDir ?? "";
        this.recordsDir = path.join(this.storageDir, "admissions");
        this.bundlesDir = path.join(this.storageDir, "bundles");
        this.stagingDir = path.join(this.storageDir, "staging");
        this.processingDir = path.join(this.storageDir, "processing");
        this.ownerPath = path.join(this.storageDir, "admission-owner.json");
        this._ownerToken = null;
        this.now = now;
        this.faults = faults;
        this.store = new VisualAssetStore(this.storageDir, {
            rootDir: path.join(this.storageDir, "assets"),
            registryPath: config?.registryPath,
            now: this.now,
            limits: {
                assetBytes: config?.limits?.assetBytes,
                assetEntries: config?.limits?.assetEntries,
                validationTimeoutMs: config?.limits?.verificationTimeoutMs,
                abandonedStageTtlMs: config?.limits?.abandonedStageTtlMs,
            },
        });
        this.records = new Map();
        this._activeScopes = new Map();
        this._scopeClosers = new Map();
        this._closed = false;
        this._ready = null;
        this._mutex = createMutex();
        this._sweepTimer = null;
    }

    get profile() {
        return this.enabled ? RUN_PACKAGE_ADMISSION_PROFILE : null;
    }

    _recordPath(handle) {
        return path.join(this.recordsDir, `${handle}.json`);
    }

    _bundlePath(handle) {
        return path.join(this.bundlesDir, `${handle}.json`);
    }

    async initialize() {
        if (this._closed) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Asset admission manager is closed.");
        if (!this.enabled) return this;
        this._ready ??= this._initialize();
        return this._ready;
    }

    async _initialize() {
        await fs.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
        await this._acquireOwner();
        await Promise.all([
            fs.mkdir(this.inboxDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.recordsDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.bundlesDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.processingDir, { recursive: true, mode: 0o700 }),
            this.store.initialize(),
        ]);
        const names = await fs.readdir(this.recordsDir);
        for (const name of names.sort()) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const record = await readJson(path.join(this.recordsDir, name)).catch(() => null);
            if (!record || record.kind !== "cev-sim.asset-admission" || record.version !== 1
                || !HANDLE.test(record.handle) || record.handle !== name.slice(0, -5)
                || !Number.isSafeInteger(record.batchPins) || record.batchPins < 0) {
                await fs.rm(path.join(this.recordsDir, name), { force: true });
                continue;
            }
            if (record.batchPins > 0 && !record.released) {
                record.expiresAt = new Date(this.now().getTime() + this.config.unusedTtlMs).toISOString();
            }
            record.batchPins = 0;
            try {
                await this._verifyRecord(record, { rights: true });
                if (record.released || Date.parse(record.expiresAt) <= this.now().getTime()) {
                    await this._disposeRecord(record);
                    continue;
                }
                const root = await this.store.getRoot(admissionOwner(record.handle));
                if (!root) {
                    const acquired = await this.store.acquireRoot({
                        ownerId: admissionOwner(record.handle),
                        ownerKind: "asset-admission",
                        useHashes: record.useHashes,
                        operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
                    });
                    record.rootGeneration = acquired.generation;
                } else {
                    const expectedUses = canonicalExactStringify(record.useHashes);
                    if (root.ownerKind !== "asset-admission"
                        || canonicalExactStringify(root.useHashes ?? []) !== expectedUses) {
                        const replaced = await this.store.replaceRoot({
                            ownerId: admissionOwner(record.handle),
                            expectedGeneration: root.generation,
                            ownerKind: "asset-admission",
                            useHashes: record.useHashes,
                            operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
                        });
                        record.rootGeneration = replaced.generation;
                    } else record.rootGeneration = root.generation;
                }
                await this._persist(record);
                this.records.set(record.handle, record);
            } catch {
                await this._disposeRecord(record);
            }
        }
        for (const name of await fs.readdir(this.bundlesDir)) {
            const match = /^([a-f0-9]{64})\.json$/.exec(name);
            if (match && !this.records.has(match[1])) await fs.rm(path.join(this.bundlesDir, name), { force: true });
        }
        for (const [ownerId, root] of Object.entries(this.store._roots?.roots ?? {})) {
            if (!ownerId.startsWith("asset-admission:")) continue;
            const handle = ownerId.slice("asset-admission:".length);
            if (!this.records.has(handle)) {
                await this.store.releaseRoot({ ownerId, expectedGeneration: root.generation }).catch(() => {});
            }
        }
        await this._reconcileInbox();
        await recoverPackageStaging(this.stagingDir, { ttlMs: 0 });
        this._scheduleSweep();
        return this;
    }

    async _acquireOwner() {
        const owner = { pid: process.pid, token: randomUUID() };
        const bytes = JSON.stringify(owner);
        if (!(await writeExclusiveFile(this.ownerPath, bytes)).existed) {
            this._ownerToken = owner.token;
            return;
        }
        const previous = await readJson(this.ownerPath);
        if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1 || typeof previous.token !== "string") {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Admission storage ownership is ambiguous; refusing recovery.");
        }
        let alive = true;
        try { process.kill(previous.pid, 0); }
        catch (error) { if (error.code === "ESRCH") alive = false; }
        if (alive) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Admission storage already has a live supervisor owner.");
        // Serialize stale-owner takeover too. If a process itself crashes
        // during takeover, fail closed for operator inspection rather than
        // ever clearing another live supervisor's pins.
        const recovery = `${this.ownerPath}.recovery`;
        await fs.mkdir(recovery, { mode: 0o700 });
        try {
            if ((await readJson(this.ownerPath))?.token !== previous.token) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Admission storage owner changed during recovery.");
            }
            await fs.rm(this.ownerPath);
            if ((await writeExclusiveFile(this.ownerPath, bytes)).existed) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Admission storage was claimed during recovery.");
            }
            this._ownerToken = owner.token;
        } finally {
            await fs.rmdir(recovery);
        }
    }

    _scheduleSweep() {
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        this._sweepTimer = null;
        if (this._closed) return;
        const expiries = [...this.records.values()]
            .filter((record) => record.batchPins === 0)
            .map((record) => Date.parse(record.expiresAt))
            .filter(Number.isFinite);
        if (!expiries.length) return;
        const delay = Math.max(1, Math.min(2_147_483_647, Math.min(...expiries) - this.now().getTime()));
        this._sweepTimer = setTimeout(() => {
            this._sweepTimer = null;
            this.sweepExpired().catch(() => {});
        }, delay);
        this._sweepTimer.unref?.();
    }

    async sweepExpired() {
        if (!this.enabled) return { removed: 0 };
        await this.initialize();
        return this._mutex(async () => {
            let removed = 0;
            const now = this.now().getTime();
            for (const record of [...this.records.values()]) {
                if (record.batchPins === 0 && Date.parse(record.expiresAt) <= now) {
                    await this._disposeRecord(record);
                    removed += 1;
                }
            }
            this._scheduleSweep();
            return { removed };
        });
    }

    async _reconcileInbox() {
        const cutoff = this.now().getTime() - this.config.unusedTtlMs;
        for (const name of await fs.readdir(this.inboxDir)) {
            const abandonedClaim = /^\.[a-f0-9]{32}\.processing-[a-f0-9-]{36}$/.test(name);
            const stagedInput = /^(?:[a-f0-9]{32}\.run-package|\.[a-f0-9]{32}\.[a-f0-9-]+\.tmp)$/.test(name);
            if (!abandonedClaim && !stagedInput) continue;
            const filePath = path.join(this.inboxDir, name);
            try {
                const stat = await fs.lstat(filePath);
                if (abandonedClaim || stat.mtimeMs <= cutoff) {
                    await fs.rm(filePath, { recursive: true, force: true });
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        for (const name of await fs.readdir(this.processingDir)) {
            if (/^[a-f0-9]{32}-[a-f0-9-]{36}\.run-package$/.test(name)) {
                await fs.rm(path.join(this.processingDir, name), { recursive: true, force: true });
            }
        }
    }

    async _persist(record) {
        await maybeFault(this.faults, "persistAdmission");
        await writeAtomic(this._recordPath(record.handle), `${canonicalExactStringify(recordShape(record))}\n`);
    }

    async _assertRights(bundle) {
        const registry = await this.store.registry.policyMap();
        const decision = evaluatePackageRights({
            bundle,
            operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
            registry,
            atTime: this.now(),
        });
        if (!decision.allowed) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.RIGHTS_DENIED, "Current visual-source rights deny asset admission.", {
                denials: decision.denials,
            });
        }
        return decision;
    }

    async _verifyRecord(record, { rights = false } = {}) {
        if (!HANDLE.test(record.handle) || !SHA256.test(record.bundleBytesHash)
            || !SHA256.test(record.bundleCanonicalHash) || !SHA256.test(record.packageManifestHash)
            || !SHA256.test(record.archiveHash) || !SHA256.test(record.resolvedHash)
            || !SHA256.test(record.simulationSemanticHash)
            || (record.assetClosureHash !== null && !SHA256.test(record.assetClosureHash))
            || !Number.isSafeInteger(record.identityVersion)
            || !Number.isSafeInteger(record.batchPins) || record.batchPins < 0
            || typeof record.released !== "boolean"
            || ![record.createdAt, record.lastUsedAt, record.expiresAt].every((value) => Number.isFinite(Date.parse(value)))) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Admission record metadata is invalid.");
        }
        const exactBytes = await readBounded(this._bundlePath(record.handle), this.config.limits.bundleBytes);
        if (!exactBytes || createHash("sha256").update(exactBytes).digest("hex") !== record.bundleBytesHash) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Admitted bundle bytes are missing or corrupt.");
        }
        const verified = verifyRunBundleBytes(exactBytes, {
            expectedBundleBytesHash: record.bundleBytesHash,
            execution: false,
        });
        const canonicalBundle = canonicalRunBundleStringify(verified.bundle);
        const closure = bundleClosureIdentity(verified.bundle);
        if (canonicalBundle !== record.canonicalBundle
            || createHash("sha256").update(canonicalBundle).digest("hex") !== record.bundleCanonicalHash
            || verified.resolvedHash !== record.resolvedHash
            || verified.simulationSemanticHash !== record.simulationSemanticHash
            || verified.identityVersion !== record.identityVersion
            || closure.assetClosureHash !== record.assetClosureHash
            || canonicalExactStringify(closure.useHashes) !== canonicalExactStringify(record.useHashes)
            || canonicalExactStringify(closure.digestUses) !== canonicalExactStringify(record.digestUses)) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Admitted canonical bundle identity changed.");
        }
        if (rights) await this._assertRights(verified.bundle);
        if (rights) {
            await this.store.validateAccessSet({
                useHashes: record.useHashes,
                operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
                verifyBytes: true,
            });
        }
        return { ...verified, exactBytes };
    }

    async admit({ stagingId, archiveHash }) {
        if (!this.enabled) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset admission is not configured.");
        if (!STAGING_ID.test(String(stagingId || ""))) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "staging_id must be exactly 32 lowercase hexadecimal characters.");
        }
        await this.initialize();
        return this._mutex(async () => {
            if (this._closed) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Asset admission manager is closed.");
            const sourcePath = path.join(this.inboxDir, `${stagingId}.run-package`);
            const processingPath = path.join(this.processingDir, `${stagingId}-${randomUUID()}.run-package`);
            let staging = null;
            let record = null;
            const deadline = Date.now() + this.config.limits.verificationTimeoutMs;
            const checkDeadline = () => {
                if (Date.now() >= deadline) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.TIMEOUT, "Asset admission exceeded its time budget.");
            };
            try {
                await fs.rename(sourcePath, processingPath);
                if (!SHA256.test(String(archiveHash || ""))) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "archive_hash must be a lowercase SHA-256 digest.");
                }
                const opened = await openRegularFile(processingPath);
                if (!opened) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Staged run package was not found.");
                if (opened.stat.nlink !== 1) {
                    await opened.handle.close();
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "Staged run packages must have exactly one link.");
                }
                let verified;
                try {
                    staging = await createPackageStagingDir(this.stagingDir);
                    verified = await verifyRunPackageArchive(opened.handle.createReadStream({ autoClose: true }), {
                        stagingDir: staging.dir,
                        retainStaging: true,
                        limits: this.config.limits,
                        deadline,
                    });
                } finally {
                    await opened.handle.close().catch(() => {});
                }
                if (verified.archiveHash !== archiveHash) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Staged archive bytes do not match archive_hash.");
                }
                const decision = await this._assertRights(verified.bundle);
                const uses = verified.bundle.resolved?.evidence?.visualAssets?.uses ?? [];
                const assets = new Map(verified.assets.map((asset) => [asset.sha256, asset.path]));
                for (const { use } of sortUsesForPublish(uses)) {
                    checkDeadline();
                    const assetPath = assets.get(use.asset.sha256);
                    if (!assetPath) {
                        throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, `Package is missing ${use.asset.sha256}.`);
                    }
                    const upload = await this.store.createUpload(use);
                    try {
                        checkDeadline();
                        await this.store.writeUploadContent(upload.id, createReadStream(assetPath), {
                            contentLength: use.asset.sizeBytes,
                            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
                        });
                    } catch (error) {
                        await this.store.abortUpload(upload.id).catch(() => {});
                        throw error;
                    }
                }
                checkDeadline();
                const handle = randomBytes(32).toString("hex");
                const createdAt = this.now().toISOString();
                const root = await this.store.acquireRoot({
                    ownerId: admissionOwner(handle),
                    ownerKind: "asset-admission",
                    useHashes: uses.map((entry) => entry.useHash),
                    operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
                });
                const closure = bundleClosureIdentity(verified.bundle);
                record = {
                    handle,
                    bundleBytesHash: verified.bundleBytesHash,
                    bundleCanonicalHash: createHash("sha256").update(verified.canonicalBundle).digest("hex"),
                    canonicalBundle: verified.canonicalBundle,
                    packageManifestHash: verified.packageManifestHash,
                    archiveHash: verified.archiveHash,
                    resolvedHash: verified.resolvedHash,
                    simulationSemanticHash: verified.simulationSemanticHash,
                    identityVersion: verified.identityVersion,
                    assetClosureHash: closure.assetClosureHash,
                    useHashes: closure.useHashes,
                    digestUses: closure.digestUses,
                    rootGeneration: root.generation,
                    createdAt,
                    lastUsedAt: createdAt,
                    expiresAt: new Date(this.now().getTime() + this.config.unusedTtlMs).toISOString(),
                    released: false,
                    batchPins: 0,
                    obligations: decision.obligations,
                };
                await writeAtomic(this._bundlePath(handle), verified.bundleBytes);
                checkDeadline();
                await this._persist(record);
                checkDeadline();
                this.records.set(handle, record);
                this._scheduleSweep();
                return { handle, bundleBytesHash: record.bundleBytesHash };
            } catch (error) {
                if (record) await this._disposeRecord(record).catch(() => {});
                throw mapRunPackageError(error);
            } finally {
                if (staging) await fs.rm(staging.dir, { recursive: true, force: true }).catch(() => {});
                await fs.rm(processingPath, { recursive: true, force: true }).catch(() => {});
            }
        });
    }

    async bind({ handle, bundleBytesHash, canonicalBytes }) {
        await this.initialize();
        return this._mutex(async () => {
            const record = this.records.get(String(handle || ""));
            if (record && Date.parse(record.expiresAt) <= this.now().getTime() && record.batchPins === 0) {
                await this._disposeRecord(record);
            }
            if (!record || record.released || (record.batchPins === 0 && Date.parse(record.expiresAt) <= this.now().getTime())) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset admission is stale, released, or unknown.");
            }
            if (record.bundleBytesHash !== String(bundleBytesHash || "")) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "asset_admission.bundle_bytes_hash does not match the admitted archive bytes.");
            }
            const wire = Buffer.from(canonicalBytes || []);
            if (!wire.equals(Buffer.from(record.canonicalBundle, "utf8"))) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Wire canonical_json does not serialize the admitted run-bundle document.");
            }
            const verified = await this._verifyRecord(record, { rights: true });
            record.lastUsedAt = this.now().toISOString();
            record.expiresAt = new Date(this.now().getTime() + this.config.unusedTtlMs).toISOString();
            await this._persist(record);
            this._scheduleSweep();
            return { record, ...verified };
        });
    }

    async acquireBatch(handles) {
        await this.initialize();
        const unique = [...new Set(handles.filter(Boolean))].sort();
        return this._mutex(async () => {
            const pinned = [];
            try {
                for (const handle of unique) {
                    const record = this.records.get(handle);
                    if (!record || record.released || (record.batchPins === 0 && Date.parse(record.expiresAt) <= this.now().getTime())) {
                        if (record && record.batchPins === 0) await this._disposeRecord(record);
                        throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset admission is unavailable.");
                    }
                    await this._verifyRecord(record, { rights: true });
                    const next = { ...record, batchPins: record.batchPins + 1, lastUsedAt: this.now().toISOString() };
                    await this._persist(next);
                    this.records.set(handle, next);
                    pinned.push(handle);
                }
                return pinned;
            } catch (error) {
                for (const handle of pinned) {
                    const record = this.records.get(handle);
                    if (record) {
                        record.batchPins = Math.max(0, record.batchPins - 1);
                        await this._persist(record).catch(() => {});
                    }
                }
                throw error;
            }
        });
    }

    async revalidate(handle) {
        await this.initialize();
        return this._mutex(async () => {
            const record = this.records.get(handle);
            if (!record || record.batchPins < 1) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset admission is no longer valid for this batch.");
            }
            return this._verifyRecord(record, { rights: true });
        });
    }

    async releaseBatch(handles) {
        if (!this.enabled) return;
        await this.initialize();
        return this._mutex(async () => {
            for (const handle of [...new Set(handles)].sort()) {
                const record = this.records.get(handle);
                if (!record) continue;
                record.batchPins = Math.max(0, record.batchPins - 1);
                if (record.batchPins === 0 && record.released) {
                    await this._disposeRecord(record);
                }
                else {
                    if (record.batchPins === 0) record.expiresAt = new Date(this.now().getTime() + this.config.unusedTtlMs).toISOString();
                    await this._persist(record);
                }
            }
            this._scheduleSweep();
        });
    }

    async release(handle) {
        if (!this.enabled) return { released: true };
        await this.initialize();
        return this._mutex(async () => {
            const record = this.records.get(String(handle || ""));
            if (!record) return { released: true };
            record.released = true;
            if (record.batchPins === 0) await this._disposeRecord(record);
            else await this._persist(record);
            this._scheduleSweep();
            return { released: true };
        });
    }

    async _disposeRecord(record) {
        await Promise.all([...this._scopeClosers.get(record.handle)?.values() ?? []].map((close) => close()));
        // Persist the tombstone before removing the root. A crash or failed
        // unlink must never turn a released admission back into a usable one.
        record.released = true;
        await writeAtomic(this._recordPath(record.handle), canonicalExactStringify({
            kind: "cev-sim.asset-admission", version: 1, handle: record.handle, released: true, batchPins: 0,
        }));
        this._activeScopes.delete(record.handle);
        const root = await this.store.getRoot(admissionOwner(record.handle));
        if (root) {
            await this.store.releaseRoot({
                ownerId: admissionOwner(record.handle),
                expectedGeneration: root.generation,
            });
        }
        await Promise.all([
            fs.rm(this._recordPath(record.handle), { force: true }),
            fs.rm(this._bundlePath(record.handle), { force: true }),
        ]);
        await Promise.all([fsyncDir(this.recordsDir), fsyncDir(this.bundlesDir)]);
        this.records.delete(record.handle);
    }

    createDigestReader(handle, environmentKey) {
        const key = String(environmentKey || "");
        if (!key) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "An environment scope is required.");
        const record = this.records.get(handle);
        if (!record || record.batchPins < 1) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "The environment asset admission is not pinned.");
        }
        const scopes = this._activeScopes.get(handle) ?? new Set();
        if (scopes.has(key)) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "The environment asset scope is already active.");
        }
        scopes.add(key);
        this._activeScopes.set(handle, scopes);
        let closed = false;
        let closing = null;
        const pending = new Set();
        const leases = new Set();
        const close = () => {
            if (closing) return closing;
            closed = true;
            closing = (async () => {
                await Promise.allSettled([...leases].map((release) => release()));
                await Promise.allSettled([...pending]);
                const active = this._activeScopes.get(handle);
                active?.delete(key);
                if (active?.size === 0) this._activeScopes.delete(handle);
                const closers = this._scopeClosers.get(handle);
                closers?.delete(key);
                if (closers?.size === 0) this._scopeClosers.delete(handle);
            })();
            return closing;
        };
        const closers = this._scopeClosers.get(handle) ?? new Map();
        closers.set(key, close);
        this._scopeClosers.set(handle, closers);
        const activeRecord = () => {
            const current = this.records.get(handle);
            if (closed || !this._activeScopes.get(handle)?.has(key)
                || !current || current.batchPins < 1) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "The environment asset admission is not pinned.");
            }
            return current;
        };
        const openResolved = async (useHash, { start = 0, end } = {}, expectedDigest = null, mappedDigest = false) => {
            const current = activeRecord();
            if (typeof useHash !== "string" || !SHA256.test(useHash)
                || (!mappedDigest && !current.useHashes.includes(useHash))) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Requested use is outside the admitted closure.");
            }
            if (!Number.isSafeInteger(start) || start < 0
                || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset reader ranges must be non-negative safe integers.");
            }
            if (!mappedDigest) {
                const use = await this.store.getUse(useHash);
                if (expectedDigest && use.asset.sha256 !== expectedDigest) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Requested digest does not match its admitted source use.");
                }
            }
            const opened = await this.store.openUseContent(useHash, {
                start, end, operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
            });
            let stream;
            let releasing = null;
            const sourceFinished = finished(opened.stream, { cleanup: true }).catch(() => {});
            const release = () => {
                releasing ??= (async () => {
                    stream?.destroy();
                    await opened.release();
                    await sourceFinished;
                    leases.delete(release);
                })();
                return releasing;
            };
            if (closed) {
                await release();
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "The environment asset admission is not pinned.");
            }
            // Never expose the filesystem-backed stream (or its fd/path).
            stream = Readable.from((async function* () {
                try {
                    for await (const chunk of opened.stream) yield chunk;
                } finally {
                    await release();
                }
            })());
            stream.once("close", () => { release().catch(() => {}); });
            leases.add(release);
            return Object.freeze({
                stream, release, mediaType: opened.mediaType, digest: opened.digest,
                size: opened.size, start: opened.start, end: opened.end,
            });
        };
        const open = async (digest, options = {}) => {
            const current = activeRecord();
            if (typeof digest !== "string" || !SHA256.test(digest)
                || !Object.hasOwn(current.digestUses, digest)) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Requested digest is outside the admitted closure.");
            }
            return openResolved(current.digestUses[digest], options, digest, true);
        };
        const authorizeUse = async (useHash, operations = []) => {
            const current = activeRecord();
            if (!current.useHashes.includes(useHash)) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Requested use is outside the active admitted closure.");
            }
            const requested = [...new Set(operations.map(String))].sort();
            if (requested.some((operation) => !RUN_PACKAGE_ADMISSION_OPERATIONS.includes(operation))) {
                throw visualAssetError(RUN_PACKAGE_ERROR_CODES.RIGHTS_DENIED, "Requested asset operation is outside worker admission rights.");
            }
            await this.store.statUseContent(useHash, { operations: requested });
            return { allowed: true, useHash, operations: requested };
        };
        const tracked = (operation) => {
            pending.add(operation);
            operation.finally(() => pending.delete(operation)).catch(() => {});
            return operation;
        };
        return Object.freeze({
            open: (...args) => tracked(open(...args)),
            openUse: (...args) => tracked(openResolved(...args)),
            authorizeUse: (...args) => tracked(authorizeUse(...args)),
            close,
        });
    }

    async close() {
        // Durable admissions intentionally outlive a supervisor process.
        this._closed = true;
        await this._ready?.catch(() => {});
        await this._mutex(async () => {
            await Promise.all([...this._scopeClosers.values()].flatMap((scopes) => [...scopes.values()].map((close) => close())));
            if (this._ownerToken && (await readJson(this.ownerPath))?.token === this._ownerToken) {
                await fs.rm(this.ownerPath);
                await fsyncDir(this.storageDir);
                this._ownerToken = null;
            }
        });
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        this._sweepTimer = null;
    }
}

export async function stageRunPackage(packagePath, inboxDir, { signal, limits = RUN_PACKAGE_RUNTIME_LIMITS } = {}) {
    signal?.throwIfAborted();
    await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const stagingId = randomBytes(16).toString("hex");
    const temporary = path.join(inboxDir, `.${stagingId}.${randomUUID()}.tmp`);
    const destination = path.join(inboxDir, `${stagingId}.run-package`);
    const source = await openRegularFile(packagePath);
    if (!source) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Run package was not found.");
    let output = null;
    let published = false;
    const hasher = createHash("sha256");
    const deadline = Date.now() + limits.verificationTimeoutMs;
    let received = 0;
    const check = () => {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.TIMEOUT, "Package staging exceeded its time budget.");
        if (received > limits.archiveBytes) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.TOO_LARGE, "Package staging exceeds the archive-byte ceiling.");
    };
    try {
        received = source.stat.size;
        check();
        received = 0;
        output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        for await (const chunk of source.handle.createReadStream({ autoClose: false, signal })) {
            received += chunk.length;
            check();
            hasher.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                check();
                const written = await output.write(chunk, offset, chunk.length - offset);
                if (written.bytesWritten <= 0) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Package staging write made no progress.");
                offset += written.bytesWritten;
            }
        }
        await output.sync();
        check();
        await output.close();
        output = null;
        await fs.rename(temporary, destination);
        await fsyncDir(inboxDir);
        published = true;
        return { stagingId, archiveHash: hasher.digest("hex"), path: destination };
    } finally {
        await source.handle.close().catch(() => {});
        await output?.close().catch(() => {});
        if (!published) {
            await Promise.all([
                fs.rm(temporary, { force: true }),
                fs.rm(destination, { force: true }),
            ]).catch(() => {});
        }
    }
}
