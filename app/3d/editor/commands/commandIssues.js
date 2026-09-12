/**
 * Structured issue codes raised by editor commands. Kept apart from
 * `OBJECT_ISSUE_CODES` (graph validation) and `TRANSFORM_ISSUE_CODES`
 * (binding plans) so the object-graph fixture exhaustiveness check stays
 * scoped to graph validation.
 */

import { issue } from "../objects/ObjectOptions.js";

export const COMMAND_ISSUE_CODES = Object.freeze({
    OBJECT_MISSING: "command.object.missing",
    OBJECT_LOCKED: "command.object.locked",
    ARGUMENT_INVALID: "command.argument.invalid",
    MUTATION_FAILED: "command.mutation.failed",
    NOT_DELETABLE: "command.delete.not-deletable",
    NOT_GROUPABLE: "command.group.not-groupable",
    REPARENT_NOT_GROUPABLE: "command.reparent.not-groupable",
    UNGROUP_NOT_GROUP: "command.ungroup.not-group",
    DUPLICATE_UNSUPPORTED: "command.duplicate.unsupported",
    SELECTION_EMPTY: "command.selection.empty",
    GESTURE_INACTIVE: "command.gesture.inactive",
    GESTURE_UNSUPPORTED: "command.gesture.unsupported",
    NOTHING_TO_UNDO: "command.history.empty",
});

export function commandIssue(code, message, { objectId = null, path = ["command"], severity = "error" } = {}) {
    return issue(path, code, message, { objectId, severity });
}

export function errorIssues(issues) {
    return (issues ?? []).filter((entry) => entry.severity === "error");
}

/** Standard failure result for command `run()` implementations. */
export function commandFailure(issues, extra = {}) {
    const list = Array.isArray(issues) ? issues : [issues];
    return { ok: false, issues: list, error: list[0]?.message ?? "Command failed.", ...extra };
}

export function commandSuccess(result = {}) {
    return { ok: true, issues: [], result };
}
