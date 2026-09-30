import { randomUUID } from "node:crypto";

import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
} from "../MarketplaceFormats.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { atomicReplaceDurable, ensureDirectory, lstatOrNull, readRegularBytes, writeExclusiveDurable } from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

const KIND = "cev-sim.marketplace-publication-bindings";
const VERSION = 1;

function emptyDocument() {
    return { kind: KIND, version: VERSION, revision: 0, bindings: [] };
}

function invalid(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message);
}

function validate(document) {
    if (!document || document.kind !== KIND || document.version !== VERSION
        || !Number.isSafeInteger(document.revision) || document.revision < 0 || !Array.isArray(document.bindings)) invalid("Marketplace publication bindings are invalid.");
    const ids = new Set();
    const keys = new Set();
    for (const binding of document.bindings) {
        const expected = ["bindingId", "profileId", "contentKind", "localIdentity", "itemId", "releaseVersion", "artifactSha256", "updatedAt"];
        if (!binding || typeof binding !== "object" || Array.isArray(binding)
            || expected.some((key) => !Object.hasOwn(binding, key)) || Object.keys(binding).some((key) => !expected.includes(key))) invalid("Marketplace publication binding shape is invalid.");
        assertCanonicalUuid(binding.bindingId, "bindingId");
        assertCanonicalUuid(binding.profileId, "profileId");
        if (!new Set(["plugin", "vehicle", "run-template", "environment", "asset-pack", "collection"]).has(binding.contentKind)) invalid("Marketplace publication binding content kind is invalid.");
        if (typeof binding.localIdentity !== "string" || !binding.localIdentity || binding.localIdentity.length > 1024) invalid("Marketplace publication local identity is invalid.");
        assertMarketplaceId(binding.itemId, "itemId");
        assertReleaseVersion(binding.releaseVersion, "releaseVersion");
        assertSha256(binding.artifactSha256, "artifactSha256");
        assertCanonicalTimestamp(binding.updatedAt, "updatedAt");
        const key = `${binding.profileId}\u0000${binding.contentKind}\u0000${binding.localIdentity}`;
        if (ids.has(binding.bindingId) || keys.has(key)) invalid("Marketplace publication bindings contain duplicates.");
        ids.add(binding.bindingId);
        keys.add(key);
    }
    return document;
}

export function publicationLocalIdentity(contentKind, localSelection, { pluginId = null, projectId = null } = {}) {
    if (contentKind === "plugin") return `plugin:${pluginId ?? "unknown"}`;
    if (contentKind === "vehicle") return `vehicle:${localSelection.vehicleId}`;
    if (contentKind === "run-template") return `run-template:${localSelection.manifestId}`;
    if (contentKind === "environment") return `environment:${localSelection.environmentId}`;
    if (contentKind === "asset-pack" && localSelection.roots.length === 1) return `asset-pack:${localSelection.roots[0].assetId}`;
    if (contentKind === "asset-pack") return `asset-pack-project:${localSelection.publicationProjectId ?? projectId ?? localSelection.roots.map((root) => root.assetId).sort().join("+")}`;
    return `collection:${localSelection.publicationProjectId ?? projectId ?? "default"}`;
}

export class MarketplacePublicationBindingStore {
    #queue = Promise.resolve();

    constructor(paths, document, now) {
        this.paths = paths;
        this.document = document;
        this.now = now;
    }

