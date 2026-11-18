import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";

import { createProtobufInterfaceResource } from "../../../app/interfaces/ProtobufRunBinding.js";
import { ARTIFACT_VERIFICATION_ERROR_CODES as ARCHIVE_CODES, ArtifactVerificationError } from "../../artifacts/ArtifactVerification.js";
import { fsyncDir, fsyncFile } from "../../storage/visual-assets/atomicFs.js";
import { createRunTemplatePackageOperationExecutor } from "../ArtifactAdapters.js";
import { assetImportOperationId } from "../AssetPackageImportPlanner.js";
import { MARKETPLACE_ERROR_CODES as CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalTimestamp, assertPlainMarketplaceTree, assertSha256 } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { RUN_TEMPLATE_PACKAGE_LIMITS, publisherTransferTimeoutMs } from "../MarketplaceContract.js";
import { prepareRunTemplatePackage, readPreparedRunTemplateRecord, readRunTemplatePackagePreparation } from "../RunTemplatePackage.js";
import { planRunTemplatePackageImport } from "../RunTemplatePackageImportPlanner.js";
import { atomicReplaceDurable, ensureDirectory, ensureDirectoryWithin, lstatOrNull, readRegularBytes, removeDirectoryDurable, verifyRegularFile, writeExclusiveDurable } from "../registry/RegistryFs.js";

const KIND = "cev-sim.local-run-template-import";
const PLAN_KIND = "cev-sim.local-run-template-import-plan";
const SOURCE = Object.freeze({ sourceId: "00000000-0000-4000-8000-000000000017", registryId: "00000000-0000-4000-8000-000000000018" });
const PHASES = new Set(["awaiting-confirmation", "commit", "needs-attention", "complete", "cancelled"]);
const OPERATION_KINDS = new Set(["publish-protobuf-interface", "add-local-plugin-manual-owner", "publish-run-template-plugin-package", "publish-visual-use", "publish-editor-asset-revision", "publish-environment-visual-layer", "publish-environment", "publish-vehicle-asset", "publish-vehicle", "publish-script", "publish-scenario", "publish-run-manifest"]);
const RECORD_BYTES = 32 * 1024 ** 2;
const RESULT_IDENTITY_KEYS = new Set(["kind", "vehicleId", "fileName", "sha256", "sizeBytes", "assetId", "revision", "localContentHash", "modelUseHash", "rootGeneration", "contentHash", "manifestId", "scriptId", "scenarioId", "environmentId", "worldHash", "useHash", "descriptorHash", "accessHash", "pluginId", "packageHash", "interfaceHash"]);
function resultIdentity(result) { return Object.fromEntries(Object.entries(result).filter(([key]) => RESULT_IDENTITY_KEYS.has(key))); }

