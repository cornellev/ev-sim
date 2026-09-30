import { createPrivateKey } from "node:crypto";

import { publisherKeyId } from "../PublisherSignatures.js";
import { createPublisherProfile } from "./MarketplacePublisherStores.js";

function publicIdentity(connection, identity, source, profile, status, reason = null) {
    return Object.freeze({
        name: identity.name,
        publisherId: identity.publisherId,
        sourceId: source?.sourceId ?? null,
        sourceName: connection.displayName,
        profileId: profile?.profileId ?? null,
        default: identity.default,
        defaults: identity.defaults,
        status,
        reason,
    });
}

export class MarketplacePublishingIdentityManager {
    constructor({ connectionPolicy, sourceStore, cache, policyStore, profileStore, secretStore, now = () => new Date() }) {
        this.connectionPolicy = connectionPolicy;
        this.sourceStore = sourceStore;
        this.cache = cache;
        this.policyStore = policyStore;
        this.profileStore = profileStore;
        this.secretStore = secretStore;
        this.now = now;
    }

    async reconcileAll() {
        for (const source of this.sourceStore.snapshot().sources) await this.reconcileSource(source.sourceId);
        return this.readiness();
    }

    async reconcileSource(sourceId) {
        const source = this.sourceStore.get(sourceId);
        if (!source) return [];
        const connection = this.connectionPolicy.find(source.baseUrl);
        if (!connection) return [];
        let current;
        try { current = await this.cache.readCurrent(source, { requireFresh: true }); }
        catch { return this.#connectionReadiness(connection, source, null); }
        if (!current) return this.#connectionReadiness(connection, source, null);

        const publishers = new Map(current.documents.publishers.map((publisher) => [publisher.publisherId, publisher]));
        const policy = await this.policyStore.snapshot();
        const registryPolicy = policy.registries.find((entry) => entry.registryId === source.registryId);
        for (const publisherId of connection.autoApprovePublisherIds) {
            if (publishers.has(publisherId) && !registryPolicy?.approvedPublishers?.includes(publisherId)) {
                await this.policyStore.setPublisherApproval(source.registryId, publisherId, true);
            }
        }

        for (const identity of connection.identities) {
            const keyId = publisherKeyId(createPrivateKey(identity.privateKeyPem));
            const publisher = publishers.get(identity.publisherId);
            const key = publisher?.keys.find((entry) => entry.keyId === keyId);
            if (!publisher || key?.status !== "active") continue;
            const profiles = this.profileStore.snapshot();
            const existing = profiles.profiles.find((profile) => profile.sourceId === sourceId && profile.publisherId === identity.publisherId);
            if (!existing) {
                const staged = await this.secretStore.stage(identity);
                try {
                    await this.profileStore.add(createPublisherProfile({
                        source,
                        name: identity.name,
                        publisherId: identity.publisherId,
                        keyId: staged.keyId,
                        secretRef: staged.secretRef,
                        now: this.now(),
                    }), profiles.revision);
                } catch (error) {
                    await this.secretStore.remove(staged.secretRef).catch(() => {});
                    throw error;
                }
                continue;
            }
            const secret = await this.secretStore.read(existing.secretRef);
            const secretChanged = secret.writeToken !== identity.writeToken || secret.privateKeyPem !== identity.privateKeyPem;
            const metadataChanged = existing.name !== identity.name || existing.keyId !== keyId;
            if (!secretChanged && !metadataChanged) continue;
            let staged = null;
            try {
                if (secretChanged) staged = await this.secretStore.stage(identity);
                await this.profileStore.update(existing.profileId, {
                    name: identity.name,
                    keyId,
                    ...(staged ? { secretRef: staged.secretRef } : {}),
                    updatedAt: this.now().toISOString(),
                }, this.profileStore.snapshot().revision);
            } catch (error) {
                if (staged) await this.secretStore.remove(staged.secretRef).catch(() => {});
                throw error;
            }
            // The profile already points at the new secret. A failed cleanup must
            // leave that referenced secret intact; startup recovery will remove
            // the now-unreferenced previous file.
            if (staged) await this.secretStore.remove(existing.secretRef).catch(() => {});
        }
        return this.#connectionReadiness(connection, source, current);
    }

    async #connectionReadiness(connection, source, current) {
        const profiles = this.profileStore.snapshot({ publicOnly: true }).profiles;
        return connection.identities.map((identity) => {
            const profile = profiles.find((entry) => entry.sourceId === source?.sourceId && entry.publisherId === identity.publisherId);
            if (!source) return publicIdentity(connection, identity, null, null, "blocked", "Source is not connected.");
            if (!current) return publicIdentity(connection, identity, source, profile, "blocked", "Source needs a successful verified refresh.");
            const publisher = current.documents.publishers.find((entry) => entry.publisherId === identity.publisherId);
            if (!publisher) return publicIdentity(connection, identity, source, profile, "blocked", "Publisher is not registered in the verified catalog.");
            const keyId = publisherKeyId(createPrivateKey(identity.privateKeyPem));
            const key = publisher.keys.find((entry) => entry.keyId === keyId);
            if (!key || key.status !== "active") return publicIdentity(connection, identity, source, profile, "blocked", "Configured signing key is not active.");
            if (!profile) return publicIdentity(connection, identity, source, null, "blocked", "Publishing identity could not be materialized.");
            return publicIdentity(connection, identity, source, profile, "ready");
        });
    }

    async readiness() {
        const result = [];
        for (const connection of this.connectionPolicy.list()) {
            const source = this.sourceStore.snapshot().sources.find((entry) => entry.baseUrl === connection.origin) ?? null;
            let current = null;
            if (source) {
                try { current = await this.cache.readCurrent(source, { requireFresh: true }); } catch { /* readiness reports the blocker */ }
            }
            result.push(...await this.#connectionReadiness(this.connectionPolicy.find(connection.origin), source, current));
        }
        const ready = result.filter((entry) => entry.status === "ready");
        const selectedDefault = ready.find((entry) => entry.default) ?? (ready.length === 1 ? ready[0] : null);
        return Object.freeze({
            identities: Object.freeze(result),
            defaultProfileId: selectedDefault?.profileId ?? null,
            ready: ready.length > 0,
        });
    }
}
