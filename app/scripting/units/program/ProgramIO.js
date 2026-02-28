import { useEffect, useState } from "react";
import { BlockOutput, reregister, storeData, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

const SUPPORTED_TYPES = ["float64", "int32", "boolean", "string"];

function normalizeType(type) {
    if (SUPPORTED_TYPES.includes(type)) return type;
    return "float64";
}

function parseValueByType(value, type) {
    const normalizedType = normalizeType(type);

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

function getInitialData(uuid, fallbackPrefix) {
    return {
        label: sanitizeLabel(uuid, fallbackPrefix),
        type: "float64",
        defaultValue: "0"
    };
}

export function ProgramInputUnit({ _uuid }) {
    const [data, setData] = useState(() => getInitialData(_uuid, "input"));

    useEffect(() => {
        storeData(_uuid, data);
    }, [data, _uuid]);

    const outputType = normalizeType(data.type);

    return (
        <Unit title="Program Input" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={[
                { label: "input", type: outputType }
            ]}
        >
            <div className="flex flex-col gap-2">
                <select
                    value={outputType}
                    className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400"
                    onChange={(e) => {
                        const type = normalizeType(e.target.value);
                        setData((prev) => ({ ...prev, type }));
                        reregister(_uuid);
                    }}
                >
                    {SUPPORTED_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                    ))}
                </select>
            </div>
        </Unit>
    )
}

export class ProgramInputBlock extends UnitBlock {
    static programNodeRole = "input";

    register() {
        const data = this.getStoredData() || this.state || getInitialData(this.uuid, "input");
        const label = sanitizeLabel(data.label, "input");
        const type = normalizeType(data.type);

        this.state = {
            label,
            type,
            defaultValue: data.defaultValue ?? "0"
        };

        this.registerOutput(label, type);
    }

    getProgramPortDefinition() {
        return {
            role: "input",
            uuid: this.uuid,
            label: this.state.label,
            type: this.state.type
        };
    }

    valid() {
        return this.hasOutput(this.state.label);
    }

    execute() {
        const fallbackValue = parseValueByType(this.state.defaultValue, this.state.type);
        const value = this.manager.resolveExternalInput(this.state.label, fallbackValue);
        return new BlockOutput().set(this.state.label, parseValueByType(value, this.state.type));
    }
}

export function ProgramOutputUnit({ _uuid }) {
    const [data, setData] = useState(() => getInitialData(_uuid, "output"));

    useEffect(() => {
        storeData(_uuid, data);
    }, [data, _uuid]);

    const inputType = normalizeType(data.type);

    return (
        <Unit title="Program Output" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "output", type: inputType }
            ]}
            outputs={[]}
        >
            <div className="flex flex-col gap-2">

                <select
                    value={inputType}
                    className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400"
                    onChange={(e) => {
                        const type = normalizeType(e.target.value);
                        setData((prev) => ({ ...prev, type }));
                        reregister(_uuid);
                    }}
                >
                    {SUPPORTED_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                    ))}
                </select>
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

        this.registerInput(label, type);
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
        return this.hasInput(this.state.label);
    }

    execute() {
        const value = this.getInput(this.state.label);
        this.manager.setExternalOutput(this.state.label, value);
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
