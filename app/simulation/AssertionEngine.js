function getBySelector(value, selector) {
    if (!selector) return value;
    return selector.split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function equal(left, right, tolerance = 0) {
    if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= tolerance;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return Object.is(left, right); }
}

function compare(operator, actual, expected, tolerance) {
    switch (operator) {
        case "eq": return equal(actual, expected, tolerance);
        case "neq": return !equal(actual, expected, tolerance);
        case "lt": return Number(actual) < Number(expected);
        case "lte": return Number(actual) <= Number(expected) + tolerance;
        case "gt": return Number(actual) > Number(expected);
        case "gte": return Number(actual) + tolerance >= Number(expected);
        case "within": return Math.abs(Number(actual) - Number(expected)) <= tolerance;
        default: return false;
    }
}

export class AssertionEngine {
    constructor(assertions = [], store = null) {
        this.assertions = structuredClone(assertions);
        this.store = store;
        this.results = new Map(assertions.map((assertion) => [assertion.id, {
            id: assertion.id,
            name: assertion.name,
            severity: assertion.severity,
            onFailure: assertion.onFailure,
            status: "pending",
            evaluations: 0,
            firstFailureStep: null,
            message: null,
        }]));
        this.eventCursor = 0;
        this.eventSteps = new Map();
        this.currentStep = 0;
    }

    reset() {
        for (const result of this.results.values()) {
            Object.assign(result, { status: "pending", evaluations: 0, firstFailureStep: null, message: null });
        }
        this.eventCursor = 0;
        this.eventSteps.clear();
        this.currentStep = 0;
    }

    evaluate(step, { final = false } = {}) {
        this.currentStep = step;
        this._collectEvents(step);
        let shouldStop = false;
        for (const assertion of this.assertions) {
            const result = this.results.get(assertion.id);
            if (["failed", "passed"].includes(result.status) && assertion.mode !== "always") continue;
            const { startStep, endStep } = assertion.window;
            if (step < startStep) continue;
            if (endStep !== null && step > endStep) continue;
            const atEnd = final || (endStep !== null && step === endStep);
            if (assertion.mode === "at-end" && !atEnd) continue;

            const evaluation = assertion.source === "event"
                ? this._evaluateEvent(assertion)
                : this._evaluateSignal(assertion);
            result.evaluations += 1;

            if (assertion.mode === "eventually") {
                if (evaluation.passed) {
                    result.status = "passed";
                    result.message = null;
                } else if (atEnd) {
                    shouldStop ||= this._fail(assertion, result, step, evaluation.message);
                }
                continue;
            }
            if (!evaluation.passed) {
                shouldStop ||= this._fail(assertion, result, step, evaluation.message);
            } else if (assertion.mode === "at-end" || atEnd) {
                result.status = "passed";
                result.message = null;
            } else if (result.status === "pending") {
                result.status = "running";
            }
        }
        return { shouldStop, results: this.snapshot() };
    }

    finalize(step) {
        const evaluated = this.evaluate(step, { final: true });
        for (const assertion of this.assertions) {
            const result = this.results.get(assertion.id);
            if (["pending", "running"].includes(result.status)) {
                if (assertion.mode === "always" && result.evaluations > 0) result.status = "passed";
                else evaluated.shouldStop ||= this._fail(assertion, result, step, "Assertion never reached a passing terminal state.");
            }
        }
        evaluated.results = this.snapshot();
        return evaluated;
    }

    snapshot() {
        return [...this.results.values()].map((result) => structuredClone(result));
    }

    _evaluateSignal(assertion) {
        const entry = this.store?.read?.(assertion.path);
        if (!entry?.exists) return { passed: false, message: `Signal "${assertion.path}" is missing.` };
        const actual = getBySelector(entry.value, assertion.selector);
        const passed = compare(assertion.operator, actual, assertion.expected, assertion.tolerance);
        return { passed, message: passed ? null : `Expected ${assertion.path}${assertion.selector ? `.${assertion.selector}` : ""} ${assertion.operator} ${JSON.stringify(assertion.expected)}, received ${JSON.stringify(actual)}.` };
    }

    _evaluateEvent(assertion) {
        const steps = this.eventSteps.get(`${assertion.category}:${assertion.event}`) || [];
        const count = steps.filter((step) => step >= assertion.window.startStep
            && (assertion.window.endStep === null || step <= assertion.window.endStep)).length;
        const bounds = typeof assertion.expected === "object" ? assertion.expected : { min: Number(assertion.expected), max: Number(assertion.expected) };
        const min = Number.isFinite(Number(bounds?.min)) ? Number(bounds.min) : 0;
        const max = bounds?.max === null || bounds?.max === undefined ? Number.POSITIVE_INFINITY : Number(bounds.max);
        const passed = count >= min && count <= max;
        return { passed, message: passed ? null : `Expected ${min}..${Number.isFinite(max) ? max : "∞"} ${assertion.category}/${assertion.event} events, received ${count}.` };
    }

    _collectEvents(step) {
        const events = this.store?.events?.() || [];
        for (const event of events.slice(this.eventCursor)) {
            const key = `${event.category}:${event.name}`;
            const occurredAtStep = Number.isInteger(event.payload?.step) ? event.payload.step : step;
            const steps = this.eventSteps.get(key) || [];
            steps.push(occurredAtStep);
            this.eventSteps.set(key, steps);
        }
        this.eventCursor = events.length;
    }

    _fail(assertion, result, step, message) {
        result.status = "failed";
        result.firstFailureStep ??= step;
        result.message = message;
        this.store?.emitTelemetryEvent?.({
            timeUs: Math.round(Number(this.store?.read?.("simulation.timeNs")?.value || 0) / 1000),
            category: "assertions",
            name: "assertion-failed",
            severity: assertion.severity,
            payload: { assertionId: assertion.id, step, message },
        });
        return assertion.severity === "error" && assertion.onFailure === "stop";
    }
}
