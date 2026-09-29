import { isDeepStrictEqual } from "node:util";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import {
    assertCanonicalUuid,
    assertMarketplaceId,
    assertPlainMarketplaceTree,
    assertReleaseVersion,
    assertSha256,
} from "../MarketplaceFormats.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

export const MARKETPLACE_INSTALL_OWNERSHIP_KIND = "cev-sim.marketplace-install-ownership";
const MAX_OWNERSHIP_BYTES = 16 * 1024 * 1024;

function invalid(path, message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${path}: ${message}`, { path });
}

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function exactKeys(value, required, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected an object");
    const expected = new Set(required);
    for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, "is required");
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${path}.${key}`, "is not allowed");
}

function exactReleaseKey(release) {
    return `${release.itemId}\u0000${release.releaseVersion}\u0000${release.artifactSha256}`;
}

function membershipKey(entry) {
    return `${entry.sourceId}\u0000${exactReleaseKey(entry.release)}`;
}

function collectionKey(entry) {
    return membershipKey(entry);
}

function ownerKey(owner) {
    return owner.kind === "direct" ? "0\u0000direct" : `1\u0000${exactReleaseKey(owner.collection)}`;
}

function assertExactRelease(release, path) {
    exactKeys(release, ["itemId", "releaseVersion", "artifactSha256"], path);
    assertMarketplaceId(release.itemId, `${path}.itemId`);
    assertReleaseVersion(release.releaseVersion, `${path}.releaseVersion`);
    assertSha256(release.artifactSha256, `${path}.artifactSha256`);
}

function sortOwners(owners) {
    return [...owners].sort((left, right) => compareUtf8(ownerKey(left), ownerKey(right)));
}

function sortMemberships(memberships) {
    return [...memberships].sort((left, right) => compareUtf8(membershipKey(left), membershipKey(right)));
}

function sortCollections(collections) {
    return [...collections].sort((left, right) => compareUtf8(collectionKey(left), collectionKey(right)));
}

function normalizedDocument(value) {
    return {
        kind: MARKETPLACE_INSTALL_OWNERSHIP_KIND,
        version: 1,
        revision: value.revision,
        memberships: sortMemberships(value.memberships).map((entry) => ({
            ...structuredClone(entry),
            owners: sortOwners(entry.owners),
        })),
        collections: sortCollections(value.collections).map((entry) => ({
            ...structuredClone(entry),
            members: [...entry.members].sort((left, right) => compareUtf8(
                exactReleaseKey(left.release), exactReleaseKey(right.release),
            )),
        })),
    };
}

export function assertInstallOwnership(value) {
    assertPlainMarketplaceTree(value);
    exactKeys(value, ["kind", "version", "revision", "memberships", "collections"], "$ownership");
    if (value.kind !== MARKETPLACE_INSTALL_OWNERSHIP_KIND || value.version !== 1) invalid("$ownership.kind", "unsupported ownership document");
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) invalid("$ownership.revision", "expected a non-negative safe integer");
    if (!Array.isArray(value.memberships) || !Array.isArray(value.collections)) invalid("$ownership", "expected membership and collection arrays");
    const membershipKeys = new Set();
    value.memberships.forEach((entry, index) => {
        const path = `$ownership.memberships.${index}`;
        exactKeys(entry, ["sourceId", "registryId", "release", "owners"], path);
        assertCanonicalUuid(entry.sourceId, `${path}.sourceId`);
        assertCanonicalUuid(entry.registryId, `${path}.registryId`);
        assertExactRelease(entry.release, `${path}.release`);
        if (!Array.isArray(entry.owners) || entry.owners.length < 1) invalid(`${path}.owners`, "expected at least one owner");
        const owners = new Set();
        entry.owners.forEach((owner, ownerIndex) => {
            const ownerPath = `${path}.owners.${ownerIndex}`;
            if (owner?.kind === "direct") exactKeys(owner, ["kind"], ownerPath);
            else if (owner?.kind === "collection") {
                exactKeys(owner, ["kind", "collection"], ownerPath);
                assertExactRelease(owner.collection, `${ownerPath}.collection`);
            } else invalid(`${ownerPath}.kind`, "expected direct or collection");
            if (owners.has(ownerKey(owner))) invalid(ownerPath, "duplicate owner");
            owners.add(ownerKey(owner));
        });
        if (membershipKeys.has(membershipKey(entry))) invalid(path, "duplicate membership");
        membershipKeys.add(membershipKey(entry));
    });
    const collectionKeys = new Set();
    value.collections.forEach((entry, index) => {
        const path = `$ownership.collections.${index}`;
        exactKeys(entry, ["sourceId", "registryId", "release", "members"], path);
        assertCanonicalUuid(entry.sourceId, `${path}.sourceId`);
        assertCanonicalUuid(entry.registryId, `${path}.registryId`);
        assertExactRelease(entry.release, `${path}.release`);
        if (!Array.isArray(entry.members)) invalid(`${path}.members`, "expected an array");
        const members = new Set();
        entry.members.forEach((member, memberIndex) => {
            const memberPath = `${path}.members.${memberIndex}`;
            exactKeys(member, ["release", "group"], memberPath);
            assertExactRelease(member.release, `${memberPath}.release`);
            if (member.group !== null && (typeof member.group !== "string" || !member.group || member.group.length > 256)) {
                invalid(`${memberPath}.group`, "expected null or bounded text");
            }
            const memberKey = exactReleaseKey(member.release);
            if (members.has(memberKey)) invalid(memberPath, "duplicate member");
            members.add(memberKey);
        });
        if (collectionKeys.has(collectionKey(entry))) invalid(path, "duplicate collection");
        collectionKeys.add(collectionKey(entry));
    });
    const collectionsByKey = new Map(value.collections.map((entry) => [collectionKey(entry), entry]));
    for (const collection of value.collections) {
        const collectionMembership = value.memberships.find((entry) => membershipKey(entry) === collectionKey(collection));
        if (!collectionMembership || collectionMembership.registryId !== collection.registryId) {
            invalid("$ownership.collections", "collection record has no matching membership");
        }
        for (const member of collection.members) {
            const owned = value.memberships.find((entry) => membershipKey(entry) === `${collection.sourceId}\u0000${exactReleaseKey(member.release)}`);
            if (!owned?.owners.some((owner) => owner.kind === "collection"
                && exactReleaseKey(owner.collection) === exactReleaseKey(collection.release))) {
                invalid("$ownership.collections", "collection member has no matching ownership edge");
            }
        }
    }
    for (const membership of value.memberships) {
        for (const owner of membership.owners) {
            if (owner.kind === "collection" && !collectionsByKey.has(`${membership.sourceId}\u0000${exactReleaseKey(owner.collection)}`)) {
                invalid("$ownership.memberships", "collection owner has no matching collection record");
            }
        }
    }
    const normalized = normalizedDocument(value);
    if (!isDeepStrictEqual(normalized, value)) invalid("$ownership", "document is not canonically ordered");
    return Object.freeze(structuredClone(value));
}

