import { VISUAL_PREVIEW_ERROR_CODES, VisualPreviewError } from "../../../simulation/visual/VisualLayer.js";

/**
 * Bounded FIFO with one in-flight slot plus coalescing is handled by callers.
 * This queue caps concurrent fetch/decode work and rejects new work after death.
 */
export class VisualWorkQueue {
    constructor({ maxConcurrentFetches = 4, maxConcurrentDecodes = 2 } = {}) {
        this.maxConcurrentFetches = Math.max(1, maxConcurrentFetches);
        this.maxConcurrentDecodes = Math.max(1, maxConcurrentDecodes);
        this._fetchActive = 0;
        this._decodeActive = 0;
        this._fetchWaiters = [];
        this._decodeWaiters = [];
        this._pending = 0;
        this._peakPending = 0;
        this._dead = false;
        this._reason = null;
    }

    get dead() {
        return this._dead;
    }

    snapshot() {
        return {
            dead: this._dead,
            reason: this._reason,
            pending: this._pending,
            peakPending: this._peakPending,
            fetchActive: this._fetchActive,
            decodeActive: this._decodeActive,
            fetchQueued: this._fetchWaiters.length,
            decodeQueued: this._decodeWaiters.length,
            maxConcurrentFetches: this.maxConcurrentFetches,
            maxConcurrentDecodes: this.maxConcurrentDecodes,
        };
    }

    rejectAll(reason = "Visual work queue was shut down.") {
        this._dead = true;
        this._reason = reason;
        const error = workQueueError(reason);
        for (const waiter of this._fetchWaiters.splice(0)) waiter.reject(error);
        for (const waiter of this._decodeWaiters.splice(0)) waiter.reject(error);
        this._pending = 0;
    }

    reset() {
        this.rejectAll("Visual work queue was reset.");
        this._dead = false;
        this._reason = null;
        this._fetchActive = 0;
        this._decodeActive = 0;
        this._pending = 0;
        this._peakPending = 0;
    }

    async runFetch(work) {
        return this._run("fetch", work);
    }

    async runDecode(work) {
        return this._run("decode", work);
    }

    async _run(kind, work) {
        this._assertLive();
        this._pending += 1;
        this._peakPending = Math.max(this._peakPending, this._pending);
        let acquired = false;
        try {
            await this._acquire(kind);
            acquired = true;
            this._assertLive();
            return await work();
        } finally {
            if (acquired) this._release(kind);
            this._pending = Math.max(0, this._pending - 1);
        }
    }

    _assertLive() {
        if (this._dead) {
            throw workQueueError(this._reason || "Visual work queue is unavailable.");
        }
    }

    _acquire(kind) {
        const activeKey = kind === "decode" ? "_decodeActive" : "_fetchActive";
        const waitersKey = kind === "decode" ? "_decodeWaiters" : "_fetchWaiters";
        const limit = kind === "decode" ? this.maxConcurrentDecodes : this.maxConcurrentFetches;
        if (this[activeKey] < limit) {
            this[activeKey] += 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this[waitersKey].push({
                resolve: () => {
                    this[activeKey] += 1;
                    resolve();
                },
                reject,
            });
        });
    }

    _release(kind) {
        const activeKey = kind === "decode" ? "_decodeActive" : "_fetchActive";
        const waitersKey = kind === "decode" ? "_decodeWaiters" : "_fetchWaiters";
        this[activeKey] = Math.max(0, this[activeKey] - 1);
        const next = this[waitersKey].shift();
        if (next) next.resolve();
    }
}

function workQueueError(reason) {
    return new VisualPreviewError(
        VISUAL_PREVIEW_ERROR_CODES.CONTEXT_LOST,
        reason,
    );
}
