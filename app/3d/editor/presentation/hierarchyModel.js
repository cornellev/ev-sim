/**
 * Pure hierarchy model over `document.objects`: a tree sorted by sibling
 * order, flattened rows for rendering, search filtering, and drop planning
 * for drag-and-drop reparenting. Presentation lookups (icons, labels) come
 * from an EditorPresentationRegistry; nothing here imports React or Three.
 */

import { childrenOf, indexObjectsById, isDescendant, parentIdOf, pruneToRoots } from "../commands/objectMutations.js";
import { GROUP_TYPE_ID } from "../objects/types/group.js";
import { editorPresentationRegistry } from "./EditorPresentationRegistry.js";

/**
 * @returns {Array<{ id, record, typeId, name, depth, children, hidden, ownHidden, locked, isGroup, supported, icon, label }>}
 */
export function buildHierarchyTree(objects, { presentation = editorPresentationRegistry } = {}) {
    const byId = indexObjectsById(objects ?? []);
    const build = (parentId, depth, inheritedHidden) => childrenOf(byId, parentId).map((record) => {
        const view = presentation.forRecord(record);
        const ownHidden = record.components?.editorHidden === true;
        const hidden = inheritedHidden || ownHidden;
        const isGroup = record.typeId === GROUP_TYPE_ID;
        return {
            id: String(record.id),
            record,
            typeId: record.typeId,
            name: record.name ?? String(record.id),
            label: record.name ?? view.label,
            typeLabel: view.label,
            depth,
            isGroup,
            hidden,
            ownHidden,
            locked: record.components?.locked === true,
            supported: view.supported,
            icon: view.icon,
            children: isGroup ? build(String(record.id), depth + 1, hidden) : [],
        };
    });
    return build(null, 0, false);
}

/** Depth-first rows; collapsed groups hide their subtree. */
export function flattenHierarchyTree(tree, { expanded = null, isExpanded = null } = {}) {
    const open = (node) => {
        if (typeof isExpanded === "function") return isExpanded(node.id) !== false;
        if (expanded instanceof Set) return expanded.has(node.id);
        if (expanded && typeof expanded === "object") return expanded[node.id] !== false;
        return true;
    };
    const rows = [];
    const visit = (nodes) => {
        for (const node of nodes) {
            const expandedNode = node.isGroup && open(node);
            rows.push({ ...node, expanded: expandedNode, hasChildren: node.children.length > 0 });
            if (expandedNode) visit(node.children);
        }
    };
    visit(tree);
    return rows;
}

/** Case-insensitive match on name, id, or type; ancestors of matches stay visible. */
export function filterHierarchyTree(tree, query) {
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return tree;
    const matches = (node) => [node.name, node.id, node.typeId, node.typeLabel].some((value) => String(value ?? "").toLowerCase().includes(needle));
    const prune = (nodes) => nodes.flatMap((node) => {
        const children = prune(node.children);
        if (matches(node) || children.length > 0) return [{ ...node, children }];
        return [];
    });
    return prune(tree);
}

export function collectHierarchyIds(tree) {
    const ids = [];
    const visit = (nodes) => {
        for (const node of nodes) {
            ids.push(node.id);
            visit(node.children);
        }
    };
    visit(tree);
    return ids;
}

/**
 * Plan a drag-and-drop reparent. `position` is "inside" (drop onto a group),
 * "before", or "after" a sibling. Returns `{ ok, parentId, index, reason }`
 * for `reparentObjects`; dropping into your own subtree is rejected here so
 * the UI can show an indicator before committing.
 */
export function planHierarchyDrop({ objects, draggedIds, targetId, position = "after" }) {
    const byId = indexObjectsById(objects ?? []);
    const roots = pruneToRoots(byId, draggedIds ?? []);
    if (roots.length === 0) return { ok: false, reason: "Nothing to move." };
    const target = targetId === null || targetId === undefined ? null : byId.get(String(targetId));
    if (targetId !== null && targetId !== undefined && !target) return { ok: false, reason: "Drop target no longer exists." };
    if (target && roots.includes(String(target.id))) return { ok: false, reason: "Cannot drop an object onto itself." };
    let parentId;
    let index;
    if (!target) {
        parentId = null;
        index = null;
    } else if (position === "inside") {
        if (target.typeId !== GROUP_TYPE_ID) return { ok: false, reason: "Only groups accept children." };
        parentId = String(target.id);
        index = null;
    } else {
        parentId = parentIdOf(target);
        const siblings = childrenOf(byId, parentId).filter((record) => !roots.includes(String(record.id)));
        const at = siblings.findIndex((record) => String(record.id) === String(target.id));
        index = at < 0 ? siblings.length : at + (position === "after" ? 1 : 0);
    }
    for (const id of roots) {
        if (parentId !== null && (id === parentId || isDescendant(byId, id, parentId))) {
            return { ok: false, reason: "Cannot move a group into its own subtree." };
        }
    }
    return { ok: true, parentId, index, objectIds: roots };
}

/** Selection ids that are part of the visible tree (for range selection). */
export function hierarchyRowIndex(rows, id) {
    return rows.findIndex((row) => row.id === String(id));
}

export function hierarchyRangeIds(rows, fromId, toId) {
    const start = hierarchyRowIndex(rows, fromId);
    const end = hierarchyRowIndex(rows, toId);
    if (start < 0 || end < 0) return toId ? [String(toId)] : [];
    const [low, high] = start <= end ? [start, end] : [end, start];
    return rows.slice(low, high + 1).map((row) => row.id);
}
