import { finiteFloat, finiteInt32, finiteResult, orderedBounds } from "../../types/PortTypes.js";

export const FILTER_WINDOW_MIN = 1;
export const FILTER_WINDOW_MAX = 4096;

export function requireDt(value, typeId) {
    const dt = Number(value);
    if (!Number.isFinite(dt) || dt < 0) {
        throw new Error(`${typeId} dt must be finite and non-negative.`);
    }
    return dt;
}

export function clampWindow(value) {
    const size = finiteInt32(value, FILTER_WINDOW_MIN);
    return Math.max(FILTER_WINDOW_MIN, Math.min(FILTER_WINDOW_MAX, size));
}

export function nonNegativeFloat(value) {
    return Math.max(0, finiteFloat(value));
}

export function cloneRuntimeValue(value) {
    if (value === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

export function mean(samples) {
    if (!Array.isArray(samples) || samples.length === 0) return 0;
    let total = 0;
    for (const sample of samples) {
        total += finiteFloat(sample);
    }
    return finiteResult(total / samples.length);
}

export function median(samples) {
    if (!Array.isArray(samples) || samples.length === 0) return 0;
    const sorted = samples.map((sample) => finiteFloat(sample)).sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return finiteResult((sorted[middle - 1] + sorted[middle]) / 2);
}

export function risingPulse(previous, initialized, value) {
    const pulse = Boolean(initialized) && !previous && value;
    return { pulse, previous: value, initialized: true };
}

export function fallingPulse(previous, initialized, value) {
    const pulse = Boolean(initialized) && previous && !value;
    return { pulse, previous: value, initialized: true };
}

export function debounceStep(state, value, dt, duration) {
    const output = Boolean(state?.output);
    let candidate = Boolean(state?.candidate);
    let elapsed = finiteFloat(state?.elapsed);
    const limit = nonNegativeFloat(duration);

    if (value === output) {
        return { output, candidate: value, elapsed: 0 };
    }
    if (value !== candidate) {
        candidate = value;
        elapsed = 0;
    }
    elapsed += dt;
    if (elapsed >= limit) {
        return { output: candidate, candidate, elapsed: 0 };
    }
    return { output, candidate, elapsed };
}

export function hysteresisStep(output, value, low, high) {
    const bounds = orderedBounds(low, high);
    const x = finiteFloat(value);
    if (x >= bounds.max) return true;
    if (x <= bounds.min) return false;
    return Boolean(output);
}

export function pulseStep(state, trigger, dt, duration) {
    const initialized = Boolean(state?.initialized);
    const previous = Boolean(state?.previous);
    let remaining = Math.max(0, finiteFloat(state?.remaining));
    const rising = initialized && !previous && trigger;
    if (rising) {
        remaining = nonNegativeFloat(duration);
    }
    const out = remaining > 0;
    remaining = Math.max(0, remaining - dt);
    return { previous: trigger, remaining, initialized: true, out };
}

export function stopwatchStep(elapsed, enabled, reset, dt) {
    if (reset) return 0;
    if (!enabled) return finiteFloat(elapsed);
    return finiteResult(finiteFloat(elapsed) + dt);
}

export function pushWindow(samples, value, window) {
    const size = clampWindow(window);
    const next = Array.isArray(samples)
        ? samples.filter((sample) => Number.isFinite(sample)).map((sample) => finiteFloat(sample))
        : [];
    next.push(finiteFloat(value));
    if (next.length > size) return next.slice(next.length - size);
    return next;
}

export function slewStep(state, value, riseRate, fallRate, dt) {
    const x = finiteFloat(value);
    if (!state?.initialized) {
        return { output: x, initialized: true };
    }

    const maxRise = nonNegativeFloat(riseRate) * dt;
    const maxFall = nonNegativeFloat(fallRate) * dt;
    let output = finiteFloat(state.output);
    const delta = x - output;
    if (delta > maxRise) output += maxRise;
    else if (delta < -maxFall) output -= maxFall;
    else output = x;
    return { output: finiteResult(output), initialized: true };
}

export function integratorStep(integral, value, dt, reset) {
    if (reset) return 0;
    return finiteResult(finiteFloat(integral) + finiteFloat(value) * dt);
}

export function derivativeStep(state, value, dt, reset) {
    const x = finiteFloat(value);
    if (reset || !state?.initialized || dt === 0) {
        return { out: 0, previous: x, initialized: true };
    }
    return {
        out: finiteResult((x - finiteFloat(state.previous)) / dt),
        previous: x,
        initialized: true,
    };
}

function clampToBounds(value, min, max) {
    return finiteResult(Math.max(min, Math.min(max, value)));
}

export function pidStep(state, inputs) {
    const error = finiteFloat(inputs.setpoint) - finiteFloat(inputs.measurement);
    const p = finiteResult(finiteFloat(inputs.kp) * error);
    const bounds = orderedBounds(inputs.min, inputs.max);
    const dt = inputs.dt;
    let integral = finiteFloat(state?.integral);
    const previousError = finiteFloat(state?.previousError);
    const initialized = Boolean(state?.initialized);

    if (inputs.reset) {
        const command = clampToBounds(p, bounds.min, bounds.max);
        return {
            state: { integral: 0, previousError: error, initialized: true },
            outputs: {
                command,
                error,
                p,
                i: 0,
                d: 0,
                saturated: p < bounds.min || p > bounds.max,
            },
        };
    }

    const d = (!initialized || dt === 0)
        ? 0
        : finiteResult(finiteFloat(inputs.kd) * (error - previousError) / dt);

    if (dt > 0) {
        const tentativeI = finiteResult(integral + finiteFloat(inputs.ki) * error * dt);
        const unbounded = p + tentativeI + d;
        const tentativeCommand = clampToBounds(unbounded, bounds.min, bounds.max);
        const saturated = unbounded < bounds.min || unbounded > bounds.max;
        if (!saturated || (unbounded - tentativeCommand) * error < 0) {
            integral = tentativeI;
        }
        const command = clampToBounds(p + integral + d, bounds.min, bounds.max);
        return {
            state: { integral, previousError: error, initialized: true },
            outputs: { command, error, p, i: integral, d, saturated },
        };
    }

    const unbounded = p + integral;
    const command = clampToBounds(unbounded, bounds.min, bounds.max);
    return {
        state: { integral, previousError: error, initialized: true },
        outputs: {
            command,
            error,
            p,
            i: integral,
            d: 0,
            saturated: unbounded < bounds.min || unbounded > bounds.max,
        },
    };
}
