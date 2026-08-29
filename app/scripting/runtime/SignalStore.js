import { normalizeSignalPath } from "./SignalPaths.js";
import { simulationTimeUsFromValues } from "../../telemetry/SimulationClock.js";

function nowIso(now = Date.now()) {
    const value = typeof now === "function" ? now() : now;
    return new Date(value).toISOString();
}

function nowMs(now = Date.now()) {
    const value = typeof now === "function" ? now() : now;
    return value instanceof Date ? value.getTime() : Number(value);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(value);
        } catch {
            // Fall through to JSON cloning for plain telemetry payloads.
        }
    }
    return JSON.parse(JSON.stringify(value));
}

function createSourceId() {
    const suffix = Math.random().toString(36).slice(2, 10);
    return `source-${Date.now().toString(36)}-${suffix}`;
}

function monotonicNowMs() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
    }
    return Date.now();
}

function inferSignalType(value, fallback = "json") {
    if (typeof value === "number") return Number.isInteger(value) ? "int32" : "float64";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "string") return "string";
    if (Array.isArray(value)) return "array[json]";
    if (value === null || value === undefined) return fallback;
    return "json";
}

function normalizeUpdatedAt(value, now = Date.now()) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") return new Date(value).toISOString();
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
    return nowIso(now);
}

function normalizeStaleAfter(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function entryAgeSeconds(entry, now = Date.now()) {
    if (!entry?.updatedAt) return null;
    const updatedAt = Date.parse(entry.updatedAt);
    if (Number.isNaN(updatedAt)) return null;
    return Math.max(0, (nowMs(now) - updatedAt) / 1000);
}

function valuesEqual(a, b) {
    if (Object.is(a, b)) return true;

    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

/** True for Image / PointCloud2-shaped payloads that must not be cloned or retained. */
export function isHeavyValue(value) {
    if (!isPlainObject(value)) return false;
    if (ArrayBuffer.isView(value.data) || value.data instanceof ArrayBuffer) {
        if (Number.isFinite(Number(value.width)) && Number.isFinite(Number(value.height)) && value.encoding != null) {
            return true;
        }
        if (Number.isFinite(Number(value.width)) && Number.isFinite(Number(value.point_step)) && Array.isArray(value.fields)) {
            return true;
        }
    }
    return false;
}

function isHeavyDescriptor(descriptor) {
    return descriptor?.logClass === "heavy";
}

function isHeavyPath(store, path) {
    return isHeavyDescriptor(store._descriptors.get(path));
}

function cloneEntryShallowHeavy(entry) {
    if (!entry) return entry;
    return {
        ...entry,
        value: entry.value,
        metadata: entry.metadata,
        validation: entry.validation,
    };
}

export function createSignalEntry(value, options = {}) {
    const type = options.type || inferSignalType(value);

    return {
        value: cloneValue(value),
        type,
        updatedAt: normalizeUpdatedAt(options.updatedAt, options.now || Date.now),
        source: options.source || "local",
        timeUs: Number.isFinite(Number(options.timeUs)) ? Math.max(0, Math.round(Number(options.timeUs))) : null,
        cycle: Number.isFinite(Number(options.cycle)) ? Math.max(0, Math.round(Number(options.cycle))) : null,
        staleAfter: normalizeStaleAfter(options.staleAfter),
        metadata: isPlainObject(options.metadata) ? cloneValue(options.metadata) : null,
        validation: isPlainObject(options.validation) ? cloneValue(options.validation) : null
    };
}

export function normalizeSignalEntry(value, options = {}) {
    if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "value")) {
        return createSignalEntry(value.value, {
            ...value,
            ...options,
            metadata: options.metadata ?? value.metadata,
            validation: options.validation ?? value.validation
        });
    }

    return createSignalEntry(value, options);
}

export function getByPath(value, path, fallback = undefined) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return value ?? fallback;

    const parts = normalizedPath.split(".").filter(Boolean);
    let current = value;

    for (const part of parts) {
        if (current === null || current === undefined) return fallback;
        if (!Object.prototype.hasOwnProperty.call(Object(current), part)) return fallback;
        current = current[part];
    }

    return current === undefined ? fallback : current;
}

export function setByPath(value, path, nextValue) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return cloneValue(nextValue);

    const root = isPlainObject(value) || Array.isArray(value) ? cloneValue(value) : {};
    const parts = normalizedPath.split(".").filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
        if (index === parts.length - 1) {
            current[part] = cloneValue(nextValue);
            return;
        }

        if (!isPlainObject(current[part]) && !Array.isArray(current[part])) {
            current[part] = {};
        }
        current = current[part];
    });

    return root;
}

