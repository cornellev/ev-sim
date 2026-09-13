/**
 * Shared, kernel-safe contracts for the ED-06 editor asset catalog.
 * Catalog records point at source-bound VIS-04 use hashes; they never copy
 * media bytes, source grants, or dependency graphs into the editor schema.
 */

import {
    hashAssetMetric,
    normalizeAssetDefinition,
    normalizeAssetMetric,
    validateAssetDefinition,
    validateAssetMetric,
} from "./AssetDefinition.js";
import { normalizeVisualLayer } from "../simulation/visual/VisualLayer.js";
import { readAssetBinding } from "./AssetBackedObject.js";

export const EDITOR_ASSET_CATALOG_KIND = "cev-sim.editor-asset-catalog";
export const EDITOR_ASSET_CATALOG_VERSION = 1;
export const EDITOR_ASSET_REVISION_KIND = "cev-sim.editor-asset-revision";
export const EDITOR_ASSET_REVISION_VERSION = 1;
export const EDITOR_ASSET_REVISION_VERSION_V2 = 2;
export const ASSET_INSTANCE_TYPE_ID = "asset-instance";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function plain(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function string(value, fallback = "") {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || fallback;
}

function stringList(value) {
    return Array.isArray(value)
        ? [...new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
        : [];
}

function issue(path, code, message, severity = "error") {
    return { path: [...path], code, message, severity };
}

function normalizeFolder(value = {}) {
    return {
        id: string(value.id),
        name: string(value.name),
        parentId: value.parentId === undefined || value.parentId === null || value.parentId === ""
            ? null
            : string(value.parentId),
    };
}

function normalizeThumbnails(value) {
    if (!plain(value)) return {};
    return Object.fromEntries(Object.entries(value)
        .filter(([revision, thumbnail]) => /^\d+$/.test(revision) && plain(thumbnail))
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([revision, thumbnail]) => [revision, {
            useHash: string(thumbnail.useHash),
            rendererVersion: Number.isInteger(thumbnail.rendererVersion) ? thumbnail.rendererVersion : 1,
        }]));
}

function normalizeAsset(value = {}) {
    return {
        id: string(value.id),
        name: string(value.name),
        folderId: value.folderId === undefined || value.folderId === null || value.folderId === ""
            ? null
            : string(value.folderId),
        tags: stringList(value.tags),
        archived: value.archived === true,
        latestRevision: Number.isInteger(value.latestRevision) ? value.latestRevision : 0,
        thumbnails: normalizeThumbnails(value.thumbnails),
        createdAt: string(value.createdAt),
        updatedAt: string(value.updatedAt),
    };
}

export function createEmptyEditorAssetCatalog() {
    return {
        kind: EDITOR_ASSET_CATALOG_KIND,
        version: EDITOR_ASSET_CATALOG_VERSION,
        revision: 0,
        folders: [],
        assets: [],
    };
}

export function normalizeEditorAssetCatalog(value = {}) {
    const source = plain(value) ? value : {};
    return {
        kind: EDITOR_ASSET_CATALOG_KIND,
        version: EDITOR_ASSET_CATALOG_VERSION,
        revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
        folders: (Array.isArray(source.folders) ? source.folders : [])
            .map(normalizeFolder)
            .sort((left, right) => left.id.localeCompare(right.id)),
        assets: (Array.isArray(source.assets) ? source.assets : [])
            .map(normalizeAsset)
            .sort((left, right) => left.id.localeCompare(right.id)),
    };
}

function validateId(value, path, label, issues) {
    if (typeof value !== "string" || !ID.test(value)) {
        issues.push(issue(path, "editor-asset.id.invalid", `${label} must be a non-empty portable id.`));
    }
}

function duplicateIssues(records, path, issues) {
    const seen = new Set();
    records.forEach((record, index) => {
        const id = typeof record?.id === "string" ? record.id : "";
        if (id && seen.has(id)) issues.push(issue([path, index, "id"], "editor-asset.id.duplicate", `Duplicate id "${id}".`));
        seen.add(id);
    });
}

export function validateEditorAssetCatalog(value = {}) {
    const issues = [];
    if (!plain(value)) return [issue([], "editor-asset.catalog.invalid", "Editor asset catalog must be an object.")];
    if (value.kind !== EDITOR_ASSET_CATALOG_KIND) issues.push(issue(["kind"], "editor-asset.catalog.kind", `Catalog kind must be ${EDITOR_ASSET_CATALOG_KIND}.`));
    if (value.version !== EDITOR_ASSET_CATALOG_VERSION) issues.push(issue(["version"], "editor-asset.catalog.version", `Catalog version must be ${EDITOR_ASSET_CATALOG_VERSION}.`));
    if (!Number.isInteger(value.revision) || value.revision < 0) issues.push(issue(["revision"], "editor-asset.catalog.revision", "Catalog revision must be a non-negative integer."));
    const folders = Array.isArray(value.folders) ? value.folders : [];
    const assets = Array.isArray(value.assets) ? value.assets : [];
    if (!Array.isArray(value.folders)) issues.push(issue(["folders"], "editor-asset.catalog.folders", "Catalog folders must be an array."));
    if (!Array.isArray(value.assets)) issues.push(issue(["assets"], "editor-asset.catalog.assets", "Catalog assets must be an array."));
    duplicateIssues(folders, "folders", issues);
    duplicateIssues(assets, "assets", issues);
    const folderIds = new Set(folders.map((entry) => entry?.id).filter(Boolean));
    folders.forEach((folder, index) => {
        validateId(folder?.id, ["folders", index, "id"], "Folder id", issues);
        if (typeof folder?.name !== "string" || !folder.name.trim()) issues.push(issue(["folders", index, "name"], "editor-asset.folder.name", "Folder name is required."));
        if (folder?.parentId !== null && folder?.parentId !== undefined && !folderIds.has(folder.parentId)) {
            issues.push(issue(["folders", index, "parentId"], "editor-asset.folder.parent-missing", `Folder parent "${folder.parentId}" does not exist.`));
        }
        const seen = new Set([folder?.id]);
        let cursor = folder?.parentId;
        while (cursor) {
            if (seen.has(cursor)) {
                issues.push(issue(["folders", index, "parentId"], "editor-asset.folder.cycle", "Folder hierarchy contains a cycle."));
                break;
            }
            seen.add(cursor);
            cursor = folders.find((candidate) => candidate?.id === cursor)?.parentId ?? null;
        }
    });
    assets.forEach((asset, index) => {
        validateId(asset?.id, ["assets", index, "id"], "Asset id", issues);
        if (typeof asset?.name !== "string" || !asset.name.trim()) issues.push(issue(["assets", index, "name"], "editor-asset.asset.name", "Asset name is required."));
        if (asset?.folderId !== null && asset?.folderId !== undefined && !folderIds.has(asset.folderId)) {
            issues.push(issue(["assets", index, "folderId"], "editor-asset.asset.folder-missing", `Asset folder "${asset.folderId}" does not exist.`));
        }
        if (!Array.isArray(asset?.tags) || !asset.tags.every((tag) => typeof tag === "string" && tag.trim())) issues.push(issue(["assets", index, "tags"], "editor-asset.asset.tags", "Asset tags must be non-empty strings."));
        if (typeof asset?.archived !== "boolean") issues.push(issue(["assets", index, "archived"], "editor-asset.asset.archived", "Archived must be boolean."));
        if (!Number.isInteger(asset?.latestRevision) || asset.latestRevision <= 0) issues.push(issue(["assets", index, "latestRevision"], "editor-asset.asset.revision", "Latest revision must be a positive integer."));
        if (!plain(asset?.thumbnails)) issues.push(issue(["assets", index, "thumbnails"], "editor-asset.asset.thumbnails", "Thumbnails must be an object."));
        else for (const [revision, thumbnail] of Object.entries(asset.thumbnails)) {
            if (!/^\d+$/.test(revision) || Number(revision) <= 0 || !plain(thumbnail) || !SHA256.test(thumbnail.useHash ?? "") || !Number.isInteger(thumbnail.rendererVersion) || thumbnail.rendererVersion <= 0) {
                issues.push(issue(["assets", index, "thumbnails", revision], "editor-asset.thumbnail.invalid", "Thumbnail entries require a positive revision, use hash, and renderer version."));
            }
        }
        for (const field of ["createdAt", "updatedAt"]) {
            if (typeof asset?.[field] !== "string" || !Number.isFinite(Date.parse(asset[field]))) issues.push(issue(["assets", index, field], "editor-asset.timestamp.invalid", `${field} must be an ISO timestamp.`));
        }
    });
    return issues;
}

export function normalizeEditorAssetRevision(value = {}) {
    const source = plain(value) ? value : {};
    const version = source.version === EDITOR_ASSET_REVISION_VERSION_V2 ? EDITOR_ASSET_REVISION_VERSION_V2 : EDITOR_ASSET_REVISION_VERSION;
    const normalized = {
        kind: EDITOR_ASSET_REVISION_KIND,
        version,
        assetId: string(source.assetId),
        revision: Number.isInteger(source.revision) ? source.revision : 0,
        publicationId: string(source.publicationId),
        modelUseHash: string(source.modelUseHash).toLowerCase(),
        createdAt: string(source.createdAt),
    };
    if (version === EDITOR_ASSET_REVISION_VERSION_V2) {
        normalized.definition = normalizeAssetDefinition(source.definition);
        normalized.metric = normalizeAssetMetric(source.metric);
        normalized.metricHash = string(source.metricHash).toLowerCase();
        normalized.geometryHash = string(source.geometryHash).toLowerCase();
        normalized.publicationPayloadHash = string(source.publicationPayloadHash).toLowerCase();
        normalized.appearance = Array.isArray(source.appearance) ? clone(source.appearance) : [];
    }
    return normalized;
}

export function validateEditorAssetRevision(value = {}) {
    const issues = [];
    if (!plain(value)) return [issue([], "editor-asset.revision.invalid", "Editor asset revision must be an object.")];
    if (value.kind !== EDITOR_ASSET_REVISION_KIND) issues.push(issue(["kind"], "editor-asset.revision.kind", `Revision kind must be ${EDITOR_ASSET_REVISION_KIND}.`));
    if (![EDITOR_ASSET_REVISION_VERSION, EDITOR_ASSET_REVISION_VERSION_V2].includes(value.version)) issues.push(issue(["version"], "editor-asset.revision.version", `Revision version must be ${EDITOR_ASSET_REVISION_VERSION} or ${EDITOR_ASSET_REVISION_VERSION_V2}.`));
    validateId(value.assetId, ["assetId"], "Asset id", issues);
    if (!Number.isInteger(value.revision) || value.revision <= 0) issues.push(issue(["revision"], "editor-asset.revision.number", "Asset revision must be a positive integer."));
    validateId(value.publicationId, ["publicationId"], "Publication id", issues);
    if (!SHA256.test(value.modelUseHash ?? "")) issues.push(issue(["modelUseHash"], "editor-asset.revision.use-hash", "Model use hash must be a SHA-256 digest."));
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) issues.push(issue(["createdAt"], "editor-asset.timestamp.invalid", "createdAt must be an ISO timestamp."));
    if (value.version === EDITOR_ASSET_REVISION_VERSION_V2) {
        issues.push(...validateAssetDefinition(value.definition).map((entry) => ({ ...entry, path: ["definition", ...entry.path] })));
        issues.push(...validateAssetMetric(value.metric).map((entry) => ({ ...entry, path: ["metric", ...entry.path] })));
        if (!SHA256.test(value.metricHash ?? "")) issues.push(issue(["metricHash"], "editor-asset.revision.metric-hash", "metricHash must be a SHA-256 digest."));
        else {
            try { if (hashAssetMetric(value.metric) !== value.metricHash) issues.push(issue(["metricHash"], "editor-asset.revision.metric-mismatch", "metricHash does not match the canonical metric snapshot.")); }
            catch (error) { issues.push(issue(["metric"], "editor-asset.revision.metric-invalid", error.message)); }
        }
        if (!SHA256.test(value.geometryHash ?? "")) issues.push(issue(["geometryHash"], "editor-asset.revision.geometry-hash", "geometryHash must be a SHA-256 digest."));
        if (!SHA256.test(value.publicationPayloadHash ?? "")) issues.push(issue(["publicationPayloadHash"], "editor-asset.revision.publication-payload-hash", "publicationPayloadHash must bind the canonical publication payload."));
        if (!Array.isArray(value.appearance)) issues.push(issue(["appearance"], "editor-asset.revision.appearance", "appearance must be an array."));
        else value.appearance.forEach((material, index) => {
            try {
                const descriptor = {
                    ...material,
                    textures: Array.isArray(material?.textures)
                        ? material.textures.map(({ useHash: _useHash, ...texture }) => texture)
                        : material?.textures,
                };
                const assets = [...new Set((descriptor.textures ?? []).map((texture) => texture.assetUri))].map((assetUri) => ({
                    sha256: String(assetUri).replace(/^sha256:/, ""), mediaType: "image/png", sizeBytes: 1, role: "texture",
                }));
                normalizeVisualLayer({
                    kind: "cev-sim.visual-layer", version: 1,
                    sourceWorldHash: "0".repeat(64),
                    assetProfile: { id: "static-gltf-surface", version: 1 },
                    assets, materials: [descriptor], chunks: [], instances: [], bindings: [],
                    appearanceDependencies: assets.map((asset) => `sha256:${asset.sha256}`),
                });
                material?.textures?.forEach?.((texture, textureIndex) => {
                    if (!SHA256.test(texture?.useHash ?? "")) issues.push(issue(["appearance", index, "textures", textureIndex, "useHash"], "editor-asset.revision.texture-use", "Published appearance textures require a source-bound use hash."));
                });
            } catch (error) {
                issues.push(issue(["appearance", index], "editor-asset.revision.material", error.message));
            }
        });
    }
    return issues;
}

