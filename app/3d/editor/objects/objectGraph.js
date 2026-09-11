/**
 * Object graph derivation, reconciliation, and validation.
 *
 * The graph is an overlay: every legacy geometry record (feature, building,
 * road edge, junction node, earth source) owns one object record sharing its
 * id, plus a single skybox. `deriveObjectGraph` builds that overlay from a
 * document snapshot; `reconcileObjectGraph` merges it with an existing graph
 * without touching geometry; `validateObjectRecords` reports structured
 * issues and never mutates its input. Kernel-safe.
 */

import { hasErrorIssue, isPlainObject, issue, text } from "./ObjectOptions.js";
import { objectTypeRegistry } from "./ObjectTypeRegistry.js";
import {
    OBJECT_GRAPH_VERSION,
    SKYBOX_OBJECT_ID,
    STANDARD_COMPONENT_KEYS,
    TILE_OBJECT_ID,
    createObjectRecord,
    normalizeObjectRecord,
    sortObjectRecords,
} from "./objectRecord.js";
import { BUILDING_TYPE_ID } from "./types/building.js";
import { BUILTIN_PROP_TYPE_ID, getBuiltinPropAsset } from "./types/builtinProp.js";
import { GROUP_TYPE_ID } from "./types/group.js";
import { INTERSECTION_TYPE_ID, isJunctionNode } from "./types/intersection.js";
import { ROAD_TYPE_ID } from "./types/road.js";
import { SKYBOX_TYPE_ID } from "./types/skybox.js";
import { TILE_TYPE_ID } from "./types/tile.js";

export const OBJECT_ISSUE_CODES = Object.freeze({
    GRAPH_VERSION: "graph.version.unsupported",
    ID_MISSING: "object.id.missing",
    ID_DUPLICATE: "object.id.duplicate",
    TYPE_MISSING: "object.type.missing",
    TYPE_UNSUPPORTED: "object.type.unsupported",
    TYPE_VERSION_UNSUPPORTED: "object.type.version-unsupported",
    NAME_INVALID: "object.name.invalid",
    ORDER_INVALID: "object.order.invalid",
    ORDER_DUPLICATE: "object.order.duplicate",
    PARENT_MISSING: "object.parent.missing",
    PARENT_SELF: "object.parent.self",
    PARENT_CYCLE: "object.parent.cycle",
    PARENT_NOT_GROUP: "object.parent.not-group",
    COMPONENTS_INVALID: "object.components.invalid",
    OPTIONS_INVALID: "object.options.invalid",
    LEGACY_MISSING: "object.legacy.missing",
    LEGACY_UNCOVERED: "object.legacy.uncovered",
    LEGACY_TYPE_MISMATCH: "object.legacy.type-mismatch",
    SKYBOX_MULTIPLE: "object.skybox.multiple",
    SKYBOX_ID: "object.skybox.id",
    TILE_MULTIPLE: "object.tile.multiple",
    TILE_ORPHAN: "object.tile.orphan",
});

export const OBJECT_SUPPORT = Object.freeze({
    SUPPORTED: "supported",
    UNSUPPORTED_TYPE: "unsupported-type",
    UNSUPPORTED_VERSION: "unsupported-version",
});

/**
 * Index the canonical legacy domains of a document snapshot by id.
 * @param {object} snapshot `EnvironmentDocument.snapshot()` or `manifest.document`
 */
