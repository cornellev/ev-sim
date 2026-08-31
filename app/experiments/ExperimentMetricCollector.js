import { MetricAccumulator } from "./MetricReducers.js";

/**
 * Collect experiment metrics from any SignalStore-compatible telemetry source.
 * This deliberately contains no browser globals so managed workers and browser
 * runs use identical signal/event subscription and t=0 seeding semantics.
 */
export class ExperimentMetricCollector {
    constructor(definitions = [], telemetry = null) {
        this.telemetry = telemetry;
        this.accumulator = new MetricAccumulator(definitions);
        this.unsubscribe = null;
    }

    start() {
        this.stop();
        const paths = this.accumulator.definitions
            .filter((metric) => metric.source.kind === "signal")
            .map((metric) => metric.source.path);
        this.unsubscribe = this.telemetry?.subscribeSignals?.(
            { paths, includeEvents: true, includeCatalog: false },
            (message) => {
                if (message.kind === "update") {
                    this.accumulator.pushSignal(message.path, message.entry?.value);
                } else if (message.kind === "event") {
                    this.accumulator.pushEvent(message.event);
                }
            },
        ) ?? null;

        // Manifest application publishes deterministic t=0 inputs before the
        // subscription is installed. Seed from the reset store so browser and
        // worker reducers include the same initial state and events.
        for (const path of paths) {
            const entry = this.telemetry?.read?.(path);
            if (entry && entry.value !== undefined) this.accumulator.pushSignal(path, entry.value);
        }
        for (const event of this.telemetry?.events?.() ?? []) this.accumulator.pushEvent(event);
        return this;
    }

    finalize(runResult = {}) {
        return this.accumulator.finalize(runResult);
    }

    snapshot() {
        return this.accumulator.snapshot();
    }

    stop() {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}

export function createExperimentMetricCollector(definitions, telemetry) {
    return new ExperimentMetricCollector(definitions, telemetry);
}
