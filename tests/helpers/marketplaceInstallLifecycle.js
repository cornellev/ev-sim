import assert from "node:assert/strict";

import {
    ArtifactAdapterRegistry,
    defineArtifactAdapter,
    pluginArtifactAdapter,
} from "../../server/marketplace/ArtifactAdapters.js";

export function createTestLifecycleRegistry(commits = [], {
    denyRights = false,
    localRevisionProvider = () => 0,
} = {}) {
    const adapter = defineArtifactAdapter({
        id: "test-plugin-lifecycle@1",
        contentKind: "plugin",
        async inspect(self, handle, context) {
            const inspection = await pluginArtifactAdapter.inspect(handle, context);
            return Object.freeze({ ...structuredClone(inspection), adapterId: self.id });
        },
        async plan(_self, { release, context }) {
            const localRevision = localRevisionProvider();
            return {
                preconditions: [{ kind: "installed-ledger", revision: context.installed.revision }],
                rights: [{ id: "plugin-files", allowed: !denyRights }],
                conflicts: [],
                mappings: [{
                    resourceKind: "plugin",
                    sourceId: release.itemId,
                    sourceRevision: 0,
                    localId: release.itemId,
                    localRevision,
                    hashes: { artifact: release.artifact.sha256 },
                }],
                warnings: [],
                blockingIssues: [],
            };
        },
        async commit(_self, { release, transactionId }) {
            const key = `${transactionId}:${release.itemId}@${release.releaseVersion}`;
            if (!commits.includes(key)) commits.push(key);
        },
        async createReceipt(_self, { adapterPlan }) {
            return { mappings: adapterPlan.mappings };
        },
    });
    return new ArtifactAdapterRegistry([adapter]);
}

export async function configureMarketplaceSource(service, registry) {
    const preview = await service.previewSource({ baseUrl: registry.baseUrl });
    const added = await service.addSource({
        expectedRevision: 0,
        name: "Install Registry",
        baseUrl: registry.baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 0,
    });
    await service.refreshSource(added.source.sourceId, { expectedRevision: 1 });
    return added.source.sourceId;
}

export async function waitForInstallJob(service, jobId, phases, timeoutMs = 10_000) {
    const accepted = new Set(Array.isArray(phases) ? phases : [phases]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const view = await service.getInstallJob(jobId);
        if (accepted.has(view.job.phase)) return view;
        if (["failed", "cancelled", "complete"].includes(view.job.phase)) {
            assert.fail(`Job reached ${view.job.phase}: ${JSON.stringify(view.job.error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${[...accepted].join(", ")}`);
}