export function legacyIndex(snapshot = {}) {
    const roads = isPlainObject(snapshot.roads) ? snapshot.roads : {};
    const nodes = new Map();
    for (const node of Array.isArray(roads.nodes) ? roads.nodes : []) {
        if (node?.id !== undefined && node?.id !== null) nodes.set(String(node.id), node);
    }
    const edges = new Map();
    const degree = new Map();
    for (const edge of Array.isArray(roads.edges) ? roads.edges : []) {
        if (edge?.id === undefined || edge?.id === null) continue;
        edges.set(String(edge.id), edge);
        for (const nodeId of [edge.startNodeId, edge.endNodeId]) {
            const key = String(nodeId);
            degree.set(key, (degree.get(key) ?? 0) + 1);
        }
    }
    const junctions = new Map();
    for (const [id, node] of nodes) {
        if (isJunctionNode(node, degree.get(id))) junctions.set(id, node);
    }
    const buildings = new Map();
    for (const building of Array.isArray(snapshot.buildings) ? snapshot.buildings : []) {
        if (building?.buildingId !== undefined && building?.buildingId !== null) {
            buildings.set(String(building.buildingId), building);
        }
    }
    const features = new Map();
    for (const feature of Array.isArray(snapshot.features) ? snapshot.features : []) {
        if (feature?.id !== undefined && feature?.id !== null) features.set(String(feature.id), feature);
    }
    return {
        nodes,
        edges,
        junctions,
        buildings,
        features,
        degree,
        earth: isPlainObject(snapshot.earth) ? snapshot.earth : null,
    };
}

/** Resolve the legacy record backing an object record for a type definition. */
export function legacyRecordFor(index, definition, id, context = {}) {
    switch (definition?.legacy?.domain) {
        case "features":
            return index.features.get(id) ?? null;
        case "buildings":
            return index.buildings.get(id) ?? null;
        case "roads.edges":
            return index.edges.get(id) ?? null;
        case "roads.nodes":
            return index.junctions.get(id) ?? null;
        case "earth":
            return id === TILE_OBJECT_ID ? index.earth : null;
        case "sky":
            return id === SKYBOX_OBJECT_ID ? (context.sky ?? {}) : null;
        default:
            return null;
    }
}

/** The typeId a legacy id implies, or null when the id is not a legacy id. */
export function legacyTypeIdFor(index, id) {
    if (id === SKYBOX_OBJECT_ID) return SKYBOX_TYPE_ID;
    if (id === TILE_OBJECT_ID) return index.earth ? TILE_TYPE_ID : null;
    if (index.features.has(id)) return BUILTIN_PROP_TYPE_ID;
    if (index.buildings.has(id)) return BUILDING_TYPE_ID;
    if (index.edges.has(id)) return ROAD_TYPE_ID;
    if (index.junctions.has(id)) return INTERSECTION_TYPE_ID;
    return null;
}

function sortedIds(map) {
    return [...map.keys()].sort();
}

/**
 * Build the complete overlay for a snapshot. Deterministic: singletons first,
 * then roads, intersections, buildings, and props, each sorted by id.
 * @returns {import("./objectRecord.js").ObjectRecord[]}
 */
export function deriveObjectGraph(snapshot = {}, { startOrder = 0 } = {}) {
    const index = legacyIndex(snapshot);
    const records = [];
    let order = startOrder;
    const push = (id, typeId, name) => {
        records.push(createObjectRecord({ id, typeId, typeVersion: 1, name, parentId: null, order }));
        order += 1;
    };
    push(SKYBOX_OBJECT_ID, SKYBOX_TYPE_ID, "Skybox");
    if (index.earth) push(TILE_OBJECT_ID, TILE_TYPE_ID, "Tile");
    for (const id of sortedIds(index.edges)) push(id, ROAD_TYPE_ID, "Road");
    for (const id of sortedIds(index.junctions)) push(id, INTERSECTION_TYPE_ID, "Intersection");
    for (const id of sortedIds(index.buildings)) push(id, BUILDING_TYPE_ID, "Building");
    for (const id of sortedIds(index.features)) {
        const feature = index.features.get(id);
        push(id, BUILTIN_PROP_TYPE_ID, getBuiltinPropAsset(feature?.type)?.label ?? String(feature?.type ?? "Prop"));
    }
    return records;
}

/**
 * Merge an existing graph with the overlay a snapshot implies. Keeps every
 * existing record (including unsupported types and groups), adds records for
 * legacy entities that lack one, and drops legacy-bound records whose legacy
 * counterpart no longer exists. Never touches geometry.
 * @returns {{ records: import("./objectRecord.js").ObjectRecord[], added: string[], orphaned: string[] }}
 */
