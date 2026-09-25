const REPORT_KIND = "cev-sim.browser-performance-report";
const REPORT_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
    minimumDisplayedFps: 58,
    maximumP95FrameIntervalMs: 18.3,
    minimumRealtimeRate: 0.99,
    minimumStepsPerSecond: 59.4,
    maximumLongTaskMs: 50,
    maximumHeapGrowthBytes: 32 * 1024 * 1024,
});

function percentile(values, fraction) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return sorted[index];
}

function timingSummary(values) {
    const numbers = values.map((entry) => entry.value);
    const totalMs = numbers.reduce((sum, value) => sum + value, 0);
    return {
        count: numbers.length,
        totalMs,
        meanMs: numbers.length > 0 ? totalMs / numbers.length : null,
        p50Ms: percentile(numbers, 0.5),
        p95Ms: percentile(numbers, 0.95),
        maxMs: numbers.length > 0 ? Math.max(...numbers) : null,
    };
}

function heapBytes() {
    return Number(globalThis.performance?.memory?.usedJSHeapSize) || null;
}

class BrowserSimulationPerformanceMonitor {
    constructor() {
        this.active = false;
        this.longTaskObserver = null;
        this.reset();
    }

    reset() {
        this.startedAt = 0;
        this.stoppedAt = 0;
        this.warmupMs = 0;
        this.workload = null;
        this.limits = { ...DEFAULT_LIMITS };
        this.raf = [];
        this.lastRafAt = null;
        this.presentation = [];
        this.lastPresentationAt = null;
        this.deferredPresentations = [];
        this.rendererBlocked = [];
        this.renderRuntime = { implementation: null, fallbackReason: null };
        this.timings = new Map();
        this.simulation = [];
        this.sensorTotals = new Map();
        this.sensorSamples = [];
        this.queueSamples = [];
        this.websocketSamples = [];
        this.memorySamples = [];
        this.longTasks = [];
    }

    now() {
        return globalThis.performance?.now?.() ?? Date.now();
    }

