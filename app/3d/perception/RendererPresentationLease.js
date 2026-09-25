import { browserSimulationPerformance } from "../../simulation/performance/BrowserSimulationPerformance.js";

/** Serializes the short main-thread WebGL sections that cannot overlap presentation. */
export class RendererPresentationLease {
    constructor() {
        this.depth = 0;
        this.startedAt = 0;
        this.listeners = new Set();
        this.generation = 0;
    }

    get blocked() {
        return this.depth > 0;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(!this.blocked);
        return () => this.listeners.delete(listener);
    }

    _emit(available) {
        for (const listener of this.listeners) listener(available);
    }

    _enter() {
        if (this.depth === 0) {
            this.startedAt = browserSimulationPerformance.now();
            this._emit(false);
        }
        this.depth += 1;
        return this.generation;
    }

    _exit(generation) {
        if (generation !== this.generation) return;
        this.depth = Math.max(0, this.depth - 1);
        if (this.depth !== 0) return;
        browserSimulationPerformance.recordRendererBlocked(
            browserSimulationPerformance.now() - this.startedAt,
        );
        this.startedAt = 0;
        this._emit(true);
    }

    runSync(operation) {
        const generation = this._enter();
        try {
            return operation();
        } finally {
            this._exit(generation);
        }
    }

    async runAsync(operation) {
        const generation = this._enter();
        try {
            return await operation();
        } finally {
            this._exit(generation);
        }
    }

    reset({ preserveListeners = false } = {}) {
        const wasBlocked = this.blocked;
        this.generation += 1;
        this.depth = 0;
        this.startedAt = 0;
        if (wasBlocked) this._emit(true);
        if (!preserveListeners) this.listeners.clear();
    }
}
