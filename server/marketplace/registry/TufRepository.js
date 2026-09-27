import { MetadataKind } from "@tufjs/models";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import {
    assertMarketplaceCatalog,
    assertMarketplaceItem,
    assertMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    ensureDirectory,
    hashRegularFile,
    lstatOrNull,
    readRegularBytes,
    requireDirectory,
    removeDirectoryDurable,
    verifyRegularFile,
    writeExclusiveDurable,
} from "./RegistryFs.js";
import {
    resolveRegistryPath,
    blobPath,
    blobRecordPath,
    tufCatalogTargetPath,
    tufConsistentTargetPath,
    tufItemTargetPath,
    tufReleaseTargetPath,
} from "./RegistryLayout.js";
import {
    assertBlobRecord,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "./RegistryDocuments.js";
import {
    TUF_DELEGATED_ROLES,
    TUF_DELEGATION_PATHS,
    TUF_EXPIRATION_MS,
    TUF_ONLINE_ROLES,
    TUF_ROLES,
    assertTufNotExpired,
    canonicalTufBytes,
    createDelegatedMetadata,
    createRootMetadata,
    createSnapshotMetadata,
    createTimestampMetadata,
    createTopTargetsMetadata,
    hashTufBytes,
    parseTufMetadata,
    rootRegistryId,
    tufExpiry,
    tufMetaFile,
    tufTargetFile,
    verifyCanonicalTufMetadata,
    verifyTufDelegationContract,
    verifyTufDelegate,
    verifyTufMetadataContract,
    verifyTufMetaFile,
    verifyTufRootContract,
} from "./TufMetadata.js";
import {
    ensurePrivateKey,
    generatePrivateKey,
    loadPrivateKey,
    tufKeyId,
    tufPublicKey,
} from "./TufKeys.js";
import {
    commitTufTransaction,
    prepareTufTransaction,
    recoverTufTransactions,
} from "./TufTransaction.js";

const TUF_METADATA_MAX_BYTES = 64 * 1024 * 1024;

function recovery(message, pathName = null, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName, cause });
}

function signature(message, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, message, { cause });
}

function metadataName(role, version) {
    if (role === TUF_ROLES.TIMESTAMP) return "timestamp.json";
    return `${version}.${role}.json`;
}

function timestampHistoryName(version) {
    return `${version}.timestamp.json`;
}

function localTufPaths(paths, tufRoot) {
    return {
        ...paths,
        tuf: tufRoot,
        tufMetadata: path.join(tufRoot, "metadata"),
        tufTargets: path.join(tufRoot, "targets"),
        tufOnlineKeys: path.join(tufRoot, "keys", "online"),
        tufTransactions: path.join(tufRoot, "transactions"),
    };
}

function onlineKeyPath(paths, role) {
    if (!TUF_ONLINE_ROLES.includes(role)) throw new TypeError(`Unknown online TUF role ${role}.`);
    return path.join(paths.tufOnlineKeys, `${role}.pem`);
}

async function writeImmutable(filePath, bytes) {
    const existing = await lstatOrNull(filePath);
    if (existing) {
        await verifyRegularFile(filePath, hashTufBytes(bytes), bytes.byteLength);
        return false;
    }
    await writeExclusiveDurable(filePath, bytes);
    return true;
}

async function readMetadata(paths, role, version) {
    const bytes = await readRegularBytes(path.join(paths.tufMetadata, metadataName(role, version)), {
        maxBytes: TUF_METADATA_MAX_BYTES,
    });
    const type = role === TUF_ROLES.ROOT
        ? MetadataKind.Root
        : role === TUF_ROLES.SNAPSHOT
            ? MetadataKind.Snapshot
            : role === TUF_ROLES.TIMESTAMP
                ? MetadataKind.Timestamp
                : MetadataKind.Targets;
    return { bytes, metadata: parseTufMetadata(bytes, type) };
}

async function latestRootVersion(paths) {
    const versions = (await fs.readdir(paths.tufMetadata)).flatMap((name) => {
        const match = /^(\d+)\.root\.json$/u.exec(name);
        return match ? [Number(match[1])] : [];
    }).sort((left, right) => left - right);
    if (versions.length < 1 || versions.some((version, index) => version !== index + 1)) {
        throw recovery("TUF root metadata history is missing or discontinuous.", paths.tufMetadata);
    }
    return versions.at(-1);
}

