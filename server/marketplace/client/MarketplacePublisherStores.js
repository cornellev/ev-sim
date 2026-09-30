import { createPrivateKey, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { publisherKeyId } from "../PublisherSignatures.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import {
    MARKETPLACE_PUBLICATION_DOCUMENT_VERSION,
    MARKETPLACE_PUBLICATION_DRAFT_KIND,
    MARKETPLACE_PUBLISHER_PROFILE_KIND,
    MARKETPLACE_PUBLISHER_SECRET_KIND,
    assertPublicationDraftsDocument,
    assertPublisherProfilesDocument,
    assertPublisherSecretDocument,
    parsePublicationDocument,
    publicationDocumentBytes,
} from "./MarketplacePublicationDocuments.js";

function conflict(expectedRevision, currentRevision, noun) {
    const error = marketplaceError(
        MARKETPLACE_ERROR_CODES.CONFLICT,
        `${noun} revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`,
    );
    error.currentRevision = currentRevision;
    return error;
}

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

function clone(value) {
    return structuredClone(value);
}

async function readCanonical(filePath, assertion, maxBytes = 8 * 1024 * 1024) {
    const bytes = await readRegularBytes(filePath, { maxBytes });
    const document = parsePublicationDocument(bytes, assertion);
    if (!Buffer.from(bytes).equals(Buffer.from(publicationDocumentBytes(document, assertion)))) {
        throw recovery("Marketplace publisher document is not canonical.", filePath);
    }
    return document;
}

async function initializeDocument(filePath, document, assertion) {
    const existing = await lstatOrNull(filePath);
    if (!existing) {
        try {
            await writeExclusiveDurable(filePath, publicationDocumentBytes(document, assertion));
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    } else if (!existing.isFile() || existing.isSymbolicLink()) {
        throw recovery("Marketplace publisher path is not a regular file.", filePath);
    }
    return readCanonical(filePath, assertion);
}

function publicProfile(profile) {
    const { secretRef: _secretRef, ...value } = profile;
    return Object.freeze({ ...clone(value), secretConfigured: true });
}

export class MarketplacePublisherProfileStore {
    #queue = Promise.resolve();

    constructor(paths, document) {
        this.paths = paths;
        this.document = document;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publisher);
        const document = await initializeDocument(paths.publisherProfiles, {
            kind: MARKETPLACE_PUBLISHER_PROFILE_KIND,
            version: MARKETPLACE_PUBLICATION_DOCUMENT_VERSION,
            revision: 0,
            profiles: [],
        }, assertPublisherProfilesDocument);
        return new MarketplacePublisherProfileStore(paths, document);
    }

    snapshot({ publicOnly = false } = {}) {
        const document = clone(this.document);
        if (publicOnly) document.profiles = document.profiles.map(publicProfile);
        return document;
    }

    get(profileId, { publicOnly = false } = {}) {
        const profile = this.document.profiles.find((entry) => entry.profileId === profileId);
        if (!profile) return null;
        return publicOnly ? publicProfile(profile) : clone(profile);
    }

    add(profile, expectedRevision) {
        return this.#mutate(expectedRevision, (document) => {
            if (document.profiles.some((entry) => entry.profileId === profile.profileId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publisher profile ID already exists.");
            }
            if (document.profiles.some((entry) => entry.sourceId === profile.sourceId && entry.publisherId === profile.publisherId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publisher profile already exists for this source and publisher.");
            }
            document.profiles.push(clone(profile));
            document.profiles.sort((left, right) => left.name.localeCompare(right.name) || left.profileId.localeCompare(right.profileId));
            return profile.profileId;
        });
    }

    update(profileId, patch, expectedRevision) {
        return this.#mutate(expectedRevision, (document) => {
            const index = document.profiles.findIndex((entry) => entry.profileId === profileId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
            document.profiles[index] = { ...document.profiles[index], ...clone(patch), revision: document.profiles[index].revision + 1 };
            document.profiles.sort((left, right) => left.name.localeCompare(right.name) || left.profileId.localeCompare(right.profileId));
            return profileId;
        });
    }

    remove(profileId, expectedRevision) {
        let removed = null;
        return this.#mutate(expectedRevision, (document) => {
            const index = document.profiles.findIndex((entry) => entry.profileId === profileId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
            [removed] = document.profiles.splice(index, 1);
            return null;
        }).then((result) => ({ ...result, removed }));
    }

    #mutate(expectedRevision, transform) {
        const request = this.#queue.catch(() => {}).then(async () => {
            const current = await readCanonical(this.paths.publisherProfiles, assertPublisherProfilesDocument);
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
                throw conflict(expectedRevision, current.revision, "Publisher profile store");
            }
            const next = clone(current);
            const selected = transform(next);
            next.revision += 1;
            const validated = assertPublisherProfilesDocument(next);
            await atomicReplaceDurable(this.paths.publisherProfiles, publicationDocumentBytes(validated, assertPublisherProfilesDocument));
            this.document = validated;
            return { document: this.snapshot({ publicOnly: true }), profile: selected ? this.get(selected, { publicOnly: true }) : null };
        });
        this.#queue = request;
        return request;
    }
}

