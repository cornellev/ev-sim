import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
    VISUAL_ASSET_ACCESS_OPERATIONS,
    VISUAL_ASSET_UPLOAD_OPERATIONS,
    VISUAL_ASSET_USE_KIND,
    VISUAL_ASSET_USE_VERSION,
    VISUAL_ASSET_PROFILE,
    assertSha256Digest,
    canonicalExactStringify,
    evaluateVisualSourcePolicy,
    hashVisualAssetUse,
    normalizeVisualAssetUse,
    parseExactJson,
    sha256FromUri,
} from "../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "./StorageErrors.js";
import { resolveVisualAssetLimits } from "./VisualAssetLimits.js";
import { VisualSourceRegistryFile } from "./VisualSourceRegistry.js";
import {
    exclusiveLink,
    fsyncDir,
    hashRegularFile,
    openRegularFile,
    streamToFile,
    writeExclusiveFile,
} from "./visual-assets/atomicFs.js";
import { Semaphore, createMutex } from "./visual-assets/semaphore.js";
import {
    VISUAL_ASSET_VALIDATION_VERSION,
    canonicalValidationRecord,
    validateVisualAssetBytes,
} from "./visual-assets/validateVisualAsset.js";

const DIGEST = /^[a-f0-9]{64}$/;

export class VisualAssetStore {
    constructor(dataDir, options = {}) {
        this.dataDir = dataDir;
        this.rootDir = options.rootDir ?? path.join(dataDir, "visual-assets");
        this.casDir = path.join(this.rootDir, "sha256");
        this.useDir = path.join(this.rootDir, "uses", "sha256");
        this.validationDir = path.join(this.rootDir, "validation", "sha256");
        this.stagingDir = path.join(this.rootDir, "staging");
        this.journalDir = path.join(this.rootDir, "journals");
        this.rootsPath = path.join(this.rootDir, "roots.json");
        this.pinsPath = path.join(this.rootDir, "pins.json");
        this.quotasPath = path.join(this.rootDir, "quotas.json");
        this.limits = resolveVisualAssetLimits(options.limits ?? {});
        this.now = options.now ?? (() => new Date());
        this.faults = options.faults ?? {};
        this.registry = new VisualSourceRegistryFile(
            options.registryPath ?? path.join(dataDir, "visual-source-registry.json"),
        );
        this._quotaMutex = createMutex();
        this._lifecycleMutex = createMutex();
        this._uploadSlots = new Semaphore(this.limits.concurrentUploads);
        this._validationSlots = new Semaphore(this.limits.concurrentValidations);
        this._readerSlots = new Semaphore(this.limits.openReaders);
        this._activeUploads = new Map();
        this._ready = null;
        this._publishedBytes = 0;
        this._reservations = new Map();
        this._roots = { kind: "cev-sim.visual-asset-roots", version: 1, roots: {} };
        this._pins = { kind: "cev-sim.visual-asset-pins", version: 1, pins: {} };
    }

    async initialize() {
        if (!this._ready) this._ready = this.recover();
        return this._ready;
    }

    async recover() {
        await fs.mkdir(this.casDir, { recursive: true });
        await fs.mkdir(this.useDir, { recursive: true });
        await fs.mkdir(this.validationDir, { recursive: true });
        await fs.mkdir(this.stagingDir, { recursive: true });
        await fs.mkdir(path.join(this.journalDir, "root-replace"), { recursive: true });
        this._publishedBytes = await this._sumRegularFiles(this.casDir);
        this._reservations = new Map();
        this._roots = await this._readJson(this.rootsPath, this._roots);
        this._pins = await this._readJson(this.pinsPath, this._pins);
        this._roots.roots = migrateRootMap(this._roots.roots);
        this._pins.pins = migratePinMap(this._pins.pins);
        await this._recoverRootJournals();
        await this._expirePins();
        const stagingIds = await this._listDir(this.stagingDir);
        const now = this.now().getTime();
        for (const id of stagingIds) {
            const meta = await this._readStagingMeta(id);
            if (!meta) {
                await this._removeStaging(id);
                continue;
            }
            const age = now - Date.parse(meta.createdAt || 0);
            const abandoned = !Number.isFinite(age) || age > this.limits.abandonedStageTtlMs;
            if (meta.phase === "published" || meta.phase === "cancelled" || meta.phase === "failed"
                || meta.phase === "created" || meta.phase === "streaming" || abandoned) {
                await this._removeStaging(id);
                continue;
            }
            try {
                if (meta.phase === "hashed") await this._validateAndPublish(meta);
                else await this._publishFromStaging(meta);
            } catch {
                this._reservations.set(id, meta.reservation ?? {
                    stagingBytes: meta.use?.asset?.sizeBytes ?? 0,
                    publishedBytes: 0,
                });
            }
        }
        return this;
    }

