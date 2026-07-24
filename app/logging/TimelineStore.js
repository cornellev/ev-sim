export class TimelineStore {
    constructor() {
        this.listeners = new Set();
        this.state = {
            timeUs: 0,
            durationUs: 0,
            playing: false,
            speed: 1,
            liveLocked: true,
            selection: null,
        };
    }

    getSnapshot() { return { ...this.state }; }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    set(patch) {
        this.state = { ...this.state, ...patch };
        this.state.timeUs = Math.min(Math.max(0, this.state.timeUs), Math.max(0, this.state.durationUs));
        for (const listener of this.listeners) listener(this.getSnapshot());
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