export class MarketplacePublisherSecretStore {
    constructor(paths) {
        this.paths = paths;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publisherSecrets);
        return new MarketplacePublisherSecretStore(paths);
    }

    #path(secretRef) {
        if (!/^[a-f0-9-]{36}$/u.test(secretRef)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publisher secret reference is invalid.");
        return path.join(this.paths.publisherSecrets, `${secretRef}.json`);
    }

    async stage({ writeToken, privateKeyPem }) {
        const document = assertPublisherSecretDocument({
            kind: MARKETPLACE_PUBLISHER_SECRET_KIND,
            version: MARKETPLACE_PUBLICATION_DOCUMENT_VERSION,
            writeToken,
            privateKeyPem,
        });
        let privateKey;
        try { privateKey = createPrivateKey(privateKeyPem); } catch (error) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, "Publisher private key is invalid.", { cause: error });
        }
        if (privateKey.asymmetricKeyType !== "ed25519") {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, "Publisher private key must be Ed25519.");
        }
        const secretRef = randomUUID();
        await writeExclusiveDurable(this.#path(secretRef), publicationDocumentBytes(document, assertPublisherSecretDocument));
        return Object.freeze({ secretRef, keyId: publisherKeyId(privateKey) });
    }

    async read(secretRef) {
        const filePath = this.#path(secretRef);
        const stat = await lstatOrNull(filePath);
        if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
            throw recovery("Publisher secret must be an owner-only regular file.", filePath);
        }
        return readCanonical(filePath, assertPublisherSecretDocument, 96 * 1024);
    }

    async remove(secretRef) {
        const filePath = this.#path(secretRef);
        const stat = await lstatOrNull(filePath);
        if (!stat) return false;
        if (!stat.isFile() || stat.isSymbolicLink()) throw recovery("Publisher secret path is not a regular file.", filePath);
        await fs.rm(filePath);
        return true;
    }

    async recover(referencedRefs) {
        const referenced = new Set(referencedRefs);
        for (const secretRef of referenced) await this.read(secretRef);
        for (const entry of await fs.readdir(this.paths.publisherSecrets, { withFileTypes: true })) {
            const filePath = path.join(this.paths.publisherSecrets, entry.name);
            if (!entry.isFile() || entry.isSymbolicLink()) throw recovery("Publisher secret directory contains a hostile node.", filePath);
            const match = /^([a-f0-9-]{36})\.json$/u.exec(entry.name);
            if (!match) throw recovery("Publisher secret directory contains an unexpected filename.", filePath);
            if (!referenced.has(match[1])) await fs.rm(filePath);
        }
    }
}