export function normalizeAssetInstanceComponent(value = {}) {
    const source = plain(value) ? value : {};
    const position = plain(source.position) ? source.position : {};
    const scale = plain(source.scale) ? source.scale : {};
    return {
        assetId: string(source.assetId),
        revision: Number.isInteger(source.revision) ? source.revision : 1,
        position: { x: Number(position.x ?? 0), y: Number(position.y ?? 0), z: Number(position.z ?? 0) },
        rotationY: Number(source.rotationY ?? 0),
        scale: { x: Number(scale.x ?? 1), y: Number(scale.y ?? 1), z: Number(scale.z ?? 1) },
        overrides: plain(source.overrides) ? clone(source.overrides) : {},
    };
}

export function validateAssetInstanceComponent(value = {}) {
    const issues = [];
    if (!plain(value)) return [issue([], "editor-asset.instance.invalid", "Asset component must be an object.")];
    validateId(value.assetId, ["assetId"], "Asset id", issues);
    if (!Number.isInteger(value.revision) || value.revision <= 0) issues.push(issue(["revision"], "editor-asset.instance.revision", "Asset revision must be a positive integer."));
    const vector = (entry, path, positive = false) => {
        if (!plain(entry)) {
            issues.push(issue(path, "editor-asset.instance.vector", `${path.at(-1)} must be a vector.`));
            return;
        }
        for (const axis of ["x", "y", "z"]) {
            if (!Number.isFinite(entry[axis]) || (positive && entry[axis] <= 0)) issues.push(issue([...path, axis], positive ? "editor-asset.instance.scale" : "editor-asset.instance.finite", `${path.at(-1)}.${axis} must be ${positive ? "positive and " : ""}finite.`));
        }
    };
    vector(value.position, ["position"]);
    vector(value.scale, ["scale"], true);
    if (!Number.isFinite(value.rotationY)) issues.push(issue(["rotationY"], "editor-asset.instance.finite", "rotationY must be finite."));
    if (!plain(value.overrides) || Object.keys(value.overrides).length > 0) issues.push(issue(["overrides"], "editor-asset.instance.overrides", "ED-06 asset overrides must be an empty object."));
    return issues;
}

export function collectAssetInstanceReferences(document = {}) {
    return (Array.isArray(document?.objects) ? document.objects : [])
        .map((record) => ({ record, asset: readAssetBinding(record) }))
        .filter(({ asset }) => Boolean(asset))
        .map(({ record, asset }) => ({
            objectId: String(record.id ?? ""),
            assetId: String(asset.assetId ?? ""),
            revision: asset.revision,
        }))
        .sort((left, right) => left.objectId.localeCompare(right.objectId));
}
