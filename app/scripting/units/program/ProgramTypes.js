/**
 * Pure program I/O helpers shared by block runtime and React UI.
 * No React imports — safe for server/MCP compile paths.
 */

export const SUPPORTED_TYPES = [
    "float64",
    "int32",
    "boolean",
    "string",
    "json",
    "message",
    "topic",
    "timestamp",
    "vec2",
    "vec3",
    "pose2d",
    "pose3d",
    "vehicle_ref",
    "device_ref",
    "object_ref",
    "route",
    "waypoint",
    "lane_ref",
    "sim_event",
    "tex1d",
    "array[float64]",
    "array[int32]",
    "array[boolean]",
    "array[string]",
    "array[json]",
    "custom[string]",
];

export const OUTPUT_NODE_MAX_OUTPUTS = 8;

export function normalizeType(type) {
    if (SUPPORTED_TYPES.includes(type)) return type;
    return "float64";
}

function arrayMemberType(type) {
    return type.match(/\[(.*?)\]/)?.[1] || "float64";
}

function parseArrayValue(value, itemType = "float64") {
    let rawItems = value;

    if (typeof value === "string") {
        const trimmed = value.trim();

        if (trimmed.length === 0) {
            rawItems = [];
        } else {
            try {
                const parsed = JSON.parse(trimmed);
                rawItems = Array.isArray(parsed) ? parsed : trimmed.split(",");
            } catch {
                rawItems = trimmed.split(",");
            }
        }
    }

    if (!Array.isArray(rawItems)) {
        rawItems = [rawItems];
    }

    return rawItems.map((item) => parseValueByType(item, itemType));
}

export function parseValueByType(value, type) {
    const normalizedType = normalizeType(type);

    if (normalizedType === "tex1d") {
        return parseArrayValue(value, "float64");
    }

    if (normalizedType.startsWith("array[")) {
        return parseArrayValue(value, arrayMemberType(normalizedType));
    }

    if (normalizedType.startsWith("custom[")) {
        if (typeof value !== "string") return value;

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    if ([
        "json",
        "message",
        "topic",
        "timestamp",
        "vec2",
        "vec3",
        "pose2d",
        "pose3d",
        "vehicle_ref",
        "device_ref",
        "object_ref",
        "route",
        "waypoint",
        "lane_ref",
        "sim_event",
    ].includes(normalizedType)) {
        if (typeof value !== "string") return value;

        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    if (normalizedType === "float64") {
        const parsed = Number.parseFloat(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    if (normalizedType === "int32") {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    if (normalizedType === "boolean") {
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
            const lowered = value.toLowerCase();
            return lowered === "true" || lowered === "1";
        }
        return Boolean(value);
    }

    if (value === null || value === undefined) return "";
    return String(value);
}

export function sanitizeLabel(rawLabel, fallbackPrefix) {
    const trimmed = String(rawLabel || "").trim();
    return trimmed.length > 0 ? trimmed : `${fallbackPrefix}`;
}

export function sanitizePortId(rawId, fallbackId) {
    const trimmed = String(rawId || "").trim().replace(/\|/g, "-");
    return trimmed.length > 0 ? trimmed : fallbackId;
}

export function createOutputNodePort(index = 0, overrides = {}) {
    const suffix = index + 1;

    return {
        id: sanitizePortId(overrides.id, index === 0 ? "output" : `output-${suffix}`),
        label: sanitizeLabel(overrides.label, index === 0 ? "output" : `output ${suffix}`),
        type: normalizeType(overrides.type),
    };
}

export function normalizeOutputNodeState(data = {}) {
    const hasOutputList = Array.isArray(data?.outputs);
    const rawOutputs = hasOutputList
        ? data.outputs
        : [createOutputNodePort(0, {
            id: "output",
            label: data?.label,
            type: data?.type,
        })];

    const usedIds = new Set();
    const outputs = rawOutputs.map((port, index) => {
        const fallbackId = index === 0 ? "output" : `output-${index + 1}`;
        const normalized = createOutputNodePort(index, {
            ...port,
            id: port?.id || fallbackId,
        });

        let id = normalized.id;
        let duplicateIndex = 2;
        while (usedIds.has(id)) {
            id = `${normalized.id}-${duplicateIndex}`;
            duplicateIndex += 1;
        }
        usedIds.add(id);

        return {
            ...normalized,
            id,
        };
    });

    return {
        outputs: outputs.length > 0 ? outputs : [createOutputNodePort(0)],
    };
}

export function hasDuplicateOutputLabels(outputs = []) {
    const labels = outputs.map((output) => sanitizeLabel(output.label, "output"));
    return new Set(labels).size !== labels.length;
}

export function getInitialData(uuid, fallbackPrefix) {
    return {
        label: sanitizeLabel(uuid, fallbackPrefix),
        type: "float64",
        defaultValue: "0",
    };
}

export function createProgramInputState(index = 0, overrides = {}) {
    const defaultLabel = index === 0 ? "input" : `input_${index + 1}`;

    return {
        label: sanitizeLabel(overrides.label, defaultLabel),
        type: normalizeType(overrides.type),
        defaultValue: overrides.defaultValue ?? "0",
    };
}

export function normalizeProgramInputState(data = {}, index = 0, uuid = null) {
    const label = data?.label === uuid ? undefined : data?.label;

    return createProgramInputState(index, {
        ...data,
        label,
    });
}
