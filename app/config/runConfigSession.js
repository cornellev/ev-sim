export const RAW_MANIFEST_BUFFER_ID = "manifest-json";
export const EMBEDDED_BINDINGS_BUFFER_ID = "scripts.embeddedBindings";
export const OTHER_JSON_BUFFER_MESSAGE = "Fix or discard the other invalid JSON before this change can apply.";

export function sensorJsonBufferId(sensorId, path) {
    return `sensor.${sensorId}.${path}`;
}

export function advancedEditorA11yProps(hidden) {
    if (!hidden) return {};
    return { hidden: true, inert: true, "aria-hidden": true };
}

function entryContents(entry) {
    return {
        label: entry.label,
        text: entry.text,
        error: entry.error || "",
        ready: Boolean(entry.ready),
        parsed: entry.parsed,
        patch: entry.patch ?? null,
    };
}

function sameEntry(left, right) {
    return left.label === right.label
        && left.text === right.text
        && left.error === right.error
        && left.ready === right.ready
        && JSON.stringify(left.parsed) === JSON.stringify(right.parsed)
        && JSON.stringify(left.patch) === JSON.stringify(right.patch);
}

export function writeJsonBuffer(buffers = {}, id, entry) {
    const current = buffers?.[id];
    if (entry == null) {
        if (!current) return buffers || {};
        const next = { ...buffers };
        delete next[id];
        return next;
    }
    const normalized = entryContents(entry);
    if (current && sameEntry(current, normalized)) return buffers;
    return { ...(buffers || {}), [id]: normalized };
}

export function listJsonBuffers(buffers = {}) {
    return Object.entries(buffers).map(([id, entry]) => ({ id, ...entry }));
}

export function jsonBufferGate(buffers = {}) {
    const entries = listJsonBuffers(buffers);
    return {
        blocked: entries.length > 0,
        invalidIds: entries.filter((entry) => !entry.ready).map((entry) => entry.id),
        readyIds: entries.filter((entry) => entry.ready).map((entry) => entry.id),
    };
}

export function jsonBufferMessage(buffers = {}) {
    return listJsonBuffers(buffers)
        .filter((entry) => entry.error)
        .map((entry) => `${entry.label}: ${entry.error}`)
        .join("\n");
}

export function runConfigHasUnsavedWork({ dirty = false, buffers = {} } = {}) {
    return Boolean(dirty) || jsonBufferGate(buffers).blocked;
}

export function stageJsonBuffer(buffers, id, { label, text, error = null, parsed, patch = null }) {
    if (error) {
        return {
            buffers: writeJsonBuffer(buffers, id, { label, text, error, ready: false, patch }),
            flush: false,
        };
    }
    const without = writeJsonBuffer(buffers, id, null);
    const waiting = jsonBufferGate(without).invalidIds.length > 0;
    return {
        buffers: writeJsonBuffer(without, id, {
            label,
            text,
            error: waiting ? OTHER_JSON_BUFFER_MESSAGE : "",
            ready: true,
            parsed,
            patch,
        }),
        flush: !waiting,
    };
}

// Raw replaces the document, then ready field patches apply onto that document.
export function planReadyFlush(buffers = {}) {
    const gate = jsonBufferGate(buffers);
    if (gate.invalidIds.length > 0 || gate.readyIds.length === 0) return [];
    const raw = gate.readyIds.filter((id) => id === RAW_MANIFEST_BUFFER_ID);
    const fields = gate.readyIds.filter((id) => id !== RAW_MANIFEST_BUFFER_ID).sort();
    return [...raw, ...fields];
}

export function applyReadyBuffers(draft, buffers, applyEntry) {
    const plan = planReadyFlush(buffers);
    if (plan.length === 0) return { draft, buffers, appliedIds: [] };
    let nextDraft = draft;
    let nextBuffers = buffers;
    const appliedIds = [];
    for (const id of plan) {
        if (jsonBufferGate(nextBuffers).invalidIds.length > 0) break;
        const entry = nextBuffers[id];
        try {
            nextDraft = applyEntry(nextDraft, entry, id);
            nextBuffers = writeJsonBuffer(nextBuffers, id, null);
            appliedIds.push(id);
        } catch (caught) {
            nextBuffers = writeJsonBuffer(nextBuffers, id, {
                ...entry,
                ready: false,
                error: caught instanceof Error ? caught.message : String(caught),
            });
        }
    }
    return { draft: nextDraft, buffers: nextBuffers, appliedIds };
}
