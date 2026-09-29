import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import semver from "semver";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import {
    hashEditorAssetRevisionContent,
} from "../../app/editor-assets/EditorAssetContract.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { VISUAL_ASSET_UPLOAD_OPERATIONS, hashVisualAssetUse, normalizeVisualAssetUse } from "../../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { verifyRunPackageArchive } from "../headless/VisualAssetPack.js";
import {
    PORTABLE_PLUGIN_MAX_JSON_BYTES,
    parsePortablePluginFile,
} from "../plugins/PortablePluginFile.js";
import { openRegularFile } from "../storage/visual-assets/atomicFs.js";
import { EDITOR_ASSET_ERROR_CODES } from "../storage/StorageErrors.js";
import { verifyVehicleBundle } from "../artifacts/VehicleBundle.js";
import {
    ASSET_PACKAGE_BLOB_PREFIX,
    inspectAssetPackage,
    prepareAssetPackage,
    readAssetPackagePreparation,
    readPreparedJsonRecord,
} from "./AssetPackage.js";
import {
    planAssetPackageImport,
    readPreparedAssetRevision,
} from "./AssetPackageImportPlanner.js";
import {
    ENVIRONMENT_PACKAGE_BLOB_PREFIX,
    inspectEnvironmentPackage,
    marketplaceEnvironmentContentHash,
    prepareEnvironmentPackage,
    readEnvironmentPackagePreparation,
    readPreparedEnvironmentJsonRecord,
} from "./EnvironmentPackage.js";
import {
    planEnvironmentPackageImport,
    readPreparedEnvironment,
} from "./EnvironmentPackageImportPlanner.js";
import {
    inspectRunTemplatePackage,
    prepareRunTemplatePackage,
    readPreparedRunTemplateRecord,
    readRunTemplatePackagePreparation,
    RUN_TEMPLATE_PACKAGE_BLOB_PREFIX,
} from "./RunTemplatePackage.js";
import {
    planRunTemplatePackageImport,
    readPreparedRunTemplateImportRecord,
} from "./RunTemplatePackageImportPlanner.js";
import { MARKETPLACE_ARTIFACTS, MARKETPLACE_LIMITS } from "./MarketplaceContract.js";
import {
    assertMarketplaceCollection,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "./MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const JSON_ARTIFACT_LIMIT = 64 * 1024 * 1024;
const READ_ONLY_CAPABILITIES = Object.freeze({
    inspect: true, validate: true, plan: false, commit: false, createReceipt: false,
    planRemoval: false, remove: false,
});

export class ArtifactOperationUnsupportedError extends Error {
    constructor(adapterId, operation) {
        super(`Artifact adapter ${adapterId} does not support ${operation}.`);
        this.name = "ArtifactOperationUnsupportedError";
        this.code = "ARTIFACT_OPERATION_UNSUPPORTED";
        this.adapterId = adapterId;
        this.operation = operation;
    }
}

function unsupported(adapterId, operation) {
    throw new ArtifactOperationUnsupportedError(adapterId, operation);
}

function freezeInspection(value) {
    for (const entry of Object.values(value)) {
        if (entry && typeof entry === "object" && !Object.isFrozen(entry)) freezeInspection(entry);
    }
    return Object.freeze(value);
}

function normalizeHandle(handle, contract) {
    if (!handle || typeof handle !== "object" || Array.isArray(handle)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "ArtifactHandle must be an object.");
    }
    if (typeof handle.path !== "string" || !path.isAbsolute(handle.path)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "ArtifactHandle path must be absolute.");
    }
    if (handle.mediaType !== contract.mediaType) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `ArtifactHandle media type must be ${contract.mediaType}.`);
    }
    if (!SHA256.test(handle.sha256)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "ArtifactHandle digest must be lowercase SHA-256.");
    }
    if (!Number.isSafeInteger(handle.sizeBytes) || handle.sizeBytes < 0 || handle.sizeBytes > MARKETPLACE_LIMITS.artifactBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "ArtifactHandle size is outside the marketplace artifact ceiling.");
    }
    return Object.freeze({
        path: handle.path,
        mediaType: handle.mediaType,
        sha256: handle.sha256,
        sizeBytes: handle.sizeBytes,
    });
}

async function openHandle(handle, contract) {
    const normalized = normalizeHandle(handle, contract);
    const opened = await openRegularFile(normalized.path);
    if (!opened) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Staged artifact file was not found.");
    if (opened.stat.size !== normalized.sizeBytes) {
        await opened.handle.close();
        throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Staged artifact byte size does not match its descriptor.");
    }
    return { normalized, opened };
}

async function readJsonArtifact(handle, contract, maxBytes = JSON_ARTIFACT_LIMIT) {
    const { normalized, opened } = await openHandle(handle, contract);
    try {
        if (opened.stat.size > maxBytes) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `JSON artifact exceeds ${maxBytes} bytes.`);
        }
        const bytes = await opened.handle.readFile();
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== normalized.sha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Staged artifact digest does not match its descriptor.");
        }
        return { handle: normalized, bytes };
    } finally {
        await opened.handle.close();
    }
}

function parseJson(bytes, label) {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch (error) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `${label} is not valid UTF-8 JSON: ${error.message}`, { cause: error });
    }
}

function baseInspection(adapter, handle, identity) {
    return freezeInspection({
        adapterId: adapter.id,
        contentKind: adapter.contentKind,
        artifact: {
            mediaType: handle.mediaType,
            sha256: handle.sha256,
            sizeBytes: handle.sizeBytes,
        },
        contract: { kind: adapter.contract.kind, version: adapter.contract.version },
        identity,
        warnings: [],
    });
}