export class SignalStore {
    constructor(initialValues = {}, options = {}) {
        this.now = options.now || Date.now;
        this.sourceId = options.sourceId || createSourceId();
        this.sessionStartedAtMs = options.sessionStartedAtMs ?? monotonicNowMs();
        this.historyDurationUs = Math.max(1, Number(options.historyDurationSeconds ?? 120)) * 1e6;
        this.historySampleLimit = Math.max(1, Number(options.historySampleLimit ?? 20000));
        this._committed = new Map();
        this._previous = new Map();
        this._layers = [];
        this._history = new Map();
        this._descriptors = new Map();
        this._listeners = new Set();
        this._events = [];
        this._eventLimit = Math.max(1, Number(options.eventLimit ?? 5000));
        this._sequence = 0;
        this.hydrate(initialValues);
    }

    getSimulationTimeUs() {
        return simulationTimeUsFromValues(
            this._committed.get("simulation.timeNs"),
            this._committed.get("simulation.time"),
        );
    }

    getTimeUs() {
        const simulationTimeUs = this.getSimulationTimeUs();
        if (simulationTimeUs !== null) return simulationTimeUs;
        return Math.max(0, Math.round((monotonicNowMs() - this.sessionStartedAtMs) * 1000));
    }

    defineSignal(descriptor = {}) {
        const path = normalizeSignalPath(descriptor.path);
        if (!path) throw new Error("Signal descriptors require a path.");

        const current = this._descriptors.get(path);
        const nextLogClass = descriptor.logClass || current?.logClass || "standard";
        // Promote to heavy even when type is unchanged — later publishes may discover size.
        const logClass = current?.logClass === "heavy" || nextLogClass === "heavy"
            ? "heavy"
            : nextLogClass;
        const normalized = {
            path,
            type: descriptor.type || current?.type || "json",
            unit: descriptor.unit ?? current?.unit ?? null,
            source: descriptor.source || current?.source || "local",
            category: descriptor.category || current?.category || path.split(".")[0] || "signals",
            replayRole: descriptor.replayRole || current?.replayRole || "derived",
            logClass,
            description: descriptor.description ?? current?.description ?? null,
            metadata: {
                ...(current?.metadata || {}),
                ...(isPlainObject(descriptor.metadata) ? cloneValue(descriptor.metadata) : {}),
            },
        };

        const typeChanged = Boolean(current && current.type !== normalized.type);
        this._descriptors.set(path, normalized);
        if (typeChanged) {
            this.emitTelemetryEvent({
                category: "schema",
                name: "signal-type-changed",
                severity: "warning",
                payload: { path, previousType: current.type, nextType: normalized.type },
            });
        }
        this._notify({ kind: "catalog", descriptor: cloneValue(normalized) });
        return cloneValue(normalized);
    }

    descriptor(path) {
        const descriptor = this._descriptors.get(normalizeSignalPath(path));
        return descriptor ? cloneValue(descriptor) : null;
    }

