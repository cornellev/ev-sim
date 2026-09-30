import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";

const KINDS = new Set(["plugin", "vehicle", "run-template", "environment", "asset-pack"]);
const SORTS = new Set(["name", "updated", "kind"]);
const DIRECTIONS = new Set(["asc", "desc"]);
const STATUSES = new Set(["all", "publishable", "unavailable", "unpublished", "drafted", "published"]);

function invalid(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message);
}

function number(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined || value === null || value === "") return fallback;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(String(value))) invalid("Publication catalog pagination is invalid.");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid("Publication catalog pagination is outside its allowed range.");
    return parsed;
}

function timestamp(value) {
    const parsed = new Date(value ?? 0).valueOf();
    return Number.isFinite(parsed) ? parsed : 0;
}

function entry(value) {
    return Object.freeze({
        ...value,
        searchText: `${value.name} ${value.localId} ${value.contentKind} ${(value.tags ?? []).join(" ")}`.toLowerCase(),
    });
}

function selectionKeys(selection) {
    if (selection.kind === "plugin") return [`plugin:${selection.packageHash}`];
    if (selection.kind === "vehicle") return [`vehicle:${selection.vehicleId}:${selection.expectedRevision}:${selection.definitionHash}`];
    if (selection.kind === "run-template") return [`run-template:${selection.manifestId}:${selection.expectedRevision}:${selection.definitionHash}`];
    if (selection.kind === "environment") return [`environment:${selection.environmentId}:${selection.expectedRevision}`];
    if (selection.kind === "asset-pack") return selection.roots.map((root) => `asset-pack:${root.assetId}:${root.revision}`);
    return [];
}

export class MarketplacePublicationCatalog {
    constructor({ storageService, editorAssetStore, draftStore = null }) {
        if (!storageService || !editorAssetStore) throw new TypeError("Publication catalog requires authoring stores.");
        this.storageService = storageService;
        this.editorAssetStore = editorAssetStore;
        this.draftStore = draftStore;
    }

