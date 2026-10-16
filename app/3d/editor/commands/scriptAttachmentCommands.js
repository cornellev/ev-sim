/**
 * Script attachments live on the object graph (`components.scripts`).
 * Commands check shape only. The inspector and MCP resolve the script
 * library and pass `hostType` when the graph derives from one object type.
 */

import { createId } from "../document/EnvironmentDocument.js";
import { isPlainObject } from "../objects/ObjectOptions.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, commandSuccess } from "./commandIssues.js";
import { setObjectComponent as setComponent } from "./objectMutations.js";

function jsonValue(value) {
    if (value === null) return true;
    const kind = typeof value;
    if (kind === "string" || kind === "boolean") return true;
    if (kind === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(jsonValue);
    if (isPlainObject(value)) return Object.values(value).every(jsonValue);
    return false;
}

function parametersIssue(parameters, objectId) {
    if (!isPlainObject(parameters) || !jsonValue(parameters)) {
        return commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Script parameters must be a JSON object.", { objectId });
    }
    return null;
}

function attachmentList(record) {
    return Array.isArray(record.components?.scripts) ? record.components.scripts.map((entry) => ({ ...entry })) : [];
}

function writeScripts(ctx, record, scripts) {
    const result = setComponent(ctx.document, record.id, "scripts", scripts.length === 0 ? undefined : scripts, { notify: false });
    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: record.id }));
    return null;
}

export function attachScript({
    objectId,
    scriptId,
    attachmentId = null,
    parameters = {},
    seed = 1,
    hostType = null,
    label = "Attach script",
} = {}) {
    return {
        id: "attach-script",
        label,
        run(ctx) {
            const id = String(objectId ?? "");
            const record = ctx.document.getObject(id);
            if (!record) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id }));
            const script = String(scriptId ?? "").trim();
            if (!script) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "scriptId is required.", { objectId: id }));
            const expected = hostType == null || hostType === "" ? null : String(hostType);
            if (expected && record.typeId !== expected) {
                return commandFailure(commandIssue(
                    COMMAND_ISSUE_CODES.ARGUMENT_INVALID,
                    `This script attaches to a ${expected}, not a ${record.typeId}.`,
                    { objectId: id },
                ));
            }
            const parameterIssue = parametersIssue(parameters, id);
            if (parameterIssue) return commandFailure(parameterIssue);
            if (typeof seed !== "number" || !Number.isFinite(seed)) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Seed must be a finite number.", { objectId: id }));
            }
            const nextId = attachmentId ? String(attachmentId) : createId("attachment");
            const scripts = attachmentList(record);
            if (scripts.some((entry) => entry.id === nextId)) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Attachment "${nextId}" already exists.`, { objectId: id }));
            }
            scripts.push({
                id: nextId,
                scriptId: script,
                parameters: structuredClone(parameters),
                seed,
            });
            const failed = writeScripts(ctx, record, scripts);
            if (failed) return failed;
            return commandSuccess({ objectId: id, attachmentId: nextId, scriptId: script });
        },
    };
}

export function detachScript({ objectId, attachmentId, label = "Detach script" } = {}) {
    return {
        id: "detach-script",
        label,
        run(ctx) {
            const id = String(objectId ?? "");
            const record = ctx.document.getObject(id);
            if (!record) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id }));
            const attachment = String(attachmentId ?? "");
            const scripts = attachmentList(record);
            const next = scripts.filter((entry) => entry.id !== attachment);
            if (next.length === scripts.length) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Attachment "${attachment}" was not found.`, { objectId: id }));
            }
            const failed = writeScripts(ctx, record, next);
            if (failed) return failed;
            return commandSuccess({ objectId: id, attachmentId: attachment });
        },
    };
}

export function setScriptParameters({ objectId, attachmentId, parameters, seed, label = "Edit script" } = {}) {
    return {
        id: "set-script-parameters",
        label,
        run(ctx) {
            const id = String(objectId ?? "");
            const record = ctx.document.getObject(id);
            if (!record) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id }));
            const attachment = String(attachmentId ?? "");
            const scripts = attachmentList(record);
            const index = scripts.findIndex((entry) => entry.id === attachment);
            if (index < 0) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Attachment "${attachment}" was not found.`, { objectId: id }));
            }
            const next = { ...scripts[index] };
            if (parameters !== undefined) {
                const parameterIssue = parametersIssue(parameters, id);
                if (parameterIssue) return commandFailure(parameterIssue);
                next.parameters = structuredClone(parameters);
            }
            if (seed !== undefined) {
                if (typeof seed !== "number" || !Number.isFinite(seed)) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "Seed must be a finite number.", { objectId: id }));
                }
                next.seed = seed;
            }
            scripts[index] = next;
            const failed = writeScripts(ctx, record, scripts);
            if (failed) return failed;
            return commandSuccess({ objectId: id, attachmentId: attachment });
        },
    };
}

export function clearAuthoredBy({ attachmentId, label = "Bake script output" } = {}) {
    return {
        id: "clear-authored-by",
        label,
        run(ctx) {
            const id = String(attachmentId ?? "");
            if (!id) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "attachmentId is required."));
            const cleared = [];
            for (const record of ctx.document.objects) {
                if (record.components?.authoredBy?.attachmentId !== id) continue;
                const result = setComponent(ctx.document, record.id, "authoredBy", undefined, { notify: false });
                if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: record.id }));
                cleared.push(record.id);
            }
            return commandSuccess({ attachmentId: id, cleared });
        },
    };
}
