/**
 * Change sets describe what a committed command or gesture did to an
 * `EnvironmentDocument`: for every domain the complete before and after record
 * keyed by id, plus changed scalars. Undo and redo apply the before or after
 * side wholesale, which is total and idempotent even for mutations that are
 * not (footprint transforms accumulate). Pure: no document or Three imports.
 */

export const CHANGE_SET_VERSION = 1;

export const CHANGE_DOMAINS = Object.freeze([
    "roads.nodes",
    "roads.edges",
    "roads.turnRules",
    "buildings",
    "features",
    "objects",
    "assetMetrics.definitions",
]);

export const CHANGE_SCALARS = Object.freeze([
    "earth",
    "geoFrame",
    "roadsAuthored",
    "buildingsAuthored",
    "featuresAuthored",
    "chunkSize",
    "sky",
    "roadGeometryVersion",
    "assetMetricsVersion",
]);

export const CHANGE_SOURCES = Object.freeze([
    "mutation",
    "command",
    "gesture",
    "undo",
    "redo",
    "cancel",
    "mcp",
    "restore",
]);

const TURN_RULE_SEPARATOR = "\u0000";

export function domainKeyOf(domain, record) {
    if (!record) return null;
    switch (domain) {
        case "roads.nodes":
        case "roads.edges":
        case "features":
        case "objects":
            return record.id === undefined || record.id === null ? null : String(record.id);
        case "assetMetrics.definitions":
            if (record.assetId === undefined || record.revision === undefined) return null;
            return `${String(record.assetId)}@${Number(record.revision)}`;
        case "buildings":
            return record.buildingId === undefined || record.buildingId === null ? null : String(record.buildingId);
        case "roads.turnRules":
            return [record.nodeId, record.fromEdgeId, record.toEdgeId].map(String).join(TURN_RULE_SEPARATOR);
        default:
            throw new TypeError(`Unknown change domain "${domain}".`);
    }
}

export function domainRecordsOf(snapshot, domain) {
    switch (domain) {
        case "roads.nodes":
            return snapshot?.roads?.nodes ?? [];
        case "roads.edges":
            return snapshot?.roads?.edges ?? [];
        case "roads.turnRules":
            return snapshot?.roads?.turnRules ?? [];
        case "buildings":
            return snapshot?.buildings ?? [];
        case "features":
            return snapshot?.features ?? [];
        case "objects":
            return snapshot?.objects ?? [];
        case "assetMetrics.definitions":
            return snapshot?.assetMetrics?.definitions ?? [];
        default:
            throw new TypeError(`Unknown change domain "${domain}".`);
    }
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function recordsEqual(left, right) {
    if (left === right) return true;
    if (left === null || right === null || left === undefined || right === undefined) return false;
    return JSON.stringify(left) === JSON.stringify(right);
}

export function scalarValueOf(snapshot, name) {
    if (name === "roadGeometryVersion") return snapshot?.roads?.geometryVersion ?? null;
    if (name === "assetMetricsVersion") return snapshot?.assetMetrics?.version ?? null;
    return snapshot?.[name] ?? null;
}

export function createEmptyChangeSet(meta = {}) {
    return {
        version: CHANGE_SET_VERSION,
        domains: {},
        scalars: {},
        meta: { transient: false, source: "mutation", ...meta },
    };
}

function ensureDomain(changeSet, domain) {
    if (!changeSet.domains[domain]) {
        changeSet.domains[domain] = { before: new Map(), after: new Map() };
    }
    return changeSet.domains[domain];
}

/** Record one changed entry. `before`/`after` may be null for add/remove. */
export function recordChange(changeSet, domain, key, before, after) {
    if (!CHANGE_DOMAINS.includes(domain)) throw new TypeError(`Unknown change domain "${domain}".`);
    const entry = ensureDomain(changeSet, domain);
    if (!entry.before.has(key)) entry.before.set(key, before === undefined ? null : clone(before));
    entry.after.set(key, after === undefined ? null : clone(after));
    return changeSet;
}

export function recordScalarChange(changeSet, name, before, after) {
    if (!CHANGE_SCALARS.includes(name)) throw new TypeError(`Unknown change scalar "${name}".`);
    if (!changeSet.scalars[name]) changeSet.scalars[name] = { before: clone(before ?? null), after: clone(after ?? null) };
    else changeSet.scalars[name].after = clone(after ?? null);
    return changeSet;
}

function indexRecords(records, domain) {
    const map = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const key = domainKeyOf(domain, record);
        if (key !== null) map.set(key, record);
    }
    return map;
}

/**
 * Diff two document snapshots. Keys present in a domain changed; a null
 * `before` means added, a null `after` means removed.
 */
export function diffSnapshots(before, after, meta = {}) {
    const changeSet = createEmptyChangeSet(meta);
    for (const domain of CHANGE_DOMAINS) {
        const beforeIndex = indexRecords(domainRecordsOf(before, domain), domain);
        const afterIndex = indexRecords(domainRecordsOf(after, domain), domain);
        const keys = new Set([...beforeIndex.keys(), ...afterIndex.keys()]);
        for (const key of keys) {
            const previous = beforeIndex.get(key) ?? null;
            const next = afterIndex.get(key) ?? null;
            if (!recordsEqual(previous, next)) recordChange(changeSet, domain, key, previous, next);
        }
    }
    for (const name of CHANGE_SCALARS) {
        const previous = scalarValueOf(before, name);
        const next = scalarValueOf(after, name);
        if (!recordsEqual(previous, next)) recordScalarChange(changeSet, name, previous, next);
    }
    return changeSet;
}

