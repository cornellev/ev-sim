/** Transactional ED-07 asset document with serializable before/after change sets. */

import { normalizeAssetDefinition, validateAssetDefinition } from "./AssetDefinition.js";
import { assetTransformMatrix, multiplyAssetMatrices } from "./AssetCompiler.js";
import { normalizeDelta } from "../3d/editor/objects/transformDelta.js";

export const ASSET_CHANGE_SET_VERSION = 1;
export const ASSET_CHANGE_DOMAINS = Object.freeze(["sources", "parts", "materials", "lidarProxies", "collisionProxies"]);
export const ASSET_CHANGE_SCALARS = Object.freeze(["normalization"]);

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function diffAssetSnapshots(before, after, meta = {}) {
    const changeSet = { version: ASSET_CHANGE_SET_VERSION, domains: {}, scalars: {}, meta: { transient: false, source: "command", ...meta } };
    for (const domain of ASSET_CHANGE_DOMAINS) {
        const prior = new Map((before?.[domain] ?? []).map((entry) => [entry.id, entry]));
        const next = new Map((after?.[domain] ?? []).map((entry) => [entry.id, entry]));
        for (const id of new Set([...prior.keys(), ...next.keys()])) {
            const left = prior.get(id) ?? null; const right = next.get(id) ?? null;
            if (!equal(left, right)) {
                changeSet.domains[domain] ??= { before: new Map(), after: new Map() };
                changeSet.domains[domain].before.set(id, clone(left));
                changeSet.domains[domain].after.set(id, clone(right));
            }
        }
    }
    for (const scalar of ASSET_CHANGE_SCALARS) if (!equal(before?.[scalar], after?.[scalar])) changeSet.scalars[scalar] = { before: clone(before?.[scalar]), after: clone(after?.[scalar]) };
    return changeSet;
}

export function applyAssetChangeSet(document, changeSet, side = "after", meta = {}) {
    if (!["before", "after"].includes(side)) throw new TypeError("Asset change-set side must be before or after.");
    return document.transaction(() => {
        for (const [domain, entries] of Object.entries(changeSet?.domains ?? {})) document.replaceDomainRecords(domain, entries[side], { notify: false });
        for (const [name, entry] of Object.entries(changeSet?.scalars ?? {})) document.setScalar(name, entry[side], { notify: false });
    }, { source: side === "before" ? "undo" : "redo", ...meta });
}

export class AssetDocument {
    constructor(definition = {}) {
        const rawIssues = validateAssetDefinition(definition);
        if (rawIssues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(rawIssues[0].message), { issues: rawIssues });
        this.definition = normalizeAssetDefinition(definition);
        const issues = validateAssetDefinition(this.definition);
        if (issues.some((entry) => entry.severity === "error")) throw Object.assign(new TypeError(issues[0].message), { issues });
        this.version = 0;
        this.inTransaction = false;
        this.subscribers = new Set();
        this.transactionState = null;
    }

    snapshot() { return clone(this.definition); }
    get parts() { return this.definition.parts; }
    get materials() { return this.definition.materials; }
    get lidarProxies() { return this.definition.lidarProxies; }
    get collisionProxies() { return this.definition.collisionProxies; }
    getPart(id) { return this.definition.parts.find((entry) => entry.id === String(id)) ?? null; }

    restoreSnapshot(snapshot, { notify = true, source = "restore" } = {}) {
        const before = this.snapshot();
        this.definition = normalizeAssetDefinition(snapshot);
        if (notify) this.notify({ source, changeSet: diffAssetSnapshots(before, this.definition, { source }) });
        return this.snapshot();
    }

    replaceDefinition(definition, { notify = true } = {}) {
        const before = this.snapshot();
        const rawIssues = validateAssetDefinition(definition);
        if (rawIssues.some((entry) => entry.severity === "error")) return { ok: false, issues: rawIssues };
        const candidate = normalizeAssetDefinition(definition);
        const issues = validateAssetDefinition(candidate);
        if (issues.some((entry) => entry.severity === "error")) return { ok: false, issues };
        this.definition = candidate;
        if (notify) this.notify({ changeSet: diffAssetSnapshots(before, candidate) });
        return { ok: true, definition: this.snapshot() };
    }

    replaceDomainRecords(domain, records, { notify = true } = {}) {
        if (!ASSET_CHANGE_DOMAINS.includes(domain)) throw new TypeError(`Unknown asset domain "${domain}".`);
        const before = this.snapshot();
        if (records instanceof Map) {
            const map = new Map(this.definition[domain].map((entry) => [entry.id, entry]));
            for (const [id, value] of records) { if (value === null) map.delete(id); else map.set(id, clone(value)); }
            this.definition = normalizeAssetDefinition({ ...this.definition, [domain]: [...map.values()] });
        } else this.definition = normalizeAssetDefinition({ ...this.definition, [domain]: records });
        if (notify) this.notify({ changeSet: diffAssetSnapshots(before, this.definition) });
    }

    setScalar(name, value, { notify = true } = {}) {
        if (!ASSET_CHANGE_SCALARS.includes(name)) throw new TypeError(`Unknown asset scalar "${name}".`);
        const before = this.snapshot();
        this.definition = normalizeAssetDefinition({ ...this.definition, [name]: clone(value) });
        if (notify) this.notify({ changeSet: diffAssetSnapshots(before, this.definition) });
    }

