/**
 * Object-graph commands: transform, reparent, group, ungroup, delete,
 * duplicate, rename, and component edits. Each factory returns
 * `{ id, label, run(ctx) }`; `run` validates before mutating and returns a
 * structured outcome. The bus reconciles the overlay and validates the graph
 * after `run`, restoring the document if anything is wrong.
 */

import { createId } from "../document/EnvironmentDocument.js";
import {
    addBuildingRecord,
    addFeature,
    removeBuilding,
    removeFeature,
    removeIntersectionNode,
    removeRoadEdge,
} from "../document/documentMutations.js";
import { buildingIdFromFootprint } from "../../city/buildingIds.js";
import {
    OBJECT_ISSUE_CODES,
    planObjectOptions,
    readObjectOptionValue,
    readObjectTransform,
    validateObjectRecords,
} from "../objects/objectGraph.js";
import { STANDARD_COMPONENT_KEYS, compareObjectRecords, createObjectRecord, normalizeObjectRecord } from "../objects/objectRecord.js";
import { GROUP_TYPE_ID } from "../objects/types/group.js";
import { BUILDING_TYPE_ID } from "../objects/types/building.js";
import { BUILTIN_PROP_TYPE_ID } from "../objects/types/builtinProp.js";
import { INTERSECTION_TYPE_ID } from "../objects/types/intersection.js";
import { ROAD_TYPE_ID } from "../objects/types/road.js";
import {
    OPTIONS_ISSUE_CODES,
    fieldPathKey,
    hasErrorIssue,
    isPlainObject,
    issue,
    setFieldValue,
    validateFieldConstraints,
} from "../objects/ObjectOptions.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, commandSuccess, errorIssues } from "./commandIssues.js";
import {
    childrenOf,
    descendantIds,
    indexObjectsById,
    isDescendant,
    parentIdOf,
    pruneToRoots,
    removeObjectRecords,
    renameObjectRecord,
    renumberSiblings,
    setObjectComponent as setComponent,
    upsertObjectRecord,
} from "./objectMutations.js";
import { applyPlanSteps } from "./planApply.js";
import { planTransform } from "./transformPlanning.js";

function definitionFor(ctx, record) {
    return ctx.registry.get(record?.typeId, record?.typeVersion) ?? ctx.registry.get(record?.typeId) ?? null;
}

function normalizeParent(parentId) {
    return parentId === undefined || parentId === null || parentId === "" ? null : String(parentId);
}

function candidateRecords(ctx) {
    return ctx.document.objects.map((record) => normalizeObjectRecord(record));
}

/** Position of `record` among the siblings that are not being moved. */
function stableIndexOf(byId, parentId, record, movingIds) {
    const moving = new Set(movingIds.map(String));
    return childrenOf(byId, parentId)
        .filter((sibling) => !moving.has(String(sibling.id)))
        .filter((sibling) => compareObjectRecords(sibling, record) < 0)
        .length;
}

function commitCandidate(ctx, candidate) {
    const validation = validateObjectRecords(candidate, ctx.document.index(), ctx.registry, { sky: ctx.sky });
    if (!validation.ok) return { ok: false, issues: errorIssues(validation.issues) };
    ctx.document.replaceObjectGraph(candidate, { notify: false });
    return { ok: true, issues: [] };
}

// ---------------------------------------------------------------- transform

/** One-shot transform (numeric field edits, MCP moves). */
export function transformObjects({ objectIds = [], delta, sub = null, label = "Transform" } = {}) {
    return {
        id: "transform-objects",
        label,
        run(ctx) {
            const plan = planTransform(ctx.document, ctx.registry, objectIds, delta, { sub });
            if (!plan.ok) return commandFailure(plan.issues);
            const applied = applyPlanSteps(ctx.document, plan.steps, { notify: false });
            if (!applied.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, applied.error));
            return commandSuccess({ objectIds: plan.closure.roots, steps: plan.steps.length });
        },
    };
}

// ----------------------------------------------------------------- reparent

/**
 * Move `objectIds` under `parentId` (null for the root) at sibling `index`.
 * World placement is unchanged by construction: no legacy record or frame
 * changes. Cycles, self-parenting, missing or non-group parents, and
 * non-groupable roots are rejected before anything is written.
 */
