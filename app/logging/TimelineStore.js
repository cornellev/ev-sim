export class TimelineStore {
    constructor() {
        this.listeners = new Set();
        this.state = {
            timeUs: 0,
            durationUs: 0,
            playing: false,
            speed: 1,
            loopEnabled: false,
            liveLocked: true,
            selection: null,
        };
    }

    getSnapshot() { return { ...this.state }; }

    subscribe(listener, options = {}) {
        const entry = {
            listener,
            uiIntervalMs: Number(options.uiIntervalMs) || 0,
            lastUiEmitAt: 0,
            pendingSnapshot: null,
            pendingTimer: null,
        };
        this.listeners.add(entry);
        listener(this.getSnapshot());
        return () => {
            if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
            this.listeners.delete(entry);
        };
    }

    _emitEntry(entry, snapshot) {
        entry.lastUiEmitAt = performance.now();
        entry.pendingSnapshot = null;
        if (entry.pendingTimer) {
            clearTimeout(entry.pendingTimer);
            entry.pendingTimer = null;
        }
        entry.listener(snapshot);
    }

    _shouldThrottleEntry(entry, patch, prev) {
        if (!entry.uiIntervalMs) return false;
        if (Object.keys(patch).length !== 1 || patch.timeUs === undefined) return false;
        if (!prev.playing || !this.state.playing) return false;
        return true;
    }

    set(patch) {
        const prev = { ...this.state };
        this.state = { ...this.state, ...patch };
        this.state.timeUs = Math.min(Math.max(0, this.state.timeUs), Math.max(0, this.state.durationUs));
        const snapshot = this.getSnapshot();
        for (const entry of this.listeners) {
            if (this._shouldThrottleEntry(entry, patch, prev)) {
                entry.pendingSnapshot = snapshot;
                const elapsed = performance.now() - entry.lastUiEmitAt;
                if (elapsed >= entry.uiIntervalMs) {
                    this._emitEntry(entry, snapshot);
                } else if (!entry.pendingTimer) {
                    entry.pendingTimer = setTimeout(() => {
                        entry.pendingTimer = null;
                        if (entry.pendingSnapshot) this._emitEntry(entry, entry.pendingSnapshot);
                    }, entry.uiIntervalMs - elapsed);
                }
                continue;
            }
            this._emitEntry(entry, snapshot);
        }
    }

    seek(timeUs) { this.set({ timeUs, liveLocked: false }); }
    setDuration(durationUs) { this.set({ durationUs }); }
    togglePlaying() { this.set({ playing: !this.state.playing }); }
}

let sharedTimeline = null;
export function getTimelineStore() {
    if (!sharedTimeline) sharedTimeline = new TimelineStore();
    return sharedTimeline;
}