export function reconcileObjectGraph(snapshot = {}, existing = [], registry = objectTypeRegistry, context = {}) {
    const index = legacyIndex(snapshot);
    const kept = [];
    const orphaned = [];
    let maxOrder = -1;
    for (const raw of Array.isArray(existing) ? existing : []) {
        const record = normalizeObjectRecord(raw);
        const definition = registry.get(record.typeId, record.typeVersion) ?? registry.get(record.typeId);
        if (definition?.legacy && legacyRecordFor(index, definition, record.id, context) === null) {
            orphaned.push(record.id);
            continue;
        }
        kept.push(record);
        if (record.order > maxOrder) maxOrder = record.order;
    }
    const existingIds = new Set(kept.map((record) => record.id));
    const added = [];
    for (const derived of deriveObjectGraph(snapshot, { startOrder: maxOrder + 1 })) {
        if (existingIds.has(derived.id)) continue;
        kept.push(derived);
        existingIds.add(derived.id);
        added.push(derived.id);
    }
    return { records: sortObjectRecords(kept), added, orphaned };
}

export function describeObjectSupport(record, registry = objectTypeRegistry) {
    const typeId = text(record?.typeId);
    if (!typeId || !registry.get(typeId)) return OBJECT_SUPPORT.UNSUPPORTED_TYPE;
    if (!registry.get(typeId, record.typeVersion)) return OBJECT_SUPPORT.UNSUPPORTED_VERSION;
    return OBJECT_SUPPORT.SUPPORTED;
}

function validateComponents(record, definition, base) {
    const issues = [];
    const components = record.components;
    if (components === undefined) return issues;
    const tag = { objectId: record.id };
    if (!isPlainObject(components)) {
        issues.push(issue([...base, "components"], OBJECT_ISSUE_CODES.COMPONENTS_INVALID, "components must be an object.", tag));
        return issues;
    }
    const allowed = [...STANDARD_COMPONENT_KEYS, ...(definition.components ?? [])];
    for (const key of Object.keys(components)) {
        if (!allowed.includes(key)) {
            issues.push(issue([...base, "components", key], OBJECT_ISSUE_CODES.COMPONENTS_INVALID, `Unknown component "${key}" for type "${definition.typeId}".`, tag));
        }
    }
    if (components.tags !== undefined && (!Array.isArray(components.tags) || !components.tags.every((entry) => typeof entry === "string"))) {
        issues.push(issue([...base, "components", "tags"], OBJECT_ISSUE_CODES.COMPONENTS_INVALID, "tags must be a list of strings.", tag));
    }
    for (const key of ["locked", "editorHidden"]) {
        if (components[key] !== undefined && typeof components[key] !== "boolean") {
            issues.push(issue([...base, "components", key], OBJECT_ISSUE_CODES.COMPONENTS_INVALID, `${key} must be true or false.`, tag));
        }
    }
    return issues;
}

function validateOptions(record, definition, legacy, base, context) {
    const optionContext = { ...context, record };
    const value = definition.options.fromLegacy(legacy, optionContext);
    return definition.options.validate(value, optionContext).map((entry) => ({
        path: [...base, "options", ...entry.path],
        code: OBJECT_ISSUE_CODES.OPTIONS_INVALID,
        optionCode: entry.code,
        message: entry.message,
        severity: entry.severity,
        objectId: record.id,
    }));
}

function parentIdOf(record) {
    const value = record?.parentId;
    return value === undefined || value === null || value === "" ? null : String(value);
}

/**
 * Validate candidate records against a legacy index. Pure: safe to call on a
 * proposed multi-object change before committing any of it.
 * @returns {{ ok: boolean, issues: import("./ObjectOptions.js").ObjectIssue[] }}
 */
