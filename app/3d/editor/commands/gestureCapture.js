/**
 * Record capture for gestures: the pristine copies of every record a
 * transform closure can touch. `updateGesture` restores this capture before
 * re-applying the cumulative delta, so frames are idempotent regardless of
 * how many pointer events arrive.
 */

import { diffCaptures } from "../document/ChangeSet.js";

function cloneInto(map, key, record) {
    if (record) map.set(String(key), structuredClone(record));
}

/**
 * @returns {{ "roads.nodes": Map, "roads.edges": Map, features: Map, buildings: Map, objects: Map }}
 */
export function captureRecords(document, closure) {
    const index = document.index();
    const capture = {
        "roads.nodes": new Map(),
        "roads.edges": new Map(),
        features: new Map(),
        buildings: new Map(),
        objects: new Map(),
    };
    for (const nodeId of closure.nodeIds ?? []) cloneInto(capture["roads.nodes"], nodeId, index.nodes.get(String(nodeId)));
    for (const edgeId of closure.edgeIds ?? []) cloneInto(capture["roads.edges"], edgeId, index.edges.get(String(edgeId)));
    for (const featureId of closure.featureIds ?? []) cloneInto(capture.features, featureId, index.features.get(String(featureId)));
    for (const buildingId of closure.buildingIds ?? []) cloneInto(capture.buildings, buildingId, index.buildings.get(String(buildingId)));
    for (const groupId of closure.groups ?? []) cloneInto(capture.objects, groupId, index.objects.get(String(groupId)));
    return capture;
}

/** Put every captured record back verbatim (no notification). */
export function restoreRecords(document, capture) {
    for (const [domain, records] of Object.entries(capture ?? {})) {
        if (records instanceof Map && records.size > 0) {
            document.replaceDomainRecords(domain, records, { notify: false });
        }
    }
}

export function capturesEqual(left, right) {
    const domains = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
    for (const domain of domains) {
        const a = left?.[domain] ?? new Map();
        const b = right?.[domain] ?? new Map();
        if (a.size !== b.size) return false;
        for (const [key, record] of a) {
            if (!b.has(key)) return false;
            if (JSON.stringify(record) !== JSON.stringify(b.get(key))) return false;
        }
    }
    return true;
}

export function changeSetBetween(before, after, meta = {}) {
    return diffCaptures(before, after, meta);
}
