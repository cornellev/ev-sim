import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";

import { verifyPluginPackage } from "../../../app/plugin/PluginPackage.js";
import { normalizeVehiclePluginLocks } from "../../../app/plugin/PluginSensorAuthoring.js";
import { exportAssetPackage } from "../AssetPackage.js";
import { exportEnvironmentPackage } from "../EnvironmentPackage.js";
import {
    ASSET_PACKAGE_LIMITS,
    ENVIRONMENT_PACKAGE_LIMITS,
    MARKETPLACE_ARTIFACTS,
    MARKETPLACE_KINDS,
    MARKETPLACE_SCHEMA_VERSION,
    RUN_TEMPLATE_PACKAGE_LIMITS,
} from "../MarketplaceContract.js";
import {
    assertMarketplaceCollection,
    assertMarketplaceItem,
    assertMarketplaceRelease,
    marketplaceDocumentBytes,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalTimestamp, assertCanonicalUuid, assertSha256, assertSourceUrl } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { exportRunTemplatePackage } from "../RunTemplatePackage.js";
import {
    ensureDirectory,
    hashRegularFile,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

const PLAN_KIND = "cev-sim.marketplace-publication-plan";
const PLAN_VERSION = 1;

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function descriptorKey(value) {
    return `${value.itemId}\u0000${value.releaseVersion}\u0000${value.artifactSha256 ?? value.artifact?.sha256}`;
}

function ownsItem(publisher, itemId) {
    return publisher.namespaces.some((namespace) => itemId === namespace || itemId.startsWith(`${namespace}.`));
}

function planPath(paths, planHash) {
    return path.join(paths.publicationPlans, `${planHash}.json`);
}

function planArtifactDirectory(paths, planHash) {
    return path.join(paths.publicationPlans, `${planHash}.artifacts`);
}

function defaultCompatibility(contentKind, inspection) {
    const contract = MARKETPLACE_ARTIFACTS[contentKind];
    return {
        cevSim: contentKind === "plugin" ? inspection.identity.engineRange : ">=0.1.0 <0.2.0",
        contracts: [{ kind: contract.kind, versions: [contract.version] }],
        platforms: [],
        architectures: [],
        runtimes: contentKind === "plugin" ? ["browser", "headless"] : [],
        backends: [],
        features: [],
    };
}

function operationId(draftId, kind) {
    return hashMarketplaceBytes(Buffer.from(`${draftId}\u0000${kind}`));
}

function exactObject(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Publication plan ${label} is invalid.`);
    }
}

function assertPublicationPlan(document, expectedHash = null) {
    exactObject(document, ["kind", "version", "createdAt", "rootDraftId", "rootDraftRevision", "source", "profile", "entries", "totalBytes", "planHash"], "document");
    if (document.kind !== PLAN_KIND || document.version !== PLAN_VERSION) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan contract is invalid.");
    assertCanonicalTimestamp(document.createdAt, "createdAt");
    assertCanonicalUuid(document.rootDraftId, "rootDraftId");
    if (!Number.isSafeInteger(document.rootDraftRevision) || document.rootDraftRevision < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan draft revision is invalid.");
    exactObject(document.source, ["sourceId", "registryId", "baseUrl", "trustedRootFingerprint", "snapshotId"], "source");
    assertCanonicalUuid(document.source.sourceId, "sourceId");
    assertCanonicalUuid(document.source.registryId, "registryId");
    assertCanonicalUuid(document.source.snapshotId, "snapshotId");
    assertSourceUrl(document.source.baseUrl);
    assertSha256(document.source.trustedRootFingerprint, "trustedRootFingerprint");
    exactObject(document.profile, ["profileId", "profileRevision", "publisherId", "keyId"], "profile");
    assertCanonicalUuid(document.profile.profileId, "profileId");
    if (!Number.isSafeInteger(document.profile.profileRevision) || document.profile.profileRevision < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan profile revision is invalid.");
    assertSha256(document.profile.keyId, "keyId");
    if (!Array.isArray(document.entries) || document.entries.length < 1 || Object.keys(document.entries).length !== document.entries.length) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan entries are invalid.");
    }
    const draftIds = new Set();
    let totalBytes = 0;
    for (const entry of document.entries) {
        exactObject(entry, ["draftId", "draftRevision", "contentKind", "item", "release", "track", "artifactFile", "operations"], "entry");
        assertCanonicalUuid(entry.draftId, "draftId");
        if (draftIds.has(entry.draftId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan contains a duplicate draft.");
        draftIds.add(entry.draftId);
        if (!Number.isSafeInteger(entry.draftRevision) || entry.draftRevision < 0 || !MARKETPLACE_ARTIFACTS[entry.contentKind]) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan entry identity is invalid.");
        const item = assertMarketplaceItem(entry.item);
        const release = assertMarketplaceRelease(entry.release);
        if (item.itemId !== release.itemId || item.publisherId !== release.publisherId || item.publisherId !== document.profile.publisherId
            || item.contentKind !== entry.contentKind || release.contentKind !== entry.contentKind) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan item and release identity disagree.");
        }
        if (entry.track !== null && !["stable", "beta"].includes(entry.track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan track is invalid.");
        if (entry.artifactFile !== entry.draftId || !Array.isArray(entry.operations)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan artifact reference is invalid.");
        const expectedOperations = [
            { operationId: operationId(entry.draftId, "artifact"), kind: "publish-artifact" },
            ...item.previews.map((preview) => ({ operationId: operationId(entry.draftId, `preview:${preview.sha256}`), kind: "publish-preview", sha256: preview.sha256 })),
            { operationId: operationId(entry.draftId, "item"), kind: "publish-item" },
            { operationId: operationId(entry.draftId, "release"), kind: "publish-release" },
        ];
        if (!Buffer.from(canonicalMarketplaceBytes(entry.operations)).equals(Buffer.from(canonicalMarketplaceBytes(expectedOperations)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan operations are invalid.");
        }
        totalBytes += release.artifact.sizeBytes + item.previews.reduce((sum, preview) => sum + preview.sizeBytes, 0);
    }
    const rootEntry = document.entries.find((entry) => entry.draftId === document.rootDraftId);
    if (!rootEntry || rootEntry.draftRevision !== document.rootDraftRevision || document.totalBytes !== totalBytes) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan totals are invalid.");
    const { planHash, ...core } = document;
    assertSha256(planHash, "planHash");
    if ((expectedHash && planHash !== expectedHash) || hashMarketplaceBytes(canonicalMarketplaceBytes(core)) !== planHash) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan hash is invalid.");
    }
    return Object.freeze(document);
}

async function writeExportedArchive(filePath, exportOperation) {
    await ensureDirectory(path.dirname(filePath));
    const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
    try {
        await exportOperation(output);
    } catch (error) {
        output.destroy();
        await fs.rm(filePath, { force: true }).catch(() => {});
        throw error;
    }
}

export class MarketplacePublicationArtifactBuilder {
    constructor({ storageService, editorAssetStore, visualAssetStore, adapterRegistry }) {
        this.storageService = storageService;
        this.editorAssetStore = editorAssetStore;
        this.visualAssetStore = visualAssetStore;
        this.adapterRegistry = adapterRegistry;
    }

    async build({ draft, outputPath, pluginReleaseRefs = [], collection = null, signal = null }) {
        signal = signal instanceof AbortSignal ? signal : undefined;
        const selection = draft.localSelection;
        await ensureDirectory(path.dirname(outputPath));
        if (draft.contentKind === "plugin") {
            const library = await this.storageService.listPluginLibrary();
            if (library.revision !== selection.libraryRevision) throw conflict("Plugin Library changed after the publication draft was created.");
            const resource = await this.storageService.getPluginPackage(selection.packageHash);
            const verified = verifyPluginPackage(resource);
            if (verified.resource.packageHash !== selection.packageHash) throw conflict("Selected plugin package identity changed.");
            await writeExclusiveDurable(outputPath, canonicalMarketplaceBytes(verified.resource));
        } else if (draft.contentKind === "vehicle") {
            const current = await this.storageService.getVehicleManifest(selection.vehicleId);
            if (!current || current.revision !== selection.expectedRevision || current.definitionHash !== selection.definitionHash) {
                throw conflict("Vehicle changed after the publication draft was created.");
            }
            await writeExclusiveDurable(outputPath, canonicalMarketplaceBytes(await this.storageService.exportVehicleBundle(selection.vehicleId)));
        } else if (draft.contentKind === "run-template") {
            const current = await this.storageService.getRunManifest(selection.manifestId);
            if (!current || current.revision !== selection.expectedRevision || current.definitionHash !== selection.definitionHash) {
                throw conflict("Run configuration changed after the publication draft was created.");
            }
            await writeExportedArchive(outputPath, (output) => exportRunTemplatePackage({
                storageService: this.storageService,
                manifestId: selection.manifestId,
                expectedRevision: selection.expectedRevision,
                pluginReleaseRefs,
                output,
                signal,
            }));
        } else if (draft.contentKind === "environment") {
            const current = await this.storageService.getEnvironment(selection.environmentId);
            if (!current || current.revision !== selection.expectedRevision) throw conflict("Environment changed after the publication draft was created.");
            await writeExportedArchive(outputPath, (output) => exportEnvironmentPackage({
                storageService: this.storageService,
                environmentId: selection.environmentId,
                expectedRevision: selection.expectedRevision,
                output,
                signal,
            }));
        } else if (draft.contentKind === "asset-pack") {
            const current = await this.editorAssetStore.list();
            if (current.catalogRevision !== selection.catalogRevision) throw conflict("Editor asset catalog changed after the publication draft was created.");
            await writeExportedArchive(outputPath, (output) => exportAssetPackage({
                editorAssetStore: this.editorAssetStore,
                visualAssetStore: this.visualAssetStore,
                roots: selection.roots,
                output,
                signal,
            }));
        } else if (draft.contentKind === "collection") {
            await writeExclusiveDurable(outputPath, marketplaceDocumentBytes(assertMarketplaceCollection(collection)));
        } else {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Unsupported publication content kind.");
        }
        const contract = MARKETPLACE_ARTIFACTS[draft.contentKind];
        const identity = await hashRegularFile(outputPath);
        const handle = Object.freeze({ path: outputPath, mediaType: contract.mediaType, ...identity });
        const stagingRoot = `${outputPath}.inspection`;
        await ensureDirectory(stagingRoot);
        const limits = draft.contentKind === "asset-pack"
            ? ASSET_PACKAGE_LIMITS
            : draft.contentKind === "environment"
                ? ENVIRONMENT_PACKAGE_LIMITS
                : draft.contentKind === "run-template" ? RUN_TEMPLATE_PACKAGE_LIMITS : undefined;
        try {
            const inspection = await this.adapterRegistry.inspect(draft.contentKind, handle, { signal, stagingRoot, ...(limits ? { limits } : {}) });
            return Object.freeze({ handle, inspection });
        } finally {
            await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
}

export class MarketplacePublicationPlanner {
    constructor({ paths, sourceStore, profileStore, secretStore, draftStore, cache, artifactBuilder, adapterRegistry, now = () => new Date() }) {
        this.paths = paths;
        this.sourceStore = sourceStore;
        this.profileStore = profileStore;
        this.secretStore = secretStore;
        this.draftStore = draftStore;
        this.cache = cache;
        this.artifactBuilder = artifactBuilder;
        this.adapterRegistry = adapterRegistry;
        this.now = now;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publicationPlans);
        return new MarketplacePublicationPlanner({ paths, ...dependencies });
    }

    async readPlan(planHash) {
        if (!/^[a-f0-9]{64}$/u.test(planHash)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publication plan hash is invalid.");
        const filePath = planPath(this.paths, planHash);
        if (!await lstatOrNull(filePath)) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication plan was not found.");
        const bytes = await readRegularBytes(filePath, { maxBytes: 16 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        if (!Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication plan is invalid.");
        }
        return assertPublicationPlan(document, planHash);
    }

    async createPlan({ draftId, draftRevision }) {
        const rootDraft = this.draftStore.get(draftId);
        if (!rootDraft) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication draft was not found.");
        if (rootDraft.revision !== draftRevision) throw conflict("Publication draft changed before preparation.");
        const profile = this.profileStore.get(rootDraft.profileId);
        if (!profile) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
        const source = this.sourceStore.get(profile.sourceId);
        if (!source || !source.enabled || source.registryId !== profile.registryId) throw conflict("Publisher source is unavailable or changed.");
        const current = await this.cache.readCurrent(source);
        if (!current || !current.fresh) throw marketplaceError(MARKETPLACE_ERROR_CODES.METADATA_EXPIRED, "Publisher source requires a fresh verified snapshot.");
        const publisher = current.documents.publishers.find((entry) => entry.publisherId === profile.publisherId);
        const signingKey = publisher?.keys.find((entry) => entry.keyId === profile.keyId);
        if (!publisher || !signingKey || signingKey.status !== "active") {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, "Publisher profile does not use an active verified registry key.");
        }
        await this.secretStore.read(profile.secretRef);

        const drafts = this.draftStore.snapshot().drafts;
        const draftsById = new Map(drafts.map((entry) => [entry.draftId, entry]));
        const vehicleDraftDependencies = new Map();
        for (const draft of drafts.filter((entry) => entry.profileId === profile.profileId && entry.contentKind === "vehicle")) {
            const manifest = await this.artifactBuilder.storageService.getVehicleManifest(draft.localSelection.vehicleId);
            const dependencies = [];
            for (const lock of normalizeVehiclePluginLocks(manifest?.pluginLocks) ?? []) {
                const existing = current.documents.releases.some((release) => release.contentKind === "plugin"
                    && release.releaseVersion === lock.version && release.executable?.pluginId === lock.pluginId
                    && release.executable?.packageHash === lock.packageHash && release.executable.runtimeHash === lock.runtimeHash);
                if (existing) continue;
                const candidates = drafts.filter((candidate) => candidate.profileId === profile.profileId && candidate.contentKind === "plugin"
                    && candidate.localSelection.packageHash === lock.packageHash);
                if (candidates.length !== 1) {
                    throw conflict(`Embedded vehicle plugin ${lock.pluginId}@${lock.version} requires one exact local plugin draft or registry release.`);
                }
                dependencies.push(candidates[0].draftId);
            }
            vehicleDraftDependencies.set(draft.draftId, dependencies);
        }
        const ordered = [];
        const visiting = new Set();
        const visited = new Set();
        const visit = (id) => {
            if (visited.has(id)) return;
            if (visiting.has(id)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publication draft dependency cycle detected.");
            const draft = draftsById.get(id);
            if (!draft) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Publication dependency draft ${id} was not found.`);
            if (draft.profileId !== profile.profileId) throw conflict("Publication dependencies must use the same publisher profile.");
            visiting.add(id);
            if (draft.contentKind === "collection") {
                draft.members.filter((entry) => entry.target.type === "draft").forEach((entry) => visit(entry.target.draftId));
            }
            if (draft.localSelection.kind === "run-template") {
                draft.localSelection.pluginBindings.filter((entry) => entry.target.type === "draft").forEach((entry) => visit(entry.target.draftId));
            }
            for (const dependencyId of vehicleDraftDependencies.get(draft.draftId) ?? []) visit(dependencyId);
            visiting.delete(id);
            visited.add(id);
            ordered.push(draft);
        };
        visit(draftId);

        const temporary = path.join(this.paths.publisher, `.publication-plan-${randomUUID()}`);
        await ensureDirectory(temporary);
        const preparedByDraft = new Map();
        const existingRelease = (target) => {
            const release = current.documents.releases.find((entry) => entry.itemId === target.itemId
                && entry.releaseVersion === target.releaseVersion && entry.artifact.sha256 === target.artifactSha256);
            if (!release) throw conflict(`Exact marketplace release ${target.itemId}@${target.releaseVersion} is not present in the verified target snapshot.`);
            return release;
        };
        try {
            for (const draft of ordered) {
                if (!ownsItem(publisher, draft.item.itemId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, `Publisher does not own item namespace ${draft.item.itemId}.`);
                const pluginReleaseRefs = draft.localSelection.kind === "run-template"
                    ? draft.localSelection.pluginBindings.map((binding) => {
                        const release = binding.target.type === "draft"
                            ? preparedByDraft.get(binding.target.draftId)?.release
                            : existingRelease(binding.target);
                        if (!release || release.contentKind !== "plugin") throw conflict(`Plugin binding ${binding.packageHash} does not resolve to a plugin release.`);
                        const packageHash = release.executable?.packageHash;
                        if (packageHash !== binding.packageHash) throw conflict(`Plugin binding ${binding.packageHash} resolves a different package hash.`);
                        return { packageHash: binding.packageHash, itemId: release.itemId, releaseVersion: release.releaseVersion, artifactSha256: release.artifact.sha256 };
                    })
                    : [];
                const members = draft.contentKind === "collection" ? draft.members.map((member) => {
                    const release = member.target.type === "draft"
                        ? preparedByDraft.get(member.target.draftId)?.release
                        : existingRelease(member.target);
                    if (!release) throw conflict("Collection member draft was not prepared.");
                    return {
                        release: { itemId: release.itemId, releaseVersion: release.releaseVersion, artifactSha256: release.artifact.sha256 },
                        ...(member.group ? { group: member.group } : {}),
                    };
                }) : [];
                const collection = draft.contentKind === "collection" ? {
                    kind: MARKETPLACE_KINDS.collection,
                    version: MARKETPLACE_SCHEMA_VERSION,
                    members,
                } : null;
                const outputPath = path.join(temporary, draft.draftId);
                const built = await this.artifactBuilder.build({ draft, outputPath, pluginReleaseRefs, collection });
                const embeddedPlugins = draft.contentKind === "vehicle"
                    ? built.inspection.identity.embeddedPlugins.map((plugin) => {
                        const admitted = [...preparedByDraft.values()].map((entry) => entry.release).find((release) => release.contentKind === "plugin"
                            && release.releaseVersion === plugin.version && release.executable?.pluginId === plugin.pluginId
                            && release.executable?.packageHash === plugin.packageHash && release.executable.runtimeHash === plugin.runtimeHash)
                            ?? current.documents.releases.find((release) => release.contentKind === "plugin"
                            && release.releaseVersion === plugin.version && release.executable?.pluginId === plugin.pluginId
                            && release.executable?.packageHash === plugin.packageHash && release.executable.runtimeHash === plugin.runtimeHash);
                        if (!admitted) throw conflict(`Embedded vehicle plugin ${plugin.pluginId}@${plugin.version} has no exact release in the target registry.`);
                        return {
                            pluginId: plugin.pluginId,
                            packageHash: plugin.packageHash,
                            runtimeHash: plugin.runtimeHash,
                            release: { itemId: admitted.itemId, releaseVersion: admitted.releaseVersion, artifactSha256: admitted.artifact.sha256 },
                        };
                    })
                    : draft.contentKind === "run-template" ? built.inspection.identity.plugins : [];
                const dependencies = draft.contentKind === "collection"
                    ? members.map((entry) => entry.release)
                    : draft.contentKind === "vehicle"
                        ? embeddedPlugins.map((plugin) => plugin.release)
                        : pluginReleaseRefs.map(({ itemId, releaseVersion, artifactSha256 }) => ({ itemId, releaseVersion, artifactSha256 }));
                const derivedCompatibility = defaultCompatibility(draft.contentKind, built.inspection);
                const compatibility = {
                    ...draft.release.compatibility,
                    cevSim: draft.contentKind === "plugin" && draft.release.compatibility.cevSim === ">=0.1.0 <0.2.0"
                        ? derivedCompatibility.cevSim
                        : draft.release.compatibility.cevSim,
                    contracts: draft.release.compatibility.contracts.length
                        ? draft.release.compatibility.contracts
                        : derivedCompatibility.contracts,
                };
                const existingItem = current.documents.items.find((entry) => entry.itemId === draft.item.itemId) ?? null;
                if (draft.mode === "new-release" && !existingItem) throw conflict("Existing marketplace item disappeared before preparation.");
                if (draft.mode === "create-item" && existingItem) throw conflict("Marketplace item already exists; use new-release mode.");
                if (existingItem && (existingItem.publisherId !== profile.publisherId || existingItem.contentKind !== draft.contentKind)) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Marketplace item ownership or content kind does not match this publisher profile.");
                }
                const item = assertMarketplaceItem({
                    kind: MARKETPLACE_KINDS.item,
                    version: MARKETPLACE_SCHEMA_VERSION,
                    publisherId: profile.publisherId,
                    contentKind: draft.contentKind,
                    ...draft.item,
                });
                const release = assertMarketplaceRelease({
                    kind: MARKETPLACE_KINDS.release,
                    version: MARKETPLACE_SCHEMA_VERSION,
                    itemId: item.itemId,
                    releaseVersion: draft.release.releaseVersion,
                    contentKind: draft.contentKind,
                    publisherId: profile.publisherId,
                    licenseExpression: draft.release.licenseExpression,
                    changelog: draft.release.changelog,
                    artifact: built.inspection.artifact,
                    compatibility,
                    capabilities: draft.contentKind === "plugin" ? built.inspection.identity.capabilities : [],
                    dependencies,
                    ...(embeddedPlugins.length ? { embeddedPlugins } : {}),
                    ...(draft.contentKind === "plugin" ? {
                        executable: {
                            pluginId: built.inspection.identity.pluginId,
                            packageHash: built.inspection.identity.packageHash,
                            runtimeHash: built.inspection.identity.runtimeHash,
                        },
                    } : {}),
                });
                this.adapterRegistry.validate(draft.contentKind, built.inspection, release);
                preparedByDraft.set(draft.draftId, Object.freeze({
                    draftId: draft.draftId,
                    draftRevision: draft.revision,
                    contentKind: draft.contentKind,
                    item,
                    release,
                    track: draft.release.track,
                    artifactFile: draft.draftId,
                    operations: [
                        { operationId: operationId(draft.draftId, "artifact"), kind: "publish-artifact" },
                        ...item.previews.map((preview) => ({ operationId: operationId(draft.draftId, `preview:${preview.sha256}`), kind: "publish-preview", sha256: preview.sha256 })),
                        { operationId: operationId(draft.draftId, "item"), kind: "publish-item" },
                        { operationId: operationId(draft.draftId, "release"), kind: "publish-release" },
                    ],
                }));
            }
            const entries = ordered.map((draft) => preparedByDraft.get(draft.draftId));
            const core = {
                kind: PLAN_KIND,
                version: PLAN_VERSION,
                createdAt: this.now().toISOString(),
                rootDraftId: draftId,
                rootDraftRevision: draftRevision,
                source: {
                    sourceId: source.sourceId,
                    registryId: source.registryId,
                    baseUrl: source.baseUrl,
                    trustedRootFingerprint: source.trustedRootFingerprint,
                    snapshotId: current.manifest.snapshotId,
                },
                profile: {
                    profileId: profile.profileId,
                    profileRevision: profile.revision,
                    publisherId: profile.publisherId,
                    keyId: profile.keyId,
                },
                entries,
                totalBytes: entries.reduce((total, entry) => total + entry.release.artifact.sizeBytes
                    + entry.item.previews.reduce((sum, preview) => sum + preview.sizeBytes, 0), 0),
            };
            const planHash = hashMarketplaceBytes(canonicalMarketplaceBytes(core));
            const finalDirectory = planArtifactDirectory(this.paths, planHash);
            if (await lstatOrNull(finalDirectory)) await fs.rm(temporary, { recursive: true, force: true });
            else await fs.rename(temporary, finalDirectory);
            const plan = Object.freeze({ ...core, planHash });
            const bytes = canonicalMarketplaceBytes(plan);
            if (!await lstatOrNull(planPath(this.paths, planHash))) await writeExclusiveDurable(planPath(this.paths, planHash), bytes);
            return plan;
        } catch (error) {
            await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    artifactPath(planHash, artifactFile) {
        if (!/^[a-f0-9-]{36}$/u.test(artifactFile)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication artifact identity is invalid.");
        return path.join(planArtifactDirectory(this.paths, planHash), artifactFile);
    }

    previewPath(digest) {
        if (!/^[a-f0-9]{64}$/u.test(digest)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Preview digest is invalid.");
        return path.join(this.paths.publicationPreviews, digest);
    }
}

export { PLAN_KIND as MARKETPLACE_PUBLICATION_PLAN_KIND, PLAN_VERSION as MARKETPLACE_PUBLICATION_PLAN_VERSION };