export function validateObjectRecords(records, index, registry = objectTypeRegistry, context = {}) {
    const issues = [];
    const list = Array.isArray(records) ? records : [];
    const byId = new Map();
    const singletonCounts = new Map([[SKYBOX_TYPE_ID, 0], [TILE_TYPE_ID, 0]]);

    list.forEach((raw, position) => {
        const record = isPlainObject(raw) ? raw : {};
        const base = ["objects", position];
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const tag = id ? { objectId: id } : {};
        if (!id) {
            issues.push(issue([...base, "id"], OBJECT_ISSUE_CODES.ID_MISSING, "Object records require an id."));
        } else if (byId.has(id)) {
            issues.push(issue([...base, "id"], OBJECT_ISSUE_CODES.ID_DUPLICATE, `Duplicate object id "${id}".`, tag));
        } else {
            byId.set(id, { record, position });
        }
        if (record.name !== undefined && typeof record.name !== "string") {
            issues.push(issue([...base, "name"], OBJECT_ISSUE_CODES.NAME_INVALID, "name must be text.", tag));
        }
        if (record.order !== undefined && !Number.isInteger(record.order)) {
            issues.push(issue([...base, "order"], OBJECT_ISSUE_CODES.ORDER_INVALID, "order must be an integer.", tag));
        }

        const typeId = typeof record.typeId === "string" ? record.typeId.trim() : "";
        if (!typeId) {
            issues.push(issue([...base, "typeId"], OBJECT_ISSUE_CODES.TYPE_MISSING, "Object records require a typeId.", tag));
            return;
        }
        const latest = registry.get(typeId);
        if (!latest) {
            issues.push(issue(
                [...base, "typeId"],
                OBJECT_ISSUE_CODES.TYPE_UNSUPPORTED,
                `Object type "${typeId}" is not registered; the record is preserved as unsupported.`,
                { ...tag, severity: "warning" },
            ));
            return;
        }
        const definition = registry.get(typeId, record.typeVersion ?? 1);
        if (!definition) {
            issues.push(issue(
                [...base, "typeVersion"],
                OBJECT_ISSUE_CODES.TYPE_VERSION_UNSUPPORTED,
                `Object type "${typeId}" version ${record.typeVersion} is newer than the registered version ${latest.version}.`,
                { ...tag, severity: "warning" },
            ));
        }
        if (singletonCounts.has(typeId)) {
            const count = singletonCounts.get(typeId) + 1;
            singletonCounts.set(typeId, count);
            if (count > 1) {
                const code = typeId === SKYBOX_TYPE_ID ? OBJECT_ISSUE_CODES.SKYBOX_MULTIPLE : OBJECT_ISSUE_CODES.TILE_MULTIPLE;
                issues.push(issue([...base, "typeId"], code, `Only one ${typeId} object is allowed.`, tag));
            }
            if (typeId === SKYBOX_TYPE_ID && id && id !== SKYBOX_OBJECT_ID) {
                issues.push(issue([...base, "id"], OBJECT_ISSUE_CODES.SKYBOX_ID, `The skybox object id must be "${SKYBOX_OBJECT_ID}".`, tag));
            }
        }
        if (!definition) return;

        issues.push(...validateComponents(record, definition, base));
        if (!id) return;

        const impliedTypeId = legacyTypeIdFor(index, id);
        if (impliedTypeId && impliedTypeId !== typeId) {
            issues.push(issue(
                [...base, "typeId"],
                OBJECT_ISSUE_CODES.LEGACY_TYPE_MISMATCH,
                `Object "${id}" is a ${impliedTypeId} in the document but is declared as "${typeId}".`,
                tag,
            ));
            return;
        }
        let legacy = null;
        if (definition.legacy) {
            legacy = legacyRecordFor(index, definition, id, context);
            if (legacy === null) {
                if (typeId === TILE_TYPE_ID) {
                    issues.push(issue([...base, "id"], OBJECT_ISSUE_CODES.TILE_ORPHAN, "Tile object has no earth source in the document.", tag));
                } else {
                    issues.push(issue(
                        [...base, "id"],
                        OBJECT_ISSUE_CODES.LEGACY_MISSING,
                        `Object "${id}" has no ${definition.legacy.domain} record in the document.`,
                        tag,
                    ));
                }
                return;
            }
        }
        issues.push(...validateOptions(record, definition, legacy, base, context));
    });

    // Parent structure and sibling ordering.
    const siblingOrders = new Map();
    for (const [id, { record, position }] of byId) {
        const base = ["objects", position];
        const parentId = parentIdOf(record);
        const orderKey = JSON.stringify([parentId, record.order ?? 0]);
        if (siblingOrders.has(orderKey)) {
            issues.push(issue(
                [...base, "order"],
                OBJECT_ISSUE_CODES.ORDER_DUPLICATE,
                `Objects "${siblingOrders.get(orderKey)}" and "${id}" share order ${record.order ?? 0} under the same parent.`,
                { objectId: id, severity: "warning" },
            ));
        } else {
            siblingOrders.set(orderKey, id);
        }
        if (parentId === null) continue;
        if (parentId === id) {
            issues.push(issue([...base, "parentId"], OBJECT_ISSUE_CODES.PARENT_SELF, `Object "${id}" cannot be its own parent.`, { objectId: id }));
            continue;
        }
        const parent = byId.get(parentId);
        if (!parent) {
            issues.push(issue([...base, "parentId"], OBJECT_ISSUE_CODES.PARENT_MISSING, `Parent "${parentId}" of object "${id}" does not exist.`, { objectId: id }));
            continue;
        }
        const parentTypeId = typeof parent.record.typeId === "string" ? parent.record.typeId.trim() : "";
        if (registry.get(parentTypeId) && parentTypeId !== GROUP_TYPE_ID) {
            issues.push(issue(
                [...base, "parentId"],
                OBJECT_ISSUE_CODES.PARENT_NOT_GROUP,
                `Parent "${parentId}" of object "${id}" is a ${parentTypeId}, not a group.`,
                { objectId: id },
            ));
        }
        const visited = new Set([id]);
        let cursor = parentId;
        while (cursor !== null && byId.has(cursor)) {
            if (visited.has(cursor)) {
                issues.push(issue([...base, "parentId"], OBJECT_ISSUE_CODES.PARENT_CYCLE, `Object "${id}" is part of a parent cycle.`, { objectId: id }));
                break;
            }
            visited.add(cursor);
            cursor = parentIdOf(byId.get(cursor).record);
        }
    }

    // Legacy coverage.
    const expected = [
        SKYBOX_OBJECT_ID,
        ...(index.earth ? [TILE_OBJECT_ID] : []),
        ...index.edges.keys(),
        ...index.junctions.keys(),
        ...index.buildings.keys(),
        ...index.features.keys(),
    ];
    for (const id of expected) {
        if (!byId.has(id)) {
            issues.push(issue(["objects"], OBJECT_ISSUE_CODES.LEGACY_UNCOVERED, `Document entity "${id}" has no object record.`, { objectId: id, severity: "warning" }));
        }
    }

    return { ok: !hasErrorIssue(issues), issues };
}