function fail(code, message) { throw marketplaceError(code, message); }
function exact(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || required.some((key) => !Object.hasOwn(value, key))
        || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
        fail(CODES.RECOVERY_REQUIRED, "Local import record has an invalid shape.");
    }
}
function integer(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail(CODES.RECOVERY_REQUIRED, "Local import counter is invalid.");
}
function mappings(value) {
    if (!Array.isArray(value)) fail(CODES.RECOVERY_REQUIRED, "Local import mappings are invalid.");
    for (const entry of value) {
        exact(entry, ["resourceKind", "sourceId", "localId", "hashes"], ["sourceRevision", "localRevision"]);
        for (const key of ["resourceKind", "sourceId", "localId"]) {
            if (typeof entry[key] !== "string" || !entry[key]) fail(CODES.RECOVERY_REQUIRED, "Local import mapping identity is invalid.");
        }
        exact(entry.hashes, [], ["sourceRecord", "sourceClosure", "localContent", "modelUse", "metric", "geometry", "sourceWorld", "localWorld", "sourceVisualDescriptor", "localVisualDescriptor", "sourceVisualAccess", "localVisualAccess"]);
        Object.values(entry.hashes).filter((value) => value !== null).forEach((value) => assertSha256(value));
        for (const key of ["sourceRevision", "localRevision"]) if (entry[key] !== undefined) integer(entry[key]);
    }
}
function snapshot(value) {
    assertPlainMarketplaceTree(value);
    exact(value, ["kind", "version", "importId", "revision", "archive", "createdAt", "updatedAt", "phase", "planHash", "progress", "error", "completions", "mappings", "destinationManifestId"]);
    if (value.kind !== KIND || value.version !== 1 || !PHASES.has(value.phase)) fail(CODES.RECOVERY_REQUIRED, "Unsupported local import record.");
    assertSha256(value.importId); assertSha256(value.planHash);
    assertCanonicalTimestamp(value.createdAt); assertCanonicalTimestamp(value.updatedAt);
    integer(value.revision);
    exact(value.archive, ["sha256", "sizeBytes", "packageVersion"]);
    if (value.archive.sha256 !== value.importId || ![1, 2].includes(value.archive.packageVersion)) fail(CODES.RECOVERY_REQUIRED, "Local import archive identity changed.");
    integer(value.archive.sizeBytes);
    if (value.archive.sizeBytes > RUN_TEMPLATE_PACKAGE_LIMITS.archiveBytes) fail(CODES.RECOVERY_REQUIRED, "Local import archive is too large.");
    exact(value.progress, ["totalOperations", "completedOperations", "currentOperation"]);
    integer(value.progress.totalOperations); integer(value.progress.completedOperations);
    if (value.progress.currentOperation !== null) assertSha256(value.progress.currentOperation);
    if (!Array.isArray(value.completions) || value.completions.length !== value.progress.completedOperations
        || value.progress.completedOperations > value.progress.totalOperations) fail(CODES.RECOVERY_REQUIRED, "Local import completion counters disagree.");
    value.completions.forEach((entry) => {
        exact(entry, ["operationId", "operationHash", "result"]);
        assertSha256(entry.operationId); assertSha256(entry.operationHash);
        exact(entry.result, [], Object.keys(entry.result ?? {}));
    });
    if (value.error !== null) {
        exact(value.error, ["code", "message"]);
        if (typeof value.error.code !== "string" || typeof value.error.message !== "string") fail(CODES.RECOVERY_REQUIRED, "Local import error is invalid.");
    }
    if (value.destinationManifestId !== null && (typeof value.destinationManifestId !== "string" || !value.destinationManifestId)) fail(CODES.RECOVERY_REQUIRED, "Local import destination is invalid.");
    if (value.phase === "complete" && (!value.destinationManifestId || value.progress.completedOperations !== value.progress.totalOperations)) fail(CODES.RECOVERY_REQUIRED, "Completed local import is incomplete.");
    mappings(value.mappings);
    return value;
}

export class LocalRunTemplateImportManager {
    #queue = Promise.resolve();
    #closed = false;
    #uploads = new Set();

    constructor(dataDir, { storageService, pluginStore, editorAssetStore, visualAssetStore, publishPluginLibraryChange = null, now = () => new Date(), fault = null, limits = {} }) {
        this.root = path.join(dataDir, "marketplace", "local-imports");
        this.storage = storageService;
        this.plugins = pluginStore;
        this.editorAssets = editorAssetStore;
        this.visualAssets = visualAssetStore;
        this.publishPluginLibraryChange = publishPluginLibraryChange;
        this.now = now;
        this.fault = fault;
        this.limits = { ...RUN_TEMPLATE_PACKAGE_LIMITS, ...limits };
        for (const [key, value] of Object.entries(this.limits)) {
            if (!Number.isSafeInteger(value) || value < 1 || value > RUN_TEMPLATE_PACKAGE_LIMITS[key]) throw new TypeError("Local import limits cannot exceed the frozen profile.");
        }
        this.executor = createRunTemplatePackageOperationExecutor({ storageService, pluginStore, editorAssetStore, visualAssetStore });
    }

