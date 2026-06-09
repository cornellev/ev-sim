import { useEffect, useState } from "react";
import { BlockOutput, reregister, storeData, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

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
    "custom[string]"
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
        "sim_event"
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

function sanitizeLabel(rawLabel, fallbackPrefix) {
    const trimmed = String(rawLabel || "").trim();
    return trimmed.length > 0 ? trimmed : `${fallbackPrefix}`;
}

function sanitizePortId(rawId, fallbackId) {
    const trimmed = String(rawId || "").trim().replace(/\|/g, "-");
    return trimmed.length > 0 ? trimmed : fallbackId;
}

export function createOutputNodePort(index = 0, overrides = {}) {
    const suffix = index + 1;

    return {
        id: sanitizePortId(overrides.id, index === 0 ? "output" : `output-${suffix}`),
        label: sanitizeLabel(overrides.label, index === 0 ? "output" : `output ${suffix}`),
        type: normalizeType(overrides.type)
    };
}

export function normalizeOutputNodeState(data = {}) {
    const hasOutputList = Array.isArray(data?.outputs);
    const rawOutputs = hasOutputList
        ? data.outputs
        : [createOutputNodePort(0, {
            id: "output",
            label: data?.label,
            type: data?.type
        })];

    const usedIds = new Set();
    const outputs = rawOutputs.map((port, index) => {
        const fallbackId = index === 0 ? "output" : `output-${index + 1}`;
        const normalized = createOutputNodePort(index, {
            ...port,
            id: port?.id || fallbackId
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
            id
        };
    });

    return {
        outputs: outputs.length > 0 ? outputs : [createOutputNodePort(0)]
    };
}

export function hasDuplicateOutputLabels(outputs = []) {
    const labels = outputs.map((output) => sanitizeLabel(output.label, "output"));
    return new Set(labels).size !== labels.length;
}

function getInitialData(uuid, fallbackPrefix) {
    return {
        label: sanitizeLabel(uuid, fallbackPrefix),
        type: "float64",
        defaultValue: "0"
    };
}

export function createProgramInputState(index = 0, overrides = {}) {
    const defaultLabel = index === 0 ? "input" : `input_${index + 1}`;

    return {
        label: sanitizeLabel(overrides.label, defaultLabel),
        type: normalizeType(overrides.type),
        defaultValue: overrides.defaultValue ?? "0"
    };
}

export function normalizeProgramInputState(data = {}, index = 0, uuid = null) {
    const label = data?.label === uuid ? undefined : data?.label;

    return createProgramInputState(index, {
        ...data,
        label
    });
}

export function ProgramInputUnit({ _uuid, initialData = null }) {
    const [data, setData] = useState(() => normalizeProgramInputState(initialData, 0, _uuid));

    useEffect(() => {
        storeData(_uuid, data);
        reregister(_uuid);
    }, [data, _uuid]);

    const outputType = normalizeType(data.type);

    const commitData = (next) => {
        setData(next);
        storeData(_uuid, next);
        reregister(_uuid);
    };

    return (
        <Unit title="Program Input" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={[
                { id: "input", label: data.label, type: outputType }
            ]}
        >
            <div className="flex flex-col gap-3 text-xs text-zinc-300">
                <label className="flex flex-col gap-1.5">
                    <span className="text-zinc-400">External label</span>
                    <input
                        value={data.label}
                        className="w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                        onChange={(e) => {
                            const label = sanitizeLabel(e.target.value, "input");
                            commitData({ ...data, label });
                        }}
                    />
                </label>

                <label className="flex flex-col gap-1.5">
                    <span className="text-zinc-400">Type</span>
                    <select
                        value={outputType}
                        className="w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                        onChange={(e) => {
                            const type = normalizeType(e.target.value);
                            commitData({ ...data, type });
                        }}
                    >
                        {SUPPORTED_TYPES.map((type) => (
                            <option key={type} value={type}>{type}</option>
                        ))}
                    </select>
                </label>

                <label className="flex flex-col gap-1.5">
                    <span className="text-zinc-400">Default value</span>
                    <input
                        value={data.defaultValue}
                        className="w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                        onChange={(e) => {
                            commitData({ ...data, defaultValue: e.target.value });
                        }}
                    />
                </label>
            </div>
        </Unit>
    )
}

export class ProgramInputBlock extends UnitBlock {
    static programNodeRole = "input";

    register() {
        const data = this.getStoredData() || this.state || createProgramInputState();
        this.state = normalizeProgramInputState(data, 0, this.uuid);

        this.registerOutput("input", this.state.type);
    }

    getProgramPortDefinition() {
        return {
            role: "input",
            uuid: this.uuid,
            portId: "input",
            label: this.state.label,
            type: this.state.type
        };
    }