/**
 * Validate a snapshot's object graph in place.
 * @returns {{ ok: boolean, issues: import("./ObjectOptions.js").ObjectIssue[] }}
 */
export function validateObjectGraph(snapshot = {}, registry = objectTypeRegistry, context = {}) {
    const issues = [];
    if (snapshot.objectGraphVersion !== undefined && snapshot.objectGraphVersion !== null
        && snapshot.objectGraphVersion !== OBJECT_GRAPH_VERSION) {
        issues.push(issue(
            ["objectGraphVersion"],
            OBJECT_ISSUE_CODES.GRAPH_VERSION,
            `Unsupported object graph version ${snapshot.objectGraphVersion}; expected ${OBJECT_GRAPH_VERSION}.`,
        ));
    }
    const result = validateObjectRecords(snapshot.objects ?? [], legacyIndex(snapshot), registry, context);
    issues.push(...result.issues);
    return { ok: !hasErrorIssue(issues), issues };
}

/** Read the world placement of a record through its type's binding. */
export function readObjectTransform(record, snapshot, registry = objectTypeRegistry, context = {}) {
    const definition = registry.get(record?.typeId, record?.typeVersion) ?? registry.get(record?.typeId);
    if (!definition) return null;
    const index = legacyIndex(snapshot);
    const legacy = definition.legacy ? legacyRecordFor(index, definition, record.id, context) : null;
    const binding = definition.getTransformBinding(record);
    return binding?.read?.(legacy, { nodes: index.nodes, record }) ?? null;
}