    async #entries() {
        const [library, vehicles, runs, environments, assets] = await Promise.all([
            this.storageService.listPluginLibrary(),
            this.storageService.listVehicleManifests(),
            this.storageService.listRunManifests(),
            this.storageService.listEnvironments(),
            this.editorAssetStore.list({ sort: "name", direction: "asc" }),
        ]);
        const entries = [
            ...library.packages.map((current) => entry({
                key: `plugin:${current.packageHash}`,
                contentKind: "plugin",
                localId: current.pluginId,
                name: `${current.pluginId} ${current.version}`,
                summary: `Portable plugin ${current.pluginId}@${current.version}`,
                revision: library.revision,
                identity: {
                    pluginId: current.pluginId,
                    version: current.version,
                    packageHash: current.packageHash,
                    runtimeHash: current.runtimeHash,
                    uiHash: current.uiHash ?? null,
                },
                localSelection: { kind: "plugin", packageHash: current.packageHash, libraryRevision: library.revision },
                publishable: true,
                unavailableReason: null,
                updatedAt: null,
                tags: [],
            })),
            ...vehicles.map((current) => entry({
                key: `vehicle:${current.id}:${current.revision}`,
                contentKind: "vehicle",
                localId: current.id,
                name: current.name || current.id,
                summary: current.description || "Custom simulator vehicle",
                revision: current.revision,
                identity: { definitionHash: current.definitionHash },
                localSelection: {
                    kind: "vehicle",
                    vehicleId: current.id,
                    expectedRevision: current.revision,
                    definitionHash: current.definitionHash,
                },
                publishable: true,
                unavailableReason: null,
                updatedAt: current.updatedAt ?? null,
                tags: [],
            })),
            ...runs.map((current) => entry({
                key: `run-template:${current.id}:${current.revision}`,
                contentKind: "run-template",
                localId: current.id,
                name: current.name || current.id,
                summary: current.description || "Editable run configuration",
                revision: current.revision,
                identity: { definitionHash: current.definitionHash },
                localSelection: {
                    kind: "run-template",
                    manifestId: current.id,
                    expectedRevision: current.revision,
                    definitionHash: current.definitionHash,
                    pluginBindings: [],
                },
                publishable: current.revision > 0,
                unavailableReason: current.revision > 0 ? null : "Built-in run configurations must be saved before publication.",
                updatedAt: current.updatedAt ?? null,
                tags: [],
            })),
            ...environments.map((current) => entry({
                key: `environment:${current.id}:${current.revision}`,
                contentKind: "environment",
                localId: current.id,
                name: current.name || current.id,
                summary: current.templateId ? `Environment based on ${current.templateId}` : "Simulator environment",
                revision: current.revision,
                identity: { sourceKind: current.sourceKind, builtIn: current.builtIn },
                localSelection: { kind: "environment", environmentId: current.id, expectedRevision: current.revision },
                publishable: !current.builtIn && current.revision > 0,
                unavailableReason: current.builtIn ? "Built-in environments must be saved as authored environments before publication." : null,
                updatedAt: current.updatedAt ?? null,
                tags: [],
            })),
            ...assets.assets.map((current) => entry({
                key: `asset-pack:${current.id}:${current.latestRevision}`,
                contentKind: "asset-pack",
                localId: current.id,
                name: current.name || current.id,
                summary: `Editor asset revision ${current.latestRevision}`,
                revision: current.latestRevision,
                identity: { assetId: current.id, revision: current.latestRevision },
                localSelection: {
                    kind: "asset-pack",
                    roots: [{ assetId: current.id, revision: current.latestRevision }],
                    catalogRevision: assets.catalogRevision,
                },
                publishable: !current.archived,
                unavailableReason: current.archived ? "Archived editor assets cannot start a publication draft." : null,
                updatedAt: current.updatedAt ?? null,
                tags: current.tags ?? [],
            })),
        ];
        const publicationStates = new Map();
        for (const draft of this.draftStore?.snapshot().drafts ?? []) {
            for (const key of selectionKeys(draft.localSelection)) {
                const state = draft.state === "published" ? "published" : "drafted";
                if (state === "published" || !publicationStates.has(key)) publicationStates.set(key, state);
            }
        }
        return entries.map((current) => Object.freeze({
            ...current,
            publicationStatus: publicationStates.get(selectionKeys(current.localSelection)[0]) ?? "unpublished",
        }));
    }

    async list({ q = "", contentKind = null, status = "all", sort = "name", direction = "asc", offset, limit } = {}) {
        const normalizedQuery = String(q).trim().toLowerCase().slice(0, 256);
        const normalizedKind = contentKind || null;
        if (normalizedKind && !KINDS.has(normalizedKind)) invalid("Publication catalog contentKind is invalid.");
        if (!STATUSES.has(status)) invalid("Publication catalog status is invalid.");
        if (!SORTS.has(sort)) invalid("Publication catalog sort is invalid.");
        if (!DIRECTIONS.has(direction)) invalid("Publication catalog direction is invalid.");
        const resolvedOffset = number(offset, 0);
        const resolvedLimit = number(limit, 50, { min: 1, max: 100 });
        const filtered = (await this.#entries()).filter((current) => (
            (!normalizedKind || current.contentKind === normalizedKind)
            && (status === "all" || (["publishable", "unavailable"].includes(status)
                ? (status === "publishable") === current.publishable
                : current.publicationStatus === status))
            && (!normalizedQuery || current.searchText.includes(normalizedQuery))
        ));
        const sign = direction === "desc" ? -1 : 1;
        filtered.sort((left, right) => {
            if (sort === "updated") return sign * (timestamp(left.updatedAt) - timestamp(right.updatedAt)) || compareUtf8(left.key, right.key);
            if (sort === "kind") return sign * compareUtf8(left.contentKind, right.contentKind) || compareUtf8(left.name, right.name);
            return sign * compareUtf8(left.name.toLowerCase(), right.name.toLowerCase()) || compareUtf8(left.key, right.key);
        });
        return Object.freeze({
            query: Object.freeze({ q: normalizedQuery, contentKind: normalizedKind, status, sort, direction, offset: resolvedOffset, limit: resolvedLimit }),
            page: Object.freeze({ offset: resolvedOffset, limit: resolvedLimit, total: filtered.length }),
            entries: Object.freeze(filtered.slice(resolvedOffset, resolvedOffset + resolvedLimit).map(({ searchText: _searchText, ...current }) => Object.freeze(current))),
            facets: Object.freeze(Object.fromEntries([...KINDS].map((kind) => [kind, filtered.filter((current) => current.contentKind === kind).length]))),
        });
    }
}
