/** Classify AssetDocument change sets for incremental Asset Studio projection. */

function jsonEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function asMap(value) {
    if (value instanceof Map) return value;
    if (value && typeof value === "object") return new Map(Object.entries(value));
    return new Map();
}

function emptyClassification() {
    return {
        rebuildAppearance: false,
        refreshMaterials: false,
        reconcileSourceLeases: false,
        reconcileChildLeases: false,
        applyNormalization: false,
        transformPartIds: new Set(),
        visibilityPartIds: new Set(),
        rebuildCollision: false,
        rebuildLidar: false,
    };
}

/**
 * @param {object|null|undefined} changeSet
 * @returns {{
 *   rebuildAppearance: boolean,
 *   refreshMaterials: boolean,
 *   reconcileSourceLeases: boolean,
 *   reconcileChildLeases: boolean,
 *   applyNormalization: boolean,
 *   transformPartIds: Set<string>,
 *   visibilityPartIds: Set<string>,
 *   rebuildCollision: boolean,
 *   rebuildLidar: boolean,
 * }}
 */
export function classifyAssetStudioChangeSet(changeSet) {
    const result = emptyClassification();
    if (!changeSet || typeof changeSet !== "object") return result;
    const domains = changeSet.domains ?? {};
    const scalars = changeSet.scalars ?? {};

    if (domains.sources) {
        result.reconcileSourceLeases = true;
        result.rebuildAppearance = true;
    }

    if (domains.parts) {
        const before = asMap(domains.parts.before);
        const after = asMap(domains.parts.after);
        for (const id of new Set([...before.keys(), ...after.keys()])) {
            const left = before.get(id) ?? null;
            const right = after.get(id) ?? null;
            if (!left || !right) {
                result.reconcileChildLeases = true;
                result.rebuildAppearance = true;
                continue;
            }
            if (
                left.parentId !== right.parentId
                || !jsonEqual(left.content, right.content)
                || !jsonEqual(left.materialBindings, right.materialBindings)
            ) {
                result.reconcileChildLeases = true;
                result.rebuildAppearance = true;
                continue;
            }
            if (!jsonEqual(left.transform, right.transform)) result.transformPartIds.add(id);
            if (left.appearanceVisible !== right.appearanceVisible) result.visibilityPartIds.add(id);
        }
    }

    if (domains.materials) result.refreshMaterials = true;
    if (scalars.normalization) result.applyNormalization = true;
    if (domains.collisionProxies) result.rebuildCollision = true;
    if (domains.lidarProxies) result.rebuildLidar = true;
    return result;
}
