/**
 * Persisted authoring records for the environment object graph (schema v4).
 *
 * Records overlay the canonical legacy domains: a record for a prop shares the
 * feature's id, a building record shares `buildingId`, road and intersection
 * records share edge and node ids, and a primitive record shares the solid id.
 * The floor record shares the scalar id `floor`. Only `group`, `skybox`, and
 * `tile` records exist without a legacy counterpart. Geometry never lives here.
 */

import { normalizeRigidBody } from "../../../simulation/world/RigidBodyRecords.js";
import { boolean, isPlainObject, stringList } from "./ObjectOptions.js";

export const OBJECT_GRAPH_VERSION = 1;
export const SKYBOX_OBJECT_ID = "skybox";
export const TILE_OBJECT_ID = "tile";
export const FLOOR_OBJECT_ID = "floor";

/**
 * @typedef {{ id: string, scriptId: string, parameters: Record<string, unknown>, seed: number }} ScriptAttachment
 * @typedef {{ attachmentId: string, scriptId: string }} AuthoredBy
 * @typedef {{ tags: string[], locked: boolean, editorHidden: boolean, scripts?: ScriptAttachment[], authoredBy?: AuthoredBy|null }} StandardComponents
 * @typedef {{ id: string, typeId: string, typeVersion: number, name: string, parentId: string|null, order: number,
 *   components: StandardComponents & Record<string, unknown> }} ObjectRecord
 */

export const STANDARD_COMPONENT_KEYS = Object.freeze(["tags", "locked", "editorHidden", "scripts", "authoredBy"]);

export const DEFAULT_COMPONENTS = Object.freeze({
    tags: Object.freeze([]),
    locked: false,
    editorHidden: false,
});

function normalizeScripts(value) {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
        if (!isPlainObject(entry)) return entry;
        return {
            id: entry.id,
            scriptId: entry.scriptId,
            parameters: isPlainObject(entry.parameters) ? structuredClone(entry.parameters) : entry.parameters,
            seed: entry.seed === undefined ? 1 : entry.seed,
        };
    });
}

function normalizeAuthoredBy(value) {
    if (value === null) return null;
    if (!isPlainObject(value)) return value;
    return {
        attachmentId: value.attachmentId,
        scriptId: value.scriptId,
    };
}

function cloneUnknown(value) {
    if (value === undefined) return undefined;
    return structuredClone(value);
}

/**
 * Structural normalization only: coerce shapes and clone, never derive or
 * validate. Unknown component keys are preserved so unsupported types round-trip.
 * @returns {ObjectRecord}
 */
export function normalizeObjectRecord(raw = {}) {
    const source = isPlainObject(raw) ? raw : {};
    const id = String(source.id ?? "").trim();
    const components = isPlainObject(source.components) ? source.components : {};
    const normalizedComponents = {
        tags: stringList(components.tags),
        locked: boolean(components.locked, DEFAULT_COMPONENTS.locked),
        editorHidden: boolean(components.editorHidden, DEFAULT_COMPONENTS.editorHidden),
    };
    if (components.scripts !== undefined) normalizedComponents.scripts = normalizeScripts(components.scripts);
    if (components.authoredBy !== undefined) normalizedComponents.authoredBy = normalizeAuthoredBy(components.authoredBy);
    for (const key of Object.keys(components)) {
        if (STANDARD_COMPONENT_KEYS.includes(key)) continue;
        normalizedComponents[key] = key === "rigidBody" ? normalizeRigidBody(components[key]) : cloneUnknown(components[key]);
    }
    const name = typeof source.name === "string" ? source.name.trim() : "";
    return {
        id,
        typeId: String(source.typeId ?? "").trim(),
        typeVersion: Number.isInteger(source.typeVersion) && source.typeVersion > 0 ? source.typeVersion : 1,
        name: name || id,
        parentId: source.parentId === undefined || source.parentId === null || source.parentId === ""
            ? null
            : String(source.parentId),
        order: Number.isInteger(source.order) ? source.order : 0,
        components: normalizedComponents,
    };
}

/** @returns {ObjectRecord} */
export function cloneObjectRecord(record) {
    return normalizeObjectRecord(record);
}

export function createObjectRecord({ id, typeId, typeVersion = 1, name, parentId = null, order = 0, components = {} }) {
    return normalizeObjectRecord({ id, typeId, typeVersion, name: name ?? id, parentId, order, components });
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical ordering: `order`, then id. Stable across serializations. */
export function compareObjectRecords(left, right) {
    if (left.order !== right.order) return left.order - right.order;
    return compareText(String(left.id), String(right.id));
}

export function sortObjectRecords(records) {
    return [...records].sort(compareObjectRecords);
}