export function reparentObjects({ objectIds = [], parentId = null, index = null, label = "Reparent" } = {}) {
    return {
        id: "reparent-objects",
        label,
        run(ctx) {
            const records = candidateRecords(ctx);
            const byId = indexObjectsById(records);
            const target = normalizeParent(parentId);
            const roots = pruneToRoots(byId, objectIds);
            const missing = [...objectIds].map(String).filter((id) => !byId.has(id));
            if (missing.length > 0) {
                return commandFailure(missing.map((id) => commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id })));
            }
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing to reparent."));
            if (target !== null) {
                const parent = byId.get(target);
                if (!parent) {
                    return commandFailure(issue(["objects"], OBJECT_ISSUE_CODES.PARENT_MISSING, `Parent "${target}" does not exist.`, { objectId: target }));
                }
                if (parent.typeId !== GROUP_TYPE_ID) {
                    return commandFailure(issue(["objects"], OBJECT_ISSUE_CODES.PARENT_NOT_GROUP, `"${parent.name ?? target}" is not a group.`, { objectId: target }));
                }
                for (const id of roots) {
                    if (id === target || isDescendant(byId, id, target)) {
                        return commandFailure(issue(["objects"], OBJECT_ISSUE_CODES.PARENT_CYCLE, `Cannot move "${byId.get(id)?.name ?? id}" into its own subtree.`, { objectId: id }));
                    }
                }
            }
            for (const id of roots) {
                const record = byId.get(id);
                const definition = definitionFor(ctx, record);
                if (!definition || !definition.getCapabilities(record)?.groupable) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.REPARENT_NOT_GROUPABLE, `"${record?.name ?? id}" cannot be placed in a group.`, { objectId: id }));
                }
                if (record.components?.locked === true) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? id}" is locked.`, { objectId: id }));
                }
            }
            const oldParents = new Set(roots.map((id) => parentIdOf(byId.get(id))));
            const rootSet = new Set(roots);
            const candidate = records.map((record) => (rootSet.has(String(record.id)) ? { ...record, parentId: target } : { ...record }));
            renumberSiblings(candidate, target, { moved: roots, index });
            for (const previous of oldParents) {
                if (previous !== target) renumberSiblings(candidate, previous);
            }
            const committed = commitCandidate(ctx, candidate);
            if (!committed.ok) return commandFailure(committed.issues);
            return commandSuccess({ moved: roots, parentId: target });
        },
    };
}

/** Reorder within the current parent. */
export function reorderObjects({ objectIds = [], index = null, label = "Reorder" } = {}) {
    return {
        id: "reorder-objects",
        label,
        run(ctx) {
            const byId = indexObjectsById(ctx.document.objects);
            const roots = pruneToRoots(byId, objectIds);
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing to reorder."));
            const parentId = parentIdOf(byId.get(roots[0]));
            return reparentObjects({ objectIds: roots, parentId, index, label }).run(ctx);
        },
    };
}

// -------------------------------------------------------------------- group