    descriptors() {
        return [...this._descriptors.values()]
            .map((descriptor) => cloneValue(descriptor))
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    removeSignal(path) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath) return false;
        const descriptor = this._descriptors.get(normalizedPath);
        const existed = Boolean(descriptor || this._committed.has(normalizedPath));
        if (!existed) return false;
        this._descriptors.delete(normalizedPath);
        this._committed.delete(normalizedPath);
        this._previous.delete(normalizedPath);
        this._history.delete(normalizedPath);
        this._notify({ kind: "catalog", action: "removed", path: normalizedPath, descriptor: descriptor ? cloneValue(descriptor) : null });
        return true;
    }

    subscribeSignals(options, listener) {
        let resolvedOptions = options;
        let resolvedListener = listener;
        if (typeof options === "function") {
            resolvedListener = options;
            resolvedOptions = {};
        }
        if (typeof resolvedListener !== "function") return () => {};

        const paths = Array.isArray(resolvedOptions?.paths)
            ? new Set(resolvedOptions.paths.map(normalizeSignalPath).filter(Boolean))
            : null;
        const subscription = {
            listener: resolvedListener,
            paths,
            includeEvents: resolvedOptions?.includeEvents !== false,
            includeCatalog: resolvedOptions?.includeCatalog !== false,
            // Default off: heavy Image/PointCloud2 must be opted into (or listed in paths).
            includeHeavy: resolvedOptions?.includeHeavy === true,
        };
        this._listeners.add(subscription);
        return () => this._listeners.delete(subscription);
    }

    _notify(message) {
        const envelope = {
            sourceId: this.sourceId,
            sequence: ++this._sequence,
            ...message,
        };
        const path = envelope.path ? normalizeSignalPath(envelope.path) : null;
        const heavyUpdate = envelope.kind === "update" && path && isHeavyPath(this, path);
        // Snapshot so a listener that setStates/resubscribes cannot extend this pass.
        for (const subscription of [...this._listeners]) {
            if (envelope.kind === "event" && !subscription.includeEvents) continue;
            if (envelope.kind === "catalog" && !subscription.includeCatalog) continue;
            if (path && subscription.paths && !subscription.paths.has(path)) continue;
            if (heavyUpdate) {
                const pathAllowed = Boolean(subscription.paths?.has(path));
                if (!subscription.includeHeavy && !pathAllowed) continue;
                // Pass by reference — cloning PointCloud2/Image is the memory leak.
                subscription.listener(envelope);
                continue;
            }
            subscription.listener(cloneValue(envelope));
        }
    }

    emitTelemetryEvent(event = {}) {
        const normalized = {
            id: `event-${this.sourceId}-${this._sequence + 1}`,
            timeUs: Number.isFinite(Number(event.timeUs)) ? Math.max(0, Math.round(Number(event.timeUs))) : this.getTimeUs(),
            category: String(event.category || "system"),
            name: String(event.name || "event"),
            severity: String(event.severity || "info"),
            payload: cloneValue(event.payload ?? null),
        };
        this._events.push(normalized);
        this._events = this._events.slice(-this._eventLimit);
        this._notify({ kind: "event", event: cloneValue(normalized) });
        return cloneValue(normalized);
    }

    events({ fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
        return this._events
            .filter((event) => event.timeUs >= fromUs && event.timeUs <= toUs)
            .map((event) => cloneValue(event));
    }

    hydrate(values = {}) {
        this._committed.clear();
        this._previous.clear();
        this._layers = [];

        Object.entries(values || {}).forEach(([path, entry]) => {
            const normalizedPath = normalizeSignalPath(path);
            if (!normalizedPath) return;
            this._committed.set(normalizedPath, normalizeSignalEntry(entry, { now: this.now }));
        });
    }

    /**
     * Clear state that must never leak between deterministic run cases while
     * retaining the signal catalog (and selected environment/config values).
     */
    resetRunState({ values = {}, preservePaths = ["environment.manifest"] } = {}) {
        const preserved = new Map();
        for (const rawPath of preservePaths ?? []) {
            const path = normalizeSignalPath(rawPath);
            const entry = path ? this._committed.get(path) : null;
            if (entry) preserved.set(path, cloneValue(entry));
        }
        this._committed.clear();
        this._previous.clear();
        this._layers = [];
        this._history.clear();
        this._events = [];
        this._sequence = 0;
        this.sessionStartedAtMs = monotonicNowMs();
        for (const [path, entry] of preserved) this._committed.set(path, entry);
        for (const [rawPath, value] of Object.entries(values ?? {})) {
            const path = normalizeSignalPath(rawPath);
            if (!path) continue;
            this._committed.set(path, normalizeSignalEntry(value, { now: this.now }));
        }
        this._notify({ kind: "reset", paths: this.paths() });
        return this.snapshot();
    }

    snapshot({ paths = null, includeHeavy = true } = {}) {
        const selectedPaths = Array.isArray(paths) ? new Set(paths.map(normalizeSignalPath).filter(Boolean)) : null;
        return Object.fromEntries(
            [...this._committed.entries()]
                .filter(([path]) => !selectedPaths || selectedPaths.has(path))
                .filter(([path]) => includeHeavy || this._descriptors.get(path)?.logClass !== "heavy")
                .map(([path, entry]) => [path, cloneValue(entry)])
        );
    }

    paths() {
        return [...this._committed.keys()].sort((a, b) => a.localeCompare(b));
    }

    pendingSnapshot() {
        const pending = new Map();
        this._layers.forEach((layer) => {
            layer.forEach((entry, path) => pending.set(path, cloneValue(entry)));
        });
        return Object.fromEntries(pending.entries());
    }

    beginTransaction() {
        const token = { index: this._layers.length };
        this._layers.push(new Map());
        return token;
    }

    _assertTopTransaction(token) {
        if (!token || token.index !== this._layers.length - 1) {
            throw new Error("Signal store transactions must be committed or rolled back in stack order.");
        }
    }

    _commitEntries(entries) {
        entries.forEach((entry, path) => {
            const previous = this._committed.get(path);
            const heavy = isHeavyDescriptor(this._descriptors.get(path)) || isHeavyValue(entry?.value);
            if (previous && !heavy) {
                this._previous.set(path, cloneValue(previous));
            } else if (heavy) {
                this._previous.delete(path);
            }

            this._committed.set(path, heavy ? entry : cloneValue(entry));
            this._appendHistory(path, entry);
            this._publishUpdate(path, entry, heavy ? null : previous);
        });
    }

    commitTransaction(token) {
        this._assertTopTransaction(token);
        const layer = this._layers.pop();

        if (this._layers.length > 0) {
            const parent = this._layers[this._layers.length - 1];
            layer.forEach((entry, path) => parent.set(path, cloneValue(entry)));
            return;
        }

        this._commitEntries(layer);
    }

    rollbackTransaction(token) {
        this._assertTopTransaction(token);
        this._layers.pop();
    }

    commit() {
        while (this._layers.length > 1) {
            this.commitTransaction({ index: this._layers.length - 1 });
        }

        if (this._layers.length === 1) {
            this.commitTransaction({ index: 0 });
        }
    }

    rollback() {
        this._layers = [];
    }

    set(path, value, options = {}) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath) return null;

        const currentDescriptor = this._descriptors.get(normalizedPath);
        const type = options.type || currentDescriptor?.type || inferSignalType(value);
        const inferredHeavy = options.logClass === "heavy" || isHeavyValue(value);
        if (!currentDescriptor || currentDescriptor.type !== type || (inferredHeavy && currentDescriptor.logClass !== "heavy")) {
            this.defineSignal({
                path: normalizedPath,
                type,
                unit: options.unit,
                source: options.source,
                category: options.category,
                replayRole: options.replayRole,
                logClass: inferredHeavy ? "heavy" : options.logClass,
                description: options.description,
                metadata: options.descriptorMetadata,
            });
        }
        const heavy = isHeavyDescriptor(this._descriptors.get(normalizedPath)) || inferredHeavy;
        const entry = heavy
            ? {
                value,
                type,
                updatedAt: normalizeUpdatedAt(options.updatedAt, options.now || this.now),
                source: options.source || "local",
                timeUs: Number.isFinite(Number(options.timeUs)) ? Math.max(0, Math.round(Number(options.timeUs))) : this.getTimeUs(),
                cycle: Number.isFinite(Number(options.cycle)) ? Math.max(0, Math.round(Number(options.cycle))) : null,
                staleAfter: normalizeStaleAfter(options.staleAfter),
                metadata: isPlainObject(options.metadata) ? options.metadata : (isPlainObject(options.descriptorMetadata) ? options.descriptorMetadata : null),
                validation: isPlainObject(options.validation) ? options.validation : null,
            }
            : normalizeSignalEntry(value, {
                ...options,
                type,
                timeUs: options.timeUs ?? this.getTimeUs(),
                now: options.now || this.now,
            });
        const previous = this._committed.get(normalizedPath);
        if (previous && !heavy) {
            this._previous.set(normalizedPath, cloneValue(previous));
        } else if (heavy) {
            this._previous.delete(normalizedPath);
        }

        this._committed.set(normalizedPath, entry);
        this._appendHistory(normalizedPath, entry, options.maxSamples, { skip: options.history === false });
        this._publishUpdate(normalizedPath, entry, heavy ? null : previous);
        return heavy ? cloneEntryShallowHeavy(entry) : cloneValue(entry);
    }

    publishSignal(path, value, options = {}) {
        return this.set(path, value, options);
    }

    _publishUpdate(path, entry, previous) {
        const heavy = isHeavyDescriptor(this._descriptors.get(path)) || isHeavyValue(entry?.value);
        this._notify({
            kind: "update",
            path,
            timeUs: entry.timeUs ?? this.getTimeUs(),
            cycle: entry.cycle ?? null,
            entry: heavy ? entry : cloneValue(entry),
            previous: heavy || !previous ? null : cloneValue(previous),
            descriptor: this.descriptor(path),
        });
    }

    write(path, value, options = {}) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath) return null;

        if (this._layers.length === 0) {
            this.beginTransaction();
        }

        const currentDescriptor = this._descriptors.get(normalizedPath);
        const type = options.type || currentDescriptor?.type || inferSignalType(value);
        if (!currentDescriptor || currentDescriptor.type !== type) {
            this.defineSignal({
                path: normalizedPath,
                type,
                unit: options.unit,
                source: options.source,
                category: options.category,
                replayRole: options.replayRole,
                logClass: options.logClass,
                metadata: options.descriptorMetadata,
            });
        }
        const entry = normalizeSignalEntry(value, {
            ...options,
            type,
            timeUs: options.timeUs ?? this.getTimeUs(),
            now: options.now || this.now,
        });
        this._layers[this._layers.length - 1].set(normalizedPath, entry);
        return cloneValue(entry);
    }

    read(path, options = {}) {
        const normalizedPath = normalizeSignalPath(path);
        const now = options.now || this.now;
        const entry = this._committed.get(normalizedPath);

        if (!normalizedPath || !entry) {
            return {
                path: normalizedPath,
                value: options.fallback ?? null,
                type: options.type || "json",
                updatedAt: null,
                source: null,
                staleAfter: null,
                metadata: null,
                validation: null,
                exists: false,
                age: null,
                stale: true
            };
        }

        const age = entryAgeSeconds(entry, now);
        const staleAfter = normalizeStaleAfter(options.staleAfter ?? entry.staleAfter);

        return {
            path: normalizedPath,
            ...cloneValue(entry),
            staleAfter,
            exists: true,
            age,
            stale: staleAfter !== null && age !== null ? age > staleAfter : false
        };
    }

    has(path) {
        return this.read(path).exists;
    }

    age(path) {
        return this.read(path).age;
    }

    changed(path) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath || !this._committed.has(normalizedPath) || !this._previous.has(normalizedPath)) {
            return false;
        }

        return !valuesEqual(
            this._committed.get(normalizedPath)?.value,
            this._previous.get(normalizedPath)?.value
        );
    }

    record(path, value, options = {}) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath) return [];

        const entry = createSignalEntry(value, {
            ...options,
            source: options.source || "record",
            timeUs: options.timeUs ?? this.getTimeUs(),
            now: options.now || this.now
        });
        this._appendHistory(normalizedPath, entry, options.maxSamples);
        return this.history(normalizedPath);
    }

    history(path) {
        const buffer = this._history.get(normalizeSignalPath(path));
        if (!buffer) return [];
        const heavy = isHeavyPath(this, normalizeSignalPath(path));
        return buffer.items.slice(buffer.head).map((entry) => (
            heavy ? cloneEntryShallowHeavy(entry) : cloneValue(entry)
        ));
    }

    series(path, { fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
        return this.history(path).filter((entry) => {
            const timeUs = entry.timeUs ?? 0;
            return timeUs >= fromUs && timeUs <= toUs;
        });
    }

    _appendHistory(path, entry, maxSamples = null, { skip = false } = {}) {
        const normalizedPath = normalizeSignalPath(path);
        if (!normalizedPath || skip) return;

        const descriptor = this._descriptors.get(normalizedPath);
        const heavy = isHeavyDescriptor(descriptor) || isHeavyValue(entry?.value);
        const limit = maxSamples !== null && maxSamples !== undefined && Number.isFinite(Number(maxSamples))
            ? Math.max(1, Number(maxSamples))
            : heavy ? 1 : this.historySampleLimit;

        let buffer = this._history.get(normalizedPath);
        if (!buffer) {
            buffer = { items: [], head: 0 };
            this._history.set(normalizedPath, buffer);
        }

        if (heavy || limit === 1) {
            // Reuse the same ring object — allocating {items,head} every tick was a heap storm.
            buffer.items[0] = heavy ? entry : cloneValue(entry);
            if (buffer.items.length !== 1) buffer.items.length = 1;
            buffer.head = 0;
            return;
        }

        buffer.items.push(cloneValue(entry));
        const newestTimeUs = entry?.timeUs ?? this.getTimeUs();
        const oldestTimeUs = Math.max(0, newestTimeUs - this.historyDurationUs);
        while (buffer.head < buffer.items.length) {
            const activeLength = buffer.items.length - buffer.head;
            const sampleTimeUs = buffer.items[buffer.head]?.timeUs ?? newestTimeUs;
            if (activeLength <= limit && sampleTimeUs >= oldestTimeUs) break;
            buffer.head += 1;
        }
        if (buffer.head > 0 && (buffer.head > 64 || buffer.head * 2 >= buffer.items.length)) {
            buffer.items = buffer.items.slice(buffer.head);
            buffer.head = 0;
        }
    }
}
