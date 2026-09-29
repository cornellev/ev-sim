import {
    MetaFile,
    Metadata,
    MetadataKind,
    Snapshot,
    TargetFile,
    Targets,
    Timestamp,
} from "@tufjs/models";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { signTufMetadata } from "./TufKeys.js";

export const TUF_SPEC_VERSION = "1.0.31";
const { canonicalize } = createRequire(import.meta.url)("@tufjs/canonical-json");
export const TUF_EXTENSION_FIELD = "x-cev-sim";
export const TUF_ROLES = Object.freeze({
    ROOT: "root",
    TARGETS: "targets",
    CATALOG: "catalog",
    ITEMS: "items",
    PUBLISHERS: "publishers",
    RELEASES: "releases",
    ADVISORIES: "advisories",
    SNAPSHOT: "snapshot",
    TIMESTAMP: "timestamp",
});
export const TUF_DELEGATED_ROLES = Object.freeze([
    TUF_ROLES.CATALOG,
    TUF_ROLES.ITEMS,
    TUF_ROLES.PUBLISHERS,
    TUF_ROLES.RELEASES,
    TUF_ROLES.ADVISORIES,
]);
export const TUF_ONLINE_ROLES = Object.freeze([
    ...TUF_DELEGATED_ROLES,
    TUF_ROLES.SNAPSHOT,
    TUF_ROLES.TIMESTAMP,
]);
export const TUF_EXPIRATION_MS = Object.freeze({
    [TUF_ROLES.TIMESTAMP]: 48 * 60 * 60 * 1000,
    [TUF_ROLES.SNAPSHOT]: 14 * 24 * 60 * 60 * 1000,
    delegated: 90 * 24 * 60 * 60 * 1000,
    [TUF_ROLES.TARGETS]: 365 * 24 * 60 * 60 * 1000,
    [TUF_ROLES.ROOT]: 365 * 24 * 60 * 60 * 1000,
});

export const TUF_DELEGATION_PATHS = Object.freeze({
    [TUF_ROLES.CATALOG]: ["catalog/*"],
    [TUF_ROLES.ITEMS]: ["items/*"],
    [TUF_ROLES.PUBLISHERS]: ["publishers/*"],
    [TUF_ROLES.RELEASES]: ["releases/*/*"],
    [TUF_ROLES.ADVISORIES]: ["advisories/*"],
});

function signatureError(message, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, message, { cause });
}

function sameStringSet(actual, expected) {
    return actual.length === expected.length
        && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

export function tufExpiry(now, durationMs) {
    const current = now instanceof Date ? now : now();
    return new Date(current.getTime() + durationMs).toISOString();
}

export function canonicalTufBytes(metadata) {
    return Buffer.from(canonicalize(metadata.toJSON()));
}

export function hashTufBytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export function parseTufMetadata(bytes, type) {
    try {
        const { document } = parseMarketplaceJsonBytes(bytes);
        return Metadata.fromJSON(type, document);
    } catch (error) {
        throw signatureError(`Invalid TUF ${type} metadata.`, error);
    }
}

export function tufTargetFile(targetPath, bytes) {
    return new TargetFile({
        path: targetPath,
        length: bytes.byteLength,
        hashes: { sha256: hashTufBytes(bytes) },
    });
}

export function tufMetaFile(version, bytes) {
    return new MetaFile({
        version,
        length: bytes.byteLength,
        hashes: { sha256: hashTufBytes(bytes) },
    });
}

function unsignedMetadata(type, signed) {
    return Metadata.fromJSON(type, { signatures: [], signed });
}

function keyMap(keys) {
    return Object.fromEntries(keys.map((key) => [key.keyID, key.toJSON()]));
}

function role(keyIDs) {
    return { keyids: keyIDs, threshold: 1 };
}

export function createRootMetadata({
    version,
    registryId,
    rootKeys,
    targetsKeys,
    snapshotKey,
    timestampKey,
    expires,
    signers,
}) {
    const allKeys = [...new Map([
        ...rootKeys,
        ...targetsKeys,
        snapshotKey,
        timestampKey,
    ].map((key) => [key.keyID, key])).values()];
    const metadata = unsignedMetadata(MetadataKind.Root, {
        _type: MetadataKind.Root,
        spec_version: TUF_SPEC_VERSION,
        version,
        expires,
        consistent_snapshot: true,
        keys: keyMap(allKeys),
        roles: {
            root: role(rootKeys.map((key) => key.keyID)),
            targets: role(targetsKeys.map((key) => key.keyID)),
            snapshot: role([snapshotKey.keyID]),
            timestamp: role([timestampKey.keyID]),
        },
        [TUF_EXTENSION_FIELD]: { repositoryVersion: 1, registryId },
    });
    signers.forEach((signer) => signTufMetadata(metadata, signer));
    return metadata;
}

export function createTopTargetsMetadata({ version, delegatedKeys, expires, signer }) {
    const roleKeys = TUF_DELEGATED_ROLES.map((name) => delegatedKeys[name]);
    const metadata = unsignedMetadata(MetadataKind.Targets, {
        _type: MetadataKind.Targets,
        spec_version: TUF_SPEC_VERSION,
        version,
        expires,
        targets: {},
        delegations: {
            keys: keyMap(roleKeys),
            roles: TUF_DELEGATED_ROLES.map((name) => ({
                name,
                keyids: [delegatedKeys[name].keyID],
                threshold: 1,
                terminating: true,
                paths: TUF_DELEGATION_PATHS[name],
            })),
        },
    });
    return signTufMetadata(metadata, signer);
}

export function createDelegatedMetadata({ version, expires, targets, signer }) {
    const metadata = new Metadata(new Targets({
        version,
        specVersion: TUF_SPEC_VERSION,
        expires,
        targets,
    }));
    return signTufMetadata(metadata, signer);
}

export function createSnapshotMetadata({ version, expires, metadataFiles, signer }) {
    const metadata = new Metadata(new Snapshot({
        version,
        specVersion: TUF_SPEC_VERSION,
        expires,
        meta: metadataFiles,
    }));
    return signTufMetadata(metadata, signer);
}

export function createTimestampMetadata({ version, expires, snapshotMeta, signer }) {
    const metadata = new Metadata(new Timestamp({
        version,
        specVersion: TUF_SPEC_VERSION,
        expires,
        snapshotMeta,
    }));
    return signTufMetadata(metadata, signer);
}

export function assertTufNotExpired(metadata, now = new Date()) {
    if (metadata.signed.isExpired(now)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.METADATA_EXPIRED, `${metadata.signed.type} metadata is expired.`);
    }
    return metadata;
}