export function groupObjects({ objectIds = [], name = "Group", groupId = null, label = "Group" } = {}) {
    return {
        id: "group-objects",
        label,
        run(ctx) {
            const records = candidateRecords(ctx);
            const byId = indexObjectsById(records);
            const roots = pruneToRoots(byId, objectIds);
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Select objects to group."));
            for (const id of roots) {
                const record = byId.get(id);
                const definition = definitionFor(ctx, record);
                if (!definition || !definition.getCapabilities(record)?.groupable) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.NOT_GROUPABLE, `"${record?.name ?? id}" cannot be grouped.`, { objectId: id }));
                }
                if (record.components?.locked === true) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? id}" is locked.`, { objectId: id }));
                }
            }
            const first = byId.get(roots[0]);
            const parentId = parentIdOf(first);
            const id = groupId ? String(groupId) : createId("group");
            if (byId.has(id)) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Object "${id}" already exists.`, { objectId: id }));

            // Pivot at the centroid of the roots' world positions.
            const positions = roots
                .map((rootId) => readObjectTransform(byId.get(rootId), ctx.document, ctx.registry, { sky: ctx.sky })?.position)
                .filter(Boolean);
            const centroid = positions.length > 0
                ? positions.reduce((acc, point) => ({ x: acc.x + point.x / positions.length, y: acc.y + point.y / positions.length, z: acc.z + point.z / positions.length }), { x: 0, y: 0, z: 0 })
                : { x: 0, y: 0, z: 0 };
            const groupType = ctx.registry.get(GROUP_TYPE_ID);
            const created = groupType.create({ name, transform: { position: centroid, rotationY: 0, scale: 1 } });
            const groupRecord = createObjectRecord({
                id,
                typeId: GROUP_TYPE_ID,
                typeVersion: groupType.version,
                name: created.name,
                parentId,
                order: first.order,
                components: created.components,
            });
            const rootSet = new Set(roots);
            const candidate = [
                ...records.map((record) => (rootSet.has(String(record.id)) ? { ...record, parentId: id } : { ...record })),
                groupRecord,
            ];
            const slot = stableIndexOf(byId, parentId, first, roots);
            renumberSiblings(candidate, id, { moved: roots });
            renumberSiblings(candidate, parentId, { moved: [id], index: slot });
            for (const previous of new Set(roots.map((rootId) => parentIdOf(byId.get(rootId))))) {
                if (previous !== parentId) renumberSiblings(candidate, previous);
            }
            const committed = commitCandidate(ctx, candidate);
            if (!committed.ok) return commandFailure(committed.issues);
            return commandSuccess({ groupId: id, children: roots, parentId });
        },
    };
}

export function ungroupObjects({ objectIds = [], label = "Ungroup" } = {}) {
    return {
        id: "ungroup-objects",
        label,
        run(ctx) {
            const candidate = candidateRecords(ctx);
            const byId = indexObjectsById(candidate);
            const roots = pruneToRoots(byId, objectIds);
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Select a group to ungroup."));
            const released = [];
            for (const id of roots) {
                const group = byId.get(id);
                if (group?.typeId !== GROUP_TYPE_ID) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.UNGROUP_NOT_GROUP, `"${group?.name ?? id}" is not a group.`, { objectId: id }));
                }
                if (group.components?.locked === true) {
                    return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${group.name ?? id}" is locked.`, { objectId: id }));
                }
            }
            for (const id of roots) {
                const group = byId.get(id);
                const parentId = parentIdOf(group);
                const children = childrenOf(candidate, id);
                const slot = stableIndexOf(indexObjectsById(candidate), parentId, group, [id]);
                for (const child of children) child.parentId = parentId;
                const position = candidate.findIndex((record) => String(record.id) === id);
                if (position >= 0) candidate.splice(position, 1);
                renumberSiblings(candidate, parentId, { moved: children.map((child) => child.id), index: slot });
                released.push(...children.map((child) => String(child.id)));
            }
            const committed = commitCandidate(ctx, candidate);
            if (!committed.ok) return commandFailure(committed.issues);
            return commandSuccess({ ungrouped: roots, children: released });
        },
    };
}

// ------------------------------------------------------------------- delete

