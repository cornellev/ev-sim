/** ED-06 commands for persisted asset-instance object records. */

import { ASSET_INSTANCE_TYPE_ID } from "../objects/types/assetInstance.js";
import { validateAssetInstanceComponent } from "../../../editor-assets/EditorAssetContract.js";
import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "./commandIssues.js";
import { nextSiblingOrder, setObjectComponent, upsertObjectRecord } from "./objectMutations.js";

function equal(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function placeAssetInstance({ record, label = "Place asset" } = {}) {
    return {
        id: "place-asset-instance",
        label,
        run(ctx) {
            if (!record || record.typeId !== ASSET_INSTANCE_TYPE_ID) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Placement requires an asset-instance record."));
            }
            if (ctx.document.getObject(String(record.id))) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Object "${record.id}" already exists.`, { objectId: String(record.id) }));
            }
            const asset = record.components?.asset;
            const issues = validateAssetInstanceComponent(asset);
            if (issues.length > 0) return commandFailure(issues);
            const parentId = record.parentId === undefined || record.parentId === "" ? null : record.parentId;
            const result = upsertObjectRecord(ctx.document, {
                ...structuredClone(record),
                typeVersion: 1,
                parentId,
                order: Number.isInteger(record.order) ? record.order : nextSiblingOrder(ctx.document.objects, parentId),
                components: {
                    tags: [], locked: false, editorHidden: false,
                    ...(structuredClone(record.components) ?? {}),
                    asset: structuredClone(asset),
                },
            }, { notify: false });
            if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error));
            return commandSuccess({ objectId: result.record.id, assetId: asset.assetId, revision: asset.revision });
        },
    };
}

export function updateAssetInstances({
    expectedDocumentVersion,
    targetRevision,
    changes = [],
    label = "Update asset instances",
} = {}) {
    return {
        id: "update-asset-instances",
        label,
        run(ctx) {
            if (!Number.isInteger(expectedDocumentVersion) || ctx.document.version !== expectedDocumentVersion) {
                return commandFailure(commandIssue(
                    COMMAND_ISSUE_CODES.DOCUMENT_STALE,
                    `The environment changed after the update was prepared (expected version ${expectedDocumentVersion}, current ${ctx.document.version}).`,
                ));
            }
            if (!Number.isInteger(targetRevision) || targetRevision <= 0 || !Array.isArray(changes) || changes.length === 0) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "A positive target revision and at least one instance change are required."));
            }
            const prepared = [];
            let assetId = null;
            const seen = new Set();
            for (const change of changes) {
                const objectId = String(change?.objectId ?? "");
                const record = ctx.document.getObject(objectId);
                if (!record || record.typeId !== ASSET_INSTANCE_TYPE_ID) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Asset instance "${objectId}" does not exist.`, { objectId }));
                }
                if (seen.has(objectId)) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Asset instance "${objectId}" occurs more than once.`, { objectId }));
                seen.add(objectId);
                if (record.components?.locked === true) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? objectId}" is locked.`, { objectId }));
                }
                const current = record.components?.asset;
                if (!equal(current, change.beforeAsset)) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.DOCUMENT_STALE, `Asset instance "${objectId}" changed after the update was prepared.`, { objectId }));
                }
                const next = structuredClone(change.afterAsset);
                if (next?.assetId !== current?.assetId || next?.revision !== targetRevision) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ASSET_MISMATCH, "Revision updates must retain the asset id and use the prepared target revision.", { objectId }));
                }
                assetId ??= current.assetId;
                if (current.assetId !== assetId) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ASSET_MISMATCH, "All updated instances must reference the same catalog asset.", { objectId }));
                }
                const issues = validateAssetInstanceComponent(next);
                if (issues.length > 0) return commandFailure(issues);
                prepared.push({ objectId, value: next });
            }
            for (const change of prepared) setObjectComponent(ctx.document, change.objectId, "asset", change.value, { notify: false });
            return commandSuccess({ objectIds: prepared.map((entry) => entry.objectId), assetId, targetRevision });
        },
    };
}
