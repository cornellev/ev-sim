/**
 * Apply editor-script operations as one undo step.
 * Accepts an environment command service or a CommandBus.
 */

import { commandFactories } from "../commands/EnvironmentCommandService.js";

function ownedIds(document, attachmentId) {
    return document.objects
        .filter((record) => record.components?.authoredBy?.attachmentId === attachmentId)
        .map((record) => record.id);
}

function applyClone(run, op) {
    const spec = op.spec ?? {};
    if (spec.typeId === "builtin-prop") {
        run("addFeature", {
            id: op.id,
            type: spec.feature?.type,
            x: op.x,
            z: op.z,
            rotationY: op.rotationY ?? 0,
            dir: spec.feature?.dir ?? 0,
            tags: spec.feature?.tags,
            name: spec.name,
            parentId: op.parentId ?? null,
        });
        return;
    }
    if (spec.typeId === "asset-instance") {
        const scale = spec.asset?.scale ?? {};
        run("createObject", {
            typeId: "asset-instance",
            typeVersion: spec.typeVersion,
            id: op.id,
            name: spec.name,
            parentId: op.parentId ?? null,
            input: {
                name: spec.name,
                asset: {
                    assetId: spec.asset?.assetId,
                    revision: spec.asset?.revision,
                    position: { x: op.x, y: op.y ?? 0, z: op.z },
                    rotationY: op.rotationY ?? 0,
                    scale: {
                        x: scale.x ?? 1,
                        y: scale.y ?? 1,
                        z: scale.z ?? 1,
                    },
                    overrides: spec.asset?.overrides ?? {},
                },
            },
        });
        return;
    }
    throw new TypeError(`Cannot clone "${spec.typeId || "object"}".`);
}

function applySteps(run, document, { attachmentId, scriptId, ops }) {
    const owned = ownedIds(document, attachmentId);
    if (owned.length > 0) run("deleteObjects", { objectIds: owned });
    const created = [];
    for (const op of ops) {
        if (op.op === "create-group") {
            run("createObject", {
                typeId: "group",
                id: op.id,
                name: op.name || "Group",
                parentId: op.parentId ?? null,
            });
        } else if (op.op === "add-feature") {
            run("addFeature", {
                id: op.id,
                type: op.type,
                x: op.x,
                z: op.z,
                rotationY: op.rotationY ?? 0,
                parentId: op.parentId ?? null,
            });
        } else if (op.op === "clone-object") {
            applyClone(run, op);
        } else {
            throw new TypeError(`Unknown author op "${op?.op}".`);
        }
        run("setObjectComponent", {
            objectId: op.id,
            key: "authoredBy",
            value: { attachmentId, scriptId },
        });
        created.push(op.id);
    }
    return { created };
}

export function applyObjectScript(host, {
    attachmentId,
    scriptId,
    ops = [],
    label = "Run script",
} = {}) {
    if (!attachmentId || !scriptId) throw new TypeError("attachmentId and scriptId are required.");
    if (typeof host?.run === "function" && typeof host.transaction === "function") {
        return host.transaction(label, (run) => applySteps(run, host.document, { attachmentId, scriptId, ops }));
    }
    if (typeof host?.transaction !== "function") throw new TypeError("applyObjectScript requires a command service or CommandBus.");
    return host.transaction(label, (run) => applySteps(
        (name, args) => run(commandFactories[name](args)),
        host.document,
        { attachmentId, scriptId, ops },
    ));
}