export function deleteObjects({ objectIds = [], label = "Delete" } = {}) {
    return {
        id: "delete-objects",
        label,
        run(ctx) {
            const byId = indexObjectsById(ctx.document.objects);
            const roots = pruneToRoots(byId, objectIds);
            const missing = [...objectIds].map(String).filter((id) => !byId.has(id));
            if (missing.length > 0) {
                return commandFailure(missing.map((id) => commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id })));
            }
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing to delete."));
            const closure = [];
            for (const id of roots) {
                if (!closure.includes(id)) closure.push(id);
                for (const descendant of descendantIds(byId, id)) {
                    if (!closure.includes(descendant)) closure.push(descendant);
                }
            }
            const issues = [];
            for (const id of closure) {
                const record = byId.get(id);
                const definition = definitionFor(ctx, record);
                if (!definition) {
                    issues.push(commandIssue(COMMAND_ISSUE_CODES.NOT_DELETABLE, `"${record?.name ?? id}" has an unsupported type and cannot be deleted here.`, { objectId: id }));
                    continue;
                }
                if (record.components?.locked === true) {
                    issues.push(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? id}" is locked.`, { objectId: id }));
                    continue;
                }
                if (!definition.getCapabilities(record)?.deletable) {
                    issues.push(commandIssue(COMMAND_ISSUE_CODES.NOT_DELETABLE, `"${record.name ?? id}" cannot be deleted.`, { objectId: id }));
                }
            }
            if (issues.length > 0) return commandFailure(issues);

            const document = ctx.document;
            const byType = (typeId) => closure.filter((id) => byId.get(id).typeId === typeId);
            const removed = { intersections: [], roads: [], buildings: [], features: [], groups: [] };
            for (const id of byType(INTERSECTION_TYPE_ID)) {
                if (document.getNode(id)) {
                    const result = removeIntersectionNode(document, id, { notify: false });
                    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: id }));
                }
                removed.intersections.push(id);
            }
            for (const id of byType(ROAD_TYPE_ID)) {
                if (document.getEdge(id)) {
                    const result = removeRoadEdge(document, id, { notify: false });
                    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: id }));
                }
                removed.roads.push(id);
            }
            for (const id of byType(BUILDING_TYPE_ID)) {
                if (document.getBuilding(id)) {
                    const result = removeBuilding(document, id, { notify: false });
                    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: id }));
                }
                removed.buildings.push(id);
            }
            for (const id of byType(BUILTIN_PROP_TYPE_ID)) {
                if (document.getFeature(id)) {
                    const result = removeFeature(document, id, { notify: false });
                    if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: id }));
                }
                removed.features.push(id);
            }
            removed.groups = byType(GROUP_TYPE_ID);
            removeObjectRecords(document, closure, { notify: false });
            return commandSuccess({ deleted: closure, removed });
        },
    };
}

// ---------------------------------------------------------------- duplicate

export function duplicateObjects({ objectIds = [], label = "Duplicate" } = {}) {
    return {
        id: "duplicate-objects",
        label,
        run(ctx) {
            const document = ctx.document;
            const byId = indexObjectsById(document.objects);
            const roots = pruneToRoots(byId, objectIds);
            if (roots.length === 0) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing to duplicate."));
            const supported = new Set([GROUP_TYPE_ID, BUILTIN_PROP_TYPE_ID, BUILDING_TYPE_ID]);
            const check = (id) => {
                const record = byId.get(id);
                const issues = [];
                if (!record || !supported.has(record.typeId)) {
                    issues.push(commandIssue(COMMAND_ISSUE_CODES.DUPLICATE_UNSUPPORTED, `"${record?.name ?? id}" cannot be duplicated yet.`, { objectId: id }));
                } else {
                    for (const child of childrenOf(byId, id)) issues.push(...check(String(child.id)));
                }
                return issues;
            };
            const issues = roots.flatMap(check);
            if (issues.length > 0) return commandFailure(issues);

            const createdIds = [];
            const rootIds = [];
            const duplicate = (id, parentId, order) => {
                const record = byId.get(id);
                const copyName = record.name ? `${record.name} copy` : undefined;
                const components = structuredClone(record.components ?? {});
                let newId;
                if (record.typeId === GROUP_TYPE_ID) {
                    newId = createId("group");
                } else if (record.typeId === BUILTIN_PROP_TYPE_ID) {
                    const feature = document.getFeature(id);
                    if (!feature) throw new Error(`Feature "${id}" is missing.`);
                    newId = createId("feature");
                    const added = addFeature(document, { ...structuredClone(feature), id: newId }, { notify: false });
                    if (!added.ok) throw new Error(added.error);
                } else {
                    const building = document.getBuilding(id);
                    if (!building) throw new Error(`Building "${id}" is missing.`);
                    newId = buildingIdFromFootprint(building.footprint, document.buildings.length + createdIds.length + 1);
                    while (document.getBuilding(newId)) newId = `${newId}-copy`;
                    const added = addBuildingRecord(document, { ...structuredClone(building), buildingId: newId, meshName: newId }, { notify: false });
                    if (!added.ok) throw new Error(added.error);
                }
                upsertObjectRecord(document, {
                    id: newId,
                    typeId: record.typeId,
                    typeVersion: record.typeVersion,
                    name: copyName ?? newId,
                    parentId,
                    order,
                    components,
                }, { notify: false });
                createdIds.push(newId);
                if (record.typeId === GROUP_TYPE_ID) {
                    childrenOf(byId, id).forEach((child, position) => duplicate(String(child.id), newId, position));
                }
                return newId;
            };
            for (const id of roots) {
                const record = byId.get(id);
                const parentId = parentIdOf(record);
                const newId = duplicate(id, parentId, record.order ?? 0);
                rootIds.push(newId);
                // Land right after the source among its siblings; renumbering makes the order dense.
                const slot = stableIndexOf(indexObjectsById(document.objects), parentId, record, [newId]) + 1;
                renumberSiblings(document.objects, parentId, { moved: [newId], index: slot });
            }
            return commandSuccess({ createdIds, rootIds });
        },
    };
}

