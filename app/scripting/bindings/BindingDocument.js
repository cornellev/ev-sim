import { TOPIC_SIGNAL_PREFIX } from "../runtime/SignalPaths.js";

export const BINDING_MANIFEST_KIND = "cev-sim.script-bindings";
export const BINDING_MANIFEST_VERSION = 1;

export const TRIGGER_KINDS = {
    TOPIC: "topic",
    FIXED_UPDATE: "fixed-update",
    SIGNAL_UPDATE: "signal-update",
    TIMER: "timer"
};

export const TRIGGER_KIND_ORDER = [
    TRIGGER_KINDS.TOPIC,
    TRIGGER_KINDS.FIXED_UPDATE,
    TRIGGER_KINDS.SIGNAL_UPDATE,
    TRIGGER_KINDS.TIMER
];

export const INPUT_SOURCES = {
    SIGNAL: "signal",
    MESSAGE: "message",
    CONSTANT: "constant",
    SIM: "sim"
};

export const OUTPUT_SINKS = {
    SIGNAL: "signal",
    PUBLISH: "publish"
};

export const SIM_VALUE_KEYS = ["dt", "time", "step"];

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createBindingId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `binding-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
    return new Date().toISOString();
}

function toPositiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function toPositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toTrimmedString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeTrigger(trigger = {}) {
    const kind = TRIGGER_KIND_ORDER.includes(trigger?.kind) ? trigger.kind : TRIGGER_KINDS.TOPIC;

    switch (kind) {
        case TRIGGER_KINDS.TOPIC:
            return { kind, topic: toTrimmedString(trigger.topic) };
        case TRIGGER_KINDS.FIXED_UPDATE:
            return { kind, everyN: toPositiveInt(trigger.everyN, 1) };
        case TRIGGER_KINDS.SIGNAL_UPDATE:
            return { kind, path: toTrimmedString(trigger.path) };
        case TRIGGER_KINDS.TIMER:
        default:
            return { kind: TRIGGER_KINDS.TIMER, intervalMs: toPositiveNumber(trigger.intervalMs, 100) };
    }
}

export function normalizeInputMapping(mapping = {}) {
    const source = Object.values(INPUT_SOURCES).includes(mapping?.source)
        ? mapping.source
        : INPUT_SOURCES.SIGNAL;

    const normalized = {
        input: toTrimmedString(mapping.input),
        source
    };

    if (source === INPUT_SOURCES.SIGNAL) {
        normalized.path = toTrimmedString(mapping.path);
        normalized.field = toTrimmedString(mapping.field);
    } else if (source === INPUT_SOURCES.MESSAGE) {
        normalized.field = toTrimmedString(mapping.field);
    } else if (source === INPUT_SOURCES.CONSTANT) {
        normalized.value = mapping.value === undefined ? null : mapping.value;
    } else if (source === INPUT_SOURCES.SIM) {
        normalized.key = SIM_VALUE_KEYS.includes(mapping.key) ? mapping.key : "dt";
    }

    return normalized;
}

export function normalizeOutputMapping(mapping = {}) {
    const sink = Object.values(OUTPUT_SINKS).includes(mapping?.sink)
        ? mapping.sink
        : OUTPUT_SINKS.SIGNAL;

    const normalized = {
        output: toTrimmedString(mapping.output),
        sink
    };

    if (sink === OUTPUT_SINKS.SIGNAL) {
        normalized.path = toTrimmedString(mapping.path);
    } else {
        normalized.topic = toTrimmedString(mapping.topic);
        normalized.type = toTrimmedString(mapping.type);
    }

    return normalized;
}

export function createBinding(partial = {}) {
    return normalizeBinding({
        id: createBindingId(),
        name: "Untitled binding",
        enabled: true,
        scriptId: null,
        trigger: { kind: TRIGGER_KINDS.TOPIC },
        inputs: [],
        outputs: [],
        ...partial
    });
}

export function normalizeBinding(binding = {}) {
    return {
        id: toTrimmedString(binding.id, createBindingId()),
        name: toTrimmedString(binding.name, "Untitled binding"),
        enabled: binding.enabled !== false,
        scriptId: toTrimmedString(binding.scriptId, "") || null,
        trigger: normalizeTrigger(binding.trigger),
        inputs: Array.isArray(binding.inputs)
            ? binding.inputs.map(normalizeInputMapping).filter((mapping) => mapping.input)
            : [],
        outputs: Array.isArray(binding.outputs)
            ? binding.outputs.map(normalizeOutputMapping).filter((mapping) => mapping.output)
            : []
    };
}

export function createBindingManifest({ bindings = [], enabled = true, updatedAt = nowIso() } = {}) {
    return {
        kind: BINDING_MANIFEST_KIND,
        version: BINDING_MANIFEST_VERSION,
        enabled: enabled !== false,
        updatedAt,
        bindings: bindings.map(normalizeBinding)
    };
}

export function isBindingManifest(value) {
    return isPlainObject(value)
        && value.kind === BINDING_MANIFEST_KIND
        && value.version === BINDING_MANIFEST_VERSION;
}

export function normalizeBindingManifest(manifest) {
    if (!isPlainObject(manifest)) {
        return createBindingManifest();
    }

    if (manifest.kind !== undefined && !isBindingManifest(manifest)) {
        throw new Error("Unsupported bindings manifest. Expected kind \"cev-sim.script-bindings\" version 1.");
    }

    return createBindingManifest({
        bindings: Array.isArray(manifest.bindings) ? manifest.bindings : [],
        enabled: manifest.enabled,
        updatedAt: manifest.updatedAt || nowIso()
    });
}

export function validateBinding(binding) {
    const issues = [];

    if (!binding.scriptId) {
        issues.push("No script selected.");
    }

    const trigger = binding.trigger || {};
    if (trigger.kind === TRIGGER_KINDS.TOPIC && !trigger.topic) {
        issues.push("Topic trigger needs a topic name.");
    }
    if (trigger.kind === TRIGGER_KINDS.SIGNAL_UPDATE && !trigger.path) {
        issues.push("Signal trigger needs a signal path.");
    }

    (binding.inputs || []).forEach((mapping) => {
        if (mapping.source === INPUT_SOURCES.SIGNAL && !mapping.path) {
            issues.push(`Input "${mapping.input}" needs a signal path.`);
        }
        if (mapping.source === INPUT_SOURCES.MESSAGE && trigger.kind !== TRIGGER_KINDS.TOPIC) {
            issues.push(`Input "${mapping.input}" reads the trigger message, but the trigger is not a topic.`);
        }
    });

    (binding.outputs || []).forEach((mapping) => {
        if (mapping.sink === OUTPUT_SINKS.SIGNAL && !mapping.path) {
            issues.push(`Output "${mapping.output}" needs a signal path.`);
        }
        if (mapping.sink === OUTPUT_SINKS.PUBLISH && (!mapping.topic || !mapping.type)) {
            issues.push(`Output "${mapping.output}" needs a topic and message type to publish.`);
        }
    });

    return issues;
}

export function summarizeTrigger(trigger = {}) {
    switch (trigger.kind) {
        case TRIGGER_KINDS.TOPIC:
            return trigger.topic ? `on ${trigger.topic}` : "on topic —";
        case TRIGGER_KINDS.FIXED_UPDATE:
            return trigger.everyN > 1 ? `every ${trigger.everyN} ticks` : "every tick";
        case TRIGGER_KINDS.SIGNAL_UPDATE:
            return trigger.path ? `when ${trigger.path} changes` : "on signal —";
        case TRIGGER_KINDS.TIMER:
            return `every ${trigger.intervalMs} ms`;
        default:
            return "unknown trigger";
    }
}

/**
 * Derive a suggested trigger from a compiled artifact's entrypoint/binding
 * metadata (emitted by On Tick / On Signal Update / On Timer / Bind Trigger blocks).
 */
export function suggestTriggerFromArtifact({ entrypoints = [], bindings = [] } = {}) {
    const entrypoint = entrypoints.find((entry) => entry && entry.kind);

    if (entrypoint) {
        if (entrypoint.kind === "tick") {
            return normalizeTrigger({ kind: TRIGGER_KINDS.FIXED_UPDATE });
        }
        if (entrypoint.kind === "signal-update") {
            const path = toTrimmedString(entrypoint.path);
            if (path.startsWith(TOPIC_SIGNAL_PREFIX)) {
                return normalizeTrigger({ kind: TRIGGER_KINDS.TOPIC, topic: path.slice(TOPIC_SIGNAL_PREFIX.length) });
            }
            return normalizeTrigger({ kind: TRIGGER_KINDS.SIGNAL_UPDATE, path });
        }
        if (entrypoint.kind === "timer") {
            return normalizeTrigger({ kind: TRIGGER_KINDS.TIMER, intervalMs: entrypoint.intervalMs });
        }
    }

    const triggerBinding = bindings.find((entry) => entry && entry.kind === "trigger" && entry.path);
    if (triggerBinding) {
        const path = toTrimmedString(triggerBinding.path);
        if (path.startsWith(TOPIC_SIGNAL_PREFIX)) {
            return normalizeTrigger({ kind: TRIGGER_KINDS.TOPIC, topic: path.slice(TOPIC_SIGNAL_PREFIX.length) });
        }
        return normalizeTrigger({ kind: TRIGGER_KINDS.SIGNAL_UPDATE, path });
    }

    return null;
}