    #paths(id) {
        assertSha256(id, "importId");
        const root = path.join(this.root, id);
        return { root, snapshot: path.join(root, "snapshot.json"), plans: path.join(root, "plans"), work: path.join(root, "work") };
    }
    #serial(work) {
        if (this.#closed) return Promise.reject(marketplaceError(CODES.CANCELLED, "Local import service is closed."));
        const task = this.#queue.catch(() => {}).then(work);
        this.#queue = task.catch(() => {});
        return task;
    }
    async #read(id) {
        const paths = this.#paths(id);
        if (!await lstatOrNull(paths.snapshot)) fail(CODES.SOURCE_NOT_FOUND, "Local import was not found.");
        let bytes;
        for (let attempt = 0; attempt < 4; attempt++) {
            try { bytes = await readRegularBytes(paths.snapshot, { maxBytes: RECORD_BYTES }); break; }
            catch (error) {
                // Atomic snapshot replacement may race the regular-file inode check.
                if (attempt === 3 || !error.message.includes("Visual asset path changed while opening it.")) throw error;
            }
        }
        const value = snapshot(parseMarketplaceJsonBytes(bytes).document);
        if (value.importId !== id || !bytes.equals(Buffer.from(canonicalMarketplaceBytes(value)))) fail(CODES.RECOVERY_REQUIRED, "Local import record is not canonical.");
        return value;
    }
    async #save(record, patch) {
        const next = snapshot({ ...record, ...patch, revision: record.revision + 1, updatedAt: this.now().toISOString() });
        await atomicReplaceDurable(this.#paths(record.importId).snapshot, canonicalMarketplaceBytes(next));
        return next;
    }
    async #readPlan(record) {
        const bytes = await readRegularBytes(path.join(this.#paths(record.importId).plans, record.planHash + ".json"), { maxBytes: RECORD_BYTES });
        const plan = parseMarketplaceJsonBytes(bytes).document;
        assertPlainMarketplaceTree(plan);
        exact(plan, ["kind", "version", "importId", "preparationHash", "adapterPlan", "review"]);
        if (plan.kind !== PLAN_KIND || plan.version !== 1 || plan.importId !== record.importId
            || hashMarketplaceBytes(bytes) !== record.planHash || !bytes.equals(Buffer.from(canonicalMarketplaceBytes(plan)))
            || plan.adapterPlan.package.archiveSha256 !== record.importId || plan.preparationHash !== plan.adapterPlan.preparationHash) fail(CODES.RECOVERY_REQUIRED, "Local import plan identity changed.");
        assertSha256(plan.preparationHash);
        mappings(plan.adapterPlan.mappings);
        const operations = plan.adapterPlan.operations;
        if (!Array.isArray(operations) || operations.length !== record.progress.totalOperations
            || new Set(operations.map((op) => op.operationId)).size !== operations.length
            || operations.at(-1)?.kind !== "publish-run-manifest") fail(CODES.RECOVERY_REQUIRED, "Local import operations are invalid.");
        for (const op of operations) {
            assertSha256(op.operationId);
            if (!OPERATION_KINDS.has(op.kind)) fail(CODES.RECOVERY_REQUIRED, "Unknown local import operation.");
        }
        for (const [index, completion] of record.completions.entries()) {
            const op = operations[index];
            if (completion.operationId !== op.operationId || completion.operationHash !== hashMarketplaceBytes(canonicalMarketplaceBytes(op))) fail(CODES.RECOVERY_REQUIRED, "Local import completion identity changed.");
        }
        return plan;
    }
    async get(id) {
        const record = await this.#read(id);
        const plan = await this.#readPlan(record);
        return { ...record, review: plan.review };
    }
    async list() {
        await ensureDirectory(this.root);
        const entries = [];
        for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
            if (entry.name === "incoming") continue;
            if (entry.isSymbolicLink() || !entry.isDirectory()) fail(CODES.RECOVERY_REQUIRED, "Local import storage contains an unexpected node.");
            if (!await lstatOrNull(this.#paths(entry.name).snapshot)) continue;
            const value = await this.get(entry.name);
            entries.push({ importId: value.importId, revision: value.revision, phase: value.phase, planHash: value.planHash, destinationManifestId: value.destinationManifestId, name: value.review.name, updatedAt: value.updatedAt });
        }
        return { entries: entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.importId.localeCompare(b.importId)) };
    }

    async create(input, { contentLength = null, signal } = {}) {
        if (this.#closed) fail(CODES.CANCELLED, "Local import service is closed.");
        if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > this.limits.archiveBytes)) fail(CODES.LIMIT_EXCEEDED, "Local import upload exceeds the archive limit.");
        const controller = new AbortController();
        this.#uploads.add(controller);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const incoming = path.join(this.root, "incoming");
        const temporary = path.join(incoming, randomUUID() + ".tar");
        const hash = createHash("sha256");
        let sizeBytes = 0;
        const timer = setTimeout(() => controller.abort(), publisherTransferTimeoutMs(contentLength ?? this.limits.archiveBytes));
        try {
            await ensureDirectory(this.root);
            await ensureDirectoryWithin(this.root, incoming);
            const source = Readable.from(input.iterator ? input.iterator({ destroyOnReturn: false }) : input);
            await pipeline(source, new Transform({ transform: (chunk, encoding, callback) => {
                sizeBytes += chunk.length;
                if (sizeBytes > this.limits.archiveBytes) { callback(marketplaceError(CODES.LIMIT_EXCEEDED, "Local import upload exceeds the archive limit.")); return; }
                hash.update(chunk); callback(null, chunk);
            } }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: combined });
            if (!sizeBytes || (contentLength !== null && sizeBytes !== contentLength)) fail(CODES.DOCUMENT_INVALID, "Local import upload is incomplete.");
            await fsyncFile(temporary);
            const id = hash.digest("hex");
            return await this.#serial(async () => {
                combined.throwIfAborted();
                const paths = this.#paths(id);
                const prior = await lstatOrNull(paths.snapshot) ? await this.#read(id) : null;
                if (prior && ["commit", "needs-attention", "awaiting-confirmation"].includes(prior.phase)) return this.get(id);
                await ensureDirectoryWithin(this.root, paths.work);
                const archivePath = path.join(paths.work, "archive.tar");
                if (await lstatOrNull(archivePath)) await verifyRegularFile(archivePath, id, sizeBytes);
                else { await fs.rename(temporary, archivePath); await fsyncDir(paths.work); }
                try { return await this.#plan(id, sizeBytes, prior, combined); }
                catch (error) { await removeDirectoryDurable(paths.work); throw error; }
            });
        } catch (error) {
            input.resume?.();
            if (error instanceof ArtifactVerificationError) {
                const code = { [ARCHIVE_CODES.HOSTILE]: CODES.DOCUMENT_INVALID, [ARCHIVE_CODES.INVALID]: CODES.DOCUMENT_INVALID, [ARCHIVE_CODES.HASH_MISMATCH]: CODES.ARTIFACT_HASH_MISMATCH, [ARCHIVE_CODES.LIMIT_EXCEEDED]: CODES.LIMIT_EXCEEDED, [ARCHIVE_CODES.CANCELLED]: CODES.CANCELLED, [ARCHIVE_CODES.TIMEOUT]: CODES.CANCELLED }[error.code] ?? CODES.RECOVERY_REQUIRED;
                throw marketplaceError(code, "Run-template archive verification failed.", { cause: error });
            }
            if (error.name === "AbortError") throw marketplaceError(CODES.CANCELLED, "Local import upload was cancelled.", { cause: error });
            throw error;
        } finally {
            clearTimeout(timer); this.#uploads.delete(controller);
            await fs.rm(temporary, { force: true });
        }
    }

    async #plan(id, sizeBytes, prior, signal) {
        const paths = this.#paths(id);
        const archivePath = path.join(paths.work, "archive.tar");
        await verifyRegularFile(archivePath, id, sizeBytes);
        const prepared = await prepareRunTemplatePackage({ archivePath, workDirectory: paths.work, limits: this.limits, signal });
        if (prepared.verified.archiveSha256 !== id) fail(CODES.ARTIFACT_HASH_MISMATCH, "Local import archive changed during preparation.");
        const release = { itemId: "local.run-template", releaseVersion: "0.0.0", artifact: { sha256: id } };
        const adapterPlan = await planRunTemplatePackageImport({
            verified: prepared.verified, preparation: prepared, storageService: this.storage, editorAssetStore: this.editorAssets, visualAssetStore: this.visualAssets,
            receiptStore: { findMappings: async ({ registryId, marketplaceSourceId, itemId, artifactSha256, resourceKind }) => (
                registryId === SOURCE.registryId && marketplaceSourceId === SOURCE.sourceId && itemId === release.itemId && artifactSha256 === id
                    ? (prior?.mappings ?? []).filter((entry) => entry.resourceKind === resourceKind).map((mapping) => ({ mapping })) : []
            ) }, release, context: { source: SOURCE, workDirectory: paths.work },
        });
        const localOperation = (op) => ({ ...op, operationId: assetImportOperationId(op, release) });
        if (prepared.verified.protobufInterface) {
            const descriptor = prepared.verified.manifest.protobufInterface;
            adapterPlan.operations.unshift(localOperation({ kind: "publish-protobuf-interface", ...descriptor }));
            adapterPlan.mappings.push({ resourceKind: "protobuf-interface", sourceId: descriptor.interfaceHash, localId: descriptor.interfaceHash, hashes: { sourceRecord: descriptor.recordSha256, localContent: descriptor.interfaceHash } });
        } else if (prepared.verified.root.protobuf.mode === "zenoh") {
            const existing = await this.storage.getProtobufInterface(prepared.verified.root.protobuf.interfaceHash);
            if (!existing || prepared.verified.root.version === 13 && existing.version !== 2) adapterPlan.blockingIssues.push("The exact compatible Protobuf interface is missing; export this template in package version 2.");
        }
        adapterPlan.operations = adapterPlan.operations.flatMap((op) => op.kind === "publish-run-template-plugin-package"
            ? [op, localOperation({ kind: "add-local-plugin-manual-owner", pluginId: op.pluginId, packageHash: op.packageHash })] : [op]);
        const library = prepared.verified.manifest.plugins.length ? await this.plugins.snapshotWithOwners() : { packages: [] };
        const existingPlugins = new Set();
        for (const plugin of prepared.verified.manifest.plugins) {
            try { await this.plugins.verifyPackage(plugin.packageHash); existingPlugins.add(plugin.packageHash); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        const existingInterface = prepared.verified.protobufInterface ? await this.storage.getProtobufInterface(prepared.verified.protobufInterface.hash) : null;
        if (prior?.phase === "complete" && isDeepStrictEqual(prior.mappings, adapterPlan.mappings) && !adapterPlan.blockingIssues.length) {
            if ((!prepared.verified.protobufInterface || existingInterface) && prepared.verified.manifest.plugins.every((plugin) => existingPlugins.has(plugin.packageHash) && library.packages.some((entry) => entry.packageHash === plugin.packageHash && entry.ownership.manual))) {
                await removeDirectoryDurable(paths.work);
                return this.get(id);
            }
        }
        const rows = adapterPlan.mappings.map((mapping) => {
            const operationKind = { "run-manifest": "publish-run-manifest", "visual-script": "publish-script", scenario: "publish-scenario", vehicle: "publish-vehicle", environment: "publish-environment" }[mapping.resourceKind];
            const op = adapterPlan.operations.find((candidate) => candidate.kind === operationKind && [candidate.manifestId, candidate.scriptId, candidate.scenarioId, candidate.vehicleId, candidate.environmentId].includes(mapping.localId));
            const reused = mapping.resourceKind === "protobuf-interface" ? Boolean(existingInterface)
                : mapping.resourceKind === "run-template-plugin-package" ? existingPlugins.has(mapping.localId)
                    : mapping.resourceKind === "editor-asset-revision" ? adapterPlan.environment.groups.some((group) => group.localAssetId === mapping.localId && group.reused)
                    : op && (op.expectedRevision > 0 || op.expectedContentHash != null);
            return { ...mapping, action: reused ? "reuse" : "create", renamed: !["run-template-plugin-package", "protobuf-interface"].includes(mapping.resourceKind) && mapping.localId !== mapping.sourceId };
        });
        const review = {
            name: prepared.verified.root.name, sourceManifestId: prepared.verified.root.id, destinationManifestId: adapterPlan.destination.manifestId,
            mappings: rows, plugins: prepared.verified.manifest.plugins.map(({ pluginId, version, packageHash, runtimeHash }) => ({ pluginId, version, packageHash, runtimeHash })),
            protobufInterface: prepared.verified.root.protobuf.interfaceHash,
            capabilities: [...new Set([...prepared.verified.plugins.values()].flatMap((entry) => entry.document.capabilities))].sort(),
            rights: adapterPlan.rights, warnings: adapterPlan.warnings, blockingIssues: adapterPlan.blockingIssues,
            committable: adapterPlan.blockingIssues.length === 0, bindingCount: adapterPlan.destination.bindingCount,
        };
        const plan = { kind: PLAN_KIND, version: 1, importId: id, preparationHash: prepared.preparationHash, adapterPlan, review };
        const bytes = canonicalMarketplaceBytes(plan);
        const planHash = hashMarketplaceBytes(bytes);
        const planPath = path.join(paths.plans, planHash + ".json");
        if (await lstatOrNull(planPath)) {
            if (!Buffer.from(await readRegularBytes(planPath)).equals(Buffer.from(bytes))) fail(CODES.RECOVERY_REQUIRED, "Immutable local import plan changed.");
        } else await writeExclusiveDurable(planPath, bytes);
        const record = snapshot({
            kind: KIND, version: 1, importId: id, revision: (prior?.revision ?? -1) + 1,
            archive: { sha256: id, sizeBytes, packageVersion: prepared.verified.manifest.version },
            createdAt: prior?.createdAt ?? this.now().toISOString(), updatedAt: this.now().toISOString(), phase: "awaiting-confirmation", planHash,
            progress: { totalOperations: adapterPlan.operations.length, completedOperations: 0, currentOperation: null }, error: null, completions: [],
            mappings: prior?.mappings ?? [], destinationManifestId: prior?.destinationManifestId ?? null,
        });
        signal?.throwIfAborted();
        await atomicReplaceDurable(paths.snapshot, canonicalMarketplaceBytes(record));
        return this.get(id);
    }

    async #rights(plan) {
        const required = plan.adapterPlan.rights;
        if (!required.length) return;
        const result = await this.visualAssets.evaluateSourceRights({ sourceIds: [...new Set(required.map((right) => right.sourceId))], operations: [...new Set(required.map((right) => right.right))] });
        if (!result.allowed) fail(CODES.RIGHTS_DENIED, "Visual source rights changed before local import publication.");
    }
    async commit(id, { expectedRevision, planHash }) {
        assertSha256(planHash, "planHash"); integer(expectedRevision);
        const value = await this.#serial(async () => {
            const record = await this.#read(id);
            if (record.planHash !== planHash) fail(CODES.CONFLICT, "Local import plan changed; review it again.");
            if (["commit", "complete"].includes(record.phase)) return this.get(id);
            if (record.revision !== expectedRevision || record.phase !== "awaiting-confirmation") fail(CODES.CONFLICT, "Local import revision or phase changed.");
            const plan = await this.#readPlan(record);
            if (!plan.review.committable || plan.adapterPlan.blockingIssues.length) fail(CODES.RIGHTS_DENIED, "Local import review contains blocking issues.");
            await this.#rights(plan);
            await this.#save(record, { phase: "commit", error: null });
            return this.get(id);
        });
        if (value.phase === "commit") this.#launch(id);
        return value;
    }
    #launch(id) { this.#serial(() => this.#run(id)).catch(() => {}); }
    async #run(id) {
        let record = await this.#read(id);
        if (record.phase !== "commit") return;
        try {
            const plan = await this.#readPlan(record);
            await this.#rights(plan);
            for (const [index, operation] of plan.adapterPlan.operations.entries()) {
                if (this.#closed) fail(CODES.CANCELLED, "Local import interrupted by shutdown.");
                record = await this.#save(record, { progress: { ...record.progress, currentOperation: operation.operationId } });
                const completion = record.completions[index];
                let result;
                if (operation.kind === "add-local-plugin-manual-owner") {
                    const verified = await this.plugins.verifyPackage(operation.packageHash);
                    if (verified.document.id !== operation.pluginId) fail(CODES.RECOVERY_REQUIRED, "Local plugin identity changed.");
                    const before = await this.plugins.snapshotWithOwners();
                    await this.plugins.addManualOwner(operation.packageHash);
                    const after = await this.plugins.snapshotWithOwners();
                    if (before.revision !== after.revision) await this.publishPluginLibraryChange?.({ pluginId: operation.pluginId, packageHash: operation.packageHash, revision: after.revision, action: "install" });
                    result = { pluginId: operation.pluginId, packageHash: operation.packageHash };
                } else if (operation.kind === "publish-protobuf-interface") {
                    const preparation = await readRunTemplatePackagePreparation({ workDirectory: this.#paths(id).work, preparationHash: plan.preparationHash, archiveSha256: id });
                    const resource = createProtobufInterfaceResource(await readPreparedRunTemplateRecord(preparation, operation.recordSha256), operation.interfaceHash);
                    const published = await this.storage.putProtobufInterface(resource.document);
                    if (published.hash !== operation.interfaceHash) fail(CODES.RECOVERY_REQUIRED, "Published Protobuf interface identity changed.");
                    result = { interfaceHash: published.hash };
                } else {
                    const input = { operation, adapterPlan: plan.adapterPlan, context: { workDirectory: this.#paths(id).work } };
                    result = await (completion ? this.executor.recover(input) : this.executor.commit(input));
                }
                await this.fault?.("after-operation-publication", { id, index, operation });
                if (completion && !isDeepStrictEqual(resultIdentity(result), resultIdentity(completion.result))) fail(CODES.RECOVERY_REQUIRED, "Completed local import result identity changed.");
                if (!completion) {
                    record = await this.#save(record, {
                        completions: [...record.completions, { operationId: operation.operationId, operationHash: hashMarketplaceBytes(canonicalMarketplaceBytes(operation)), result }],
                        progress: { ...record.progress, completedOperations: index + 1, currentOperation: null },
                    });
                }
                await this.fault?.("after-operation-completion", { id, index, operation });
            }
            record = await this.#save(record, { phase: "complete", error: null, mappings: plan.adapterPlan.mappings, destinationManifestId: plan.adapterPlan.destination.manifestId, progress: { ...record.progress, currentOperation: null } });
            await this.fault?.("after-import-complete", { id });
            await removeDirectoryDurable(this.#paths(id).work);
        } catch (error) {
            if (record.phase === "complete") return;
            if (this.#closed) {
                await this.#save(record, { progress: { ...record.progress, currentOperation: null }, error: null });
                return;
            }
            const code = error instanceof MarketplaceError ? error.code : error.code === "CONFLICT" ? CODES.CONFLICT : CODES.RECOVERY_REQUIRED;
            await this.#save(record, { phase: "needs-attention", progress: { ...record.progress, currentOperation: null }, error: { code, message: code === CODES.CONFLICT ? "Imported content changed locally. Replan to preserve those edits." : code === CODES.RIGHTS_DENIED ? "Visual source rights prevent publication. Restore those rights before resuming." : "Local import needs attention. Resume after restoring its dependencies or rights." } });
        }
    }
    async resume(id, expectedRevision) {
        await this.#serial(async () => {
            const record = await this.#read(id);
            if (record.revision !== expectedRevision || record.phase !== "needs-attention") fail(CODES.CONFLICT, "Local import cannot be resumed at this revision.");
            await this.#save(record, { phase: "commit", error: null });
        });
        this.#launch(id);
        return this.get(id);
    }
    replan(id, expectedRevision) {
        return this.#serial(async () => {
            const record = await this.#read(id);
            if (record.revision !== expectedRevision || !["needs-attention", "awaiting-confirmation"].includes(record.phase)) fail(CODES.CONFLICT, "Local import cannot be replanned at this revision.");
            return this.#plan(id, record.archive.sizeBytes, record);
        });
    }
    cancel(id, expectedRevision) {
        return this.#serial(async () => {
            const record = await this.#read(id);
            if (record.revision !== expectedRevision || record.phase !== "awaiting-confirmation") fail(CODES.CONFLICT, "Local import can no longer be cancelled.");
            await this.#save(record, { phase: "cancelled" });
            await removeDirectoryDurable(this.#paths(id).work);
            return this.get(id);
        });
    }
    async recover() {
        await ensureDirectory(this.root);
        const incoming = path.join(this.root, "incoming");
        if (await lstatOrNull(incoming)) await removeDirectoryDurable(incoming);
        for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
            const paths = this.#paths(entry.name);
            if (entry.isSymbolicLink() || !entry.isDirectory()) fail(CODES.RECOVERY_REQUIRED, "Local import storage contains an unexpected node.");
            if (!await lstatOrNull(paths.snapshot)) await removeDirectoryDurable(paths.root);
        }
        for (const entry of (await this.list()).entries) {
            if (entry.phase === "commit") await this.#serial(() => this.#run(entry.importId));
            if (["complete", "cancelled"].includes(entry.phase) && await lstatOrNull(this.#paths(entry.importId).work)) await removeDirectoryDurable(this.#paths(entry.importId).work);
        }
    }
    async close() {
        this.#closed = true;
        for (const controller of this.#uploads) controller.abort();
        await this.#queue;
    }
}