function assertNoDraftCycles(document) {
    const drafts = new Map(document.drafts.map((entry) => [entry.draftId, entry]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (draftId) => {
        if (visited.has(draftId)) return;
        if (visiting.has(draftId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publication draft dependency cycle detected.", { path: "members" });
        const draft = drafts.get(draftId);
        if (!draft) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Referenced publication draft ${draftId} was not found.`, { path: "members" });
        visiting.add(draftId);
        const targets = [
            ...draft.members.filter((entry) => entry.target.type === "draft").map((entry) => entry.target.draftId),
            ...(draft.localSelection.kind === "run-template"
                ? draft.localSelection.pluginBindings.filter((entry) => entry.target.type === "draft").map((entry) => entry.target.draftId)
                : []),
        ];
        targets.forEach((targetId) => {
            const target = drafts.get(targetId);
            if (target && target.profileId !== draft.profileId) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publication draft dependencies must use the same publisher profile and registry.", { path: "members" });
            }
            visit(targetId);
        });
        visiting.delete(draftId);
        visited.add(draftId);
    };
    document.drafts.forEach((entry) => visit(entry.draftId));
}

export class MarketplacePublicationDraftStore {
    #queue = Promise.resolve();

    constructor(paths, document) {
        this.paths = paths;
        this.document = document;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publisher);
        await ensureDirectory(paths.publicationPreviews);
        const document = await initializeDocument(paths.publicationDrafts, {
            kind: MARKETPLACE_PUBLICATION_DRAFT_KIND,
            version: MARKETPLACE_PUBLICATION_DOCUMENT_VERSION,
            revision: 0,
            drafts: [],
        }, assertPublicationDraftsDocument);
        assertNoDraftCycles(document);
        return new MarketplacePublicationDraftStore(paths, document);
    }

    snapshot() { return clone(this.document); }

    get(draftId) {
        const draft = this.document.drafts.find((entry) => entry.draftId === draftId);
        return draft ? clone(draft) : null;
    }

    add(draft, expectedRevision) {
        return this.#mutateStore(expectedRevision, (document) => {
            if (document.drafts.some((entry) => entry.draftId === draft.draftId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publication draft ID already exists.");
            }
            document.drafts.push(clone(draft));
            return draft.draftId;
        });
    }

    update(draftId, patch, expectedRevision) {
        return this.#mutateDraft(draftId, expectedRevision, (draft) => ({ ...draft, ...clone(patch) }));
    }

    async attachPreview(draftId, descriptor, expectedRevision) {
        return this.#mutateDraft(draftId, expectedRevision, (draft) => ({
            ...draft,
            item: {
                ...draft.item,
                previews: [...draft.item.previews.filter((entry) => entry.sha256 !== descriptor.sha256), clone(descriptor)],
            },
        }));
    }

    async removePreview(draftId, digest, expectedRevision) {
        return this.#mutateDraft(draftId, expectedRevision, (draft) => ({
            ...draft,
            item: { ...draft.item, previews: draft.item.previews.filter((entry) => entry.sha256 !== digest) },
        }));
    }

    remove(draftId, expectedRevision) {
        return this.#mutateStore(expectedRevision, (document) => {
            if (document.drafts.some((entry) => entry.members.some((member) => member.target.type === "draft" && member.target.draftId === draftId)
                || (entry.localSelection.kind === "run-template" && entry.localSelection.pluginBindings.some((binding) => binding.target.type === "draft" && binding.target.draftId === draftId)))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publication draft is referenced by another draft.");
            }
            const index = document.drafts.findIndex((entry) => entry.draftId === draftId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication draft was not found.");
            document.drafts.splice(index, 1);
            return null;
        });
    }

    #mutateDraft(draftId, expectedRevision, transform) {
        const request = this.#queue.catch(() => {}).then(async () => {
            const current = await readCanonical(this.paths.publicationDrafts, assertPublicationDraftsDocument);
            const index = current.drafts.findIndex((entry) => entry.draftId === draftId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication draft was not found.");
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.drafts[index].revision) {
                throw conflict(expectedRevision, current.drafts[index].revision, "Publication draft");
            }
            const timestamp = new Date().toISOString();
            const next = clone(current);
            next.drafts[index] = {
                ...transform(next.drafts[index]),
                revision: next.drafts[index].revision + 1,
                updatedAt: timestamp,
            };
            next.revision += 1;
            const validated = assertPublicationDraftsDocument(next);
            assertNoDraftCycles(validated);
            await atomicReplaceDurable(this.paths.publicationDrafts, publicationDocumentBytes(validated, assertPublicationDraftsDocument));
            this.document = validated;
            return { document: this.snapshot(), draft: this.get(draftId) };
        });
        this.#queue = request;
        return request;
    }

    #mutateStore(expectedRevision, transform) {
        const request = this.#queue.catch(() => {}).then(async () => {
            const current = await readCanonical(this.paths.publicationDrafts, assertPublicationDraftsDocument);
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
                throw conflict(expectedRevision, current.revision, "Publication draft store");
            }
            const next = clone(current);
            const selected = transform(next);
            next.revision += 1;
            const validated = assertPublicationDraftsDocument(next);
            assertNoDraftCycles(validated);
            await atomicReplaceDurable(this.paths.publicationDrafts, publicationDocumentBytes(validated, assertPublicationDraftsDocument));
            this.document = validated;
            return { document: this.snapshot(), draft: selected ? this.get(selected) : null };
        });
        this.#queue = request;
        return request;
    }
}

export function createPublisherProfile({ source, name, publisherId, keyId, secretRef, now = new Date() }) {
    const timestamp = now.toISOString();
    return Object.freeze({
        profileId: randomUUID(),
        sourceId: source.sourceId,
        registryId: source.registryId,
        name,
        publisherId,
        keyId,
        secretRef,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
    });
}

export function createPublicationDraft({ profileId, contentKind, localSelection, item, release, members = [], mode = "create-item", now = new Date() }) {
    const timestamp = now.toISOString();
    return Object.freeze({
        draftId: randomUUID(),
        revision: 0,
        profileId,
        mode,
        contentKind,
        localSelection: clone(localSelection),
        item: clone(item),
        release: clone(release),
        members: clone(members),
        state: contentKind === "collection" && members.length === 0 ? "incomplete" : "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
    });
}
