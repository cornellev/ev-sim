import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";

function key(value) {
    return `${value.itemId}\u0000${value.releaseVersion}`;
}

function tupleKey(value) {
    return `${key(value)}\u0000${value.artifactSha256 ?? value.artifact.sha256}`;
}

function display(value) {
    return `${value.itemId}@${value.releaseVersion}`;
}

function exactMatches(reference, release) {
    return release && release.artifact.sha256 === reference.artifactSha256;
}

function exactRef(release) {
    return Object.freeze({
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifactSha256 ?? release.artifact.sha256,
    });
}

function ownerKey(owner) {
    return owner.kind === "direct" ? "direct" : `collection\u0000${tupleKey(owner.collection)}`;
}

export function resolveDependencyDag({
    rootRelease,
    catalog,
    releases,
    releasePolicy = () => Object.freeze({ blocked: false, warnings: Object.freeze([]) }),
}) {
    const releaseMap = new Map();
    for (const release of releases) {
        const releaseKey = key(release);
        const previous = releaseMap.get(releaseKey);
        if (previous && previous.artifact.sha256 !== release.artifact.sha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, `Verified snapshot rewrites ${display(release)}.`);
        }
        releaseMap.set(releaseKey, release);
    }
    const root = releaseMap.get(key(rootRelease));
    if (!root || root.artifact.sha256 !== rootRelease.artifactSha256) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Requested exact marketplace release is not present in the verified snapshot.");
    }
    const yanked = new Set(catalog.yanks.map((entry) => `${key(entry.release)}\u0000${entry.release.artifactSha256}`));
    const state = new Map();
    const stack = [];
    const reachable = new Map();
    const warnings = [];

    const visit = (release) => {
        const releaseKey = key(release);
        const current = state.get(releaseKey);
        if (current === "done") return;
        if (current === "visiting") {
            const start = stack.findIndex((entry) => key(entry) === releaseKey);
            const cycle = [...stack.slice(start), release].map(display).join(" -> ");
            throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, `Marketplace dependency cycle: ${cycle}.`);
        }
        const policy = releasePolicy(release) ?? {};
        if (policy.blocked) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RELEASE_BLOCKED, `Marketplace release ${display(release)} is blocked.`);
        }
        for (const warning of policy.warnings ?? []) warnings.push(String(warning));
        if (yanked.has(`${releaseKey}\u0000${release.artifact.sha256}`)) {
            warnings.push(`Exact release ${display(release)} is yanked.`);
        }
        state.set(releaseKey, "visiting");
        stack.push(release);
        const dependencies = [...release.dependencies].sort((left, right) => compareUtf8(tupleKey(left), tupleKey(right)));
        for (const dependency of dependencies) {
            const resolved = releaseMap.get(key(dependency));
            if (!exactMatches(dependency, resolved)) {
                throw marketplaceError(
                    MARKETPLACE_ERROR_CODES.INCOMPATIBLE,
                    `Exact dependency ${display(dependency)} is missing or has a different artifact digest.`,
                );
            }
            visit(resolved);
        }
        stack.pop();
        state.set(releaseKey, "done");
        reachable.set(releaseKey, release);
    };

    visit(root);
    const pendingDependencies = new Map();
    const dependents = new Map();
    for (const [releaseKey, release] of reachable) {
        const dependencies = new Set(release.dependencies.map(key));
        pendingDependencies.set(releaseKey, dependencies.size);
        for (const dependencyKey of dependencies) {
            const entries = dependents.get(dependencyKey) ?? [];
            entries.push(releaseKey);
            dependents.set(dependencyKey, entries);
        }
    }
    const ready = [...reachable.entries()]
        .filter(([releaseKey]) => pendingDependencies.get(releaseKey) === 0)
        .map(([, release]) => release)
        .sort((left, right) => compareUtf8(tupleKey(left), tupleKey(right)));
    const ordered = [];
    while (ready.length) {
        const release = ready.shift();
        ordered.push(release);
        const nextKeys = (dependents.get(key(release)) ?? [])
            .sort((left, right) => compareUtf8(tupleKey(reachable.get(left)), tupleKey(reachable.get(right))));
        for (const dependentKey of nextKeys) {
            const remaining = pendingDependencies.get(dependentKey) - 1;
            pendingDependencies.set(dependentKey, remaining);
            if (remaining === 0) {
                ready.push(reachable.get(dependentKey));
                ready.sort((left, right) => compareUtf8(tupleKey(left), tupleKey(right)));
            }
        }
    }
    return Object.freeze({
        releases: Object.freeze(ordered.map((release) => Object.freeze(structuredClone(release)))),
        warnings: Object.freeze([...new Set(warnings)].sort(compareUtf8)),
    });
}

export function resolveInstallGraph(input) {
    const dependencyDag = resolveDependencyDag(input);
    const byKey = new Map(dependencyDag.releases.map((release) => [key(release), release]));
    const requested = new Set([key(input.rootRelease)]);
    const owners = new Map([[key(input.rootRelease), [{ kind: "direct" }]]]);
    const pendingCollections = [];
    const root = byKey.get(key(input.rootRelease));
    if (root.contentKind === "collection") pendingCollections.push(root);

    const expandedCollections = new Set();
    while (pendingCollections.length) {
        pendingCollections.sort((left, right) => compareUtf8(tupleKey(left), tupleKey(right)));
        const collection = pendingCollections.shift();
        const collectionKey = key(collection);
        if (expandedCollections.has(collectionKey)) continue;
        expandedCollections.add(collectionKey);
        const collectionOwner = Object.freeze({ kind: "collection", collection: exactRef(collection) });
        for (const dependency of collection.dependencies) {
            const member = byKey.get(key(dependency));
            requested.add(key(member));
            const memberOwners = owners.get(key(member)) ?? [];
            if (!memberOwners.some((entry) => ownerKey(entry) === ownerKey(collectionOwner))) {
                memberOwners.push(collectionOwner);
                memberOwners.sort((left, right) => compareUtf8(ownerKey(left), ownerKey(right)));
                owners.set(key(member), memberOwners);
            }
            if (member.contentKind === "collection") pendingCollections.push(member);
        }
    }

    const entries = dependencyDag.releases.map((release) => Object.freeze({
        release,
        disposition: requested.has(key(release))
            ? (release.contentKind === "collection" ? "collection" : "requested")
            : "artifact-only",
        owners: Object.freeze((owners.get(key(release)) ?? []).map((owner) => Object.freeze(structuredClone(owner)))),
    }));
    return Object.freeze({
        releases: Object.freeze(entries),
        warnings: dependencyDag.warnings,
    });
}