    transaction(fn, meta = {}) {
        if (this.inTransaction) return { result: fn(this), changeSet: null };
        const before = this.snapshot();
        this.inTransaction = true;
        let result;
        try { result = fn(this); }
        catch (error) { this.definition = before; throw error; }
        finally { this.inTransaction = false; }
        const changeSet = diffAssetSnapshots(before, this.snapshot(), meta);
        if (Object.keys(changeSet.domains).length || Object.keys(changeSet.scalars).length) this.notify({ transient: meta.transient === true, source: meta.source ?? "command", changeSet });
        return { result, changeSet };
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot(), { version: this.version, transient: false, changeSet: null, source: "subscribe" });
        return () => this.subscribers.delete(callback);
    }

    notify(event = {}) {
        this.version += 1;
        const payload = { version: this.version, transient: false, changeSet: null, source: "mutation", ...event };
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot, payload));
    }
}

export function createAssetDocumentAdapter() {
    return {
        kind: "asset",
        reconcile() {},
        validate(document) {
            const issues = validateAssetDefinition(document.snapshot());
            return { ok: !issues.some((entry) => entry.severity === "error"), issues };
        },
        applyChangeSet: applyAssetChangeSet,
        pruneSelection(document, selection) { selection?.prune?.(new Set(document.parts.map((part) => part.id))); },
        selectionIds(document) { return document.parts.map((part) => part.id); },
        collectGestureClosure(document, _registry, objectIds) {
            const selected = new Set(objectIds.map(String));
            const parts = new Map(document.parts.map((part) => [part.id, part]));
            const issues = [...selected].filter((id) => !parts.has(id)).map((id) => ({ path: ["parts", id], code: "asset.part.missing", message: `Part "${id}" does not exist.`, severity: "error" }));
            const roots = new Set([...selected].filter((id) => {
                let parentId = parts.get(id)?.parentId;
                while (parentId) { if (selected.has(parentId)) return false; parentId = parts.get(parentId)?.parentId; }
                return true;
            }));
            return { partIds: roots, issues };
        },
        gestureClosureEmpty(closure) { return closure.partIds.size === 0; },
        captureGesture(document) { return document.snapshot(); },
        restoreGesture(document, capture) { document.restoreSnapshot(capture, { notify: false }); },
        planGesture(document, _registry, _objectIds, delta, { closure }) {
            const candidate = document.snapshot();
            const normalized = normalizeDelta(delta);
            try {
                candidate.parts = candidate.parts.map((part) => closure.partIds.has(part.id)
                    ? { ...part, transform: transformFromMatrix(multiplyAssetMatrices(normalized.matrix, assetTransformMatrix(part.transform))) }
                    : part);
                const rawIssues = validateAssetDefinition(candidate);
                if (rawIssues.some((entry) => entry.severity === "error")) return { ok: false, issues: rawIssues, candidate: null };
                const normalizedCandidate = normalizeAssetDefinition(candidate);
                const issues = validateAssetDefinition(normalizedCandidate);
                return { ok: !issues.some((entry) => entry.severity === "error"), issues, candidate: normalizedCandidate };
            } catch (error) {
                return { ok: false, issues: [{ path: ["parts"], code: "asset.transform.invalid", message: error.message, severity: "error" }], candidate: null };
            }
        },
        applyGesturePlan(document, plan) { return document.replaceDefinition(plan.candidate, { notify: false }); },
        capturesEqual(left, right) { return equal(left, right); },
        changeSetBetween: diffAssetSnapshots,
        applyChangeSet: applyAssetChangeSet,
        isEmptyChangeSet(changeSet) { return Object.keys(changeSet?.domains ?? {}).length === 0 && Object.keys(changeSet?.scalars ?? {}).length === 0; },
    };
}

function transformFromMatrix(matrix) {
    const position = [matrix[12], matrix[13], matrix[14]];
    const scale = [Math.hypot(matrix[0], matrix[1], matrix[2]), Math.hypot(matrix[4], matrix[5], matrix[6]), Math.hypot(matrix[8], matrix[9], matrix[10])];
    if (scale.some((value) => !Number.isFinite(value) || value <= 1e-12)) throw new TypeError("Asset part scale must remain positive and nonsingular.");
    const m00 = matrix[0] / scale[0], m01 = matrix[4] / scale[1], m02 = matrix[8] / scale[2];
    const m10 = matrix[1] / scale[0], m11 = matrix[5] / scale[1], m12 = matrix[9] / scale[2];
    const m20 = matrix[2] / scale[0], m21 = matrix[6] / scale[1], m22 = matrix[10] / scale[2];
    const determinant = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
    if (determinant <= 0) throw new TypeError("Asset part transforms cannot contain reflection or negative scale.");
    let x; let y; let z; let w;
    const trace = m00 + m11 + m22;
    if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
    const length = Math.hypot(x, y, z, w);
    const quaternion = [x / length, y / length, z / length, w / length];
    if (quaternion[3] < 0) quaternion.forEach((value, index) => { quaternion[index] = -value; });
    return { position, quaternion, scale };
}