export function verifyTufDelegate(parent, roleName, child) {
    try {
        parent.verifyDelegate(roleName, child);
        return child;
    } catch (error) {
        throw signatureError(`TUF ${roleName} signature is invalid.`, error);
    }
}

export function rootRegistryId(root) {
    return root.signed.unrecognizedFields?.[TUF_EXTENSION_FIELD]?.registryId ?? null;
}

export function verifyCanonicalTufMetadata(entry, label) {
    if (!Buffer.from(entry.bytes).equals(canonicalTufBytes(entry.metadata))) {
        throw signatureError(`TUF ${label} metadata is not canonically serialized.`);
    }
    return entry;
}

export function verifyTufMetadataContract(metadata, expectedType, label) {
    const signed = metadata.toJSON().signed;
    if (signed._type !== expectedType || signed.spec_version !== TUF_SPEC_VERSION) {
        throw signatureError(`TUF ${label} type or specification version is invalid.`);
    }
    return metadata;
}

export function verifyTufMetaFile(meta, bytes, label) {
    try {
        meta.verify(bytes);
        return meta;
    } catch (error) {
        throw signatureError(`TUF ${label} length or hash is invalid.`, error);
    }
}

export function verifyTufRootContract(root) {
    const signed = root.toJSON().signed;
    if (signed.spec_version !== TUF_SPEC_VERSION || signed.consistent_snapshot !== true
        || signed[TUF_EXTENSION_FIELD]?.repositoryVersion !== 1) {
        throw signatureError("TUF root repository contract is invalid.");
    }
    for (const role of [TUF_ROLES.ROOT, TUF_ROLES.TARGETS, TUF_ROLES.SNAPSHOT, TUF_ROLES.TIMESTAMP]) {
        const definition = signed.roles?.[role];
        if (definition?.threshold !== 1 || !Array.isArray(definition.keyids) || definition.keyids.length < 1) {
            throw signatureError(`TUF root role ${role} is invalid.`);
        }
    }
    if (!sameStringSet(signed.roles.root.keyids, signed.roles.targets.keyids)
        || signed.roles.snapshot.keyids.length !== 1 || signed.roles.timestamp.keyids.length !== 1) {
        throw signatureError("TUF root and top-level targets must share offline keys, with one snapshot and timestamp key.");
    }
    const referencedKeys = new Set(Object.values(signed.roles).flatMap((definition) => definition.keyids));
    if (referencedKeys.size !== signed.roles.root.keyids.length + 2) {
        throw signatureError("TUF offline root, snapshot, and timestamp keys must be distinct.");
    }
    if (!sameStringSet(Object.keys(signed.keys ?? {}), [...referencedKeys])) {
        throw signatureError("TUF root contains unused or missing keys.");
    }
    for (const key of Object.values(signed.keys ?? {})) {
        if (key.keytype !== "ed25519" || key.scheme !== "ed25519" || !/^[a-f0-9]{64}$/u.test(key.keyval?.public ?? "")) {
            throw signatureError("TUF root contains a non-Ed25519 key.");
        }
    }
    return root;
}

export function verifyTufDelegationContract(targets) {
    const signed = targets.toJSON().signed;
    if (Object.keys(signed.targets ?? {}).length !== 0) {
        throw signatureError("Top-level TUF targets role must not contain targets.");
    }
    const roles = signed.delegations?.roles ?? [];
    if (!sameStringSet(roles.map((role) => role.name), TUF_DELEGATED_ROLES)) {
        throw signatureError("Top-level TUF targets delegation set is invalid.");
    }
    const referenced = [];
    for (const roleName of TUF_DELEGATED_ROLES) {
        const role = roles.find((entry) => entry.name === roleName);
        if (role?.threshold !== 1 || role.terminating !== true || role.keyids?.length !== 1
            || !sameStringSet(role.paths ?? [], TUF_DELEGATION_PATHS[roleName])) {
            throw signatureError(`TUF ${roleName} delegation contract is invalid.`);
        }
        referenced.push(...role.keyids);
    }
    if (!sameStringSet(Object.keys(signed.delegations?.keys ?? {}), referenced)) {
        throw signatureError("Top-level TUF targets contains unused or missing delegated keys.");
    }
    return targets;
}

// Stable shared names used by both the registry publisher and simulator
// client. The TUF-prefixed exports above remain explicit at call sites that
// mix marketplace-document and TUF verification.
export const verifyCanonicalMetadata = verifyCanonicalTufMetadata;
export const verifyMetadataContract = verifyTufMetadataContract;
export const verifyMetaFile = verifyTufMetaFile;
export const verifyRootContract = verifyTufRootContract;
export const verifyDelegationContract = verifyTufDelegationContract;