    async createUpload(input) {
        await this.initialize();
        const use = normalizeVisualAssetUse({
            kind: input?.kind ?? VISUAL_ASSET_USE_KIND,
            version: input?.version ?? VISUAL_ASSET_USE_VERSION,
            asset: input.asset,
            sourceIds: input.sourceIds,
            dependencies: input.dependencies ?? {},
        });
        if (use.asset.sizeBytes > this.limits.assetBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Asset size ${use.asset.sizeBytes} exceeds the ${this.limits.assetBytes}-byte ceiling.`,
            );
        }
        await this._assertDependencies(use);
        const closure = await this._collectClosure(use);
        await this._assertRights(closure.sourceIds, VISUAL_ASSET_UPLOAD_OPERATIONS);
        const useHash = hashVisualAssetUse(use);
        const existing = await this._readUse(useHash, { optional: true });
        const digestExists = await this._casExists(use.asset.sha256);
        const id = randomUUID();
        const reservation = {
            stagingBytes: use.asset.sizeBytes,
            publishedBytes: digestExists ? 0 : use.asset.sizeBytes,
        };
        await this._quotaMutex(async () => {
            await this._assertQuota(reservation);
            this._reservations.set(id, reservation);
        });
        const meta = {
            id,
            phase: "created",
            createdAt: this.now().toISOString(),
            use,
            useHash,
            reservation,
            existingUse: Boolean(existing),
        };
        await this._writeStagingMeta(meta);
        this._activeUploads.set(id, { abort: new AbortController() });
        return { id, useHash, use, existing: Boolean(existing) };
    }

    async writeUploadContent(id, source, { contentLength, signal } = {}) {
        await this.initialize();
        return this._uploadSlots.run(async () => {
            const meta = await this._requireStaging(id);
            if (meta.phase === "published") {
                return { useHash: meta.useHash, use: meta.use, existing: true };
            }
            const expected = meta.use.asset.sizeBytes;
            if (contentLength == null) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_METADATA, "Content-Length is required.");
            }
            const length = Number(contentLength);
            if (!Number.isSafeInteger(length) || length !== expected) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
                    `Content-Length ${contentLength} must equal declared size ${expected}.`,
                );
            }
            const readable = asReadable(source);
            const contentPath = this._stagingContentPath(id);
            meta.phase = "streaming";
            await this._writeStagingMeta(meta);
            const session = this._activeUploads.get(id);
            const abortSignal = signal ?? session?.abort?.signal;
            const onAbort = () => readable.destroy?.(visualAssetError(
                VISUAL_ASSET_ERROR_CODES.UPLOAD_NOT_FOUND,
                "Visual asset upload was cancelled.",
            ));
            abortSignal?.addEventListener("abort", onAbort, { once: true });
            let streamed;
            try {
                streamed = await streamToFile(readable, contentPath, {
                    expectedBytes: expected,
                    maxBytes: this.limits.assetBytes,
                    faults: this.faults,
                });
            } catch (error) {
                meta.phase = "failed";
                meta.error = error.message;
                await this._writeStagingMeta(meta).catch(() => {});
                await this.abortUpload(id).catch(() => {});
                throw error;
            } finally {
                abortSignal?.removeEventListener("abort", onAbort);
            }
            if (streamed.digest !== meta.use.asset.sha256) {
                await this.abortUpload(id).catch(() => {});
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
                    "Uploaded bytes do not match the declared SHA-256 digest.",
                );
            }
            meta.phase = "hashed";
            meta.observedDigest = streamed.digest;
            meta.observedSize = streamed.received;
            await this._writeStagingMeta(meta);
            return this._validateAndPublish(meta);
        });
    }

    async abortUpload(id) {
        await this.initialize();
        const session = this._activeUploads.get(id);
        session?.abort?.abort();
        const meta = await this._readStagingMeta(id);
        if (meta?.phase === "published") {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.DELETION_DISABLED,
                "Published visual assets cannot be deleted.",
            );
        }
        await this._quotaMutex(async () => this._reservations.delete(id));
        this._activeUploads.delete(id);
        await this._removeStaging(id);
        return { cancelled: true, id };
    }

    async getUse(useHash, { optional = false } = {}) {
        await this.initialize();
        return this._readUse(useHash, { optional });
    }

    async getRoot(ownerId) {
        await this.initialize();
        return this._roots.roots[ownerId] ?? null;
    }

    async readPublishedBytes(digest, { expectedSize } = {}) {
        await this.initialize();
        const identity = await hashRegularFile(this._casPath(digest));
        if (!identity) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, `Published visual asset ${digest} is missing.`);
        }
        if ((expectedSize != null && identity.size !== expectedSize) || identity.digest !== digest) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, `Published visual asset ${digest} is corrupt.`);
        }
        const opened = await openRegularFile(this._casPath(digest));
        if (!opened) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, `Published visual asset ${digest} is missing.`);
        }
        try {
            return await opened.handle.readFile();
        } finally {
            await opened.handle.close();
        }
    }

    async getValidation(useHash, { optional = false } = {}) {
        await this.initialize();
        return this._readValidation(useHash, { optional });
    }

    async statUseContent(useHash, { operations = VISUAL_ASSET_ACCESS_OPERATIONS } = {}) {
        await this.initialize();
        const use = await this.getUse(useHash);
        const validation = await this._requireCurrentValidation(useHash, use);
        const closure = await this._collectClosure(use, validation.decodedBytesEstimate);
        await this._assertRights(closure.sourceIds, operations);
        const identity = await hashRegularFile(this._casPath(use.asset.sha256));
        if (!identity || identity.size !== use.asset.sizeBytes || identity.digest !== use.asset.sha256) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, "Published visual asset bytes are corrupt.");
        }
        return {
            mediaType: use.asset.mediaType,
            digest: use.asset.sha256,
            size: identity.size,
            use,
        };
    }

    async openUseContent(useHash, { start = 0, end = undefined, operations = VISUAL_ASSET_ACCESS_OPERATIONS } = {}) {
        await this.initialize();
        const use = await this.getUse(useHash);
        const validation = await this._requireCurrentValidation(useHash, use);
        const closure = await this._collectClosure(use, validation.decodedBytesEstimate);
        await this._assertRights(closure.sourceIds, operations);
        const identity = await hashRegularFile(this._casPath(use.asset.sha256));
        if (!identity) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, "Published visual asset bytes are missing.");
        }
        if (identity.size !== use.asset.sizeBytes || identity.digest !== use.asset.sha256) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, "Published visual asset bytes are corrupt.");
        }
        const size = identity.size;
        const last = end === undefined ? size - 1 : end;
        if (size === 0 || start < 0 || last < start || start >= size || last >= size) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.RANGE_NOT_SATISFIABLE,
                "Requested byte range is not satisfiable.",
                { headers: { "Content-Range": `bytes */${size}` } },
            );
        }
        await this._readerSlots.acquire();
        let released = false;
        const releaseSlot = () => {
            if (released) return;
            released = true;
            this._readerSlots.release();
        };
        try {
            const opened = await openRegularFile(this._casPath(use.asset.sha256));
            if (!opened) throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, "Published visual asset bytes are missing.");
            const stream = opened.handle.createReadStream({ start, end: last, autoClose: true });
            stream.once("close", releaseSlot);
            stream.once("error", releaseSlot);
            return {
                stream,
                handle: opened.handle,
                release: async () => {
                    if (!stream.destroyed) stream.destroy();
                    releaseSlot();
                },
                mediaType: use.asset.mediaType,
                digest: use.asset.sha256,
                size,
                start,
                end: last,
                use,
            };
        } catch (error) {
            releaseSlot();
            throw error;
        }
    }

    async validateClosure({ useHash, operations = VISUAL_ASSET_ACCESS_OPERATIONS } = {}) {
        await this.initialize();
        const use = await this.getUse(useHash);
        const validation = await this._requireCurrentValidation(useHash, use);
        const closure = await this._collectClosure(use, validation.decodedBytesEstimate);
        if (closure.depth > this.limits.graphDepth) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Use closure depth ${closure.depth} exceeds the ${this.limits.graphDepth} ceiling.`,
            );
        }
        if (closure.assetCount > this.limits.assetEntries) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Use closure has ${closure.assetCount} assets, exceeding the ${this.limits.assetEntries} ceiling.`,
            );
        }
        if (closure.decodedBytes > this.limits.decodedClosureBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                "Use closure exceeds the aggregate decoded-size budget.",
            );
        }
        const decision = await this._assertRights(closure.sourceIds, operations);
        return {
            ok: true,
            useHash,
            assetCount: closure.assetCount,
            depth: closure.depth,
            decodedBytesEstimate: closure.decodedBytes,
            obligations: decision.obligations,
        };
    }

    async validateAccessSet({
        useHashes = [],
        operations = VISUAL_ASSET_ACCESS_OPERATIONS,
        verifyBytes = false,
        includeUseRecords = false,
    } = {}) {
        await this.initialize();
        const requested = [...new Set(useHashes.map((hash) => assertSha256Digest(hash, "useHash")))].sort();
        const uses = new Map();
        const validations = new Map();
        const sourceIds = new Set();
        const digests = new Set();
        let decodedBytes = 0;
        let depth = 1;
        const visit = async (useHash, currentDepth) => {
            if (uses.has(useHash)) {
                depth = Math.max(depth, currentDepth);
                return;
            }
            if (currentDepth > this.limits.graphDepth) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                    `Use closure depth exceeds the ${this.limits.graphDepth} ceiling.`,
                );
            }
            const use = await this._readUse(useHash);
            const validation = await this._requireCurrentValidation(useHash, use);
            uses.set(useHash, use);
            validations.set(useHash, validation);
            depth = Math.max(depth, currentDepth);
            for (const sourceId of use.sourceIds) sourceIds.add(sourceId);
            if (!digests.has(use.asset.sha256)) {
                digests.add(use.asset.sha256);
                decodedBytes += validation.decodedBytesEstimate;
            }
            for (const child of Object.values(use.dependencies)) await visit(child, currentDepth + 1);
        };
        for (const useHash of requested) await visit(useHash, 1);
        if (digests.size > this.limits.assetEntries) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Use closure has ${digests.size} assets, exceeding the ${this.limits.assetEntries} ceiling.`,
            );
        }
        if (decodedBytes > this.limits.decodedClosureBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                "Use closure exceeds the aggregate decoded-size budget.",
            );
        }
        const decision = await this._assertRights([...sourceIds], operations);
        if (verifyBytes) {
            const checked = new Set();
            for (const use of uses.values()) {
                if (checked.has(use.asset.sha256)) continue;
                checked.add(use.asset.sha256);
                const identity = await hashRegularFile(this._casPath(use.asset.sha256));
                if (!identity || identity.size !== use.asset.sizeBytes || identity.digest !== use.asset.sha256) {
                    throw visualAssetError(
                        VISUAL_ASSET_ERROR_CODES.CORRUPT,
                        `Published visual asset ${use.asset.sha256} is missing or corrupt.`,
                    );
                }
            }
        }
        return {
            ok: true,
            operations: [...operations],
            assetCount: digests.size,
            useCount: uses.size,
            depth,
            decodedBytesEstimate: decodedBytes,
            obligations: decision.obligations,
            evaluatedSourceIds: decision.evaluatedSourceIds,
            uses: requested.map((useHash) => {
                const use = uses.get(useHash);
                const validation = validations.get(useHash);
                return {
                    useHash,
                    sha256: use.asset.sha256,
                    mediaType: use.asset.mediaType,
                    sizeBytes: use.asset.sizeBytes,
                    role: use.asset.role,
                    decodedBytesEstimate: validation.decodedBytesEstimate,
                    graph: validation?.graph
                        ? {
                            nodes: validation.graph.nodes ?? 0,
                            triangles: validation.graph.triangles ?? 0,
                            depth: validation.graph.depth ?? 0,
                        }
                        : null,
                    inspected: validation?.inspected
                        ? {
                            width: validation.inspected.width ?? 0,
                            height: validation.inspected.height ?? 0,
                            mipLevels: validation.inspected.mipLevels ?? 0,
                        }
                        : null,
                };
            }),
            ...(includeUseRecords ? {
                closureUses: [...uses.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([useHash, use]) => ({ useHash, use })),
            } : {}),
        };
    }

    async acquireRoot({ ownerId, ownerKind = "synthetic", useHash, useHashes, operations }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            if (this._roots.roots[ownerId]) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CONFLICT, `Visual asset root ${ownerId} already exists.`);
            }
            const hashes = normalizeUseHashSet({ useHash, useHashes });
            await this._validateUseHashSet(hashes, operations);
            const record = {
                ownerId,
                ownerKind,
                generation: 1,
                useHashes: hashes,
                useHash: hashes[0] ?? null,
                acquiredAt: this.now().toISOString(),
            };
            this._roots.roots[ownerId] = record;
            await this._writeState(this.rootsPath, this._roots);
            return record;
        });
    }

    async replaceRoot({ ownerId, expectedGeneration, useHash, useHashes, operations, ownerKind }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            const current = migrateRootRecord(this._roots.roots[ownerId]);
            if (!current) throw visualAssetError(VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND, `Visual asset root ${ownerId} was not found.`);
            if (current.generation !== expectedGeneration) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.CONFLICT,
                    `Visual asset root ${ownerId} generation ${expectedGeneration} does not match ${current.generation}.`,
                );
            }
            const hashes = normalizeUseHashSet({ useHash, useHashes });
            await this._validateUseHashSet(hashes, operations);
            const next = {
                ownerId,
                ownerKind: ownerKind ?? current.ownerKind,
                generation: current.generation + 1,
                useHashes: hashes,
                useHash: hashes[0] ?? null,
                acquiredAt: this.now().toISOString(),
            };
            const journalPath = this._rootJournalPath(ownerId);
            const journal = {
                phase: "acquire-new",
                ownerId,
                ownerKind: next.ownerKind,
                oldGeneration: current.generation,
                newGeneration: next.generation,
                oldUseHash: current.useHash,
                newUseHash: next.useHash,
                oldUseHashes: current.useHashes ?? (current.useHash ? [current.useHash] : []),
                newUseHashes: next.useHashes,
            };
            await this._writeState(journalPath, journal);
            await fsyncDir(path.dirname(journalPath), this.faults);
            this._roots.roots[ownerId] = next;
            await this._writeState(this.rootsPath, this._roots);
            journal.phase = "release-old";
            await this._writeState(journalPath, journal);
            await fs.rm(journalPath, { force: true });
            await fsyncDir(path.dirname(journalPath), this.faults);
            return next;
        });
    }

    async releaseRoot({ ownerId, expectedGeneration }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            const current = this._roots.roots[ownerId];
            if (!current) return { released: true, ownerId };
            if (current.generation !== expectedGeneration) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.CONFLICT,
                    `Visual asset root ${ownerId} generation ${expectedGeneration} does not match ${current.generation}.`,
                );
            }
            delete this._roots.roots[ownerId];
            await this._writeState(this.rootsPath, this._roots);
            return { released: true, ownerId, generation: expectedGeneration };
        });
    }

    async acquirePin({ ownerId, useHash, useHashes, operations, leaseMs = this.limits.abandonedStageTtlMs }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            const hashes = normalizeUseHashSet({ useHash, useHashes });
            await this._validateUseHashSet(hashes, operations);
            const handle = randomBytes(16).toString("hex");
            const record = {
                handle,
                ownerId,
                useHashes: hashes,
                useHash: hashes[0] ?? null,
                acquiredAt: this.now().toISOString(),
                expiresAt: new Date(this.now().getTime() + leaseMs).toISOString(),
            };
            this._pins.pins[handle] = record;
            await this._writeState(this.pinsPath, this._pins);
            return record;
        });
    }

    async renewPin({ handle, leaseMs = this.limits.abandonedStageTtlMs }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            const record = this._pins.pins[handle];
            if (!record) throw visualAssetError(VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND, "Visual asset pin was not found.");
            if (Date.parse(record.expiresAt) <= this.now().getTime()) {
                delete this._pins.pins[handle];
                await this._writeState(this.pinsPath, this._pins);
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND, "Visual asset pin has expired.");
            }
            record.expiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
            this._pins.pins[handle] = record;
            await this._writeState(this.pinsPath, this._pins);
            return record;
        });
    }

    async releasePin({ handle }) {
        await this.initialize();
        return this._lifecycleMutex(async () => {
            if (this._pins.pins[handle]) {
                delete this._pins.pins[handle];
                await this._writeState(this.pinsPath, this._pins);
            }
            return { released: true, handle };
        });
    }

    async deletePublished() {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.DELETION_DISABLED,
            "Published visual asset deletion is disabled.",
        );
    }

    _casPath(digest) {
        return path.join(this.casDir, assertSha256Digest(digest));
    }

    _usePath(digest) {
        return path.join(this.useDir, `${assertSha256Digest(digest)}.json`);
    }

    _validationPath(digest) {
        return path.join(this.validationDir, `${assertSha256Digest(digest)}.json`);
    }

    _stagingMetaPath(id) {
        return path.join(this.stagingDir, id, "meta.json");
    }

    _stagingContentPath(id) {
        return path.join(this.stagingDir, id, "content");
    }

    _rootJournalPath(ownerId) {
        return path.join(this.journalDir, "root-replace", `${ownerId}.json`);
    }

    async _validateAndPublish(meta) {
        meta.phase = "validating";
        await this._writeStagingMeta(meta);
        const bytes = await fs.readFile(this._stagingContentPath(meta.id));
        const resources = await this._loadDependencyBytes(meta.use);
        const validation = await this._validationSlots.run(() => validateVisualAssetBytes(bytes, {
            asset: meta.use.asset,
            limits: this.limits,
            declaredDependencies: meta.use.dependencies,
            resources,
            timeoutMs: this.limits.validationTimeoutMs,
            memoryMb: this.limits.validatorMemoryMb,
        }));
        const closure = await this._collectClosure(meta.use, validation.decodedBytesEstimate);
        if (closure.decodedBytes > this.limits.decodedClosureBytes) {
            await this.abortUpload(meta.id).catch(() => {});
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                "Use closure exceeds the aggregate decoded-size budget.",
            );
        }
        await this._assertRights(closure.sourceIds, VISUAL_ASSET_UPLOAD_OPERATIONS);
        meta.phase = "validated";
        meta.validation = canonicalValidationRecord(validation, meta.useHash);
        await this._writeStagingMeta(meta);
        return this._publishFromStaging(meta);
    }

    async _publishFromStaging(meta) {
        const contentPath = this._stagingContentPath(meta.id);
        const casPath = this._casPath(meta.use.asset.sha256);
        meta.phase = "publishing-bytes";
        await this._writeStagingMeta(meta);
        const existing = await hashRegularFile(casPath);
        if (existing) {
            if (existing.digest !== meta.use.asset.sha256 || existing.size !== meta.use.asset.sizeBytes) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.CORRUPT,
                    "An existing CAS object does not match its digest path.",
                );
            }
        } else {
            const linked = await exclusiveLink(contentPath, casPath, this.faults);
            if (linked.existed) {
                const verify = await hashRegularFile(casPath);
                if (!verify || verify.digest !== meta.use.asset.sha256) {
                    throw visualAssetError(
                        VISUAL_ASSET_ERROR_CODES.CORRUPT,
                        "An existing CAS object does not match its digest path.",
                    );
                }
            } else {
                this._publishedBytes += meta.use.asset.sizeBytes;
            }
        }
        meta.phase = "publishing-metadata";
        await this._writeStagingMeta(meta);
        const useBytes = `${canonicalExactStringify(meta.use)}\n`;
        const useWrite = await writeExclusiveFile(this._usePath(meta.useHash), useBytes, { faults: this.faults });
        if (useWrite.existed) {
            const current = await this._readUse(meta.useHash);
            if (canonicalExactStringify(current) !== canonicalExactStringify(meta.use)) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CONFLICT, "Visual asset use digest collision.");
            }
        }
        await this._writeState(this._validationPath(meta.useHash), meta.validation);
        await this._quotaMutex(async () => this._reservations.delete(meta.id));
        meta.phase = "published";
        await this._writeStagingMeta(meta);
        this._activeUploads.delete(meta.id);
        await this._removeStaging(meta.id);
        return { useHash: meta.useHash, use: meta.use, validation: meta.validation };
    }

    async _readUse(useHash, { optional = false } = {}) {
        const digest = assertSha256Digest(useHash, "useHash");
        const opened = await openRegularFile(this._usePath(digest));
        if (!opened) {
            if (optional) return null;
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND, `Visual asset use ${digest} was not found.`);
        }
        try {
            const text = await opened.handle.readFile("utf8");
            return normalizeVisualAssetUse(parseExactJson(text.trim()));
        } finally {
            await opened.handle.close();
        }
    }

    async _readValidation(useHash, { optional = false } = {}) {
        const digest = assertSha256Digest(useHash, "useHash");
        const opened = await openRegularFile(this._validationPath(digest));
        if (!opened) {
            if (optional) return null;
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.USE_NOT_FOUND, `Visual asset validation ${digest} was not found.`);
        }
        try {
            return parseExactJson((await opened.handle.readFile("utf8")).trim());
        } finally {
            await opened.handle.close();
        }
    }

    async _requireCurrentValidation(useHash, use = null) {
        const record = use ?? await this._readUse(useHash);
        const validation = await this._readValidation(useHash, { optional: true });
        if (
            validation?.kind === "cev-sim.visual-asset-validation"
            && validation.version === VISUAL_ASSET_VALIDATION_VERSION
            && validation.useHash === useHash
            && canonicalExactStringify(validation.asset) === canonicalExactStringify(record.asset)
            && canonicalExactStringify(validation.profile) === canonicalExactStringify(VISUAL_ASSET_PROFILE)
        ) {
            return validation;
        }
        const opened = await openRegularFile(this._casPath(record.asset.sha256));
        if (!opened) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, `Asset bytes for ${useHash} are missing.`);
        }
        let bytes;
        try {
            bytes = await opened.handle.readFile();
        } finally {
            await opened.handle.close();
        }
        const resources = await this._loadDependencyBytes(record);
        const refreshed = await this._validationSlots.run(() => validateVisualAssetBytes(bytes, {
            asset: record.asset,
            limits: this.limits,
            declaredDependencies: record.dependencies,
            resources,
            timeoutMs: this.limits.validationTimeoutMs,
            memoryMb: this.limits.validatorMemoryMb,
        }));
        const canonical = canonicalValidationRecord(refreshed, useHash);
        await this._writeState(this._validationPath(useHash), canonical);
        return canonical;
    }

    async _assertDependencies(use) {
        for (const [uri, useHash] of Object.entries(use.dependencies)) {
            const digest = sha256FromUri(uri);
            if (!digest) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, `Dependency key ${uri} is not a sha256 URI.`);
            }
            const dependency = await this._readUse(useHash);
            if (dependency.asset.sha256 !== digest) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                    `Dependency ${uri} does not match use ${useHash}.`,
                );
            }
        }
    }

    async _loadDependencyBytes(use) {
        const resources = {};
        for (const [uri, useHash] of Object.entries(use.dependencies)) {
            const dependency = await this._readUse(useHash);
            const opened = await openRegularFile(this._casPath(dependency.asset.sha256));
            if (!opened) {
                throw visualAssetError(VISUAL_ASSET_ERROR_CODES.CORRUPT, `Dependency bytes for ${uri} are missing.`);
            }
            try {
                resources[uri] = await opened.handle.readFile();
            } finally {
                await opened.handle.close();
            }
        }
        return resources;
    }

    async _collectClosure(use, selfDecoded = 0) {
        const sourceIds = new Set(use.sourceIds);
        const useHashes = new Set();
        const digests = new Set([use.asset.sha256]);
        let depth = 1;
        let decodedBytes = selfDecoded;
        const visit = async (useHash, currentDepth) => {
            if (useHashes.has(useHash)) return;
            if (currentDepth > this.limits.graphDepth) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                    `Use closure depth exceeds the ${this.limits.graphDepth} ceiling.`,
                );
            }
            useHashes.add(useHash);
            depth = Math.max(depth, currentDepth);
            const record = await this._readUse(useHash);
            const validation = await this._requireCurrentValidation(useHash, record);
            for (const sourceId of record.sourceIds) sourceIds.add(sourceId);
            digests.add(record.asset.sha256);
            decodedBytes += validation.decodedBytesEstimate;
            for (const child of Object.values(record.dependencies)) await visit(child, currentDepth + 1);
        };
        for (const child of Object.values(use.dependencies)) await visit(child, 2);
        if (digests.size > this.limits.assetEntries) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `Use closure has ${digests.size} assets, exceeding the ${this.limits.assetEntries} ceiling.`,
            );
        }
        return { sourceIds: [...sourceIds], depth, decodedBytes, assetCount: digests.size };
    }

    async _assertRights(sourceIds, operations) {
        const registry = await this.registry.policyMap();
        const decision = evaluateVisualSourcePolicy({
            sourceIds,
            operations,
            registry,
            atTime: this.now(),
        });
        if (!decision.allowed) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
                "Visual asset source policy denied the requested operation.",
                { denials: decision.denials },
            );
        }
        return decision;
    }

    async _assertQuota(reservation) {
        const stagingUsed = [...this._reservations.values()].reduce((sum, entry) => sum + (entry.stagingBytes ?? 0), 0);
        const publishedReserved = [...this._reservations.values()].reduce((sum, entry) => sum + (entry.publishedBytes ?? 0), 0);
        if (stagingUsed + reservation.stagingBytes > this.limits.stagingBytes) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.QUOTA_EXCEEDED, "Visual asset staging quota is exhausted.");
        }
        if (this._publishedBytes + publishedReserved + reservation.publishedBytes > this.limits.publishedBytes) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.QUOTA_EXCEEDED, "Visual asset published quota is exhausted.");
        }
    }

    async _casExists(digest) {
        const opened = await openRegularFile(this._casPath(digest));
        if (!opened) return false;
        await opened.handle.close();
        return true;
    }

    async _requireStaging(id) {
        const meta = await this._readStagingMeta(id);
        if (!meta) {
            throw visualAssetError(VISUAL_ASSET_ERROR_CODES.UPLOAD_NOT_FOUND, `Visual asset upload ${id} was not found.`);
        }
        return meta;
    }

    async _readStagingMeta(id) {
        try {
            const text = await fs.readFile(this._stagingMetaPath(id), "utf8");
            return JSON.parse(text);
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    async _writeStagingMeta(meta) {
        const filePath = this._stagingMetaPath(meta.id);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(meta, null, 2)}\n`);
        await fs.rename(tempPath, filePath);
        await fsyncDir(path.dirname(filePath), this.faults);
    }

    async _removeStaging(id) {
        await fs.rm(path.join(this.stagingDir, id), { recursive: true, force: true });
        this._activeUploads.delete(id);
    }

    async _writeState(filePath, value) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
        await fs.rename(tempPath, filePath);
        await fsyncDir(path.dirname(filePath), this.faults);
    }

    async _readJson(filePath, fallback) {
        try {
            return parseExactJson((await fs.readFile(filePath, "utf8")).trim());
        } catch (error) {
            if (error.code === "ENOENT") return structuredClone(fallback);
            throw error;
        }
    }

    async _sumRegularFiles(dir) {
        const names = await this._listDir(dir);
        let total = 0;
        for (const name of names) {
            if (!DIGEST.test(name)) continue;
            const filePath = path.join(dir, name);
            try {
                const lstat = await fs.lstat(filePath);
                if (lstat.isSymbolicLink() || !lstat.isFile()) continue;
                total += lstat.size;
            } catch {
                // Ignore unreadable entries while reconciling.
            }
        }
        return total;
    }

    async _listDir(dir) {
        try {
            return await fs.readdir(dir);
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }

    async _recoverRootJournals() {
        const dir = path.join(this.journalDir, "root-replace");
        for (const name of await this._listDir(dir)) {
            if (!name.endsWith(".json")) continue;
            const filePath = path.join(dir, name);
            let journal;
            try {
                journal = JSON.parse(await fs.readFile(filePath, "utf8"));
            } catch {
                await fs.rm(filePath, { force: true });
                continue;
            }
            if (journal.phase === "acquire-new") {
                const useHashes = Array.isArray(journal.newUseHashes)
                    ? journal.newUseHashes
                    : journal.newUseHash ? [journal.newUseHash] : [];
                this._roots.roots[journal.ownerId] = {
                    ownerId: journal.ownerId,
                    ownerKind: journal.ownerKind,
                    generation: journal.newGeneration,
                    useHashes,
                    useHash: useHashes[0] ?? journal.newUseHash ?? null,
                    acquiredAt: this.now().toISOString(),
                };
                await this._writeState(this.rootsPath, this._roots);
            }
            await fs.rm(filePath, { force: true });
        }
    }

    async _expirePins() {
        const now = this.now().getTime();
        let changed = false;
        for (const [handle, pin] of Object.entries(this._pins.pins)) {
            if (Date.parse(pin.expiresAt) <= now) {
                delete this._pins.pins[handle];
                changed = true;
            }
        }
        if (changed) await this._writeState(this.pinsPath, this._pins);
    }

    async _validateUseHashSet(useHashes, operations) {
        if (!useHashes.length) return { ok: true, useHashes: [], assetCount: 0 };
        if (useHashes.length === 1) return this.validateClosure({ useHash: useHashes[0], operations });
        return this.validateAccessSet({ useHashes, operations });
    }
}

function asReadable(source) {
    if (source instanceof Readable) return source;
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) return Readable.from(Buffer.from(source));
    throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_METADATA, "Upload content must be a stream or buffer.");
}

export function normalizeUseHashSet(input = {}) {
    let hashes = [];
    if (Array.isArray(input)) hashes = input;
    else if (Array.isArray(input.useHashes)) hashes = input.useHashes;
    else if (input.useHash) hashes = [input.useHash];
    return [...new Set(hashes.map((hash) => assertSha256Digest(hash, "useHash")))].sort();
}

function migrateRootRecord(record) {
    if (!record) return record;
    const useHashes = Array.isArray(record.useHashes) && record.useHashes.length
        ? [...new Set(record.useHashes)].sort()
        : record.useHash ? [record.useHash] : [];
    return {
        ...record,
        useHashes,
        useHash: useHashes[0] ?? record.useHash ?? null,
    };
}

function migrateRootMap(roots = {}) {
    return Object.fromEntries(Object.entries(roots).map(([id, record]) => [id, migrateRootRecord(record)]));
}

function migratePinMap(pins = {}) {
    return Object.fromEntries(Object.entries(pins).map(([id, record]) => [id, migrateRootRecord(record)]));
}