export function installOwnershipBytes(value) {
    return canonicalMarketplaceBytes(assertInstallOwnership(value));
}

export function installOwnershipHash(value) {
    return hashMarketplaceBytes(installOwnershipBytes(value));
}

function createMigration(installed) {
    return assertInstallOwnership(normalizedDocument({
        revision: installed.revision,
        memberships: installed.installations.map((entry) => ({
            sourceId: entry.sourceId,
            registryId: entry.registryId,
            release: structuredClone(entry.release),
            owners: [{ kind: "direct" }],
        })),
        collections: [],
    }));
}

export class MarketplaceInstallOwnershipStore {
    constructor(paths) {
        this.paths = paths;
        this.queue = Promise.resolve();
    }

    static async open(dataDir, installedSnapshot, { allowPending = false } = {}) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        if (!await lstatOrNull(paths.ownership)) {
            try {
                await writeExclusiveDurable(paths.ownership, installOwnershipBytes(createMigration(installedSnapshot)));
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        const store = new MarketplaceInstallOwnershipStore(paths);
        const snapshot = await store.snapshot();
        if (!allowPending) store.verifyAgainstInstalled(snapshot, installedSnapshot);
        return store;
    }

    async snapshot() {
        const bytes = await readRegularBytes(this.paths.ownership, { maxBytes: MAX_OWNERSHIP_BYTES });
        const { document } = parseMarketplaceJsonBytes(bytes);
        const ownership = assertInstallOwnership(document);
        if (!Buffer.from(bytes).equals(Buffer.from(installOwnershipBytes(ownership)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace ownership ledger is not canonical.");
        }
        return ownership;
    }

    verifyAgainstInstalled(ownership, installed) {
        const checked = assertInstallOwnership(ownership);
        if (checked.revision !== installed.revision) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace ownership and installed revisions differ.");
        const installedByKey = new Map(installed.installations.map((entry) => [membershipKey(entry), entry]));
        if (installedByKey.size !== checked.memberships.length) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace ownership does not cover the installed ledger.");
        for (const membership of checked.memberships) {
            const installedEntry = installedByKey.get(membershipKey(membership));
            if (!installedEntry || installedEntry.registryId !== membership.registryId) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace ownership membership does not match an installed entry.");
            }
        }
        const collections = new Map(checked.collections.map((entry) => [collectionKey(entry), entry]));
        for (const collection of checked.collections) {
            if (!installedByKey.has(collectionKey(collection))) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace collection ownership has no installed membership.");
        }
        for (const membership of checked.memberships) {
            for (const owner of membership.owners) {
                if (owner.kind === "collection" && !collections.has(`${membership.sourceId}\u0000${exactReleaseKey(owner.collection)}`)) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace collection owner has no collection record.");
                }
            }
        }
        return checked;
    }

    prepareInstall(base, { memberships = [], collections = [], targetRevision = null } = {}) {
        const checked = assertInstallOwnership(base);
        const byKey = new Map(checked.memberships.map((entry) => [membershipKey(entry), structuredClone(entry)]));
        const collectionByKey = new Map(checked.collections.map((entry) => [collectionKey(entry), structuredClone(entry)]));
        let changed = false;
        for (const addition of memberships) {
            const key = membershipKey(addition);
            const current = byKey.get(key);
            if (!current) {
                byKey.set(key, structuredClone(addition));
                changed = true;
                continue;
            }
            if (current.registryId !== addition.registryId) throw conflict("Marketplace ownership registry identity changed.");
            const currentOwners = new Map(current.owners.map((owner) => [ownerKey(owner), owner]));
            for (const owner of addition.owners) {
                if (!currentOwners.has(ownerKey(owner))) {
                    current.owners.push(structuredClone(owner));
                    changed = true;
                }
            }
        }
        for (const collection of collections) {
            const key = collectionKey(collection);
            const current = collectionByKey.get(key);
            if (!current) {
                collectionByKey.set(key, structuredClone(collection));
                changed = true;
            } else if (JSON.stringify(normalizedDocument({ revision: 0, memberships: [], collections: [current] }).collections[0])
                !== JSON.stringify(normalizedDocument({ revision: 0, memberships: [], collections: [collection] }).collections[0])) {
                throw conflict("Marketplace collection ownership members changed.");
            }
        }
        const revision = targetRevision ?? checked.revision + (changed ? 1 : 0);
        if (!Number.isSafeInteger(revision) || revision < checked.revision || (changed && revision === checked.revision)) {
            throw conflict("Marketplace ownership target revision is invalid.");
        }
        return assertInstallOwnership(normalizedDocument({
            revision,
            memberships: byKey.values(),
            collections: collectionByKey.values(),
        }));
    }

    prepareRemoval(base, request) {
        const checked = assertInstallOwnership(base);
        if (request.expectedRevision !== checked.revision) throw conflict("Marketplace ownership revision is stale.");
        const targetKey = `${request.sourceId}\u0000${request.itemId}\u0000${request.releaseVersion}\u0000${request.artifactSha256}`;
        const byKey = new Map(checked.memberships.map((entry) => [membershipKey(entry), structuredClone(entry)]));
        const collections = new Map(checked.collections.map((entry) => [collectionKey(entry), structuredClone(entry)]));
        const target = byKey.get(targetKey);
        if (!target) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Installed marketplace release was not found.");
        const directIndex = target.owners.findIndex((owner) => owner.kind === "direct");
        if (directIndex < 0) throw conflict("Marketplace release is retained only by collections and has no direct installation owner.");
        target.owners.splice(directIndex, 1);
        const removedMemberships = [];
        const pending = target.owners.length === 0 ? [targetKey] : [];
        while (pending.length) {
            const removedKey = pending.shift();
            const removed = byKey.get(removedKey);
            if (!removed) continue;
            byKey.delete(removedKey);
            removedMemberships.push(removed);
            const collection = collections.get(removedKey);
            if (!collection) continue;
            collections.delete(removedKey);
            for (const member of collection.members) {
                const memberKey = `${collection.sourceId}\u0000${exactReleaseKey(member.release)}`;
                const membership = byKey.get(memberKey);
                if (!membership) continue;
                membership.owners = membership.owners.filter((owner) => !(owner.kind === "collection"
                    && exactReleaseKey(owner.collection) === exactReleaseKey(collection.release)));
                if (membership.owners.length === 0) pending.push(memberKey);
            }
        }
        return Object.freeze({
            target: assertInstallOwnership(normalizedDocument({
                revision: checked.revision + 1,
                memberships: byKey.values(),
                collections: collections.values(),
            })),
            removedMemberships: Object.freeze(removedMemberships.map((entry) => Object.freeze(entry))),
        });
    }

    prepareLegacyInstalledTarget(base, installedTarget) {
        const checked = assertInstallOwnership(base);
        const current = new Map(checked.memberships.map((entry) => [membershipKey(entry), entry]));
        return assertInstallOwnership(normalizedDocument({
            revision: installedTarget.revision,
            memberships: installedTarget.installations.map((entry) => {
                const existing = current.get(membershipKey(entry));
                return {
                    sourceId: entry.sourceId,
                    registryId: entry.registryId,
                    release: structuredClone(entry.release),
                    owners: existing?.owners.some((owner) => owner.kind === "direct")
                        ? structuredClone(existing.owners)
                        : [{ kind: "direct" }],
                };
            }),
            collections: checked.collections.filter((entry) => installedTarget.installations.some((installed) => (
                membershipKey(installed) === collectionKey(entry)
            ))),
        }));
    }

    async commitTarget({ base, target }) {
        const operation = this.queue.then(async () => {
            const current = await this.snapshot();
            if (installOwnershipHash(current) === installOwnershipHash(target)) return target;
            if (installOwnershipHash(current) !== installOwnershipHash(base)) throw conflict("Marketplace ownership ledger changed during the transaction.");
            await atomicReplaceDurable(this.paths.ownership, installOwnershipBytes(target));
            return target;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    async close() {
        await this.queue;
    }
}
