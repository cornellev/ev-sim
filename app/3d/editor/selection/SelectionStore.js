/**
 * Shared selection for hierarchy, scene, map, and inspector. Selection
 * identity is object ids (document record ids) plus an optional sub-object
 * (a road node without its own record). Follows the EditorState subscriber
 * idiom: `subscribe` fires immediately and returns an unsubscribe.
 */

export const SELECTION_MODES = Object.freeze(["replace", "add", "toggle", "remove"]);

function normalizeIds(input) {
    const list = Array.isArray(input) ? input : input === null || input === undefined ? [] : [input];
    const ids = [];
    for (const value of list) {
        if (value === null || value === undefined || value === "") continue;
        const id = String(value);
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

function normalizeSub(sub) {
    if (!sub || sub.kind !== "road-node" || sub.id === undefined || sub.id === null) return null;
    return { kind: "road-node", id: String(sub.id) };
}

export class SelectionStore {
    constructor({ now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) } = {}) {
        /** @type {string[]} */
        this.ids = [];
        /** @type {string|null} */
        this.primary = null;
        /** @type {{ kind: "road-node", id: string } | null} */
        this.sub = null;
        this.version = 0;
        this.subscribers = new Set();
        this.suppressedUntil = 0;
        this.now = now;
    }

    snapshot() {
        return {
            ids: [...this.ids],
            primary: this.primary,
            sub: this.sub ? { ...this.sub } : null,
            version: this.version,
            count: this.ids.length,
        };
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot());
        return () => {
            this.subscribers.delete(callback);
        };
    }

    notify() {
        this.version += 1;
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot));
    }

    isSelected(id) {
        return this.ids.includes(String(id));
    }

    isEmpty() {
        return this.ids.length === 0;
    }

    /**
     * @param {string|string[]} idOrIds
     * @param {{ mode?: "replace"|"add"|"toggle"|"remove", primary?: string|null, sub?: object|null }} [options]
     */
    select(idOrIds, { mode = "replace", primary = undefined, sub = undefined } = {}) {
        if (!SELECTION_MODES.includes(mode)) throw new TypeError(`Unknown selection mode "${mode}".`);
        const incoming = normalizeIds(idOrIds);
        let next;
        if (mode === "replace") {
            next = incoming;
        } else if (mode === "add") {
            next = [...this.ids, ...incoming.filter((id) => !this.ids.includes(id))];
        } else if (mode === "remove") {
            next = this.ids.filter((id) => !incoming.includes(id));
        } else {
            next = [...this.ids];
            for (const id of incoming) {
                const position = next.indexOf(id);
                if (position >= 0) next.splice(position, 1);
                else next.push(id);
            }
        }
        let nextPrimary;
        if (primary !== undefined) nextPrimary = primary === null ? null : String(primary);
        else if (mode === "remove") nextPrimary = next.includes(this.primary) ? this.primary : (next.at(-1) ?? null);
        else if (mode === "toggle") nextPrimary = incoming.find((id) => next.includes(id)) ?? (next.includes(this.primary) ? this.primary : (next.at(-1) ?? null));
        else nextPrimary = incoming.at(-1) ?? (next.includes(this.primary) ? this.primary : (next.at(-1) ?? null));
        if (nextPrimary !== null && !next.includes(nextPrimary)) nextPrimary = next.at(-1) ?? null;
        const nextSub = sub === undefined ? (mode === "replace" ? null : this.sub) : normalizeSub(sub);
        this._commit(next, nextPrimary, nextSub);
        return this.snapshot();
    }

    setPrimary(id) {
        const primary = id === null || id === undefined ? null : String(id);
        if (primary !== null && !this.ids.includes(primary)) return this.snapshot();
        this._commit(this.ids, primary, this.sub);
        return this.snapshot();
    }

    setSub(sub) {
        this._commit(this.ids, this.primary, normalizeSub(sub));
        return this.snapshot();
    }

    clear() {
        this._commit([], null, null);
        return this.snapshot();
    }

    /** Drop ids that no longer exist. */
    prune(existingIds) {
        const existing = existingIds instanceof Set ? existingIds : new Set([...(existingIds ?? [])].map(String));
        const next = this.ids.filter((id) => existing.has(id));
        const primary = next.includes(this.primary) ? this.primary : (next.at(-1) ?? null);
        const sub = this.sub && next.length === 0 ? null : this.sub;
        this._commit(next, primary, sub);
        return this.snapshot();
    }

    /** Swallow clicks for `ms` after a gesture ends so pointer-up does not reselect. */
    suppress(ms = 300) {
        this.suppressedUntil = this.now() + Math.max(0, Number(ms) || 0);
    }

    isSuppressed() {
        return this.now() < this.suppressedUntil;
    }

    _commit(ids, primary, sub) {
        const sameIds = ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index]);
        const sameSub = (sub === null && this.sub === null) || (sub && this.sub && sub.kind === this.sub.kind && sub.id === this.sub.id);
        if (sameIds && primary === this.primary && sameSub) return;
        this.ids = [...ids];
        this.primary = primary;
        this.sub = sub ? { ...sub } : null;
        this.notify();
    }
}
