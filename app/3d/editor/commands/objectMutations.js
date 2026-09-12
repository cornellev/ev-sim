/**
 * Object-record helpers for commands: hierarchy queries over
 * `document.objects` and small in-place mutations of the overlay. Order is
 * sibling-relative and dense; the persisted flat sort `(order, id)` is
 * unchanged, so renumbering siblings never reorders unrelated subtrees.
 */

import { compareObjectRecords, normalizeObjectRecord, sortObjectRecords } from "../objects/objectRecord.js";

export function indexObjectsById(records) {
    const byId = new Map();
    for (const record of records ?? []) {
        if (record?.id !== undefined && record?.id !== null) byId.set(String(record.id), record);
    }
    return byId;
}

export function parentIdOf(record) {
    const value = record?.parentId;
    return value === undefined || value === null || value === "" ? null : String(value);
}

/** Direct children sorted by `(order, id)`. */
export function childrenOf(records, parentId) {
    const list = records instanceof Map ? [...records.values()] : (records ?? []);
    const target = parentId === undefined || parentId === null || parentId === "" ? null : String(parentId);
    return list.filter((record) => parentIdOf(record) === target).sort(compareObjectRecords);
}

/** Depth-first descendants (excluding `id`), parents before children. */
export function descendantIds(records, id) {
    const byId = records instanceof Map ? records : indexObjectsById(records);
    const result = [];
    const visit = (parentId) => {
        for (const child of childrenOf(byId, parentId)) {
            if (result.includes(child.id)) continue;
            result.push(child.id);
            visit(child.id);
        }
    };
    visit(String(id));
    return result;
}

export function isDescendant(records, ancestorId, candidateId) {
    const byId = records instanceof Map ? records : indexObjectsById(records);
    const ancestor = String(ancestorId);
    let cursor = byId.get(String(candidateId));
    const seen = new Set();
    while (cursor) {
        const parent = parentIdOf(cursor);
        if (parent === null || seen.has(parent)) return false;
        if (parent === ancestor) return true;
        seen.add(parent);
        cursor = byId.get(parent);
    }
    return false;
}

/** Ids whose ancestors are not also in the set, preserving input order. */
export function pruneToRoots(records, ids) {
    const byId = records instanceof Map ? records : indexObjectsById(records);
    const wanted = new Set([...(ids ?? [])].map(String));
    const roots = [];
    for (const id of wanted) {
        if (!byId.has(id)) continue;
        let cursor = byId.get(id);
        let covered = false;
        const seen = new Set([id]);
        while (cursor) {
            const parent = parentIdOf(cursor);
            if (parent === null || seen.has(parent)) break;
            if (wanted.has(parent)) {
                covered = true;
                break;
            }
            seen.add(parent);
            cursor = byId.get(parent);
        }
        if (!covered) roots.push(id);
    }
    return roots;
}

export function nextSiblingOrder(records, parentId) {
    const siblings = childrenOf(records, parentId);
    return siblings.length === 0 ? 0 : Math.max(...siblings.map((record) => record.order ?? 0)) + 1;
}

/**
 * Renumber the children of `parentId` in `records` (mutated in place) so
 * `order` is dense from 0. `moved` records keep their relative order and are
 * inserted at `index` (default: after the existing siblings).
 */
export function renumberSiblings(records, parentId, { moved = [], index = null } = {}) {
    const target = parentId === undefined || parentId === null || parentId === "" ? null : String(parentId);
    const movedIds = [...moved].map(String);
    const movedSet = new Set(movedIds);
    const siblings = records.filter((record) => parentIdOf(record) === target);
    const stable = siblings.filter((record) => !movedSet.has(String(record.id))).sort(compareObjectRecords);
    const movingRecords = movedIds
        .map((id) => siblings.find((record) => String(record.id) === id))
        .filter(Boolean);
    const insertAt = index === null || index === undefined
        ? stable.length
        : Math.max(0, Math.min(stable.length, Math.trunc(index)));
    const ordered = [...stable.slice(0, insertAt), ...movingRecords, ...stable.slice(insertAt)];
    ordered.forEach((record, position) => {
        record.order = position;
    });
    return ordered.map((record) => record.id);
}

/** Set one component on a record in place. Returns `{ ok, record }`. */
export function setObjectComponent(document, objectId, key, value, runtime = {}) {
    const record = document.getObject(String(objectId));
    if (!record) return { ok: false, error: `Object "${objectId}" not found.` };
    if (typeof key !== "string" || key.length === 0) return { ok: false, error: "Component key is required." };
    record.components = { ...(record.components ?? {}), [key]: value === undefined ? undefined : structuredClone(value) };
    if (value === undefined) delete record.components[key];
    if (runtime.notify !== false) document.notify();
    return { ok: true, record };
}

export function renameObjectRecord(document, objectId, name, runtime = {}) {
    const record = document.getObject(String(objectId));
    if (!record) return { ok: false, error: `Object "${objectId}" not found.` };
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return { ok: false, error: "Object names cannot be empty." };
    record.name = trimmed;
    if (runtime.notify !== false) document.notify();
    return { ok: true, record };
}

/** Insert or replace a record, keeping canonical order. */
export function upsertObjectRecord(document, record, runtime = {}) {
    const normalized = normalizeObjectRecord(record);
    if (!normalized.id) return { ok: false, error: "Object records require an id." };
    const list = document.objects.filter((candidate) => String(candidate.id) !== normalized.id);
    list.push(normalized);
    document.objects = sortObjectRecords(list);
    if (runtime.notify !== false) document.notify();
    return { ok: true, record: normalized };
}

export function removeObjectRecords(document, ids, runtime = {}) {
    const removing = new Set([...(ids ?? [])].map(String));
    const before = document.objects.length;
    document.objects = document.objects.filter((record) => !removing.has(String(record.id)));
    const removed = before - document.objects.length;
    if (removed > 0 && runtime.notify !== false) document.notify();
    return { ok: true, removed };
}

/**
 * Ensure a record exists for a legacy entity that a command just created.
 * Returns the existing record when present.
 */
export function ensureObjectRecord(document, { id, typeId, typeVersion = 1, name, parentId = null, components = {} }, runtime = {}) {
    const existing = document.getObject(String(id));
    if (existing) return { ok: true, record: existing, created: false };
    const parent = parentId === undefined || parentId === null || parentId === "" ? null : String(parentId);
    const result = upsertObjectRecord(document, {
        id: String(id),
        typeId,
        typeVersion,
        name: name ?? String(id),
        parentId: parent,
        order: nextSiblingOrder(document.objects, parent),
        components,
    }, runtime);
    return { ...result, created: result.ok };
}
