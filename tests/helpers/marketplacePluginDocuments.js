import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";

export function marketplacePluginDocuments({ item, release, artifact, resource }) {
    const verified = verifyPluginPackage(resource);
    const pluginId = verified.document.id;
    const releaseVersion = verified.document.version;
    return Object.freeze({
        item: Object.freeze({
            ...structuredClone(item),
            itemId: pluginId,
            contentKind: "plugin",
        }),
        release: Object.freeze({
            ...structuredClone(release),
            itemId: pluginId,
            releaseVersion,
            contentKind: "plugin",
            artifact: structuredClone(artifact),
            compatibility: {
                ...structuredClone(release.compatibility),
                cevSim: verified.document.engines.cevSim,
                contracts: [{ kind: "cev-sim.plugin-package", versions: [1] }],
            },
            capabilities: [...verified.document.capabilities],
        }),
        verified,
    });
}
