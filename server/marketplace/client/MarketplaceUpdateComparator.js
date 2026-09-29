import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "../MarketplaceJson.js";

function setDelta(before, after) {
    const left = new Set(before);
    const right = new Set(after);
    return Object.freeze({
        added: Object.freeze([...right].filter((value) => !left.has(value)).sort(compareUtf8)),
        removed: Object.freeze([...left].filter((value) => !right.has(value)).sort(compareUtf8)),
    });
}

function executableIdentities(release, inspection = null) {
    const identities = [];
    const direct = inspection?.identity ?? release.executable;
    if (release.contentKind === "plugin" && direct) {
        identities.push({
            pluginId: direct.pluginId,
            packageHash: direct.packageHash,
            runtimeHash: direct.runtimeHash,
            role: "direct",
        });
    }
    for (const plugin of release.embeddedPlugins ?? []) identities.push({ ...plugin, role: "embedded" });
    return identities.sort((left, right) => compareUtf8(`${left.pluginId}\u0000${left.packageHash}`, `${right.pluginId}\u0000${right.packageHash}`));
}

function executableDelta(before, after) {
    const keyed = (values) => new Map(values.map((entry) => [entry.pluginId, entry]));
    const left = keyed(before);
    const right = keyed(after);
    const added = [...right.keys()].filter((key) => !left.has(key)).map((key) => right.get(key));
    const removed = [...left.keys()].filter((key) => !right.has(key)).map((key) => left.get(key));
    const changed = [...right.keys()].filter((key) => left.has(key)
        && (left.get(key).packageHash !== right.get(key).packageHash || left.get(key).runtimeHash !== right.get(key).runtimeHash))
        .map((key) => ({ before: left.get(key), after: right.get(key) }));
    return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed), changed: Object.freeze(changed) });
}

export class MarketplaceUpdateComparator {
    static compare({
        installedRelease,
        candidateRelease,
        installedInspection = null,
        candidateInspection = null,
        installedCompatibility,
        candidateCompatibility,
        installedAdapterPlan,
        candidateAdapterPlan,
        receiptMappings = [],
    }) {
        const comparison = Object.freeze({
            capabilities: setDelta(installedRelease.capabilities, candidateRelease.capabilities),
            executables: executableDelta(
                executableIdentities(installedRelease, installedInspection),
                executableIdentities(candidateRelease, candidateInspection),
            ),
            compatibility: Object.freeze({
                before: structuredClone(installedCompatibility),
                after: structuredClone(candidateCompatibility),
                regression: Boolean(installedCompatibility?.compatible && !candidateCompatibility?.compatible),
            }),
            rights: Object.freeze({
                before: structuredClone(installedAdapterPlan?.rights ?? []),
                after: structuredClone(candidateAdapterPlan?.rights ?? []),
                denied: Object.freeze((candidateAdapterPlan?.rights ?? []).filter((entry) => entry.allowed === false || entry.verdict === "denied")),
            }),
            mappings: Object.freeze({
                installed: structuredClone(receiptMappings),
                candidate: structuredClone(candidateAdapterPlan?.mappings ?? []),
            }),
        });
        return Object.freeze({ comparison, comparisonHash: hashMarketplaceBytes(canonicalMarketplaceBytes(comparison)) });
    }
}
