import semver from "semver";

import { effectivePluginLocks } from "../../../app/plugin/PluginSelection.js";
import { normalizeRunManifest } from "../../../app/simulation/RunManifest.js";

function releaseTarget(release) {
    return Object.freeze({
        type: "release",
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
    });
}

export class MarketplacePublicationDependencyResolver {
    constructor({ profileStore, sourceStore, cache, draftStore, storageService }) {
        this.profileStore = profileStore;
        this.sourceStore = sourceStore;
        this.cache = cache;
        this.draftStore = draftStore;
        this.storageService = storageService;
    }

    async #snapshot(profileId) {
        const profile = this.profileStore.get(profileId);
        if (!profile) return null;
        const source = this.sourceStore.get(profile.sourceId);
        if (!source?.enabled) return null;
        const current = await this.cache.readCurrent(source).catch(() => null);
        return current ? { profile, source, current } : null;
    }

    async releaseOptions({ q = "", profileId = null, contentKind = null } = {}) {
        const query = String(q).trim().toLowerCase().slice(0, 256);
        const profiles = this.profileStore.snapshot().profiles.filter((profile) => !profileId || profile.profileId === profileId);
        const options = [];
        for (const profile of profiles) {
            const snapshot = await this.#snapshot(profile.profileId);
            if (!snapshot) continue;
            const items = new Map(snapshot.current.documents.items.map((item) => [item.itemId, item]));
            for (const release of snapshot.current.documents.releases) {
                const item = items.get(release.itemId);
                if (!item || (contentKind && item.contentKind !== contentKind)) continue;
                const search = `${item.displayName} ${item.itemId} ${release.releaseVersion}`.toLowerCase();
                if (query && !search.includes(query)) continue;
                options.push(Object.freeze({
                    optionId: `${snapshot.source.sourceId}:${release.itemId}:${release.releaseVersion}:${release.artifact.sha256}`,
                    sourceId: snapshot.source.sourceId,
                    profileId: profile.profileId,
                    contentKind: item.contentKind,
                    displayName: item.displayName,
                    releaseVersion: release.releaseVersion,
                    target: releaseTarget(release),
                    ...(release.contentKind === "plugin" && release.executable ? {
                        plugin: Object.freeze({
                            pluginId: release.executable.pluginId,
                            packageHash: release.executable.packageHash,
                        }),
                    } : {}),
                }));
            }
        }
        options.sort((left, right) => left.displayName.localeCompare(right.displayName)
            || semver.rcompare(left.releaseVersion, right.releaseVersion));
        return Object.freeze({ options: Object.freeze(options.slice(0, 200)) });
    }

    async resolveRunTemplate(profileId, localSelection) {
        const snapshot = await this.#snapshot(profileId);
        if (!snapshot) return Object.freeze({ localSelection, dependencies: Object.freeze([]) });
        const stored = await this.storageService.getRunManifest(localSelection.manifestId);
        if (!stored) return Object.freeze({ localSelection, dependencies: Object.freeze([]) });
        const manifest = normalizeRunManifest(stored);
        const existing = new Map(localSelection.pluginBindings.map((binding) => [binding.packageHash, binding]));
        const drafts = this.draftStore.snapshot().drafts.filter((draft) => draft.profileId === profileId && draft.contentKind === "plugin");
        const dependencies = [];
        for (const lock of effectivePluginLocks(manifest.plugins)) {
            const packageHash = lock.expectedHash;
            if (existing.has(packageHash)) {
                dependencies.push(Object.freeze({ pluginId: lock.pluginId, packageHash, status: "resolved" }));
                continue;
            }
            const local = drafts.filter((draft) => draft.localSelection.packageHash === packageHash);
            const verified = snapshot.current.documents.releases.filter((release) => release.contentKind === "plugin"
                && release.executable?.packageHash === packageHash);
            if (local.length === 1) {
                const binding = Object.freeze({ packageHash, target: Object.freeze({ type: "draft", draftId: local[0].draftId }) });
                existing.set(packageHash, binding);
                dependencies.push(Object.freeze({ pluginId: lock.pluginId, packageHash, status: "resolved-local" }));
            } else if (local.length === 0 && verified.length === 1) {
                const binding = Object.freeze({ packageHash, target: releaseTarget(verified[0]) });
                existing.set(packageHash, binding);
                dependencies.push(Object.freeze({ pluginId: lock.pluginId, packageHash, status: "resolved-release" }));
            } else {
                dependencies.push(Object.freeze({
                    pluginId: lock.pluginId,
                    packageHash,
                    status: local.length + verified.length === 0 ? "missing" : "ambiguous",
                }));
            }
        }
        return Object.freeze({
            localSelection: Object.freeze({ ...localSelection, pluginBindings: Object.freeze([...existing.values()]) }),
            dependencies: Object.freeze(dependencies),
        });
    }
}