// ------------------------------------------------------------- record edits

export function renameObject({ objectId, name, label = "Rename" } = {}) {
    return {
        id: "rename-object",
        label,
        run(ctx) {
            const result = renameObjectRecord(ctx.document, objectId, name, { notify: false });
            if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, result.error, { objectId: String(objectId) }));
            return commandSuccess({ objectId: String(objectId), name: result.record.name });
        },
    };
}

export function setObjectComponent({ objectId, key, value, label = "Edit" } = {}) {
    return {
        id: "set-object-component",
        label,
        run(ctx) {
            const record = ctx.document.getObject(String(objectId));
            if (!record) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${objectId}" does not exist.`, { objectId: String(objectId) }));
            const definition = definitionFor(ctx, record);
            const allowed = [...STANDARD_COMPONENT_KEYS, ...(definition?.components ?? [])];
            if (!allowed.includes(key)) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, `Component "${key}" is not allowed on "${record.typeId}".`, { objectId: record.id }));
            }
            const result = setComponent(ctx.document, record.id, key, value, { notify: false });
            if (!result.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, result.error, { objectId: record.id }));
            return commandSuccess({ objectId: record.id, key });
        },
    };
}

export function setObjectsHidden({ objectIds = [], hidden = true, label = hidden ? "Hide" : "Show" } = {}) {
    return {
        id: "set-objects-hidden",
        label,
        run(ctx) {
            for (const id of objectIds) {
                const result = setObjectComponent({ objectId: id, key: "editorHidden", value: hidden === true }).run(ctx);
                if (!result.ok) return result;
            }
            return commandSuccess({ objectIds: [...objectIds].map(String), hidden: hidden === true });
        },
    };
}

export function setObjectsLocked({ objectIds = [], locked = true, label = locked ? "Lock" : "Unlock" } = {}) {
    return {
        id: "set-objects-locked",
        label,
        run(ctx) {
            for (const id of objectIds) {
                const result = setObjectComponent({ objectId: id, key: "locked", value: locked === true }).run(ctx);
                if (!result.ok) return result;
            }
            return commandSuccess({ objectIds: [...objectIds].map(String), locked: locked === true });
        },
    };
}

// ------------------------------------------------------------------ options

/**
 * Normalize a patch into `[{ path, value }]` entries. Accepts the entry array
 * directly or a (possibly nested) plain object whose leaves are matched
 * against the type's field descriptors.
 */
export function normalizeOptionPatch(patch, fields = []) {
    if (Array.isArray(patch)) {
        return patch
            .filter((entry) => entry && Array.isArray(entry.path) && entry.path.length > 0)
            .map((entry) => ({ path: entry.path.map(String), value: entry.value }));
    }
    if (!isPlainObject(patch)) return [];
    const known = new Set(fields.map((descriptor) => fieldPathKey(descriptor.path)));
    const entries = [];
    // Walk the object: a prefix that names a descriptor is one entry (so
    // vector values stay whole); other plain objects recurse; leaves that
    // match no descriptor still become entries so the command can report
    // them as unknown paths instead of silently ignoring them.
    const walk = (value, prefix) => {
        for (const [key, entry] of Object.entries(value)) {
            const path = [...prefix, key];
            if (entry === undefined) continue;
            if (known.has(fieldPathKey(path)) || !isPlainObject(entry)) entries.push({ path, value: entry });
            else walk(entry, path);
        }
    };
    walk(patch, []);
    return entries;
}