function validateRelease(adapter, inspection, release) {
    if (!inspection || inspection.adapterId !== adapter.id || inspection.contentKind !== adapter.contentKind
        || inspection.contract?.kind !== adapter.contract.kind || inspection.contract?.version !== adapter.contract.version
        || inspection.artifact?.mediaType !== adapter.contract.mediaType
        || !SHA256.test(inspection.artifact?.sha256)
        || !Number.isSafeInteger(inspection.artifact?.sizeBytes) || inspection.artifact.sizeBytes < 0) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Inspection does not match adapter ${adapter.id}.`);
    }
    if (release?.contentKind !== adapter.contentKind) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Release contentKind must be ${adapter.contentKind}.`);
    }
    if (release?.artifact?.mediaType !== adapter.contract.mediaType) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Release artifact media type must be ${adapter.contract.mediaType}.`);
    }
    if (release.artifact.sha256 !== inspection.artifact.sha256
        || release.artifact.sizeBytes !== inspection.artifact.sizeBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Release artifact digest or byte size does not match the inspected artifact.");
    }
    return inspection;
}

function exactReleaseRef(release) {
    return Object.freeze({
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifactSha256 ?? release.artifact.sha256,
    });
}

function exactReleaseRefKey(release) {
    const exact = exactReleaseRef(release);
    return `${exact.itemId}\u0000${exact.releaseVersion}\u0000${exact.artifactSha256}`;
}

export async function inspectCollectionArtifact(adapter, rawHandle) {
    const { handle, bytes } = await readJsonArtifact(rawHandle, adapter.contract, MARKETPLACE_LIMITS.jsonBytes);
    const collection = assertMarketplaceCollection(parseMarketplaceDocument(bytes));
    const canonicalBytes = marketplaceDocumentBytes(collection);
    if (!Buffer.from(bytes).equals(Buffer.from(canonicalBytes))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Collection artifact bytes must be canonical marketplace JSON.");
    }
    return baseInspection(adapter, handle, {
        memberCount: collection.members.length,
        members: collection.members.map((member) => Object.freeze({
            release: exactReleaseRef(member.release),
            group: member.group ?? null,
        })),
    });
}

export function validateCollectionRelease(_adapter, inspection, release) {
    const inspected = inspection.identity.members.map((member) => exactReleaseRefKey(member.release)).sort(compareUtf8);
    const signed = release.dependencies.map(exactReleaseRefKey).sort(compareUtf8);
    if (!isDeepStrictEqual(inspected, signed)) {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID,
            "Collection members must exactly match the signed release dependencies.",
        );
    }
    return inspection;
}

export function assertPluginReleaseMatchesInspection(inspection, release) {
    const identity = inspection?.identity;
    const invalid = (message) => {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message);
    };
    if (release.itemId !== identity?.pluginId) {
        invalid("Plugin release itemId must match plugin.json id.");
    }
    if (release.releaseVersion !== identity.version) {
        invalid("Plugin releaseVersion must match plugin.json version.");
    }
    const declared = [...release.capabilities].sort(compareUtf8);
    const packaged = [...identity.capabilities].sort(compareUtf8);
    if (!isDeepStrictEqual(declared, packaged)) {
        invalid("Plugin release capabilities must exactly match plugin.json capabilities.");
    }
    if (!semver.subset(release.compatibility.cevSim, identity.engineRange, { includePrerelease: true })) {
        invalid("Plugin release compatibility cannot exceed plugin.json engines.cevSim.");
    }
    const contract = release.compatibility.contracts.find((entry) => entry.kind === "cev-sim.plugin-package");
    if (!contract?.versions.includes(1)) {
        invalid("Plugin release compatibility must declare cev-sim.plugin-package version 1.");
    }
    return inspection;
}

export function defineArtifactAdapter({
    id,
    contentKind,
    inspect,
    validateInspection = null,
    plan = null,
    commit = null,
    recover = null,
    createReceipt = null,
    planRemoval = null,
    remove = null,
    receiptResourceKinds = [],
}) {
    const contract = Object.freeze({ ...MARKETPLACE_ARTIFACTS[contentKind] });
    const lifecycle = [plan, commit, createReceipt].every((operation) => typeof operation === "function");
    if ([plan, commit, createReceipt].some(Boolean) && !lifecycle) {
        throw new TypeError(`Artifact adapter ${id} must implement plan, commit, and createReceipt together.`);
    }
    const removalLifecycle = [planRemoval, remove].every((operation) => typeof operation === "function");
    if ([planRemoval, remove].some(Boolean) && !removalLifecycle) {
        throw new TypeError(`Artifact adapter ${id} must implement planRemoval and remove together.`);
    }
    if (!Array.isArray(receiptResourceKinds) || receiptResourceKinds.some((entry) => typeof entry !== "string" || !entry)) {
        throw new TypeError(`Artifact adapter ${id} receiptResourceKinds must be bounded strings.`);
    }
    const capabilities = lifecycle || removalLifecycle ? Object.freeze({
        inspect: true,
        validate: true,
        plan: lifecycle,
        commit: lifecycle,
        recover: lifecycle,
        createReceipt: lifecycle,
        planRemoval: removalLifecycle,
        remove: removalLifecycle,
    }) : READ_ONLY_CAPABILITIES;
    const adapter = {
        id,
        contentKind,
        contract,
        capabilities,
        receiptResourceKinds: Object.freeze([...receiptResourceKinds].sort(compareUtf8)),
        inspect: (handle, context = {}) => inspect(adapter, handle, context),
        validate: (inspection, release) => {
            const validated = validateRelease(adapter, inspection, release);
            return validateInspection ? validateInspection(adapter, validated, release) : validated;
        },
        plan: lifecycle ? (input) => plan(adapter, input) : () => unsupported(id, "plan"),
        commit: lifecycle ? (input) => commit(adapter, input) : () => unsupported(id, "commit"),
        recover: lifecycle ? (input) => (recover ? recover(adapter, input) : commit(adapter, input)) : () => unsupported(id, "recover"),
        createReceipt: lifecycle ? (input) => createReceipt(adapter, input) : () => unsupported(id, "createReceipt"),
        planRemoval: removalLifecycle ? (input) => planRemoval(adapter, input) : () => unsupported(id, "planRemoval"),
        remove: removalLifecycle ? (input) => remove(adapter, input) : () => unsupported(id, "remove"),
    };
    return Object.freeze(adapter);
}

async function inspectPlugin(adapter, rawHandle) {
    const { handle, bytes } = await readJsonArtifact(rawHandle, adapter.contract, PORTABLE_PLUGIN_MAX_JSON_BYTES);
    const verified = verifyPluginPackage(parsePortablePluginFile(bytes));
    return baseInspection(adapter, handle, {
        pluginId: verified.document.id,
        version: verified.document.version,
        packageHash: verified.resource.packageHash,
        runtimeHash: verified.resource.runtimeHash,
        uiHash: verified.resource.uiHash ?? null,
        engineRange: verified.document.engines.cevSim,
        capabilities: [...verified.document.capabilities],
    });
}

function validatePlugin(_adapter, inspection, release) {
    return assertPluginReleaseMatchesInspection(inspection, release);
}

function exactMarketplaceOwner(source, release) {
    return Object.freeze({
        sourceId: source.sourceId,
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
    });
}

function ownerKey(owner) {
    return `${owner.sourceId}\u0000${owner.itemId}\u0000${owner.releaseVersion}\u0000${owner.artifactSha256}`;
}

function pluginMapping(identity) {
    return Object.freeze({
        resourceKind: "plugin-package",
        sourceId: identity.pluginId,
        localId: identity.pluginId,
        hashes: Object.freeze({
            packageHash: identity.packageHash,
            runtimeHash: identity.runtimeHash,
            ...(identity.uiHash ? { uiHash: identity.uiHash } : {}),
        }),
    });
}

export const pluginArtifactAdapter = defineArtifactAdapter({
    id: "plugin@1",
    contentKind: "plugin",
    inspect: inspectPlugin,
    validateInspection: validatePlugin,
});

export function createPluginLifecycleAdapter({ pluginStore, publishLibraryChange = null } = {}) {
    if (!pluginStore || typeof pluginStore.snapshotWithOwners !== "function") {
        throw new TypeError("Plugin lifecycle adapter requires PluginStore.");
    }
    return defineArtifactAdapter({
        id: "plugin@1",
        contentKind: "plugin",
        inspect: inspectPlugin,
        validateInspection: validatePlugin,
        receiptResourceKinds: ["plugin-package"],
        async plan(_adapter, { release, inspection, context }) {
            const library = await pluginStore.snapshotWithOwners();
            const identity = inspection.identity;
            const owner = exactMarketplaceOwner(context.source, release);
            const current = library.packages.find((entry) => entry.pluginId === identity.pluginId
                && entry.packageHash === identity.packageHash);
            let casAction = "add";
            try {
                const existing = await pluginStore.verifyPackage(identity.packageHash);
                if (existing.resource.runtimeHash !== identity.runtimeHash
                    || (existing.resource.uiHash ?? null) !== identity.uiHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Plugin CAS identity disagrees with the marketplace artifact.");
                }
                casAction = "reuse";
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            const hasOwner = current?.ownership.marketplace.some((entry) => ownerKey(entry) === ownerKey(owner)) ?? false;
            const coexistingPackages = library.packages
                .filter((entry) => entry.pluginId === identity.pluginId && entry.packageHash !== identity.packageHash)
                .map((entry) => ({ version: entry.version, packageHash: entry.packageHash }))
                .sort((left, right) => compareUtf8(left.version, right.version) || compareUtf8(left.packageHash, right.packageHash));
            return {
                preconditions: [{ kind: "plugin-library", revision: library.revision }],
                plugin: structuredClone(identity),
                owner,
                changes: {
                    cas: casAction,
                    libraryMembership: current ? "reuse" : "add",
                    marketplaceOwner: hasOwner ? "reuse" : "add",
                },
                coexistingPackages,
                capabilityChange: {
                    required: [...identity.capabilities],
                    grantsAdded: [],
                },
                rights: [],
                conflicts: [],
                mappings: [pluginMapping(identity)],
                warnings: [],
                blockingIssues: [],
                operations: [{
                    operationId: createHash("sha256").update(`plugin\u0000${release.artifact.sha256}`).digest("hex"),
                    kind: "publish-plugin-package",
                    packageHash: identity.packageHash,
                }],
            };
        },
        async commit(adapter, { release, inspection, adapterPlan, artifactHandle }) {
            const { bytes } = await readJsonArtifact(artifactHandle, adapter.contract, PORTABLE_PLUGIN_MAX_JSON_BYTES);
            const resource = parsePortablePluginFile(bytes);
            const verified = verifyPluginPackage(resource);
            const freshInspection = baseInspection(adapter, artifactHandle, {
                pluginId: verified.document.id,
                version: verified.document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
                uiHash: verified.resource.uiHash ?? null,
                engineRange: verified.document.engines.cevSim,
                capabilities: [...verified.document.capabilities],
            });
            adapter.validate(freshInspection, release);
            if (!isDeepStrictEqual(freshInspection.identity, inspection.identity)
                || !isDeepStrictEqual(adapterPlan.plugin, inspection.identity)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Plugin marketplace plan identity changed before commit.");
            }
            const result = await pluginStore.addMarketplaceOwner(verified.resource, adapterPlan.owner);
            if (result.membershipChanged) {
                await publishLibraryChange?.({
                    pluginId: result.package.pluginId,
                    action: "installed",
                    packageHash: result.package.packageHash,
                    revision: result.revision,
                });
            }
            return result;
        },
        async createReceipt(_adapter, { adapterPlan }) {
            return { mappings: adapterPlan.mappings };
        },
        async recover(adapter, input) {
            return adapter.commit(input);
        },
        async planRemoval(_adapter, { receipt, installation }) {
            const mapping = receipt.mappings.find((entry) => entry.resourceKind === "plugin-package");
            if (!mapping?.hashes?.packageHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Plugin marketplace receipt has no package mapping.");
            }
            const owner = Object.freeze({
                sourceId: installation.sourceId,
                itemId: installation.release.itemId,
                releaseVersion: installation.release.releaseVersion,
                artifactSha256: installation.release.artifactSha256,
            });
            const library = await pluginStore.snapshotWithOwners();
            const current = library.packages.find((entry) => entry.pluginId === mapping.localId
                && entry.packageHash === mapping.hashes.packageHash);
            if (!current?.ownership.marketplace.some((entry) => ownerKey(entry) === ownerKey(owner))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Installed plugin marketplace membership has no matching library owner.");
            }
            return Object.freeze({
                pluginId: mapping.localId,
                packageHash: mapping.hashes.packageHash,
                owner,
                libraryRevision: library.revision,
            });
        },
        async remove(_adapter, { removalPlan }) {
            const result = await pluginStore.removeMarketplaceOwner(
                removalPlan.pluginId,
                removalPlan.packageHash,
                removalPlan.owner,
            );
            if (result.membershipChanged) {
                await publishLibraryChange?.({
                    pluginId: removalPlan.pluginId,
                    action: "removed",
                    packageHash: removalPlan.packageHash,
                    revision: result.revision,
                });
            }
            return result;
        },
    });
}

export const vehicleArtifactAdapter = defineArtifactAdapter({
    id: "vehicle@1",
    contentKind: "vehicle",
    async inspect(adapter, rawHandle) {
        const { handle, bytes } = await readJsonArtifact(rawHandle, adapter.contract);
        const verified = verifyVehicleBundle(parseJson(bytes, "Vehicle bundle"));
        const assets = Object.values(verified.decodedAssets);
        return baseInspection(adapter, handle, {
            vehicleId: verified.manifest.id,
            bundleHash: verified.computedBundleHash,
            assetCount: assets.length,
            assetBytes: assets.reduce((total, entry) => total + entry.length, 0),
            embeddedPlugins: verified.verifiedPluginPackages.map((entry) => ({
                pluginId: entry.document.id,
                version: entry.document.version,
                packageHash: entry.resource.packageHash,
                runtimeHash: entry.resource.runtimeHash,
            })),
        });
    },
});

export async function inspectRunTemplatePackageArtifact(adapter, rawHandle, context) {
    const { normalized: handle, opened } = await openHandle(rawHandle, adapter.contract);
    await opened.handle.close();
    const inspection = await inspectRunTemplatePackage({
        archivePath: handle.path,
        stagingRoot: context.stagingRoot,
        limits: context.limits,
        signal: context.signal,
    });
    if (inspection.archiveSha256 !== handle.sha256 || inspection.archiveSizeBytes !== handle.sizeBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Run-template package identity does not match its descriptor.");
    }
    return baseInspection(adapter, handle, inspection);
}

function validateRunTemplatePluginInventory(_adapter, inspection, release) {
    const signed = release.embeddedPlugins ?? [];
    const packaged = inspection.identity.plugins;
    if (!isDeepStrictEqual(signed, packaged)) {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID,
            "Signed embeddedPlugins must exactly match the run-template package plugin inventory.",
        );
    }
    return inspection;
}

export const runTemplateArtifactAdapter = defineArtifactAdapter({
    id: "run-template@1",
    contentKind: "run-template",
    inspect: inspectRunTemplatePackageArtifact,
    validateInspection: validateRunTemplatePluginInventory,
});

export const runPackageArtifactAdapter = defineArtifactAdapter({
    id: "run-package@1",
    contentKind: "run-package",
    async inspect(adapter, rawHandle, context) {
        const { normalized: handle, opened } = await openHandle(rawHandle, adapter.contract);
        try {
            const verified = await verifyRunPackageArchive(opened.handle.createReadStream({ autoClose: false, signal: context.signal }), {
                signal: context.signal,
                limits: context.limits,
                stagingRoot: context.stagingRoot,
            });
            if (verified.archiveHash !== handle.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Run-package archive digest does not match its descriptor.");
            }
            return baseInspection(adapter, handle, {
                manifestId: verified.bundle.manifest.id,
                archiveHash: verified.archiveHash,
                packageManifestHash: verified.packageManifestHash,
                bundleBytesHash: verified.bundleBytesHash,
                resolvedHash: verified.resolvedHash,
                simulationSemanticHash: verified.simulationSemanticHash,
                identityVersion: verified.identityVersion,
                assetCount: verified.manifest.assets.length,
                assetBytes: verified.manifest.assets.reduce((total, entry) => total + entry.sizeBytes, 0),
            });
        } finally {
            await opened.handle.close();
        }
    },
});

async function inspectAssetPackageArtifact(adapter, rawHandle, context) {
    const { normalized: handle, opened } = await openHandle(rawHandle, adapter.contract);
    await opened.handle.close();
    const inspection = await inspectAssetPackage({
        archivePath: handle.path,
        stagingRoot: context.stagingRoot,
        limits: context.limits,
        signal: context.signal,
    });
    if (inspection.archiveSha256 !== handle.sha256 || inspection.archiveSizeBytes !== handle.sizeBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Asset-package archive identity does not match its descriptor.");
    }
    return baseInspection(adapter, handle, inspection);
}

export const assetPackageArtifactAdapter = defineArtifactAdapter({
    id: "asset-pack@1",
    contentKind: "asset-pack",
    inspect: inspectAssetPackageArtifact,
});

export const collectionArtifactAdapter = defineArtifactAdapter({
    id: "collection@1",
    contentKind: "collection",
    inspect: inspectCollectionArtifact,
    validateInspection: validateCollectionRelease,
});

function collectionMapping(release) {
    return Object.freeze({
        resourceKind: "marketplace-collection",
        sourceId: release.itemId,
        localId: release.itemId,
        hashes: Object.freeze({ artifactSha256: release.artifact.sha256 }),
    });
}

export function createCollectionLifecycleAdapter() {
    return defineArtifactAdapter({
        id: "collection@1",
        contentKind: "collection",
        inspect: inspectCollectionArtifact,
        validateInspection: validateCollectionRelease,
        receiptResourceKinds: ["marketplace-collection"],
        async plan(_adapter, { release, inspection }) {
            return {
                collection: {
                    members: structuredClone(inspection.identity.members),
                    memberCount: inspection.identity.memberCount,
                },
                rights: [],
                conflicts: [],
                mappings: [collectionMapping(release)],
                warnings: [],
                blockingIssues: [],
                operations: [{
                    operationId: createHash("sha256")
                        .update(`marketplace-collection\u0000${release.artifact.sha256}`)
                        .digest("hex"),
                    kind: "verify-marketplace-collection",
                }],
            };
        },
        async commit(adapter, { release, inspection, adapterPlan, artifactHandle, operation }) {
            if (operation?.operationId !== adapterPlan.operations[0]?.operationId) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Collection verification operation is not in the final plan.");
            }
            const current = await inspectCollectionArtifact(adapter, artifactHandle);
            validateCollectionRelease(adapter, current, release);
            if (!isDeepStrictEqual(current.identity, inspection.identity)
                || !isDeepStrictEqual(current.identity.members, adapterPlan.collection.members)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Collection artifact changed after final planning.");
            }
            return { kind: operation.kind, artifactSha256: release.artifact.sha256 };
        },
        async createReceipt(_adapter, { release }) {
            return { mappings: [collectionMapping(release)] };
        },
    });
}

async function inspectEnvironmentPackageArtifact(adapter, rawHandle, context) {
    const { normalized: handle, opened } = await openHandle(rawHandle, adapter.contract);
    await opened.handle.close();
    const inspection = await inspectEnvironmentPackage({
        archivePath: handle.path,
        stagingRoot: context.stagingRoot,
        limits: context.limits,
        signal: context.signal,
    });
    if (inspection.archiveSha256 !== handle.sha256 || inspection.archiveSizeBytes !== handle.sizeBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Environment-package archive identity does not match its descriptor.");
    }
    return baseInspection(adapter, handle, inspection);
}

export const environmentArtifactAdapter = defineArtifactAdapter({
    id: "environment@1",
    contentKind: "environment",
    inspect: inspectEnvironmentPackageArtifact,
});

export function createAssetPackageLifecycleAdapter({
    editorAssetStore, visualAssetStore, receiptStore,
} = {}) {
    if (!editorAssetStore || !visualAssetStore || !receiptStore) {
        throw new TypeError("Asset-package lifecycle adapter requires editor, visual, and receipt stores.");
    }
    return defineArtifactAdapter({
        id: "asset-pack@1",
        contentKind: "asset-pack",
        inspect: inspectAssetPackageArtifact,
        receiptResourceKinds: ["editor-asset-revision"],
        async plan(_adapter, { release, artifactHandle, context }) {
            if (!context.workDirectory) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Asset-package planning requires durable job work storage.");
            const prepared = await prepareAssetPackage({
                archivePath: artifactHandle.path,
                workDirectory: context.workDirectory,
                signal: context.signal,
            });
            if (prepared.verified.archiveSha256 !== artifactHandle.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Prepared asset package changed after inspection.");
            }
            const planned = await planAssetPackageImport({
                verified: prepared.verified,
                editorAssetStore,
                visualAssetStore,
                receiptStore,
                release,
                context,
                preparationHash: prepared.preparationHash,
                preparation: prepared,
            });
            return {
                package: {
                    archiveSha256: prepared.verified.archiveSha256,
                    manifestSha256: prepared.verified.manifestSha256,
                    roots: prepared.verified.manifest.roots,
                    assetCount: prepared.verified.manifest.assets.length,
                    revisionCount: prepared.verified.revisions.size,
                    useCount: prepared.verified.uses.size,
                    blobCount: prepared.verified.manifest.blobs.length,
                },
                ...planned,
            };
        },
        async commit(_adapter, { operation, adapterPlan, context }) {
            if (!operation || !adapterPlan.operations.some((entry) => entry.operationId === operation.operationId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Asset-package transaction operation is not in the final plan.");
            }
            const preparation = await readAssetPackagePreparation({
                workDirectory: context.workDirectory,
                preparationHash: adapterPlan.preparationHash,
                archiveSha256: adapterPlan.package.archiveSha256,
            });
            if (operation.kind === "publish-visual-use") {
                const use = normalizeVisualAssetUse(await readPreparedJsonRecord(preparation, operation.recordSha256));
                if (hashVisualAssetUse(use) !== operation.useHash || use.asset.sha256 !== operation.blobSha256) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared visual-use operation identity changed.");
                }
                const rights = await visualAssetStore.evaluateSourceRights({
                    sourceIds: use.sourceIds,
                    operations: VISUAL_ASSET_UPLOAD_OPERATIONS,
                });
                if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before asset import.");
                const blob = preparation.entry(`${ASSET_PACKAGE_BLOB_PREFIX}${operation.blobSha256}`);
                const upload = await visualAssetStore.createUpload(use);
                await visualAssetStore.writeUploadContent(upload.id, createReadStream(blob.path), { contentLength: blob.sizeBytes });
                return { kind: operation.kind, useHash: operation.useHash };
            }
            if (operation.kind === "publish-editor-asset-revision") {
                const preparedRevision = await readPreparedAssetRevision({
                    workDirectory: context.workDirectory,
                    preparationHash: adapterPlan.preparationHash,
                    preparedRevisionHash: operation.preparedRevisionHash,
                });
                if (preparedRevision.sourceAssetId !== operation.sourceAssetId
                    || preparedRevision.sourceRevision !== operation.sourceRevision
                    || preparedRevision.localAssetId !== operation.localAssetId
                    || preparedRevision.localRevision !== operation.localRevision
                    || preparedRevision.hashes.localContent !== operation.localContentHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared editor-asset revision identity changed.");
                }
                const rights = await visualAssetStore.evaluateSourceRights({
                    sourceIds: preparedRevision.requiredSourceIds,
                    operations: [
                        ...VISUAL_ASSET_UPLOAD_OPERATIONS,
                        ...(preparedRevision.draft.definition ? ["derivatives"] : []),
                    ],
                });
                if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before asset publication.");
                const replay = await editorAssetStore.findPublication(operation.publicationId);
                if (replay) {
                    if (replay.revision.assetId !== operation.localAssetId || replay.revision.revision !== operation.localRevision) {
                        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported asset publication replay has a different identity.");
                    }
                    if (hashEditorAssetRevisionContent(replay.revision) !== operation.localContentHash) {
                        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported asset publication replay has different content.");
                    }
                    const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
                    return {
                        kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision,
                        localContentHash: operation.localContentHash, modelUseHash: replay.revision.modelUseHash,
                        rootGeneration: root?.generation ?? null,
                    };
                }
                let existing = null;
                try {
                    existing = await editorAssetStore.getRevision(operation.localAssetId, operation.localRevision);
                } catch (error) {
                    if (error.code !== EDITOR_ASSET_ERROR_CODES.NOT_FOUND) throw error;
                }
                if (existing) {
                    if (hashEditorAssetRevisionContent(existing) !== operation.localContentHash) {
                        throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Local editor-asset history changed after import planning.");
                    }
                    const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
                    if (root?.useHash !== existing.modelUseHash) {
                        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Content-identical editor-asset history has no intact root.");
                    }
                    return {
                        kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision,
                        localContentHash: operation.localContentHash, modelUseHash: existing.modelUseHash,
                        rootGeneration: root.generation,
                    };
                }
                const snapshot = await editorAssetStore.list({ archived: true });
                const result = await editorAssetStore.publishImportedRevision(preparedRevision.draft, snapshot.catalogRevision);
                if (result.revision.assetId !== operation.localAssetId || result.revision.revision !== operation.localRevision
                    || hashEditorAssetRevisionContent(result.revision) !== operation.localContentHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported editor-asset revision committed at an unexpected identity.");
                }
                const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
                if (root?.useHash !== result.revision.modelUseHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported editor-asset revision root is missing after publication.");
                }
                return {
                    kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision,
                    localContentHash: operation.localContentHash, modelUseHash: result.revision.modelUseHash,
                    rootGeneration: root.generation,
                };
            }
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Unknown asset-package operation ${operation.kind}.`);
        },
        async recover(adapter, input) {
            const { operation } = input;
            if (operation.kind === "publish-visual-use") {
                const use = await visualAssetStore.getUse(operation.useHash, { optional: true });
                if (use && hashVisualAssetUse(use) === operation.useHash) {
                    await visualAssetStore.readPublishedBytes(use.asset.sha256, { expectedSize: use.asset.sizeBytes });
                    return { kind: operation.kind, useHash: operation.useHash };
                }
            } else if (operation.kind === "publish-editor-asset-revision") {
                let revision = null;
                try {
                    revision = await editorAssetStore.getRevision(operation.localAssetId, operation.localRevision);
                } catch (error) {
                    if (error.code !== EDITOR_ASSET_ERROR_CODES.NOT_FOUND) throw error;
                }
                const root = revision ? await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`) : null;
                if (revision && hashEditorAssetRevisionContent(revision) === operation.localContentHash
                    && root?.useHash === revision.modelUseHash) {
                    return {
                        kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision,
                        localContentHash: operation.localContentHash, modelUseHash: revision.modelUseHash,
                        rootGeneration: root.generation,
                    };
                }
            }
            return adapter.commit(input);
        },
        async createReceipt(_adapter, { adapterPlan }) {
            return { mappings: adapterPlan.mappings };
        },
    });
}

export function createEnvironmentPackageLifecycleAdapter({
    storageService, editorAssetStore, visualAssetStore, receiptStore,
} = {}) {
    if (!storageService || !editorAssetStore || !visualAssetStore || !receiptStore) {
        throw new TypeError("Environment-package lifecycle adapter requires storage, editor, visual, and receipt stores.");
    }

    const requirePlannedOperation = (adapterPlan, operation) => {
        const planned = adapterPlan?.operations?.find((entry) => entry.operationId === operation?.operationId);
        if (!planned || !isDeepStrictEqual(planned, operation)) {
            throw marketplaceError(
                MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED,
                "Environment-package transaction operation is not the exact operation frozen in the final plan.",
            );
        }
        return planned;
    };

    const commitAssetOperation = async ({ operation, adapterPlan, preparation }) => {
        if (operation.kind === "publish-visual-use") {
            const use = normalizeVisualAssetUse(await readPreparedEnvironmentJsonRecord(preparation, operation.recordSha256));
            if (hashVisualAssetUse(use) !== operation.useHash || use.asset.sha256 !== operation.blobSha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment visual-use operation identity changed.");
            }
            const rights = await visualAssetStore.evaluateSourceRights({
                sourceIds: use.sourceIds,
                operations: VISUAL_ASSET_UPLOAD_OPERATIONS,
            });
            if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before environment import.");
            const blob = preparation.entry(`${ENVIRONMENT_PACKAGE_BLOB_PREFIX}${operation.blobSha256}`);
            const upload = await visualAssetStore.createUpload(use);
            await visualAssetStore.writeUploadContent(upload.id, createReadStream(blob.path), { contentLength: blob.sizeBytes });
            return { kind: operation.kind, useHash: operation.useHash };
        }
        if (operation.kind !== "publish-editor-asset-revision") return null;
        const preparedRevision = await readPreparedAssetRevision({
            preparationDir: preparation.preparationDir,
            preparedRevisionHash: operation.preparedRevisionHash,
        });
        if (preparedRevision.sourceAssetId !== operation.sourceAssetId
            || preparedRevision.sourceRevision !== operation.sourceRevision
            || preparedRevision.localAssetId !== operation.localAssetId
            || preparedRevision.localRevision !== operation.localRevision
            || preparedRevision.hashes.localContent !== operation.localContentHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment asset revision identity changed.");
        }
        const rights = await visualAssetStore.evaluateSourceRights({
            sourceIds: preparedRevision.requiredSourceIds,
            operations: [
                ...VISUAL_ASSET_UPLOAD_OPERATIONS,
                ...(preparedRevision.draft.definition ? ["derivatives"] : []),
            ],
        });
        if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before environment asset publication.");
        const replay = await editorAssetStore.findPublication(operation.publicationId);
        if (replay) {
            if (replay.revision.assetId !== operation.localAssetId || replay.revision.revision !== operation.localRevision
                || hashEditorAssetRevisionContent(replay.revision) !== operation.localContentHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported environment asset publication replay has a different identity.");
            }
            const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
            if (root?.useHash !== replay.revision.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported environment asset root is missing.");
            return {
                kind: operation.kind,
                assetId: operation.localAssetId,
                revision: operation.localRevision,
                localContentHash: operation.localContentHash,
                modelUseHash: replay.revision.modelUseHash,
                rootGeneration: root.generation,
            };
        }
        let existing = null;
        try {
            existing = await editorAssetStore.getRevision(operation.localAssetId, operation.localRevision);
        } catch (error) {
            if (error.code !== EDITOR_ASSET_ERROR_CODES.NOT_FOUND) throw error;
        }
        if (existing) {
            if (hashEditorAssetRevisionContent(existing) !== operation.localContentHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Local editor-asset history changed after environment planning.");
            }
            const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
            if (root?.useHash !== existing.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Content-identical environment asset history has no intact root.");
            return {
                kind: operation.kind,
                assetId: operation.localAssetId,
                revision: operation.localRevision,
                localContentHash: operation.localContentHash,
                modelUseHash: existing.modelUseHash,
                rootGeneration: root.generation,
            };
        }
        const snapshot = await editorAssetStore.list({ archived: true });
        const result = await editorAssetStore.publishImportedRevision(preparedRevision.draft, snapshot.catalogRevision);
        if (result.revision.assetId !== operation.localAssetId || result.revision.revision !== operation.localRevision
            || hashEditorAssetRevisionContent(result.revision) !== operation.localContentHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported environment asset revision committed at an unexpected identity.");
        }
        const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
        if (root?.useHash !== result.revision.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Imported environment asset root is missing after publication.");
        return {
            kind: operation.kind,
            assetId: operation.localAssetId,
            revision: operation.localRevision,
            localContentHash: operation.localContentHash,
            modelUseHash: result.revision.modelUseHash,
            rootGeneration: root.generation,
        };
    };

    return defineArtifactAdapter({
        id: "environment@1",
        contentKind: "environment",
        inspect: inspectEnvironmentPackageArtifact,
        receiptResourceKinds: ["environment"],
        async plan(_adapter, { release, artifactHandle, context }) {
            if (!context.workDirectory) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Environment-package planning requires durable job work storage.");
            const prepared = await prepareEnvironmentPackage({
                archivePath: artifactHandle.path,
                workDirectory: context.workDirectory,
                signal: context.signal,
            });
            if (prepared.verified.archiveSha256 !== artifactHandle.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Prepared environment package changed after inspection.");
            }
            return planEnvironmentPackageImport({
                verified: prepared.verified,
                preparation: prepared,
                storageService,
                editorAssetStore,
                visualAssetStore,
                receiptStore,
                release,
                context,
            });
        },
        async commit(_adapter, { operation, adapterPlan, context }) {
            operation = requirePlannedOperation(adapterPlan, operation);
            const preparation = await readEnvironmentPackagePreparation({
                workDirectory: context.workDirectory,
                preparationHash: adapterPlan.preparationHash,
                archiveSha256: adapterPlan.package.archiveSha256,
            });
            if (operation.kind === "publish-visual-use" || operation.kind === "publish-editor-asset-revision") {
                return commitAssetOperation({ operation, adapterPlan, preparation });
            }
            const prepared = await readPreparedEnvironment({
                preparationDir: preparation.preparationDir,
                preparedEnvironmentHash: operation.preparedEnvironmentHash,
            });
            if (prepared.target.environmentId !== adapterPlan.environment.localEnvironmentId
                || prepared.target.contentHash !== adapterPlan.environment.localContentHash
                || prepared.target.worldHash !== adapterPlan.environment.localWorldHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment identity changed after planning.");
            }
            if (operation.kind === "publish-environment-visual-layer") {
                if (!prepared.visual || prepared.visual.descriptorHash !== operation.descriptorHash
                    || prepared.visual.accessHash !== operation.accessHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment visual identity changed.");
                }
                return {
                    kind: operation.kind,
                    ...await storageService.publishMarketplaceVisualLayer({
                        descriptor: prepared.visual.descriptor,
                        access: prepared.visual.access,
                    }),
                };
            }
            if (operation.kind === "publish-environment") {
                if (operation.environmentId !== prepared.target.environmentId
                    || operation.expectedRevision !== prepared.target.expectedRevision
                    || operation.contentHash !== prepared.target.contentHash
                    || operation.worldHash !== prepared.target.worldHash
                    || marketplaceEnvironmentContentHash(prepared.target.manifest) !== operation.contentHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment publication operation changed.");
                }
                return {
                    kind: operation.kind,
                    ...await storageService.commitMarketplaceEnvironment({
                        environmentId: prepared.target.environmentId,
                        manifest: prepared.target.manifest,
                        expectedRevision: prepared.target.expectedRevision,
                        contentHash: prepared.target.contentHash,
                    }),
                };
            }
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Unknown environment-package operation ${operation.kind}.`);
        },
        async recover(adapter, input) {
            const adapterPlan = input.adapterPlan;
            const operation = requirePlannedOperation(adapterPlan, input.operation);
            input = { ...input, operation };
            if (operation.kind === "publish-visual-use") {
                const use = await visualAssetStore.getUse(operation.useHash, { optional: true });
                if (use && hashVisualAssetUse(use) === operation.useHash) {
                    await visualAssetStore.readPublishedBytes(use.asset.sha256, { expectedSize: use.asset.sizeBytes });
                    return { kind: operation.kind, useHash: operation.useHash };
                }
            } else if (operation.kind === "publish-editor-asset-revision") {
                let revision = null;
                try {
                    revision = await editorAssetStore.getRevision(operation.localAssetId, operation.localRevision);
                } catch (error) {
                    if (error.code !== EDITOR_ASSET_ERROR_CODES.NOT_FOUND) throw error;
                }
                const root = revision ? await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`) : null;
                if (revision && hashEditorAssetRevisionContent(revision) === operation.localContentHash
                    && root?.useHash === revision.modelUseHash) {
                    return {
                        kind: operation.kind,
                        assetId: operation.localAssetId,
                        revision: operation.localRevision,
                        localContentHash: operation.localContentHash,
                        modelUseHash: revision.modelUseHash,
                        rootGeneration: root.generation,
                    };
                }
            } else if (operation.kind === "publish-environment") {
                const current = await storageService.getEnvironment(operation.environmentId);
                if (current && marketplaceEnvironmentContentHash(current) === operation.contentHash
                    && createWorldResource(current).hash === operation.worldHash
                    && (current.revision === operation.expectedRevision
                        || (operation.expectedRevision === 0 && current.revision === 1))) {
                    return {
                        kind: operation.kind,
                        environmentId: operation.environmentId,
                        revision: current.revision,
                        contentHash: operation.contentHash,
                        worldHash: operation.worldHash,
                        descriptorHash: current.visualLayer?.descriptorHash ?? null,
                        accessHash: current.visualLayer?.accessHash ?? null,
                        reused: true,
                    };
                }
                if (current) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Imported environment changed before marketplace recovery completed.");
            }
            return adapter.commit({ ...input, adapterPlan });
        },
        async createReceipt(_adapter, { adapterPlan }) {
            return { mappings: adapterPlan.mappings };
        },
    });
}

export function createRunTemplatePackageLifecycleAdapter({
    storageService, pluginStore, editorAssetStore, visualAssetStore, receiptStore,
} = {}) {
    if (!storageService || !pluginStore || !editorAssetStore || !visualAssetStore || !receiptStore) {
        throw new TypeError("Run-template lifecycle adapter requires storage, plugin, editor, visual, and receipt stores.");
    }
    const requirePlannedOperation = (adapterPlan, operation) => {
        const planned = adapterPlan?.operations?.find((entry) => entry.operationId === operation?.operationId);
        if (!planned || !isDeepStrictEqual(planned, operation)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template transaction operation is not the exact operation frozen in the final plan.");
        }
        return planned;
    };

    const commitEnvironmentOperation = async ({ operation, adapterPlan, preparation }) => {
        const environmentPlan = adapterPlan.environment;
        if (!environmentPlan) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template has no planned environment closure.");
        if (operation.kind === "publish-visual-use") {
            const use = normalizeVisualAssetUse(await readPreparedEnvironmentJsonRecord(preparation, operation.recordSha256));
            if (hashVisualAssetUse(use) !== operation.useHash || use.asset.sha256 !== operation.blobSha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template visual-use identity changed.");
            }
            const existing = await visualAssetStore.getUse(operation.useHash, { optional: true });
            if (existing && hashVisualAssetUse(existing) === operation.useHash) {
                await visualAssetStore.readPublishedBytes(existing.asset.sha256, { expectedSize: existing.asset.sizeBytes });
                return { kind: operation.kind, useHash: operation.useHash };
            }
            const rights = await visualAssetStore.evaluateSourceRights({ sourceIds: use.sourceIds, operations: VISUAL_ASSET_UPLOAD_OPERATIONS });
            if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before run-template import.");
            const blob = preparation.entry(`${ENVIRONMENT_PACKAGE_BLOB_PREFIX}${operation.blobSha256}`);
            const upload = await visualAssetStore.createUpload(use);
            await visualAssetStore.writeUploadContent(upload.id, createReadStream(blob.path), { contentLength: blob.sizeBytes });
            return { kind: operation.kind, useHash: operation.useHash };
        }
        if (operation.kind === "publish-editor-asset-revision") {
            const preparedRevision = await readPreparedAssetRevision({
                preparationDir: preparation.preparationDir,
                preparedRevisionHash: operation.preparedRevisionHash,
            });
            if (preparedRevision.localAssetId !== operation.localAssetId
                || preparedRevision.localRevision !== operation.localRevision
                || preparedRevision.hashes.localContent !== operation.localContentHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template asset revision identity changed.");
            }
            const rights = await visualAssetStore.evaluateSourceRights({
                sourceIds: preparedRevision.requiredSourceIds,
                operations: [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...(preparedRevision.draft.definition ? ["derivatives"] : [])],
            });
            if (!rights.allowed) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Visual source rights changed before run-template asset publication.");
            const replay = await editorAssetStore.findPublication(operation.publicationId);
            if (replay) {
                if (replay.revision.assetId !== operation.localAssetId || replay.revision.revision !== operation.localRevision
                    || hashEditorAssetRevisionContent(replay.revision) !== operation.localContentHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template asset publication replay has a different identity.");
                }
                const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
                if (root?.useHash !== replay.revision.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template asset root is missing.");
                return { kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision, localContentHash: operation.localContentHash, modelUseHash: replay.revision.modelUseHash, rootGeneration: root.generation };
            }
            let existing = null;
            try {
                existing = await editorAssetStore.getRevision(operation.localAssetId, operation.localRevision);
            } catch (error) {
                if (error.code !== EDITOR_ASSET_ERROR_CODES.NOT_FOUND) throw error;
            }
            if (existing) {
                if (hashEditorAssetRevisionContent(existing) !== operation.localContentHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Local editor asset changed after run-template planning.");
                const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
                if (root?.useHash !== existing.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Content-identical run-template asset has no intact root.");
                return { kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision, localContentHash: operation.localContentHash, modelUseHash: existing.modelUseHash, rootGeneration: root.generation };
            }
            const snapshot = await editorAssetStore.list({ archived: true });
            const result = await editorAssetStore.publishImportedRevision(preparedRevision.draft, snapshot.catalogRevision);
            if (result.revision.assetId !== operation.localAssetId || result.revision.revision !== operation.localRevision
                || hashEditorAssetRevisionContent(result.revision) !== operation.localContentHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template asset committed at an unexpected identity.");
            }
            const root = await visualAssetStore.getRoot(`editor-asset:${operation.localAssetId}:revision:${operation.localRevision}`);
            if (root?.useHash !== result.revision.modelUseHash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template asset root is missing after publication.");
            return { kind: operation.kind, assetId: operation.localAssetId, revision: operation.localRevision, localContentHash: operation.localContentHash, modelUseHash: result.revision.modelUseHash, rootGeneration: root.generation };
        }
        const prepared = await readPreparedEnvironment({
            preparationDir: preparation.preparationDir,
            preparedEnvironmentHash: operation.preparedEnvironmentHash,
        });
        if (prepared.target.environmentId !== environmentPlan.environment.localEnvironmentId
            || prepared.target.contentHash !== environmentPlan.environment.localContentHash
            || prepared.target.worldHash !== environmentPlan.environment.localWorldHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template environment identity changed.");
        }
        if (operation.kind === "publish-environment-visual-layer") {
            if (!prepared.visual || prepared.visual.descriptorHash !== operation.descriptorHash || prepared.visual.accessHash !== operation.accessHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template environment visual identity changed.");
            }
            return { kind: operation.kind, ...await storageService.publishMarketplaceVisualLayer({ descriptor: prepared.visual.descriptor, access: prepared.visual.access }) };
        }
        if (operation.kind === "publish-environment") {
            if (operation.environmentId !== prepared.target.environmentId || operation.expectedRevision !== prepared.target.expectedRevision
                || operation.contentHash !== prepared.target.contentHash || operation.worldHash !== prepared.target.worldHash
                || marketplaceEnvironmentContentHash(prepared.target.manifest) !== operation.contentHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template environment operation changed.");
            }
            return { kind: operation.kind, ...await storageService.commitMarketplaceEnvironment({
                environmentId: prepared.target.environmentId,
                manifest: prepared.target.manifest,
                expectedRevision: prepared.target.expectedRevision,
                contentHash: prepared.target.contentHash,
            }) };
        }
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Unknown run-template environment operation ${operation.kind}.`);
    };

    return defineArtifactAdapter({
        id: "run-template@1",
        contentKind: "run-template",
        inspect: inspectRunTemplatePackageArtifact,
        validateInspection: validateRunTemplatePluginInventory,
        receiptResourceKinds: [
            "editor-asset-revision", "environment", "run-manifest", "run-template-plugin-package",
            "scenario", "script-binding", "vehicle", "visual-script",
        ],
        async plan(_adapter, { release, artifactHandle, context }) {
            if (!context.workDirectory) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Run-template planning requires durable job work storage.");
            const prepared = await prepareRunTemplatePackage({
                archivePath: artifactHandle.path,
                workDirectory: context.workDirectory,
                signal: context.signal,
            });
            if (prepared.verified.archiveSha256 !== artifactHandle.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Prepared run-template package changed after inspection.");
            }
            return planRunTemplatePackageImport({
                verified: prepared.verified,
                preparation: prepared,
                storageService,
                editorAssetStore,
                visualAssetStore,
                receiptStore,
                release,
                context,
            });
        },
        async commit(_adapter, { operation, adapterPlan, context }) {
            operation = requirePlannedOperation(adapterPlan, operation);
            const preparation = await readRunTemplatePackagePreparation({
                workDirectory: context.workDirectory,
                preparationHash: adapterPlan.preparationHash,
                archiveSha256: adapterPlan.package.archiveSha256,
            });
            if (operation.kind === "publish-run-template-plugin-package") {
                const resource = await readPreparedRunTemplateRecord(preparation, operation.recordSha256);
                const verified = verifyPluginPackage(resource);
                if (verified.document.id !== operation.pluginId || verified.resource.packageHash !== operation.packageHash) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template plugin identity changed.");
                }
                await pluginStore.putPackage(verified.resource);
                return { kind: operation.kind, pluginId: operation.pluginId, packageHash: operation.packageHash };
            }
            if (["publish-visual-use", "publish-editor-asset-revision", "publish-environment-visual-layer", "publish-environment"].includes(operation.kind)) {
                return commitEnvironmentOperation({ operation, adapterPlan, preparation });
            }
            if (operation.kind === "publish-vehicle-asset") {
                const blob = preparation.entry(`${RUN_TEMPLATE_PACKAGE_BLOB_PREFIX}${operation.sha256}`);
                if (blob.sizeBytes !== operation.sizeBytes) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared vehicle asset size changed.");
                return { kind: operation.kind, ...await storageService.commitMarketplaceVehicleAsset({
                    vehicleId: operation.vehicleId,
                    fileName: operation.fileName,
                    bytes: await fs.readFile(blob.path),
                    sha256: operation.sha256,
                    expectedVehicleRevision: operation.expectedVehicleRevision,
                    expectedVehicleContentHash: operation.expectedVehicleContentHash,
                    publishedVehicleContentHash: operation.publishedVehicleContentHash,
                }) };
            }
            if (operation.kind === "publish-vehicle") {
                const manifest = await readPreparedRunTemplateImportRecord({ preparationDir: preparation.preparationDir, kind: "vehicle", preparedHash: operation.preparedHash });
                return { kind: operation.kind, ...await storageService.commitMarketplaceVehicle({ vehicleId: operation.vehicleId, manifest, expectedRevision: operation.expectedRevision, contentHash: operation.contentHash }) };
            }
            if (operation.kind === "publish-script") {
                const document = await readPreparedRunTemplateImportRecord({ preparationDir: preparation.preparationDir, kind: "script", preparedHash: operation.preparedHash });
                return { kind: operation.kind, ...await storageService.commitMarketplaceScript({ scriptId: operation.scriptId, document, expectedContentHash: operation.expectedContentHash, contentHash: operation.contentHash }) };
            }
            if (operation.kind === "publish-scenario") {
                const scenario = await readPreparedRunTemplateImportRecord({ preparationDir: preparation.preparationDir, kind: "scenario", preparedHash: operation.preparedHash });
                return { kind: operation.kind, ...await storageService.commitMarketplaceScenario({ scenarioId: operation.scenarioId, scenario, expectedRevision: operation.expectedRevision, contentHash: operation.contentHash }) };
            }
            if (operation.kind === "publish-run-manifest") {
                const manifest = await readPreparedRunTemplateImportRecord({ preparationDir: preparation.preparationDir, kind: "run-manifest", preparedHash: operation.preparedHash });
                return { kind: operation.kind, ...await storageService.commitMarketplaceRunManifest({ manifestId: operation.manifestId, manifest, expectedRevision: operation.expectedRevision, contentHash: operation.contentHash }) };
            }
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Unknown run-template operation ${operation.kind}.`);
        },
        async recover(adapter, input) {
            return adapter.commit(input);
        },
        async createReceipt(_adapter, { adapterPlan }) {
            return { mappings: adapterPlan.mappings };
        },
    });
}

export const MARKETPLACE_ARTIFACT_ADAPTERS = Object.freeze([
    pluginArtifactAdapter,
    vehicleArtifactAdapter,
    runTemplateArtifactAdapter,
    runPackageArtifactAdapter,
    environmentArtifactAdapter,
    assetPackageArtifactAdapter,
    collectionArtifactAdapter,
]);

export class ArtifactAdapterRegistry {
    #adapters = new Map();
    #adaptersById = new Map();

    constructor(adapters = MARKETPLACE_ARTIFACT_ADAPTERS) {
        for (const adapter of adapters) this.#register(adapter);
    }

    #register(adapter) {
        const expected = MARKETPLACE_ARTIFACTS[adapter?.contentKind];
        if (!expected || adapter.contract?.kind !== expected.kind || adapter.contract?.version !== expected.version
            || adapter.contract?.mediaType !== expected.mediaType) {
            throw new TypeError(`Artifact adapter ${adapter?.id ?? "<unknown>"} does not match MARKETPLACE_ARTIFACTS.`);
        }
        if (this.#adapters.has(adapter.contentKind)) throw new TypeError(`Duplicate artifact adapter for ${adapter.contentKind}.`);
        if (this.#adaptersById.has(adapter.id)) throw new TypeError(`Duplicate artifact adapter ID ${adapter.id}.`);
        this.#adapters.set(adapter.contentKind, adapter);
        this.#adaptersById.set(adapter.id, adapter);
    }

    get(contentKind) {
        const adapter = this.#adapters.get(contentKind);
        if (!adapter) throw new ArtifactOperationUnsupportedError(`${contentKind}@unknown`, "inspect");
        return adapter;
    }

    inspect(contentKind, handle, context) {
        return this.get(contentKind).inspect(handle, context);
    }

    validate(contentKind, inspection, release) {
        return this.get(contentKind).validate(inspection, release);
    }

    requireOperation(contentKind, operation) {
        const adapter = this.get(contentKind);
        if (adapter.capabilities[operation] !== true || typeof adapter[operation] !== "function") {
            throw new ArtifactOperationUnsupportedError(adapter.id, operation);
        }
        return adapter[operation].bind(adapter);
    }

    hasLifecycle(contentKind = null) {
        if (contentKind !== null) {
            const adapter = this.#adapters.get(contentKind);
            return Boolean(adapter && adapter.capabilities.plan && adapter.capabilities.commit && adapter.capabilities.createReceipt);
        }
        return [...this.#adapters.values()].some((adapter) => (
            adapter.capabilities.plan && adapter.capabilities.commit && adapter.capabilities.createReceipt
        ));
    }

    requireLifecycle(contentKind) {
        const adapter = this.get(contentKind);
        for (const operation of ["plan", "commit", "createReceipt"]) this.requireOperation(contentKind, operation);
        return adapter;
    }

    findRemovalAdapter(receipt) {
        const resourceKinds = new Set((receipt?.mappings ?? []).map((entry) => entry.resourceKind));
        const matches = [...this.#adapters.values()].filter((adapter) => (
            adapter.capabilities.planRemoval && adapter.capabilities.remove
            && adapter.receiptResourceKinds.some((entry) => resourceKinds.has(entry))
        ));
        if (matches.length > 1) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace receipt matches multiple removal adapters.");
        }
        return matches[0] ?? null;
    }

    requireRemovalAdapter(adapterId) {
        const adapter = this.#adaptersById.get(adapterId);
        if (!adapter || !adapter.capabilities.planRemoval || !adapter.capabilities.remove) {
            throw new ArtifactOperationUnsupportedError(adapterId, "remove");
        }
        return adapter;
    }
}

export const artifactAdapterRegistry = Object.freeze(new ArtifactAdapterRegistry());

export function createMarketplaceClientArtifactRegistry(options) {
    return new ArtifactAdapterRegistry([
        createPluginLifecycleAdapter(options),
        vehicleArtifactAdapter,
        options?.storageService && options?.pluginStore && options?.editorAssetStore && options?.visualAssetStore && options?.receiptStore
            ? createRunTemplatePackageLifecycleAdapter(options)
            : runTemplateArtifactAdapter,
        runPackageArtifactAdapter,
        options?.storageService && options?.editorAssetStore && options?.visualAssetStore && options?.receiptStore
            ? createEnvironmentPackageLifecycleAdapter(options)
            : environmentArtifactAdapter,
        options?.editorAssetStore && options?.visualAssetStore && options?.receiptStore
            ? createAssetPackageLifecycleAdapter(options)
            : assetPackageArtifactAdapter,
        createCollectionLifecycleAdapter(),
    ]);
}
