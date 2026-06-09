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

function normalizePath(path) {
    return String(path || "").trim();
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

export function createSignalEntry(value, options = {}) {
    const type = options.type || inferSignalType(value);

    return {
        value: cloneValue(value),
        type,
        updatedAt: normalizeUpdatedAt(options.updatedAt, options.now || Date.now),
        source: options.source || "local",
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
        this._committed = new Map();
        this._previous = new Map();
        this._layers = [];
        this._history = new Map();
        this.hydrate(initialValues);
    }

    hydrate(values = {}) {
        this._committed.clear();
        this._previous.clear();
        this._layers = [];

        Object.entries(values || {}).forEach(([path, entry]) => {
            if (!normalizePath(path)) return;
            this._committed.set(path, normalizeSignalEntry(entry, { now: this.now }));
        });
    }

    snapshot() {
        return Object.fromEntries(
            [...this._committed.entries()].map(([path, entry]) => [path, cloneValue(entry)])
        );
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
            if (previous) {
                this._previous.set(path, cloneValue(previous));
            }

            this._committed.set(path, cloneValue(entry));
            this._appendHistory(path, entry);
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
        const normalizedPath = normalizePath(path);
        if (!normalizedPath) return null;

        const entry = normalizeSignalEntry(value, { ...options, now: options.now || this.now });
        const previous = this._committed.get(normalizedPath);
        if (previous) {
            this._previous.set(normalizedPath, cloneValue(previous));
        }

        this._committed.set(normalizedPath, entry);
        this._appendHistory(normalizedPath, entry);
        return cloneValue(entry);
    }

    write(path, value, options = {}) {
        const normalizedPath = normalizePath(path);
        if (!normalizedPath) return null;

        if (this._layers.length === 0) {
            this.beginTransaction();
        }

        const entry = normalizeSignalEntry(value, { ...options, now: options.now || this.now });
        this._layers[this._layers.length - 1].set(normalizedPath, entry);
        return cloneValue(entry);
    }

    read(path, options = {}) {
        const normalizedPath = normalizePath(path);
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
        const normalizedPath = normalizePath(path);
        if (!normalizedPath || !this._committed.has(normalizedPath) || !this._previous.has(normalizedPath)) {
            return false;
        }

        return !valuesEqual(
            this._committed.get(normalizedPath)?.value,
            this._previous.get(normalizedPath)?.value
        );
    }

    record(path, value, options = {}) {
        const normalizedPath = normalizePath(path);
        if (!normalizedPath) return [];

        const entry = createSignalEntry(value, {
            ...options,
            source: options.source || "record",
            now: options.now || this.now
        });
        this._appendHistory(normalizedPath, entry, options.maxSamples);
        return this.history(normalizedPath);
    }

    history(path) {
        return (this._history.get(normalizePath(path)) || []).map((entry) => cloneValue(entry));
    }

    _appendHistory(path, entry, maxSamples = 120) {
        const normalizedPath = normalizePath(path);
        if (!normalizedPath) return;

        const current = this._history.get(normalizedPath) || [];
        current.push(cloneValue(entry));
        const limit = Number.isFinite(Number(maxSamples)) ? Math.max(1, Number(maxSamples)) : 120;
        this._history.set(normalizedPath, current.slice(-limit));
    }
}
