import { longitudinalSpeed } from "./simpleRunModel.js";

export const RESOLUTION_DOMAINS = new Set([
    "scenario",
    "scenario-catalog",
    "environment",
    "vehicle",
    "script",
    "bindings",
    "plugin",
]);

function emptyLane() {
    return {
        status: "unresolved",
        generation: 0,
        key: null,
        result: null,
        error: null,
        body: null,
        due: false,
        timer: null,
        suspended: false,
    };
}

function publishLane(slot) {
    return {
        status: slot.status,
        generation: slot.generation,
        key: slot.key,
        result: slot.result,
        error: slot.error,
    };
}

function errorText(error) {
    return error instanceof Error && error.message ? error.message : "Resolve failed";
}

export function createEffectiveResolver({
    resolve,
    delayMs = 400,
    setTimeout = globalThis.setTimeout.bind(globalThis),
    clearTimeout = globalThis.clearTimeout.bind(globalThis),
} = {}) {
    if (typeof resolve !== "function") throw new TypeError("A resolve function is required.");
    let disposed = false;
    let inflight = null;
    const lanes = { draft: emptyLane(), baseline: emptyLane() };
    const listeners = new Set();

    function snapshot() {
        return {
            draft: publishLane(lanes.draft),
            baseline: publishLane(lanes.baseline),
        };
    }

    function emit() {
        if (disposed) return;
        const current = snapshot();
        for (const listener of [...listeners]) listener(current);
    }

    function pump() {
        if (disposed || inflight) return;
        // Draft goes first so a baseline resolve cannot hold the only in-flight slot.
        const lane = lanes.draft.due && !lanes.draft.suspended
            ? "draft"
            : lanes.baseline.due && !lanes.baseline.suspended
                ? "baseline"
                : null;
        if (!lane) return;
        const slot = lanes[lane];
        slot.due = false;
        const generation = slot.generation;
        const body = slot.body;
        inflight = { lane, generation };
        Promise.resolve()
            .then(() => resolve(body))
            .then((result) => {
                if (disposed || slot.generation !== generation) return;
                slot.status = "ready";
                slot.result = result;
                slot.error = null;
            })
            .catch((error) => {
                if (disposed || slot.generation !== generation) return;
                slot.status = "failed";
                slot.result = null;
                slot.error = errorText(error);
            })
            .finally(() => {
                if (inflight?.lane === lane && inflight.generation === generation) inflight = null;
                emit();
                pump();
            });
    }

    return {
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            listener(snapshot());
            return () => listeners.delete(listener);
        },
        submit({ lane, key = null, body = null, suspended = false } = {}) {
            if (lane !== "draft" && lane !== "baseline") {
                throw new TypeError(`Unknown resolution lane "${lane}".`);
            }
            const slot = lanes[lane];
            const hold = suspended || body == null;
            if (!hold && lane === "baseline" && key === slot.key && (slot.status === "checking" || slot.status === "ready")) {
                return;
            }
            slot.generation += 1;
            slot.key = key;
            slot.body = body;
            slot.suspended = hold;
            slot.result = null;
            slot.error = null;
            slot.due = false;
            if (slot.timer != null) clearTimeout(slot.timer);
            slot.timer = null;
            const generation = slot.generation;
            slot.status = hold ? "unresolved" : "checking";
            if (!hold) {
                slot.timer = setTimeout(() => {
                    slot.timer = null;
                    if (disposed || slot.generation !== generation) return;
                    slot.due = true;
                    pump();
                }, delayMs);
            }
            emit();
        },
        dispose() {
            disposed = true;
            for (const slot of Object.values(lanes)) {
                slot.generation += 1;
                slot.due = false;
                if (slot.timer != null) clearTimeout(slot.timer);
                slot.timer = null;
            }
            inflight = null;
            listeners.clear();
        },
    };
}

function egoVehicle(manifest) {
    const vehicles = Array.isArray(manifest?.initialState?.vehicles) ? manifest.initialState.vehicles : [];
    return vehicles.find((vehicle) => vehicle?.id === "ego") ?? vehicles[0] ?? null;
}

function text(value) {
    if (value == null || value === "") return "";
    return String(value);
}

function sensorCounts(manifest) {
    const counts = new Map();
    for (const sensor of manifest?.sensorRig?.sensors ?? []) {
        const type = sensor?.type || "unknown";
        counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");
}

function readSummary(manifest) {
    if (!manifest) return null;
    const vehicle = egoVehicle(manifest);
    const position = vehicle?.pose?.position;
    return {
        scenario: manifest.scenario?.id ? String(manifest.scenario.id) : "Manifest only",
        environment: text(manifest.environment?.id),
        vehicle: text(vehicle?.type),
        authority: text(manifest.controls?.authority),
        pacing: text(manifest.clock?.pacing),
        speed: manifest.clock?.speed == null ? "" : String(manifest.clock.speed),
        step: manifest.clock?.stepNs == null ? "" : String(manifest.clock.stepNs),
        maxSteps: manifest.clock?.maxSteps == null ? "Unlimited" : String(manifest.clock.maxSteps),
        recording: text(manifest.logging?.policy),
        sensors: sensorCounts(manifest),
        position: position ? ["x", "y", "z"].map((axis) => position[axis] ?? 0).join(", ") : "",
        heading: vehicle?.pose?.rotation?.y == null ? "" : String(vehicle.pose.rotation.y),
        longitudinalSpeed: vehicle ? String(longitudinalSpeed(vehicle)) : "",
    };
}

const SUMMARY_FIELDS = Object.freeze([
    ["scenario", "Scenario"],
    ["environment", "Environment"],
    ["vehicle", "Vehicle"],
    ["authority", "Control"],
    ["pacing", "Pacing"],
    ["speed", "Speed"],
    ["step", "Step"],
    ["maxSteps", "Maximum steps"],
    ["recording", "Recording"],
    ["sensors", "Sensors"],
    ["position", "Position"],
    ["heading", "Heading"],
    ["longitudinalSpeed", "Longitudinal speed"],
]);

export function summaryRows(currentManifest, baselineManifest) {
    const current = readSummary(currentManifest);
    const baseline = readSummary(baselineManifest);
    return SUMMARY_FIELDS.map(([id, label]) => ({
        id,
        label,
        current: current ? current[id] : null,
        baseline: baseline ? baseline[id] : null,
    }));
}
