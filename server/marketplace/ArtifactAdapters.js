import { createHash } from "node:crypto";
import path from "node:path";

import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { verifyRunBundleBytes } from "../headless/RunBundle.js";
import { verifyRunPackageArchive } from "../headless/VisualAssetPack.js";
import {
    PORTABLE_PLUGIN_MAX_JSON_BYTES,
    parsePortablePluginFile,
} from "../plugins/PortablePluginFile.js";
import { openRegularFile } from "../storage/visual-assets/atomicFs.js";
import { verifyVehicleBundle } from "../artifacts/VehicleBundle.js";
import { MARKETPLACE_ARTIFACTS, MARKETPLACE_LIMITS } from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const JSON_ARTIFACT_LIMIT = 64 * 1024 * 1024;
const READ_ONLY_CAPABILITIES = Object.freeze({
    inspect: true, validate: true, plan: false, commit: false, createReceipt: false,
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

export function defineArtifactAdapter({ id, contentKind, inspect, plan = null, commit = null, createReceipt = null }) {
    const contract = Object.freeze({ ...MARKETPLACE_ARTIFACTS[contentKind] });
    const lifecycle = [plan, commit, createReceipt].every((operation) => typeof operation === "function");
    if ([plan, commit, createReceipt].some(Boolean) && !lifecycle) {
        throw new TypeError(`Artifact adapter ${id} must implement plan, commit, and createReceipt together.`);
    }
    const capabilities = lifecycle ? Object.freeze({
        inspect: true, validate: true, plan: true, commit: true, createReceipt: true,
    }) : READ_ONLY_CAPABILITIES;
    const adapter = {
        id,
        contentKind,
        contract,
        capabilities,
        inspect: (handle, context = {}) => inspect(adapter, handle, context),
        validate: (inspection, release) => validateRelease(adapter, inspection, release),
        plan: lifecycle ? (input) => plan(adapter, input) : () => unsupported(id, "plan"),
        commit: lifecycle ? (input) => commit(adapter, input) : () => unsupported(id, "commit"),
        createReceipt: lifecycle ? (input) => createReceipt(adapter, input) : () => unsupported(id, "createReceipt"),
    };
    return Object.freeze(adapter);
}

export const pluginArtifactAdapter = defineArtifactAdapter({
    id: "plugin@1",
    contentKind: "plugin",
    async inspect(adapter, rawHandle) {
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
    },
});

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

export const runTemplateArtifactAdapter = defineArtifactAdapter({
    id: "run-template@1",
    contentKind: "run-template",
    async inspect(adapter, rawHandle) {
        const { handle, bytes } = await readJsonArtifact(rawHandle, adapter.contract);
        const verified = verifyRunBundleBytes(bytes, { execution: false });
        return baseInspection(adapter, handle, {
            manifestId: verified.bundle.manifest.id,
            bundleBytesHash: verified.bundleBytesHash,
            resolvedHash: verified.resolvedHash,
            simulationSemanticHash: verified.simulationSemanticHash,
            identityVersion: verified.identityVersion,
            plugins: structuredClone(verified.resolved.plugins ?? []),
            requestedBackends: structuredClone(verified.resolved.backendSelections ?? []),
        });
    },
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

export const MARKETPLACE_ARTIFACT_ADAPTERS = Object.freeze([
    pluginArtifactAdapter,
    vehicleArtifactAdapter,
    runTemplateArtifactAdapter,
    runPackageArtifactAdapter,
]);

export class ArtifactAdapterRegistry {
    #adapters = new Map();

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
        this.#adapters.set(adapter.contentKind, adapter);
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
}

export const artifactAdapterRegistry = Object.freeze(new ArtifactAdapterRegistry());