function runOptionsEdit(ctx, objectId, patch) {
    const id = String(objectId);
    const record = ctx.document.getObject(id);
    if (!record) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_MISSING, `Object "${id}" does not exist.`, { objectId: id }));
    if (record.components?.locked === true) {
        return commandFailure(commandIssue(COMMAND_ISSUE_CODES.OBJECT_LOCKED, `"${record.name ?? id}" is locked.`, { objectId: id }));
    }
    const definition = definitionFor(ctx, record);
    if (!definition?.options) {
        return commandFailure(issue(["options"], OPTIONS_ISSUE_CODES.UNSUPPORTED, `Object type "${record.typeId}" has no editable options.`, { objectId: id }));
    }
    const index = ctx.document.index();
    const context = { sky: ctx.sky };
    const previous = readObjectOptionValue(record, index, ctx.registry, context);
    const fields = [...definition.options.getFields({ record })];
    const byPath = new Map(fields.map((descriptor) => [fieldPathKey(descriptor.path), descriptor]));
    const entries = normalizeOptionPatch(patch, fields);
    if (entries.length === 0) {
        return commandFailure(commandIssue(COMMAND_ISSUE_CODES.ARGUMENT_INVALID, "No option values were supplied.", { objectId: id }));
    }
    const issues = [];
    let candidate = previous ?? definition.options.getDefaults();
    for (const entry of entries) {
        const descriptor = byPath.get(fieldPathKey(entry.path));
        if (!descriptor) {
            issues.push(issue(entry.path, OPTIONS_ISSUE_CODES.UNKNOWN_PATH, `"${fieldPathKey(entry.path)}" is not an option of ${definition.label}.`, { objectId: id }));
            continue;
        }
        if (descriptor.readOnly) {
            issues.push(issue(entry.path, OPTIONS_ISSUE_CODES.READ_ONLY, `${descriptor.label} is read-only.`, { objectId: id }));
            continue;
        }
        candidate = setFieldValue(candidate, entry.path, entry.value);
    }
    if (issues.length > 0) return commandFailure(issues);

    // Validate the raw candidate against descriptors first so out-of-range
    // input is reported instead of silently clamped by `normalize()`.
    const constraintIssues = validateFieldConstraints(fields, candidate).map((entry) => ({ ...entry, objectId: id }));
    if (hasErrorIssue(constraintIssues)) return commandFailure(errorIssues(constraintIssues));
    const next = definition.options.normalize(candidate);
    const validation = (definition.options.validate(next, { record }) ?? []).map((entry) => ({ ...entry, objectId: id }));
    if (hasErrorIssue(validation)) return commandFailure(errorIssues(validation));

    const plan = planObjectOptions(record, index, ctx.registry, next, { ...context, previous });
    if (hasErrorIssue(plan.issues)) return commandFailure(errorIssues(plan.issues));
    if (plan.steps.length > 0) {
        const applied = applyPlanSteps(ctx.document, plan.steps, { notify: false });
        if (!applied.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, applied.error, { objectId: id }));
    }
    if (plan.delta) {
        const transform = planTransform(ctx.document, ctx.registry, [id], plan.delta, {});
        if (!transform.ok) return commandFailure(transform.issues);
        const applied = applyPlanSteps(ctx.document, transform.steps, { notify: false });
        if (!applied.ok) return commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, applied.error, { objectId: id }));
    }
    return commandSuccess({ objectId: id, paths: entries.map((entry) => fieldPathKey(entry.path)), value: next });
}

/**
 * Write option field values back to one record through its type's
 * `planOptions`. `patch` is `[{ path: string[], value }]` or a plain object.
 * Validation issues keep their field `path` and nothing mutates on failure.
 */
export function setObjectOptions({ objectId, patch = [], label = "Edit options" } = {}) {
    return {
        id: "set-object-options",
        label,
        run(ctx) {
            return runOptionsEdit(ctx, objectId, patch);
        },
    };
}

/** Apply the same option patch to several records atomically (multi-selection edits). */
export function setObjectsOptions({ objectIds = [], patch = [], label = "Edit options" } = {}) {
    return {
        id: "set-objects-options",
        label,
        run(ctx) {
            if (!Array.isArray(objectIds) || objectIds.length === 0) {
                return commandFailure(commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "No objects to edit."));
            }
            const results = [];
            for (const id of objectIds) {
                const result = runOptionsEdit(ctx, id, patch);
                if (!result.ok) return result;
                results.push(result.result);
            }
            return commandSuccess({ objectIds: results.map((entry) => entry.objectId), paths: results[0]?.paths ?? [] });
        },
    };
}