    valid() {
        return this.hasOutput("input");
    }

    execute() {
        const fallbackValue = parseValueByType(this.state.defaultValue, this.state.type);
        const value = this.manager.resolveExternalInput(this.state.label, fallbackValue);
        return new BlockOutput().set("input", parseValueByType(value, this.state.type));
    }
}

export function ProgramOutputUnit({ _uuid, initialData = null }) {
    const [data, setData] = useState(() => initialData || getInitialData(_uuid, "output"));

    useEffect(() => {
        storeData(_uuid, data);
        reregister(_uuid);
    }, [data, _uuid]);

    const inputType = normalizeType(data.type);

    return (
        <Unit title="Program Output" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "output", type: inputType }
            ]}
            outputs={[]}
        >
            <div className="flex flex-col gap-3 text-xs text-zinc-300">
                <label className="flex flex-col gap-1.5">
                    <span className="text-zinc-400">External label</span>
                <input
                    value={data.label}
                    className="w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                    placeholder="output label"
                    onChange={(e) => {
                        const label = sanitizeLabel(e.target.value, "output");
                        setData((prev) => ({ ...prev, label }));
                    }}
                />
                </label>

                <label className="flex flex-col gap-1.5">
                    <span className="text-zinc-400">Type</span>
                <select
                    value={inputType}
                    className="w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                    onChange={(e) => {
                        const type = normalizeType(e.target.value);
                        setData((prev) => ({ ...prev, type }));
                    }}
                >
                    {SUPPORTED_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                    ))}
                </select>
                </label>
            </div>
        </Unit>
    )
}

export class ProgramOutputBlock extends UnitBlock {
    static programNodeRole = "output";

    register() {
        const data = this.getStoredData() || this.state || getInitialData(this.uuid, "output");
        const label = sanitizeLabel(data.label, "output");
        const type = normalizeType(data.type);

        this.state = {
            label,
            type
        };

        this.registerInput("output", type);
    }

    getProgramPortDefinition() {
        return {
            role: "output",
            uuid: this.uuid,
            label: this.state.label,
            type: this.state.type
        };
    }

    valid() {
        return this.hasInput("output");
    }

    execute() {
        const value = this.getInput("output");
        this.manager.setExternalOutput(this.state.label, value);
        return new BlockOutput();
    }
}

export function OutputNodeUnit({ _uuid, outputs = null, outputType = "float64", initialPosition = null }) {
    const state = normalizeOutputNodeState(outputs ? { outputs } : {
        id: "output",
        label: "output",
        type: outputType
    });

    return (
        <Unit title="OutputNode" hasOptions={false} _uuid={_uuid} initialPosition={initialPosition}
            inputs={state.outputs.map((output) => ({
                id: output.id,
                label: output.label,
                type: output.type
            }))}
            outputs={[]}
        />
    )
}

export class OutputNodeBlock extends UnitBlock {
    static programNodeRole = "output";

    register() {
        const data = this.getStoredData() || this.state || normalizeOutputNodeState();
        const state = normalizeOutputNodeState(data);

        this.state = state;

        this.state.outputs.forEach((output) => {
            this.registerInput(output.id, output.type);
        });
    }

    resolveInputLabel(label) {
        const outputs = this.state.outputs || [];
        const idMatch = outputs.find((output) => output.id === label);
        if (idMatch) return idMatch.id;

        const labelMatch = outputs.find((output) => output.label === label);
        return labelMatch?.id || label;
    }

    getProgramPortDefinition() {
        return this.state.outputs.map((output) => ({
            role: "output",
            uuid: this.uuid,
            portId: output.id,
            label: output.label,
            type: output.type
        }));
    }

    valid() {
        const outputs = this.state.outputs || [];

        return outputs.length > 0
            && !hasDuplicateOutputLabels(outputs)
            && outputs.every((output) => this.hasInput(output.id));
    }

    execute() {
        this.state.outputs.forEach((output) => {
            const value = this.getInput(output.id);
            this.manager.setExternalOutput(output.label, value);
        });

        return new BlockOutput();
    }
}

export function createCompiledProgramUnit(compiledProgram, title = null) {
    const unitTitle = title || compiledProgram?.name || "Compiled Program";
    const inputs = compiledProgram?.interface?.inputs || [];
    const outputs = compiledProgram?.interface?.outputs || [];

    return function CompiledProgramUnit({ _uuid }) {
        return (
            <Unit title={unitTitle} hasOptions={false} _uuid={_uuid}
                inputs={inputs.map((inputPort) => ({ label: inputPort.label, type: inputPort.type }))}
                outputs={outputs.map((outputPort) => ({ label: outputPort.label, type: outputPort.type }))}
            />
        )
    }
}