async function metadataHistory(paths) {
    const histories = Object.fromEntries([
        TUF_ROLES.ROOT,
        TUF_ROLES.TARGETS,
        ...TUF_DELEGATED_ROLES,
        TUF_ROLES.SNAPSHOT,
        TUF_ROLES.TIMESTAMP,
    ].map((role) => [role, []]));
    for (const name of await fs.readdir(paths.tufMetadata)) {
        if (name === "timestamp.json") continue;
        const match = /^([1-9][0-9]*)\.(root|targets|catalog|items|releases|advisories|snapshot|timestamp)\.json$/u.exec(name);
        if (!match) throw recovery("TUF metadata directory contains an unexpected filename.", name);
        histories[match[2]].push(Number(match[1]));
    }
    for (const versions of Object.values(histories)) versions.sort((left, right) => left - right);
    return histories;
}

function assertContinuousVersions(versions, role) {
    if (versions.length < 1 || versions.some((version, index) => version !== index + 1)) {
        throw recovery(`TUF ${role} metadata history is missing or discontinuous.`);
    }
}

async function loadOnlineKeys(paths) {
    const entries = await Promise.all(TUF_ONLINE_ROLES.map(async (role) => [role, await loadPrivateKey(onlineKeyPath(paths, role))]));
    return Object.fromEntries(entries);
}

function targetMapFromMetadata(metadata) {
    return metadata.signed.targets ?? {};
}

function targetIdentity(target) {
    return `${target.length}:${target.hashes?.sha256 ?? ""}`;
}

async function verifyTargetFile(paths, target) {
    const sha256 = target.hashes?.sha256;
    if (typeof sha256 !== "string") throw signature(`TUF target ${target.path} is missing its SHA-256.`);
    const relative = tufConsistentTargetPath(target.path, sha256);
    const filePath = path.join(paths.tufTargets, ...relative.split("/"));
    await verifyRegularFile(filePath, sha256, target.length);
    return { filePath, relativePath: relative };
}

async function projectTarget(paths, logicalPath, bytes, writes, { publish }) {
    const target = tufTargetFile(logicalPath, bytes);
    const relative = tufConsistentTargetPath(logicalPath, target.hashes.sha256);
    if (publish) {
        const filePath = path.join(paths.tufTargets, ...relative.split("/"));
        await writeImmutable(filePath, bytes);
    } else {
        writes.push({ phase: "target", destinationPath: `targets/${relative}`, bytes });
    }
    return target;
}

async function projectCatalogTargets(paths, catalog, { publish = true } = {}) {
    const roles = Object.fromEntries(TUF_DELEGATED_ROLES.map((role) => [role, {}]));
    const writes = [];
    const catalogBytes = marketplaceDocumentBytes(catalog);
    const catalogTarget = await projectTarget(paths, tufCatalogTargetPath(), catalogBytes, writes, { publish });
    roles[TUF_ROLES.CATALOG][catalogTarget.path] = catalogTarget;
    for (const summary of catalog.items) {
        const bytes = await readRegularBytes(resolveRegistryPath(paths, summary.target.path));
        const target = await projectTarget(paths, tufItemTargetPath(summary.itemId), bytes, writes, { publish });
        roles[TUF_ROLES.ITEMS][target.path] = target;
    }
    for (const summary of catalog.releases) {
        const bytes = await readRegularBytes(resolveRegistryPath(paths, summary.target.path));
        const target = await projectTarget(paths, tufReleaseTargetPath(summary.itemId, summary.releaseVersion), bytes, writes, { publish });
        roles[TUF_ROLES.RELEASES][target.path] = target;
    }
    return { roles, writes };
}

async function generateOnlineKeys(paths) {
    await ensureDirectory(paths.tufOnlineKeys);
    for (const role of TUF_ONLINE_ROLES) {
        await writeExclusiveDurable(onlineKeyPath(paths, role), generatePrivateKey());
    }
    return loadOnlineKeys(paths);
}

