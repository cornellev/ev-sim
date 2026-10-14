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
import { scriptHostType } from "../../../scripting/units/world/attachmentHosts.js";

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
        const id = String(inputs[port.label] ?? "").trim();
        if (!id) {
            if (port.sceneType) return `Program input "${port.label}" needs a ${port.sceneType}.`;
            continue;
        }
        const target = document?.getObject?.(id) ?? null;
        if (!target) return `Program input "${port.label}" names missing object "${id}".`;
        if (port.sceneType && target.typeId !== port.sceneType) {
            return `Program input "${port.label}" needs a ${port.sceneType}, not a ${target.typeId}.`;
        }
    }
    return null;
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
        const kind = op?.op === "create-group" ? "group" : "feature";
        const id = createId(kind);
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
