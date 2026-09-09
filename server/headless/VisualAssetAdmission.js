import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";

import { canonicalExactStringify } from "../../app/simulation/visual/VisualLayer.js";
import { RUN_PACKAGE_ERROR_CODES, VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../storage/StorageErrors.js";
import { VisualAssetStore } from "../storage/VisualAssetStore.js";
import { createMutex } from "../storage/visual-assets/semaphore.js";
import { fsyncDir, hashRegularFile, openRegularFile } from "../storage/visual-assets/atomicFs.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes } from "./RunBundle.js";
import {
    createPackageStagingDir,
    evaluatePackageRights,
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

async function readJson(filePath) {
    const opened = await openRegularFile(filePath);
    if (!opened) return null;
    try {
        return JSON.parse(await opened.handle.readFile("utf8"));
    } finally {
        await opened.handle.close();
    }
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
        if (!this.enabled) return this;
        this._ready ??= this._initialize();
        return this._ready;
    }

    async _initialize() {
        await Promise.all([
            fs.mkdir(this.inboxDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.recordsDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.bundlesDir, { recursive: true, mode: 0o700 }),
            fs.mkdir(this.stagingDir, { recursive: true, mode: 0o700 }),
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
        this._scheduleSweep();
        return this;
    }

    _scheduleSweep() {
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        this._sweepTimer = null;
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
            const filePath = path.join(this.inboxDir, name);
            try {
                const stat = await fs.lstat(filePath);
                if (name.includes(".processing-") || stat.mtimeMs <= cutoff) {
                    await fs.rm(filePath, { recursive: true, force: true });
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
    }

    async _persist(record) {
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
        const identity = await hashRegularFile(this._bundlePath(record.handle));
        if (!identity || identity.digest !== record.bundleBytesHash) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Admitted bundle bytes are missing or corrupt.");
        }
        const exactBytes = await fs.readFile(this._bundlePath(record.handle));
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
        if (!SHA256.test(String(archiveHash || ""))) {
            throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "archive_hash must be a lowercase SHA-256 digest.");
        }
        await this.initialize();
        return this._mutex(async () => {
            const sourcePath = path.join(this.inboxDir, `${stagingId}.run-package`);
            const processingPath = path.join(this.inboxDir, `.${stagingId}.processing-${randomUUID()}`);
            let staging = null;
            let record = null;
            try {
                await fs.rename(sourcePath, processingPath);
                const opened = await openRegularFile(processingPath);
                if (!opened) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Staged run package was not found.");
                if (opened.stat.nlink !== 1) {
                    await opened.handle.close();
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.HOSTILE, "Staged run packages must have exactly one link.");
                }
                staging = await createPackageStagingDir(this.stagingDir);
                let verified;
                try {
                    verified = await verifyRunPackageArchive(opened.handle.createReadStream({ autoClose: true }), {
                        stagingDir: staging.dir,
                        retainStaging: true,
                        limits: this.config.limits,
                        deadline: Date.now() + this.config.limits.verificationTimeoutMs,
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
                    const assetPath = assets.get(use.asset.sha256);
                    if (!assetPath) {
                        throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, `Package is missing ${use.asset.sha256}.`);
                    }
                    const upload = await this.store.createUpload(use);
                    await this.store.writeUploadContent(upload.id, createReadStream(assetPath), {
                        contentLength: use.asset.sizeBytes,
                    });
                }
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
                await this._persist(record);
                this.records.set(handle, record);
                this._scheduleSweep();
                return { handle, bundleBytesHash: record.bundleBytesHash };
            } catch (error) {
                if (record) await this._disposeRecord(record).catch(() => {});
                throw error;
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
            if (!record || record.released || Date.parse(record.expiresAt) <= this.now().getTime()) {
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
                    if (!record || record.released || Date.parse(record.expiresAt) <= this.now().getTime()) {
                        if (record && record.batchPins === 0) await this._disposeRecord(record);
                        throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset admission is unavailable.");
                    }
                    await this._verifyRecord(record, { rights: true });
                    record.batchPins += 1;
                    record.lastUsedAt = this.now().toISOString();
                    await this._persist(record);
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
                if (record.batchPins === 0 && (record.released || Date.parse(record.expiresAt) <= this.now().getTime())) {
                    await this._disposeRecord(record);
                }
                else await this._persist(record);
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
        this.records.delete(record.handle);
        this._activeScopes.delete(record.handle);
        const root = await this.store.getRoot(admissionOwner(record.handle)).catch(() => null);
        if (root) {
            await this.store.releaseRoot({
                ownerId: admissionOwner(record.handle),
                expectedGeneration: root.generation,
            }).catch(() => {});
        }
        await Promise.all([
            fs.rm(this._recordPath(record.handle), { force: true }),
            fs.rm(this._bundlePath(record.handle), { force: true }),
        ]);
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
        return Object.freeze({
            open: async (digest, { start = 0, end } = {}) => {
                const current = this.records.get(handle);
                if (closed || !this._activeScopes.get(handle)?.has(key)
                    || !current || current.batchPins < 1) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "The environment asset admission is not pinned.");
                }
                const useHash = current.digestUses[digest];
                if (!useHash) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.CLOSURE_MISMATCH, "Requested digest is outside the admitted closure.");
                }
                if (!Number.isSafeInteger(start) || start < 0
                    || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
                    throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Asset reader ranges must be non-negative safe integers.");
                }
                const opened = await this.store.openUseContent(useHash, {
                    start,
                    end,
                    operations: [...RUN_PACKAGE_ADMISSION_OPERATIONS],
                });
                return Object.freeze({
                    stream: opened.stream,
                    release: opened.release,
                    mediaType: opened.mediaType,
                    digest: opened.digest,
                    size: opened.size,
                    start: opened.start,
                    end: opened.end,
                });
            },
            close: () => {
                if (closed) return;
                closed = true;
                const active = this._activeScopes.get(handle);
                active?.delete(key);
                if (active?.size === 0) this._activeScopes.delete(handle);
            },
        });
    }

    async close() {
        // Durable admissions intentionally outlive a supervisor process.
        if (this._sweepTimer) clearTimeout(this._sweepTimer);
        this._sweepTimer = null;
    }
}

export async function stageRunPackage(packagePath, inboxDir) {
    await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });
    const stagingId = randomBytes(16).toString("hex");
    const temporary = path.join(inboxDir, `.${stagingId}.${randomUUID()}.tmp`);
    const destination = path.join(inboxDir, `${stagingId}.run-package`);
    const source = await openRegularFile(packagePath);
    if (!source) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.INVALID, "Run package was not found.");
    let output = null;
    let published = false;
    const hasher = createHash("sha256");
    try {
        output = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        for await (const chunk of source.handle.createReadStream({ autoClose: false })) {
            hasher.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const written = await output.write(chunk, offset, chunk.length - offset);
                if (written.bytesWritten <= 0) throw visualAssetError(RUN_PACKAGE_ERROR_CODES.IO, "Package staging write made no progress.");
                offset += written.bytesWritten;
            }
        }
        await output.sync();
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