function metadataVersions(state) {
    return Object.fromEntries(Object.entries(state.roles).map(([role, entry]) => [role, entry.metadata.signed.version]));
}

function sameStringSet(actual, expected) {
    return actual.length === expected.length && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

async function verifyReferencedBlob(paths, descriptor) {
    await verifyRegularFile(resolveRegistryPath(paths, blobPath(descriptor.sha256)), descriptor.sha256, descriptor.sizeBytes);
    const recordBytes = await readRegularBytes(resolveRegistryPath(paths, blobRecordPath(descriptor.sha256)));
    const record = parseRegistryDocumentBytes(recordBytes, assertBlobRecord);
    if (!Buffer.from(recordBytes).equals(Buffer.from(registryDocumentBytes(record, assertBlobRecord)))) {
        throw recovery("Published marketplace blob record is not canonical.", descriptor.sha256);
    }
    if (record.sha256 !== descriptor.sha256 || record.sizeBytes !== descriptor.sizeBytes || record.mediaType !== descriptor.mediaType) {
        throw recovery("Published marketplace blob record does not match its descriptor.", descriptor.sha256);
    }
}

async function verifyRegularTree(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw recovery("TUF repository contains a symlink.", entryPath);
        if (entry.isDirectory()) await verifyRegularTree(entryPath);
        else if (!entry.isFile()) throw recovery("TUF repository contains a non-regular node.", entryPath);
    }
}

async function verifyConsistentTargetTree(directory, root = directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw recovery("TUF target repository contains a symlink.", entryPath);
        if (entry.isDirectory()) {
            await verifyConsistentTargetTree(entryPath, root);
            continue;
        }
        if (!entry.isFile()) throw recovery("TUF target repository contains a non-regular node.", entryPath);
        const relative = path.relative(root, entryPath).split(path.sep).join("/");
        if (!/^(?:catalog|items|advisories)\/[a-f0-9]{64}\.[A-Za-z0-9._-]+\.json$|^releases\/[a-z0-9.-]+\/[a-f0-9]{64}\.[0-9A-Za-z.-]+\.json$/u.test(relative)) {
            throw recovery("TUF target repository contains an invalid consistent target path.", relative);
        }
        const expected = entry.name.slice(0, 64);
        const actual = await hashRegularFile(entryPath);
        if (actual.sha256 !== expected) throw recovery("TUF consistent target digest does not match its filename.", relative);
    }
}

export class TufRepository {
    constructor(paths, registry, { now = () => new Date(), faults = {} } = {}) {
        this.paths = paths;
        this.registry = registry;
        this.now = now;
        this.faults = faults;
    }