    static async open(dataDir, { now = () => new Date() } = {}) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publisher);
        const existing = await lstatOrNull(paths.publicationBindings);
        if (!existing) await writeExclusiveDurable(paths.publicationBindings, canonicalMarketplaceBytes(emptyDocument()));
        else if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) {
            invalid("Marketplace publication bindings must be an owner-only regular file.");
        }
        const store = new MarketplacePublicationBindingStore(paths, emptyDocument(), now);
        store.document = await store.#read();
        return store;
    }

    async #read() {
        const bytes = await readRegularBytes(this.paths.publicationBindings, { maxBytes: 8 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        validate(document);
        if (!Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) invalid("Marketplace publication bindings are not canonical.");
        return document;
    }

    snapshot() { return structuredClone(this.document); }

    get(profileId, contentKind, localIdentity) {
        const value = this.document.bindings.find((entry) => entry.profileId === profileId && entry.contentKind === contentKind && entry.localIdentity === localIdentity);
        return value ? structuredClone(value) : null;
    }

    findAny(contentKind, localIdentity) {
        const value = this.document.bindings.find((entry) => entry.contentKind === contentKind && entry.localIdentity === localIdentity);
        return value ? structuredClone(value) : null;
    }

    upsert(input) {
        const request = this.#queue.catch(() => {}).then(async () => {
            const current = await this.#read();
            const next = structuredClone(current);
            const index = next.bindings.findIndex((entry) => entry.profileId === input.profileId && entry.contentKind === input.contentKind && entry.localIdentity === input.localIdentity);
            if (index >= 0) {
                const existing = next.bindings[index];
                if (existing.itemId === input.itemId
                    && existing.releaseVersion === input.releaseVersion
                    && existing.artifactSha256 === input.artifactSha256) {
                    this.document = current;
                    return structuredClone(existing);
                }
            }
            const binding = {
                bindingId: index >= 0 ? next.bindings[index].bindingId : randomUUID(),
                ...structuredClone(input),
                updatedAt: this.now().toISOString(),
            };
            if (index >= 0) next.bindings[index] = binding; else next.bindings.push(binding);
            next.bindings.sort((left, right) => `${left.profileId}:${left.contentKind}:${left.localIdentity}`.localeCompare(`${right.profileId}:${right.contentKind}:${right.localIdentity}`));
            next.revision += 1;
            validate(next);
            await atomicReplaceDurable(this.paths.publicationBindings, canonicalMarketplaceBytes(next));
            this.document = next;
            return structuredClone(binding);
        });
        this.#queue = request;
        return request;
    }
}

export class MarketplacePublicationBindingReconciler {
    constructor({ bindingStore, draftStore, profileStore, sourceStore, cache, publishJobManager }) {
        this.bindingStore = bindingStore;
        this.draftStore = draftStore;
        this.profileStore = profileStore;
        this.sourceStore = sourceStore;
        this.cache = cache;
        this.publishJobManager = publishJobManager;
    }

    async reconcileSource(sourceId) {
        const source = this.sourceStore.get(sourceId);
        if (!source) return [];
        const current = await this.cache.readCurrent(source).catch(() => null);
        if (!current) return [];
        const profiles = this.profileStore.snapshot().profiles.filter((profile) => profile.sourceId === sourceId);
        const profileIds = new Set(profiles.map((profile) => profile.profileId));
        const reconciled = [];
        for (const draft of this.draftStore.snapshot().drafts) {
            if (draft.state !== "published" || !profileIds.has(draft.profileId)) continue;
            const published = await this.publishJobManager.completedPublicationForDraft(draft.draftId);
            if (!published) continue;
            const release = current.documents.releases.find((entry) => entry.itemId === published.itemId
                && entry.releaseVersion === published.releaseVersion && entry.artifact.sha256 === published.artifactSha256);
            if (!release) continue;
            const localIdentity = publicationLocalIdentity(draft.contentKind, draft.localSelection, {
                pluginId: draft.contentKind === "plugin" ? draft.item.itemId : null,
                projectId: draft.draftId,
            });
            reconciled.push(await this.bindingStore.upsert({
                profileId: draft.profileId,
                contentKind: draft.contentKind,
                localIdentity,
                itemId: release.itemId,
                releaseVersion: release.releaseVersion,
                artifactSha256: release.artifact.sha256,
            }));
        }
        return reconciled;
    }

    async reconcileAll() {
        const values = [];
        for (const source of this.sourceStore.snapshot().sources) values.push(...await this.reconcileSource(source.sourceId));
        return values;
    }
}
