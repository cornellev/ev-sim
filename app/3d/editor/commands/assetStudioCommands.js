/** Command factories for isolated ED-07 AssetDocument sessions. */

import { normalizeAssetDefinition, validateAssetDefinition } from "../../../editor-assets/AssetDefinition.js";
import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "./commandIssues.js";

function clone(value) { return structuredClone(value); }

function commit(ctx, candidate, result = {}) {
    const rawIssues = validateAssetDefinition(candidate);
    if (rawIssues.some((entry) => entry.severity === "error")) return commandFailure(rawIssues);
    const normalized = normalizeAssetDefinition(candidate);
    const issues = validateAssetDefinition(normalized);
    if (issues.some((entry) => entry.severity === "error")) return commandFailure(issues);
    const applied = ctx.document.replaceDefinition(normalized, { notify: false });
    return applied.ok ? commandSuccess(result) : commandFailure(applied.issues);
}

function command(id, label, mutate) {
    return { id, label, run(ctx) {
        try { return mutate(ctx, ctx.document.snapshot()); }
        catch (error) { return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, error.message)); }
    } };
}

function find(list, id, label) {
    const index = list.findIndex((entry) => entry.id === String(id));
    if (index < 0) throw new Error(`${label} "${id}" does not exist.`);
    return index;
}