/** Diff two record captures of the shape `{ [domain]: Map<key, record> }`. */
export function diffCaptures(before, after, meta = {}) {
    const changeSet = createEmptyChangeSet(meta);
    const domains = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    for (const domain of domains) {
        if (!CHANGE_DOMAINS.includes(domain)) continue;
        const previousMap = before?.[domain] ?? new Map();
        const nextMap = after?.[domain] ?? new Map();
        for (const key of new Set([...previousMap.keys(), ...nextMap.keys()])) {
            const previous = previousMap.get(key) ?? null;
            const next = nextMap.get(key) ?? null;
            if (!recordsEqual(previous, next)) recordChange(changeSet, domain, key, previous, next);
        }
    }
    const scalarNames = new Set([
        ...((before?.scalars instanceof Map) ? before.scalars.keys() : []),
        ...((after?.scalars instanceof Map) ? after.scalars.keys() : []),
    ]);
    for (const name of scalarNames) {
        if (!CHANGE_SCALARS.includes(name)) continue;
        const previous = before?.scalars?.get(name) ?? null;
        const next = after?.scalars?.get(name) ?? null;
        if (!recordsEqual(previous, next)) recordScalarChange(changeSet, name, previous, next);
    }
    return changeSet;
}

export function isEmptyChangeSet(changeSet) {
    if (!changeSet) return true;
    return Object.keys(changeSet.domains ?? {}).length === 0 && Object.keys(changeSet.scalars ?? {}).length === 0;
}

export function changedKeys(changeSet, domain) {
    const entry = changeSet?.domains?.[domain];
    return entry ? [...entry.after.keys()] : [];
}

export function hasDomainChanges(changeSet, ...domains) {
    return domains.some((domain) => Boolean(changeSet?.domains?.[domain]));
}

/** Merge `next` onto `base`: the earliest before and the latest after win. */
export function mergeChangeSets(base, next, meta = {}) {
    const merged = createEmptyChangeSet({ ...(base?.meta ?? {}), ...(next?.meta ?? {}), ...meta });
    for (const source of [base, next]) {
        for (const [domain, entry] of Object.entries(source?.domains ?? {})) {
            for (const key of entry.after.keys()) {
                recordChange(merged, domain, key, entry.before.get(key) ?? null, entry.after.get(key) ?? null);
            }
        }
        for (const [name, entry] of Object.entries(source?.scalars ?? {})) {
            recordScalarChange(merged, name, entry.before, entry.after);
        }
    }
    return merged;
}

/** Swap before/after so applying the result's "after" side undoes the original. */
export function invertChangeSet(changeSet, meta = {}) {
    const inverted = createEmptyChangeSet({ ...(changeSet?.meta ?? {}), ...meta });
    for (const [domain, entry] of Object.entries(changeSet?.domains ?? {})) {
        for (const key of entry.after.keys()) {
            recordChange(inverted, domain, key, entry.after.get(key) ?? null, entry.before.get(key) ?? null);
        }
    }
    for (const [name, entry] of Object.entries(changeSet?.scalars ?? {})) {
        recordScalarChange(inverted, name, entry.after, entry.before);
    }
    return inverted;
}

/**
 * Apply one side of a change set to a document. Uses the document's own
 * record replacement so clones and canonical ordering stay consistent.
 * @param {"before"|"after"} side
 */
export function applyChangeSet(document, changeSet, side = "after", meta = {}) {
    if (side !== "before" && side !== "after") throw new TypeError(`Change set side must be "before" or "after", got "${side}".`);
    if (typeof document?.transaction !== "function") throw new TypeError("applyChangeSet requires an EnvironmentDocument.");
    return document.transaction(() => {
        for (const [domain, entry] of Object.entries(changeSet?.domains ?? {})) {
            document.replaceDomainRecords(domain, entry[side], { notify: false });
        }
        for (const [name, entry] of Object.entries(changeSet?.scalars ?? {})) {
            document.setScalar(name, entry[side], { notify: false });
        }
    }, { source: side === "after" ? "redo" : "undo", transient: false, ...meta });
}

export function serializeChangeSet(changeSet) {
    const domains = {};
    for (const [domain, entry] of Object.entries(changeSet?.domains ?? {})) {
        domains[domain] = {
            before: [...entry.before.entries()],
            after: [...entry.after.entries()],
        };
    }
    return {
        version: CHANGE_SET_VERSION,
        domains,
        scalars: clone(changeSet?.scalars ?? {}),
        meta: clone(changeSet?.meta ?? {}),
    };
}

export function deserializeChangeSet(serialized) {
    const changeSet = createEmptyChangeSet(serialized?.meta ?? {});
    for (const [domain, entry] of Object.entries(serialized?.domains ?? {})) {
        const before = new Map(entry.before ?? []);
        const after = new Map(entry.after ?? []);
        for (const key of new Set([...before.keys(), ...after.keys()])) {
            recordChange(changeSet, domain, key, before.get(key) ?? null, after.get(key) ?? null);
        }
    }
    for (const [name, entry] of Object.entries(serialized?.scalars ?? {})) {
        recordScalarChange(changeSet, name, entry.before, entry.after);
    }
    return changeSet;
}