    start({ workload = null, warmupMs = 0, limits = {} } = {}) {
        const renderRuntime = this.renderRuntime;
        this.stop();
        this.reset();
        this.renderRuntime = renderRuntime;
        this.active = true;
        this.startedAt = this.now();
        this.warmupMs = Math.max(0, Number(warmupMs) || 0);
        this.workload = workload ? structuredClone(workload) : null;
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        this.recordMemory();
        if (typeof globalThis.PerformanceObserver === "function") {
            try {
                this.longTaskObserver = new globalThis.PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        this.longTasks.push({ time: entry.startTime, value: entry.duration });
                    }
                });
                this.longTaskObserver.observe({ type: "longtask", buffered: true });
            } catch {
                this.longTaskObserver = null;
            }
        }
        return this.snapshot();
    }

    stop() {
        if (this.active) this.stoppedAt = this.now();
        this.active = false;
        this.longTaskObserver?.disconnect?.();
        this.longTaskObserver = null;
        this.recordMemory();
        return this.snapshot();
    }

    recordRaf(now = this.now()) {
        if (!this.active) return;
        if (this.lastRafAt !== null) this.raf.push({ time: now, value: Math.max(0, now - this.lastRafAt) });
        this.lastRafAt = now;
        this.recordMemory(now);
    }

    recordPresentation(now = this.now()) {
        if (!this.active) return;
        if (this.lastPresentationAt !== null) {
            this.presentation.push({ time: now, value: Math.max(0, now - this.lastPresentationAt) });
        }
        this.lastPresentationAt = now;
    }

    recordPresentationDeferred(time = this.now()) {
        if (!this.active) return;
        this.deferredPresentations.push({ time, value: 1 });
    }

    recordRendererBlocked(durationMs, time = this.now()) {
        if (!this.active || !Number.isFinite(durationMs)) return;
        this.rendererBlocked.push({ time, value: Math.max(0, durationMs) });
    }

    recordRenderRuntime({ implementation = null, fallbackReason = null } = {}) {
        this.renderRuntime = {
            implementation: implementation ? String(implementation) : null,
            fallbackReason: fallbackReason ? {
                code: String(fallbackReason.code || "PBR_WORKER_UNAVAILABLE"),
                message: String(fallbackReason.message || "PBR worker was unavailable."),
            } : null,
        };
    }

    recordTiming(name, durationMs, time = this.now()) {
        if (!this.active || !Number.isFinite(durationMs)) return;
        const samples = this.timings.get(name) ?? [];
        samples.push({ time, value: Math.max(0, durationMs) });
        this.timings.set(name, samples);
    }

    recordSimulation(advancedNs, durationMs, advancedSteps = 0, time = this.now()) {
        if (!this.active) return;
        this.simulation.push({
            time,
            advancedNs: Math.max(0, Number(advancedNs) || 0),
            advancedSteps: Math.max(0, Number(advancedSteps) || 0),
            durationMs,
        });
    }

    recordSensorState(sensorId, health, time = this.now()) {
        if (!this.active || !health) return;
        const next = {
            due: Number(health.captureAttempts) || 0,
            captured: Number(health.capturedFrames) || 0,
            delivered: Number(health.deliveredFrames) || 0,
        };
        const previous = this.sensorTotals.get(sensorId) ?? { due: 0, captured: 0, delivered: 0 };
        const delta = {};
        for (const key of ["due", "captured", "delivered"]) {
            delta[key] = next[key] >= previous[key] ? next[key] - previous[key] : next[key];
        }
        this.sensorTotals.set(sensorId, next);
        this.sensorSamples.push({ time, ...delta });
        this.recordQueue(sensorId, health.queueDepth, health.queueBytes, time);
    }

    recordQueue(sensorId, depth, bytes, time = this.now()) {
        if (!this.active) return;
        this.queueSamples.push({
            time,
            sensorId: String(sensorId),
            depth: Math.max(0, Number(depth) || 0),
            bytes: Math.max(0, Number(bytes) || 0),
        });
    }

    recordWebSocketBytes(bytes, time = this.now()) {
        if (!this.active) return;
        this.websocketSamples.push({ time, value: Math.max(0, Number(bytes) || 0) });
    }

    recordMemory(time = this.now()) {
        if (!this.active && !this.startedAt) return;
        const value = heapBytes();
        if (value !== null) this.memorySamples.push({ time, value });
    }

    _measured(values) {
        const threshold = this.startedAt + this.warmupMs;
        return values.filter((entry) => entry.time >= threshold);
    }

    snapshot() {
        const endedAt = this.stoppedAt || this.now();
        const measuredStart = Math.min(endedAt, this.startedAt + this.warmupMs);
        const measuredDurationMs = Math.max(0, endedAt - measuredStart);
        const raf = this._measured(this.raf).map((entry) => entry.value);
        const presentation = this._measured(this.presentation).map((entry) => entry.value);
        const deferredPresentations = this._measured(this.deferredPresentations);
        const sensor = this._measured(this.sensorSamples);
        const counts = sensor.reduce((result, entry) => ({
            due: result.due + entry.due,
            captured: result.captured + entry.captured,
            delivered: result.delivered + entry.delivered,
        }), { due: 0, captured: 0, delivered: 0 });
        const simulation = this._measured(this.simulation);
        const advancedNs = simulation.reduce((sum, entry) => sum + entry.advancedNs, 0);
        const advancedSteps = simulation.reduce((sum, entry) => sum + entry.advancedSteps, 0);
        const queue = this._measured(this.queueSamples);
        const websocket = this._measured(this.websocketSamples);
        const memory = this._measured(this.memorySamples);
        const longTasks = this._measured(this.longTasks);
        const displayedFps = presentation.length > 0
            ? 1000 / (presentation.reduce((sum, value) => sum + value, 0) / presentation.length)
            : 0;
        const realtimeRate = measuredDurationMs > 0 ? advancedNs / (measuredDurationMs * 1e6) : 0;
        const stepsPerSecond = advancedSteps > 0 && measuredDurationMs > 0
            ? advancedSteps * 1000 / measuredDurationMs
            : 0;
        const p95FrameIntervalMs = percentile(presentation, 0.95);
        const rendererBlocked = this._measured(this.rendererBlocked).map((entry) => entry.value);
        const maximumLongTaskMs = longTasks.length > 0 ? Math.max(...longTasks.map((entry) => entry.value)) : 0;
        const heapGrowthBytes = memory.length > 1 ? memory.at(-1).value - memory[0].value : null;
        const timings = Object.fromEntries(
            [...this.timings.entries()].map(([name, values]) => [name, timingSummary(this._measured(values))]),
        );
        const gates = {
            displayedFps: displayedFps >= this.limits.minimumDisplayedFps,
            frameInterval: p95FrameIntervalMs !== null
                && p95FrameIntervalMs <= this.limits.maximumP95FrameIntervalMs,
            realtimeRate: realtimeRate >= this.limits.minimumRealtimeRate,
            stepsPerSecond: stepsPerSecond >= this.limits.minimumStepsPerSecond,
            longTasks: maximumLongTaskMs <= this.limits.maximumLongTaskMs,
            scheduledSensors: counts.due === counts.captured && counts.captured === counts.delivered,
            memory: heapGrowthBytes === null || heapGrowthBytes <= this.limits.maximumHeapGrowthBytes,
        };
        return {
            kind: REPORT_KIND,
            version: REPORT_VERSION,
            active: this.active,
            workload: this.workload,
            measurement: {
                startedAtMs: this.startedAt,
                endedAtMs: endedAt,
                warmupMs: this.warmupMs,
                durationMs: measuredDurationMs,
            },
            display: {
                frames: presentation.length,
                fps: displayedFps,
                p50IntervalMs: percentile(presentation, 0.5),
                p95IntervalMs: p95FrameIntervalMs,
                maxIntervalMs: presentation.length > 0 ? Math.max(...presentation) : null,
                rafCallbacks: raf.length,
                deferredPresentations: deferredPresentations.length,
            },
            rendering: {
                ...this.renderRuntime,
                blockedCount: rendererBlocked.length,
                blockedTotalMs: rendererBlocked.reduce((sum, value) => sum + value, 0),
                blockedMaxMs: rendererBlocked.length > 0 ? Math.max(...rendererBlocked) : 0,
            },
            simulation: {
                advancedNs,
                realtimeRate,
                stepsPerSecond,
            },
            sensors: {
                ...counts,
                skipped: Math.max(0, counts.due - counts.captured),
                undelivered: Math.max(0, counts.captured - counts.delivered),
            },
            timings,
            longTasks: {
                count: longTasks.length,
                totalMs: longTasks.reduce((sum, entry) => sum + entry.value, 0),
                maxMs: maximumLongTaskMs,
            },
            queues: {
                maxDepth: queue.length > 0 ? Math.max(...queue.map((entry) => entry.depth)) : 0,
                maxBytes: queue.length > 0 ? Math.max(...queue.map((entry) => entry.bytes)) : 0,
                finalDepth: queue.at(-1)?.depth ?? 0,
                finalBytes: queue.at(-1)?.bytes ?? 0,
            },
            websocket: {
                packets: websocket.length,
                bytes: websocket.reduce((sum, entry) => sum + entry.value, 0),
            },
            memory: {
                supported: memory.length > 0,
                initialHeapBytes: memory[0]?.value ?? null,
                finalHeapBytes: memory.at(-1)?.value ?? null,
                growthBytes: heapGrowthBytes,
            },
            limits: { ...this.limits },
            gates,
            passed: Object.values(gates).every(Boolean),
        };
    }
}

export const browserSimulationPerformance = new BrowserSimulationPerformanceMonitor();

globalThis.__cevSimBrowserPerformance = Object.freeze({
    start: (options) => browserSimulationPerformance.start(options),
    stop: () => browserSimulationPerformance.stop(),
    snapshot: () => browserSimulationPerformance.snapshot(),
});
