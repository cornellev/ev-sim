/**
 * Add, remove, and edit `components.rigidBody`. The bus validates the graph,
 * so a rejected component never lands in the document.
 */

import { commandFailure, commandIssue, commandSuccess, COMMAND_ISSUE_CODES } from "./commandIssues.js";
import { setObjectComponent } from "./objectMutations.js";
import { defaultRigidBody, normalizeRigidBody, rigidBodyFieldIssues, rigidBodyShapeIssue } from "../../../simulation/world/RigidBodyRecords.js";

function recordOf(ctx, objectId) {
    const id = String(objectId ?? "");
    const record = ctx.document.getObject(id);
    if (!record) return { id, failure: commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id })) };
    return { id, record };
}

function writeBody(ctx, id, value) {
    const result = setObjectComponent(ctx.document, id, "rigidBody", value, { notify: false });
    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: id }));
    return null;
}

export function addRigidBody({ objectId, label = "Add rigid body" } = {}) {
    return {
        id: "add-rigid-body",
        label,
        run(ctx) {
            const { id, record, failure } = recordOf(ctx, objectId);
            if (failure) return failure;
            if (record.components?.rigidBody) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "This object already has a rigid body.", { objectId: id }));
            }
            const shapeIssue = rigidBodyShapeIssue(ctx.document, record);
            if (shapeIssue) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, shapeIssue, { objectId: id }));
            const failed = writeBody(ctx, id, defaultRigidBody());
            if (failed) return failed;
            return commandSuccess({ objectId: id, rigidBody: defaultRigidBody() });
        },
    };
}

export function removeRigidBody({ objectId, label = "Remove rigid body" } = {}) {
    return {
        id: "remove-rigid-body",
        label,
        run(ctx) {
            const { id, record, failure } = recordOf(ctx, objectId);
            if (failure) return failure;
            if (!record.components?.rigidBody) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "This object has no rigid body.", { objectId: id }));
            }
            const failed = writeBody(ctx, id, undefined);
            if (failed) return failed;
            return commandSuccess({ objectId: id });
        },
    };
}

export function putRigidBody({ objectId, rigidBody, label = "Set rigid body" } = {}) {
    return {
        id: "put-rigid-body",
        label,
        run(ctx) {
            const { id, record, failure } = recordOf(ctx, objectId);
            if (failure) return failure;
            const next = normalizeRigidBody(rigidBody);
            const fieldIssue = rigidBodyFieldIssues(next)[0];
            if (fieldIssue) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, fieldIssue, { objectId: id }));
            const shapeIssue = rigidBodyShapeIssue(ctx.document, record);
            if (shapeIssue) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, shapeIssue, { objectId: id }));
            const failed = writeBody(ctx, id, next);
            if (failed) return failed;
            return commandSuccess({ objectId: id, rigidBody: next });
        },
    };
}

export function setRigidBody({ objectId, patch = {}, label = "Edit rigid body" } = {}) {
    return {
        id: "set-rigid-body",
        label,
        run(ctx) {
            const { id, record, failure } = recordOf(ctx, objectId);
            if (failure) return failure;
            if (!record.components?.rigidBody) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "This object has no rigid body.", { objectId: id }));
            }
            const current = record.components.rigidBody;
            const next = normalizeRigidBody({
                ...current,
                ...patch,
                constantForce: patch.constantForce === undefined ? current.constantForce : patch.constantForce,
            });
            const fieldIssue = rigidBodyFieldIssues(next)[0];
            if (fieldIssue) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, fieldIssue, { objectId: id }));
            const failed = writeBody(ctx, id, next);
            if (failed) return failed;
            return commandSuccess({ objectId: id, rigidBody: next });
        },
    };
}
