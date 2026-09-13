/** Compile pinned v2 asset appearance into ordinary visual-layer v1 records. */

import {
    VISUAL_ASSET_PROFILE,
    VISUAL_LAYER_KIND,
    VISUAL_LAYER_VERSION,
    normalizeVisualLayer,
} from "../simulation/visual/VisualLayer.js";
import { readAssetBinding } from "./AssetBackedObject.js";

function instanceMatrix(asset) {
    const c = Math.cos(asset.rotationY);
    const s = Math.sin(asset.rotationY);
    return [
        c * asset.scale.x, 0, -s * asset.scale.x, 0,
        0, asset.scale.y, 0, 0,
        s * asset.scale.z, 0, c * asset.scale.z, 0,
        asset.position.x, asset.position.y, asset.position.z, 1,
    ];
}

function rootUseHashes(input) {
    return [
        input.revision.modelUseHash,
        ...input.revision.appearance.flatMap((material) => material.textures.map((texture) => texture.useHash)),
    ];
}

function reachableUses(roots, usesByHash) {
    const result = new Map();
    const visit = (useHash) => {
        if (result.has(useHash)) return;
        const use = usesByHash.get(useHash);
        if (!use) throw new TypeError(`Visual asset use ${useHash} is missing from the validated closure.`);
        result.set(useHash, use);
        Object.values(use.dependencies ?? {}).sort().forEach(visit);
    };
    roots.forEach(visit);
    return result;
}

function descriptorMaterial(material) {
    return {
        ...structuredClone(material),
        textures: material.textures.map(({ useHash: _useHash, ...texture }) => texture),
    };
}

export function compileAssetVisualLayer({ world, inputs = [], closureUses = [] } = {}) {
    const usesByHash = new Map(closureUses.map((entry) => [entry.useHash, entry.use]));
    const allUses = new Map();
    const materials = new Map();
    const instances = [];
    const chunks = [];
    const bindings = [];
    const truthIds = new Set((world?.description?.assetProxies ?? []).map((entry) => String(entry.sourceId)));
    for (const input of [...inputs].sort((left, right) => String(left.record.id).localeCompare(String(right.record.id)))) {
        const roots = rootUseHashes(input);
        const reached = reachableUses(roots, usesByHash);
        for (const [useHash, use] of reached) allUses.set(useHash, use);
        const asset = readAssetBinding(input.record);
        const modelUse = usesByHash.get(input.revision.modelUseHash);
        if (!modelUse) throw new TypeError(`Compiled appearance use ${input.revision.modelUseHash} is missing.`);
        for (const material of input.revision.appearance) {
            const normalized = descriptorMaterial(material);
            materials.set(normalized.id, normalized);
        }
        const id = `asset:${input.record.id}`;
        const chunkId = `asset-chunk:${input.record.id}`;
        const dependencyUris = [...new Set([...reached.values()].map((use) => `sha256:${use.asset.sha256}`))].sort();
        instances.push({
            id,
            assetUri: `sha256:${modelUse.asset.sha256}`,
            lodLevels: [`sha256:${modelUse.asset.sha256}`],
            matrix: instanceMatrix(asset),
            chunkIds: [chunkId],
            materialIds: input.revision.appearance.map((material) => material.id).sort(),
        });
        chunks.push({ id: chunkId, instanceIds: [id], dependencyUris });
        if (truthIds.has(String(input.record.id))) bindings.push({ id: `asset-binding:${input.record.id}`, instanceId: id, truthEntityId: String(input.record.id) });
    }
    const assets = [...allUses.values()].map((use) => use.asset).sort((left, right) => left.sha256.localeCompare(right.sha256));
    const description = normalizeVisualLayer({
        kind: VISUAL_LAYER_KIND,
        version: VISUAL_LAYER_VERSION,
        sourceWorldHash: world.hash,
        assetProfile: VISUAL_ASSET_PROFILE,
        assets,
        materials: [...materials.values()],
        chunks,
        instances,
        bindings,
        appearanceDependencies: assets.map((asset) => `sha256:${asset.sha256}`),
    });
    return {
        description,
        assetUses: [...allUses].map(([useHash, use]) => ({ sha256: use.asset.sha256, useHash })).sort((left, right) => left.sha256.localeCompare(right.sha256)),
        rootUseHashes: [...new Set(inputs.flatMap(rootUseHashes))].sort(),
    };
}

export function composeVisualLayers(base, addition) {
    if (!base) return addition;
    if (!addition || addition.instances.length === 0) return base;
    if (base.sourceWorldHash !== addition.sourceWorldHash) throw new TypeError("Visual layers must bind the same world before composition.");
    const merge = (left, right, key) => [...new Map([...left, ...right].map((entry) => [entry[key], entry])).values()];
    return normalizeVisualLayer({
        ...base,
        assets: merge(base.assets, addition.assets, "sha256"),
        materials: merge(base.materials, addition.materials, "id"),
        chunks: merge(base.chunks, addition.chunks, "id"),
        instances: merge(base.instances, addition.instances, "id"),
        bindings: merge(base.bindings, addition.bindings, "id"),
        appearanceDependencies: [...new Set([...base.appearanceDependencies, ...addition.appearanceDependencies])],
    });
}