export const assetStudioCommands = Object.freeze({
    setNormalization(patch = {}) {
        return command("asset-set-normalization", "Set asset normalization", (ctx, definition) => commit(ctx, {
            ...definition, normalization: { ...definition.normalization, ...clone(patch) },
        }));
    },

    addPart(part) {
        return command("asset-add-part", "Add asset part", (ctx, definition) => {
            if (definition.parts.some((entry) => entry.id === String(part?.id))) throw new Error(`Part "${part?.id}" already exists.`);
            return commit(ctx, { ...definition, parts: [...definition.parts, clone(part)] }, { partId: String(part.id) });
        });
    },

    updatePart(partId, patch) {
        return command("asset-update-part", "Update asset part", (ctx, definition) => {
            const index = find(definition.parts, partId, "Part");
            definition.parts[index] = { ...definition.parts[index], ...clone(patch), transform: patch?.transform ? { ...definition.parts[index].transform, ...clone(patch.transform) } : definition.parts[index].transform };
            return commit(ctx, definition, { partId: String(partId) });
        });
    },

    transformPart(partId, transform) {
        return this.updatePart(partId, { transform });
    },

    reparentPart(partId, parentId, order = 0) {
        return this.updatePart(partId, { parentId: parentId === null ? null : String(parentId), order });
    },

    deletePart(partId) {
        return command("asset-delete-part", "Delete asset part", (ctx, definition) => {
            find(definition.parts, partId, "Part");
            const removed = new Set([String(partId)]);
            let changed = true;
            while (changed) { changed = false; for (const part of definition.parts) if (part.parentId && removed.has(part.parentId) && !removed.has(part.id)) { removed.add(part.id); changed = true; } }
            definition.parts = definition.parts.filter((entry) => !removed.has(entry.id));
            for (const proxy of [...definition.lidarProxies, ...definition.collisionProxies]) if (proxy.generated) proxy.generated.includedPartIds = proxy.generated.includedPartIds.filter((id) => !removed.has(id));
            return commit(ctx, definition, { partIds: [...removed].sort() });
        });
    },

    deleteParts({ partIds = [] } = {}) {
        return command("asset-delete-parts", "Delete asset parts", (ctx, definition) => {
            const removed = new Set(partIds.map(String));
            for (const id of removed) find(definition.parts, id, "Part");
            let changed = true;
            while (changed) { changed = false; for (const part of definition.parts) if (part.parentId && removed.has(part.parentId) && !removed.has(part.id)) { removed.add(part.id); changed = true; } }
            definition.parts = definition.parts.filter((entry) => !removed.has(entry.id));
            for (const proxy of [...definition.lidarProxies, ...definition.collisionProxies]) if (proxy.generated) proxy.generated.includedPartIds = proxy.generated.includedPartIds.filter((id) => !removed.has(id));
            return commit(ctx, definition, { partIds: [...removed].sort() });
        });
    },

    duplicatePart(partId, newId) {
        return command("asset-duplicate-part", "Duplicate asset part", (ctx, definition) => {
            const source = definition.parts[find(definition.parts, partId, "Part")];
            if (definition.parts.some((entry) => entry.id === String(newId))) throw new Error(`Part "${newId}" already exists.`);
            definition.parts.push({ ...clone(source), id: String(newId), name: `${source.name} copy`, order: source.order + 1 });
            return commit(ctx, definition, { partId: String(newId) });
        });
    },

    duplicateParts({ partIds = [] } = {}) {
        return command("asset-duplicate-parts", "Duplicate asset parts", (ctx, definition) => {
            const created = [];
            for (const partId of partIds.map(String).sort()) {
                const source = definition.parts[find(definition.parts, partId, "Part")];
                let suffix = 1;
                let id = `${source.id}-copy-${suffix}`;
                while (definition.parts.some((entry) => entry.id === id)) { suffix += 1; id = `${source.id}-copy-${suffix}`; }
                definition.parts.push({ ...clone(source), id, name: `${source.name} copy`, order: source.order + suffix });
                created.push(id);
            }
            return commit(ctx, definition, { partIds: created });
        });
    },

    updateChildRevision(partId, revision) {
        return command("asset-update-child-revision", "Update child asset revision", (ctx, definition) => {
            const index = find(definition.parts, partId, "Part");
            const part = definition.parts[index];
            if (part.content.kind !== "asset-reference") throw new Error(`Part "${partId}" is not an asset reference.`);
            part.content = { ...part.content, revision };
            return commit(ctx, definition, { partId: String(partId), revision });
        });
    },

    upsertMaterial(material) {
        return command("asset-upsert-material", "Edit asset material", (ctx, definition) => {
            const index = definition.materials.findIndex((entry) => entry.id === String(material?.id));
            if (index < 0) definition.materials.push(clone(material)); else definition.materials[index] = { ...definition.materials[index], ...clone(material) };
            return commit(ctx, definition, { materialId: String(material.id) });
        });
    },

    deleteMaterial(materialId) {
        return command("asset-delete-material", "Delete asset material", (ctx, definition) => {
            find(definition.materials, materialId, "Material");
            definition.materials = definition.materials.filter((entry) => entry.id !== String(materialId));
            definition.parts = definition.parts.map((part) => ({ ...part, materialBindings: Object.fromEntries(Object.entries(part.materialBindings).filter(([, id]) => id !== String(materialId))) }));
            return commit(ctx, definition, { materialId: String(materialId) });
        });
    },

    setMaterialBinding(partId, slot, materialId = null) {
        return command("asset-set-material-binding", "Assign asset material", (ctx, definition) => {
            const part = definition.parts[find(definition.parts, partId, "Part")];
            const bindings = { ...part.materialBindings };
            if (materialId === null) delete bindings[String(slot)]; else bindings[String(slot)] = String(materialId);
            part.materialBindings = bindings;
            return commit(ctx, definition, { partId: String(partId), slot: String(slot) });
        });
    },

    upsertProxy(channel, proxy) {
        return command("asset-upsert-proxy", `Edit ${channel} proxy`, (ctx, definition) => {
            const field = channel === "collision" ? "collisionProxies" : "lidarProxies";
            const index = definition[field].findIndex((entry) => entry.id === String(proxy?.id));
            if (index < 0) definition[field].push(clone(proxy)); else definition[field][index] = { ...definition[field][index], ...clone(proxy) };
            return commit(ctx, definition, { channel, proxyId: String(proxy.id) });
        });
    },

    setProxyEnabled(channel, proxyId, enabled) {
        return command("asset-set-proxy-enabled", `${enabled ? "Enable" : "Disable"} ${channel} proxy`, (ctx, definition) => {
            const field = channel === "collision" ? "collisionProxies" : "lidarProxies";
            const index = find(definition[field], proxyId, "Proxy"); definition[field][index].enabled = enabled === true;
            return commit(ctx, definition, { channel, proxyId: String(proxyId), enabled: enabled === true });
        });
    },

    deleteProxy(channel, proxyId) {
        return command("asset-delete-proxy", `Delete ${channel} proxy`, (ctx, definition) => {
            const field = channel === "collision" ? "collisionProxies" : "lidarProxies";
            find(definition[field], proxyId, "Proxy"); definition[field] = definition[field].filter((entry) => entry.id !== String(proxyId));
            return commit(ctx, definition, { channel, proxyId: String(proxyId) });
        });
    },

    replaceGeneratedProxy({ channel, proxy, expectedDocumentVersion, expectedInputGeometryHash }) {
        return command("asset-replace-generated-proxy", `Generate ${channel} proxy`, (ctx, definition) => {
            if (ctx.document.version !== expectedDocumentVersion) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.DOCUMENT_STALE, "Asset changed while proxy generation was running."));
            if (proxy?.generated?.inputGeometryHash !== expectedInputGeometryHash) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Generated proxy input fingerprint does not match the requested job."));
            const field = channel === "collision" ? "collisionProxies" : "lidarProxies";
            const index = definition[field].findIndex((entry) => entry.id === String(proxy.id));
            if (index < 0) definition[field].push(clone(proxy)); else definition[field][index] = clone(proxy);
            return commit(ctx, definition, { channel, proxyId: String(proxy.id) });
        });
    },
});
