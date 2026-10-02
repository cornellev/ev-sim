/** Publish a v2 obstacle revision for a catalog pin, reusing one when it already matches. */

import { normalizePerceptionClassName } from "../../../autonomy/PerceptionLabelCatalog.js";
import { compileAssetDefinition, createObstacleProxies } from "../../../editor-assets/AssetCompiler.js";
import { createImportedAssetDefinition, extractAssetSourceGeometries } from "./AssetModelLoader.js";

function lidarMatches(revision, semantic) {
    const lidar = revision?.metric?.lidar ?? [];
    return lidar.length > 0 && lidar.every((entry) => normalizePerceptionClassName(entry.semantic) === semantic);
}

export function revisionIsObstacle(revision, semantic = "unknown") {
    const wanted = normalizePerceptionClassName(semantic);
    return revision?.version === 2
        && (revision.metric?.collision?.length ?? 0) > 0
        && lidarMatches(revision, wanted);
}

function releaseLeases(leases) {
    for (const lease of leases) lease?.release?.();
}

export class AssetObstaclePublisher {
    constructor({ repository, models } = {}) {
        if (!repository || !models) throw new TypeError("AssetObstaclePublisher requires a repository and model loader.");
        this.repository = repository;
        this.models = models;
    }

    async ensureObstacleRevision({ assetId, revision, semantic = "unknown", signal } = {}) {
        const wanted = normalizePerceptionClassName(semantic);
        const requested = await this.repository.getRevision(assetId, revision, { signal });
        if (revisionIsObstacle(requested, wanted)) return requested;
        const catalog = await this.repository.get(assetId, { signal });
        const latestNumber = catalog.asset.latestRevision;
        const latest = latestNumber === requested.revision
            ? requested
            : await this.repository.getRevision(assetId, latestNumber, { signal });
        if (revisionIsObstacle(latest, wanted)) return latest;

        const leases = [];
        try {
            const loaded = await this._definitionFor(latest, catalog.asset.name, signal);
            leases.push(...loaded.leases);
            const partIds = loaded.definition.parts
                .filter((part) => part.content.kind === "model-node")
                .map((part) => part.id);
            const proxies = createObstacleProxies(loaded.definition, {
                sourceGeometries: loaded.sourceGeometries,
                semantic: wanted,
                partIds,
            });
            const definition = {
                ...loaded.definition,
                collisionProxies: [proxies.collision],
                lidarProxies: [proxies.lidar],
            };
            const compiled = compileAssetDefinition(definition, { sourceGeometries: loaded.sourceGeometries });
            if (compiled.staleProxyIds.length > 0) {
                throw new Error(`Regenerate or disable stale proxies: ${compiled.staleProxyIds.join(", ")}.`);
            }
            const published = await this.repository.publishRevision(assetId, {
                publicationId: globalThis.crypto?.randomUUID?.() ?? `publication-${Date.now().toString(36)}`,
                name: catalog.asset.name,
                modelUseHash: latest.modelUseHash,
                expectedAssetRevision: latestNumber,
                definition: compiled.definition,
                metric: compiled.metric,
                metricHash: compiled.metricHash,
                appearance: compiled.materials,
                geometryHash: "0".repeat(64),
            }, catalog.catalogRevision, { signal });
            return published.revision;
        } finally {
            releaseLeases(leases);
        }
    }

    async _definitionFor(revision, name, signal) {
        if (revision.definition) {
            const sourceGeometries = {};
            const leases = [];
            for (const source of revision.definition.sources) {
                const lease = await this.models.acquire(source.modelUseHash, { signal });
                leases.push(lease);
                sourceGeometries[source.id] = Object.fromEntries(extractAssetSourceGeometries(lease));
            }
            return { definition: structuredClone(revision.definition), sourceGeometries, leases };
        }
        const lease = await this.models.acquireRevision(revision, { signal });
        const definition = createImportedAssetDefinition({
            lease,
            modelUseHash: revision.modelUseHash,
            name: name ?? revision.assetId,
        });
        const sourceId = definition.sources[0]?.id ?? "source";
        return {
            definition,
            sourceGeometries: { [sourceId]: Object.fromEntries(extractAssetSourceGeometries(lease)) },
            leases: [lease],
        };
    }
}