    static async initialize(paths, registry, {
        offlineRootKeyPath,
        now = () => new Date(),
    }) {
        if (!offlineRootKeyPath) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "TUF initialization requires an offline root key path.");
        const rootKey = await ensurePrivateKey(offlineRootKeyPath, { registryRoot: paths.root });
        const existingTuf = await lstatOrNull(paths.tuf);
        if (existingTuf) {
            if (!existingTuf.isDirectory() || existingTuf.isSymbolicLink()) throw recovery("TUF repository is not a regular directory.", paths.tuf);
            const repository = new TufRepository(paths, registry, { now });
            await repository.recover();
            const latest = await repository.latestRoot();
            const authorized = latest.metadata.signed.roles.root.keyIDs;
            if (!authorized.includes(tufKeyId(rootKey.privateKey))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "The supplied offline root key is not authorized by the current TUF root.");
            }
            await repository.verify();
            return repository;
        }
        const temporary = path.join(paths.root, `.tuf.initialize-${randomUUID()}`);
        const temporaryPaths = localTufPaths(paths, temporary);
        try {
            await ensureDirectory(temporaryPaths.tufMetadata);
            await ensureDirectory(temporaryPaths.tufTargets);
            await ensureDirectory(temporaryPaths.tufTransactions);
            const online = await generateOnlineKeys(temporaryPaths);
            const publicKeys = Object.fromEntries(Object.entries(online).map(([role, key]) => [role, tufPublicKey(key)]));
            const rootPublic = tufPublicKey(rootKey.privateKey);
            const root = createRootMetadata({
                version: 1,
                registryId: registry.registryId,
                rootKeys: [rootPublic],
                targetsKeys: [rootPublic],
                snapshotKey: publicKeys.snapshot,
                timestampKey: publicKeys.timestamp,
                expires: tufExpiry(now, TUF_EXPIRATION_MS.root),
                signers: [rootKey.privateKey],
            });
            const topTargets = createTopTargetsMetadata({
                version: 1,
                delegatedKeys: publicKeys,
                expires: tufExpiry(now, TUF_EXPIRATION_MS.targets),
                signer: rootKey.privateKey,
            });
            const catalog = assertMarketplaceCatalog(parseMarketplaceDocument(await readRegularBytes(paths.catalogCurrent)));
            const { roles: targets } = await projectCatalogTargets(temporaryPaths, catalog);
            const delegated = {};
            for (const role of TUF_DELEGATED_ROLES) {
                delegated[role] = createDelegatedMetadata({
                    version: 1,
                    expires: tufExpiry(now, TUF_EXPIRATION_MS.delegated),
                    targets: targets[role],
                    signer: online[role],
                });
            }
            await writeImmutable(path.join(temporaryPaths.tufMetadata, metadataName("root", 1)), canonicalTufBytes(root));
            const topBytes = canonicalTufBytes(topTargets);
            await writeImmutable(path.join(temporaryPaths.tufMetadata, metadataName("targets", 1)), topBytes);
            const metadataFiles = { "targets.json": tufMetaFile(1, topBytes) };
            for (const role of TUF_DELEGATED_ROLES) {
                const bytes = canonicalTufBytes(delegated[role]);
                await writeImmutable(path.join(temporaryPaths.tufMetadata, metadataName(role, 1)), bytes);
                metadataFiles[`${role}.json`] = tufMetaFile(1, bytes);
            }
            const snapshot = createSnapshotMetadata({
                version: 1,
                expires: tufExpiry(now, TUF_EXPIRATION_MS.snapshot),
                metadataFiles,
                signer: online.snapshot,
            });
            const snapshotBytes = canonicalTufBytes(snapshot);
            await writeImmutable(path.join(temporaryPaths.tufMetadata, metadataName("snapshot", 1)), snapshotBytes);
            const timestamp = createTimestampMetadata({
                version: 1,
                expires: tufExpiry(now, TUF_EXPIRATION_MS.timestamp),
                snapshotMeta: tufMetaFile(1, snapshotBytes),
                signer: online.timestamp,
            });
            const timestampBytes = canonicalTufBytes(timestamp);
            await writeImmutable(path.join(temporaryPaths.tufMetadata, timestampHistoryName(1)), timestampBytes);
            await writeExclusiveDurable(path.join(temporaryPaths.tufMetadata, "timestamp.json"), timestampBytes);
            await fsyncDir(temporary);
            await fs.rename(temporary, paths.tuf);
            await fsyncDir(paths.root);
            const repository = new TufRepository(paths, registry, { now });
            await repository.verify();
            return repository;
        } catch (error) {
            await removeDirectoryDurable(temporary).catch(() => {});
            throw error;
        }
    }

    static async open(paths, registry, options = {}) {
        const stat = await lstatOrNull(paths.tuf);
        if (!stat) return null;
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw recovery("TUF repository is not a regular directory.", paths.tuf);
        for (const directory of [paths.tufMetadata, paths.tufTargets, paths.tufOnlineKeys, paths.tufTransactions]) {
            await requireDirectory(directory);
        }
        const repository = new TufRepository(paths, registry, options);
        await repository.recover();
        return repository;
    }

    async latestRoot() {
        const version = await latestRootVersion(this.paths);
        return { version, ...await readMetadata(this.paths, TUF_ROLES.ROOT, version) };
    }

    async readPublishedState() {
        const root = await this.latestRoot();
        const timestamp = await readMetadata(this.paths, TUF_ROLES.TIMESTAMP);
        const snapshotVersion = timestamp.metadata.signed.snapshotMeta.version;
        const snapshot = await readMetadata(this.paths, TUF_ROLES.SNAPSHOT, snapshotVersion);
        const roles = {};
        for (const role of [TUF_ROLES.TARGETS, ...TUF_DELEGATED_ROLES]) {
            const meta = snapshot.metadata.signed.meta[`${role}.json`];
            if (!meta) throw recovery(`Snapshot does not reference ${role}.json.`);
            roles[role] = await readMetadata(this.paths, role, meta.version);
        }
        return { root, timestamp, snapshot, roles };
    }

    async publishCatalog(catalog, {
        operation = "publish-catalog",
        forceRefresh = false,
        topTargetsOverride = null,
        preWrites = [],
        postTimestampWrites = [],
    } = {}) {
        const validated = assertMarketplaceCatalog(catalog);
        const state = await this.readPublishedState();
        const online = await loadOnlineKeys(this.paths);
        const projected = await projectCatalogTargets(this.paths, validated, { publish: false });
        const targets = projected.roles;
        const writes = [...preWrites, ...projected.writes];
        const delegated = {};
        for (const role of TUF_DELEGATED_ROLES) {
            const previous = state.roles[role].metadata;
            const previousTargets = targetMapFromMetadata(previous);
            const changed = forceRefresh
                || Object.keys(previousTargets).length !== Object.keys(targets[role]).length
                || Object.entries(targets[role]).some(([name, target]) => targetIdentity(previousTargets[name] ?? {}) !== targetIdentity(target));
            if (!changed) {
                delegated[role] = state.roles[role];
                continue;
            }
            const metadata = createDelegatedMetadata({
                version: previous.signed.version + 1,
                expires: tufExpiry(this.now, TUF_EXPIRATION_MS.delegated),
                targets: targets[role],
                signer: online[role],
            });
            const bytes = canonicalTufBytes(metadata);
            writes.push({
                phase: "delegated",
                destinationPath: `metadata/${metadataName(role, metadata.signed.version)}`,
                bytes,
            });
            delegated[role] = { bytes, metadata };
        }
        const topTargets = topTargetsOverride ?? state.roles.targets;
        if (topTargetsOverride) {
            writes.push({
                phase: "targets",
                destinationPath: `metadata/${metadataName("targets", topTargets.metadata.signed.version)}`,
                bytes: topTargets.bytes,
            });
        }
        const metadataFiles = {
            "targets.json": tufMetaFile(topTargets.metadata.signed.version, topTargets.bytes),
        };
        for (const role of TUF_DELEGATED_ROLES) {
            metadataFiles[`${role}.json`] = tufMetaFile(delegated[role].metadata.signed.version, delegated[role].bytes);
        }
        const snapshotVersion = state.snapshot.metadata.signed.version + 1;
        const snapshot = createSnapshotMetadata({
            version: snapshotVersion,
            expires: tufExpiry(this.now, TUF_EXPIRATION_MS.snapshot),
            metadataFiles,
            signer: online.snapshot,
        });
        const snapshotBytes = canonicalTufBytes(snapshot);
        writes.push({
            phase: "snapshot",
            destinationPath: `metadata/${metadataName("snapshot", snapshotVersion)}`,
            bytes: snapshotBytes,
        });
        const timestampVersion = state.timestamp.metadata.signed.version + 1;
        const timestamp = createTimestampMetadata({
            version: timestampVersion,
            expires: tufExpiry(this.now, TUF_EXPIRATION_MS.timestamp),
            snapshotMeta: tufMetaFile(snapshotVersion, snapshotBytes),
            signer: online.timestamp,
        });
        const timestampBytes = canonicalTufBytes(timestamp);
        writes.push({
            phase: "timestamp-history",
            destinationPath: `metadata/${timestampHistoryName(timestampVersion)}`,
            bytes: timestampBytes,
        });
        const prepared = await prepareTufTransaction({
            paths: this.paths,
            registryId: this.registry.registryId,
            operation,
            catalog: validated,
            baseTimestamp: state.timestamp,
            targetTimestamp: { metadata: timestamp, bytes: timestampBytes },
            writes,
            postTimestampWrites,
            faults: this.faults,
        });
        await commitTufTransaction(this.paths, prepared);
        return Object.freeze({
            operation,
            catalogRevision: validated.revision,
            timestampVersion,
            snapshotVersion,
            roleVersions: Object.fromEntries(TUF_DELEGATED_ROLES.map((role) => [role, delegated[role].metadata.signed.version])),
        });
    }

    async refresh(catalog) {
        return this.publishCatalog(catalog, { operation: "refresh", forceRefresh: true });
    }

    async recover() {
        const catalog = assertMarketplaceCatalog(parseMarketplaceDocument(await readRegularBytes(this.paths.catalogCurrent)));
        await recoverTufTransactions(this.paths, {
            faults: this.faults,
            registryId: this.registry.registryId,
            catalog,
        });
        const state = await this.readPublishedState();
        const catalogTarget = state.roles.catalog.metadata.signed.targets[tufCatalogTargetPath()];
        if (!catalogTarget || catalogTarget.hashes.sha256 !== hashMarketplaceBytes(marketplaceDocumentBytes(catalog))) {
            return this.publishCatalog(catalog, { operation: "recover-catalog" });
        }
        return null;
    }

    async rotateRoot({ currentRootKeyPath, newRootKeyPath }) {
        const currentKey = await loadPrivateKey(currentRootKeyPath, { registryRoot: this.paths.root });
        const nextKeyRecord = await ensurePrivateKey(newRootKeyPath, { registryRoot: this.paths.root });
        const nextKey = nextKeyRecord.privateKey;
        if (tufKeyId(currentKey) === tufKeyId(nextKey)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "New offline root key must differ from the current root key.");
        }
        const latest = await this.latestRoot();
        if (!latest.metadata.signed.roles.root.keyIDs.includes(tufKeyId(currentKey))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Current offline root key is not authorized by the latest root metadata.");
        }
        const online = await loadOnlineKeys(this.paths);
        const publicOnline = Object.fromEntries(Object.entries(online).map(([role, key]) => [role, tufPublicKey(key)]));
        const oldPublic = tufPublicKey(currentKey);
        const newPublic = tufPublicKey(nextKey);
        const transitionVersion = latest.version + 1;
        const transition = createRootMetadata({
            version: transitionVersion,
            registryId: this.registry.registryId,
            rootKeys: [oldPublic, newPublic],
            targetsKeys: [oldPublic, newPublic],
            snapshotKey: publicOnline.snapshot,
            timestampKey: publicOnline.timestamp,
            expires: tufExpiry(this.now, TUF_EXPIRATION_MS.root),
            signers: [currentKey, nextKey],
        });
        const state = await this.readPublishedState();
        const topTargets = createTopTargetsMetadata({
            version: state.roles.targets.metadata.signed.version + 1,
            delegatedKeys: publicOnline,
            expires: tufExpiry(this.now, TUF_EXPIRATION_MS.targets),
            signer: nextKey,
        });
        const topEntry = { metadata: topTargets, bytes: canonicalTufBytes(topTargets) };
        const catalog = assertMarketplaceCatalog(parseMarketplaceDocument(await readRegularBytes(this.paths.catalogCurrent)));
        const finalVersion = transitionVersion + 1;
        const finalRoot = createRootMetadata({
            version: finalVersion,
            registryId: this.registry.registryId,
            rootKeys: [newPublic],
            targetsKeys: [newPublic],
            snapshotKey: publicOnline.snapshot,
            timestampKey: publicOnline.timestamp,
            expires: tufExpiry(this.now, TUF_EXPIRATION_MS.root),
            signers: [currentKey, nextKey],
        });
        await this.publishCatalog(catalog, {
            operation: "rotate-root",
            topTargetsOverride: topEntry,
            preWrites: [{
                phase: "root",
                destinationPath: `metadata/${metadataName("root", transitionVersion)}`,
                bytes: canonicalTufBytes(transition),
            }],
            postTimestampWrites: [{
                phase: "root",
                destinationPath: `metadata/${metadataName("root", finalVersion)}`,
                bytes: canonicalTufBytes(finalRoot),
            }],
        });
        return Object.freeze({ previousRootVersion: latest.version, rootVersion: finalVersion, rootKeyId: newPublic.keyID });
    }

    async verify({ now = this.now() } = {}) {
        await requireDirectory(this.paths.tufMetadata);
        await requireDirectory(this.paths.tufTargets);
        await verifyRegularTree(this.paths.tufMetadata);
        await verifyConsistentTargetTree(this.paths.tufTargets);
        const latestVersion = await latestRootVersion(this.paths);
        let trusted;
        for (let version = 1; version <= latestVersion; version += 1) {
            const current = await readMetadata(this.paths, TUF_ROLES.ROOT, version);
            verifyCanonicalTufMetadata(current, `${version}.root.json`);
            verifyTufRootContract(current.metadata);
            if (version === 1) verifyTufDelegate(current.metadata, TUF_ROLES.ROOT, current.metadata);
            else {
                verifyTufDelegate(trusted.metadata, TUF_ROLES.ROOT, current.metadata);
                verifyTufDelegate(current.metadata, TUF_ROLES.ROOT, current.metadata);
            }
            if (rootRegistryId(current.metadata) !== this.registry.registryId) throw signature("TUF root registry UUID does not match registry.json.");
            trusted = current;
        }
        assertTufNotExpired(trusted.metadata, now);
        const state = await this.readPublishedState();
        verifyCanonicalTufMetadata(state.timestamp, "timestamp.json");
        verifyTufMetadataContract(state.timestamp.metadata, MetadataKind.Timestamp, "timestamp.json");
        verifyTufDelegate(trusted.metadata, TUF_ROLES.TIMESTAMP, state.timestamp.metadata);
        assertTufNotExpired(state.timestamp.metadata, now);
        const histories = await metadataHistory(this.paths);
        for (const [role, versions] of Object.entries(histories)) assertContinuousVersions(versions, role);
        const pendingTransactions = await fs.readdir(this.paths.tufTransactions);
        if (pendingTransactions.length === 0) {
            const publishedVersions = {
                [TUF_ROLES.ROOT]: latestVersion,
                [TUF_ROLES.TARGETS]: state.roles.targets.metadata.signed.version,
                [TUF_ROLES.CATALOG]: state.roles.catalog.metadata.signed.version,
                [TUF_ROLES.ITEMS]: state.roles.items.metadata.signed.version,
                [TUF_ROLES.RELEASES]: state.roles.releases.metadata.signed.version,
                [TUF_ROLES.ADVISORIES]: state.roles.advisories.metadata.signed.version,
                [TUF_ROLES.SNAPSHOT]: state.snapshot.metadata.signed.version,
                [TUF_ROLES.TIMESTAMP]: state.timestamp.metadata.signed.version,
            };
            for (const [role, version] of Object.entries(publishedVersions)) {
                if (histories[role].at(-1) !== version) throw recovery(`Published TUF ${role} version is rolled back.`);
            }
        }
        for (const version of histories.timestamp) {
            const historyBytes = await readRegularBytes(path.join(this.paths.tufMetadata, timestampHistoryName(version)), {
                maxBytes: TUF_METADATA_MAX_BYTES,
            });
            const history = { bytes: historyBytes, metadata: parseTufMetadata(historyBytes, MetadataKind.Timestamp) };
            if (history.metadata.signed.version !== version) throw recovery("TUF timestamp history filename has the wrong version.");
            verifyCanonicalTufMetadata(history, `${version}.timestamp.json`);
            verifyTufMetadataContract(history.metadata, MetadataKind.Timestamp, `${version}.timestamp.json`);
            verifyTufDelegate(trusted.metadata, TUF_ROLES.TIMESTAMP, history.metadata);
            if (version === state.timestamp.metadata.signed.version && !Buffer.from(historyBytes).equals(state.timestamp.bytes)) {
                throw recovery("Published timestamp alias does not match its immutable history entry.");
            }
        }
        verifyTufMetaFile(state.timestamp.metadata.signed.snapshotMeta, state.snapshot.bytes, "snapshot.json");
        verifyCanonicalTufMetadata(state.snapshot, `${state.snapshot.metadata.signed.version}.snapshot.json`);
        verifyTufMetadataContract(state.snapshot.metadata, MetadataKind.Snapshot, "snapshot.json");
        verifyTufDelegate(trusted.metadata, TUF_ROLES.SNAPSHOT, state.snapshot.metadata);
        assertTufNotExpired(state.snapshot.metadata, now);
        const expectedSnapshotFiles = [TUF_ROLES.TARGETS, ...TUF_DELEGATED_ROLES].map((role) => `${role}.json`);
        if (!sameStringSet(Object.keys(state.snapshot.metadata.signed.meta), expectedSnapshotFiles)) {
            throw signature("TUF snapshot metadata set is invalid.");
        }
        for (const [role, entry] of Object.entries(state.roles)) {
            verifyTufMetaFile(state.snapshot.metadata.signed.meta[`${role}.json`], entry.bytes, `${role}.json`);
            verifyCanonicalTufMetadata(entry, `${entry.metadata.signed.version}.${role}.json`);
            verifyTufMetadataContract(entry.metadata, MetadataKind.Targets, `${role}.json`);
            verifyTufDelegate(role === TUF_ROLES.TARGETS ? trusted.metadata : state.roles.targets.metadata, role, entry.metadata);
            assertTufNotExpired(entry.metadata, now);
        }
        verifyTufDelegationContract(state.roles.targets.metadata);
        if (Object.keys(state.roles.advisories.metadata.signed.targets).length !== 0) {
            throw signature("MKT-04 advisory delegation must be empty.");
        }
        const documents = {};
        for (const role of [TUF_ROLES.CATALOG, TUF_ROLES.ITEMS, TUF_ROLES.RELEASES]) {
            documents[role] = {};
            for (const target of Object.values(state.roles[role].metadata.signed.targets)) {
                const { filePath } = await verifyTargetFile(this.paths, target);
                const bytes = await readRegularBytes(filePath, { maxBytes: TUF_METADATA_MAX_BYTES });
                const document = parseMarketplaceDocument(bytes);
                if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
                    throw signature(`Published ${target.path} target is not canonical marketplace JSON.`);
                }
                documents[role][target.path] = { bytes, document, target };
            }
        }
        const catalogEntry = documents.catalog[tufCatalogTargetPath()];
        if (!catalogEntry) throw recovery("Published catalog TUF target is missing.");
        const catalog = assertMarketplaceCatalog(catalogEntry.document);
        if (catalog.registryId !== this.registry.registryId) throw signature("Published catalog registry UUID is invalid.");
        const expectedItemTargets = catalog.items.map((item) => tufItemTargetPath(item.itemId));
        const expectedReleaseTargets = catalog.releases.map((release) => tufReleaseTargetPath(release.itemId, release.releaseVersion));
        if (!sameStringSet(Object.keys(documents.catalog), [tufCatalogTargetPath()])
            || !sameStringSet(Object.keys(documents.items), expectedItemTargets)
            || !sameStringSet(Object.keys(documents.releases), expectedReleaseTargets)) {
            throw recovery("Published delegated target sets do not match the catalog.");
        }
        for (const item of catalog.items) {
            const entry = documents.items[tufItemTargetPath(item.itemId)];
            const document = assertMarketplaceItem(entry.document);
            if (document.itemId !== item.itemId || entry.target.hashes.sha256 !== item.target.sha256
                || entry.target.length !== item.target.sizeBytes) {
                throw recovery("Published item target does not match its catalog summary.", item.itemId);
            }
            for (const preview of document.previews) await verifyReferencedBlob(this.paths, preview);
        }
        for (const release of catalog.releases) {
            const entry = documents.releases[tufReleaseTargetPath(release.itemId, release.releaseVersion)];
            const document = assertMarketplaceRelease(entry.document);
            if (document.itemId !== release.itemId || document.releaseVersion !== release.releaseVersion
                || entry.target.hashes.sha256 !== release.target.sha256 || entry.target.length !== release.target.sizeBytes) {
                throw recovery("Published release target does not match its catalog summary.", `${release.itemId}@${release.releaseVersion}`);
            }
            await verifyReferencedBlob(this.paths, document.artifact);
        }
        return Object.freeze({
            ok: true,
            rootVersion: latestVersion,
            timestampVersion: state.timestamp.metadata.signed.version,
            snapshotVersion: state.snapshot.metadata.signed.version,
            roleVersions: metadataVersions(state),
            catalogRevision: catalog.revision,
            catalogSha256: catalogEntry.target.hashes.sha256,
        });
    }
}
