/**
 * Run a compiled visual script as an editor attachment.
 * Pure: no React, DOM, or CommandBus. `author` only records operations.
 */

import { createId } from "../document/EnvironmentDocument.js";
import { createWorldDescription } from "../../../simulation/world/WorldDescription.js";
import { SeededRNG } from "../../../util/SeededRNG.js";
import { registerBuiltInBlocks } from "../../../scripting/registerBuiltInBlocks.js";
import { LoadedVisualScript } from "../../../scripting/ScriptRuntime.js";
import { assertSupportedArtifact } from "../../../scripting/runtime/Artifact.js";
import { parseValueByType } from "../../../scripting/units/program/ProgramTypes.js";
import { hostTypePhrase, programInputHostTypes, scriptHostType } from "../../../scripting/units/world/attachmentHosts.js";

export function attachmentContext(record, document) {
    const feature = document?.getFeature?.(record?.id) ?? null;
    const asset = record?.components?.asset;
    return {
        typeId: record?.typeId ?? "",
        objectId: record?.id ?? "",
        name: record?.name ?? "",
        edgeId: record?.typeId === "road" ? record.id : "",
        buildingId: record?.typeId === "building" ? record.id : "",
        nodeId: record?.typeId === "intersection" ? record.id : "",
        assetId: feature?.type ?? asset?.assetId ?? "",
    };
}

function programInputs(artifact, parameters = {}) {
    const inputs = {};
    for (const port of artifact.interface?.inputs ?? []) {
        const node = (artifact.nodes ?? []).find((entry) => entry.uuid === port.uuid);
        const stored = node?.storedData ?? node?.state ?? {};
        const hasParameter = Object.prototype.hasOwnProperty.call(parameters, port.label);
        const raw = hasParameter ? parameters[port.label] : stored.defaultValue;
        inputs[port.label] = parseValueByType(raw, port.type);
    }
    return inputs;
}

function sceneObjectError(artifact, inputs, document) {
    for (const port of artifact.interface?.inputs ?? []) {
        if (port.type !== "scene_object") continue;
        const allowed = programInputHostTypes(port);
        const id = String(inputs[port.label] ?? "").trim();
        if (!id) {
            if (allowed.length > 0) return `Program input "${port.label}" needs a ${hostTypePhrase(allowed)}.`;
            continue;
        }
        const target = document?.getObject?.(id) ?? null;
        if (!target) return `Program input "${port.label}" names missing object "${id}".`;
        if (allowed.length > 0 && !allowed.includes(target.typeId)) {
            return `Program input "${port.label}" needs a ${hostTypePhrase(allowed)}, not a ${target.typeId}.`;
        }
    }
    return null;
}

function finiteScale(value, fallback = 1) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/** Snapshot a prop or asset instance so Clone Object can place copies. */
export function lookupCloneSource(document, objectId) {
    const id = String(objectId ?? "").trim();
    const record = document?.getObject?.(id) ?? null;
    if (!record) return null;
    if (record.typeId === "builtin-prop") {
        const feature = document.getFeature?.(record.id) ?? null;
        if (!feature?.type) return null;
        return {
            typeId: "builtin-prop",
            typeVersion: record.typeVersion ?? 1,
            name: record.name || feature.type,
            feature: {
                type: String(feature.type),
                dir: Number.isFinite(Number(feature.dir)) ? Number(feature.dir) : 0,
                tags: Array.isArray(feature.tags) ? [...feature.tags] : [],
            },
        };
    }
    if (record.typeId === "asset-instance") {
        const asset = record.components?.asset;
        const assetId = typeof asset?.assetId === "string" ? asset.assetId.trim() : "";
        if (!assetId) return null;
        const overrides = asset.overrides && typeof asset.overrides === "object" ? structuredClone(asset.overrides) : {};
        return {
            typeId: "asset-instance",
            typeVersion: Number.isInteger(record.typeVersion) ? record.typeVersion : 1,
            name: record.name || assetId,
            asset: {
                assetId,
                revision: asset.revision,
                scale: {
                    x: finiteScale(asset.scale?.x),
                    y: finiteScale(asset.scale?.y),
                    z: finiteScale(asset.scale?.z),
                },
                overrides,
            },
        };
    }
    return null;
}

function authoredIdKind(op) {
    if (op?.op === "create-group") return "group";
    if (op?.op === "clone-object" && op.spec?.typeId === "asset-instance") return "asset";
    return "feature";
}

function worldFor(document, world) {
    if (world) return world;
    const snapshot = document.snapshot();
    return createWorldDescription({
        environmentId: snapshot.environmentId,
        templateId: snapshot.environmentId === "igvc" ? "igvc" : "blank",
        document: snapshot,
    });
}

/**
 * @returns {{ ok: boolean, ops: object[], error: string|null }}
 */
export function runObjectScript({
    artifact,
    record,
    document,
    parameters = null,
    seed = 1,
    world = null,
} = {}) {
    registerBuiltInBlocks();
    try {
        assertSupportedArtifact(artifact);
    } catch (error) {
        return { ok: false, ops: [], error: error?.message ?? String(error) };
    }
    const host = scriptHostType(artifact);
    if (!host.ok) return { ok: false, ops: [], error: host.error };
    if (host.typeId && record?.typeId !== host.typeId) {
        return { ok: false, ops: [], error: `This script attaches to a ${host.typeId}, not a ${record?.typeId ?? "object"}.` };
    }
    const inputs = programInputs(artifact, parameters ?? {});
    const sceneError = sceneObjectError(artifact, inputs, document);
    if (sceneError) return { ok: false, ops: [], error: sceneError };

    const ops = [];
    const author = (op) => {
        const id = createId(authoredIdKind(op));
        ops.push({ ...op, id });
        return id;
    };
    const rng = new SeededRNG(seed ?? 1);
    const script = new LoadedVisualScript(artifact, {
        runtimeContext: {
            attachment: attachmentContext(record, document),
            world: worldFor(document, world),
            random: () => rng.next(),
            author,
            lookupObject: (objectId) => lookupCloneSource(document, objectId),
            scriptId: artifact.name ?? "",
        },
    });
    const result = script.runResult(inputs);
    script.dispose?.();
    if (result.status !== "success") {
        return { ok: false, ops: [], error: result.e?.message || "Visual script execution failed." };
    }
    return { ok: true, ops, error: null };
}
