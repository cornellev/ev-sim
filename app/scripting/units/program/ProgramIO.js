import { useEffect, useState } from "react";
import { reregister, storeData } from "../../ScriptManager";
import Unit from "../Unit";
import {
    SUPPORTED_TYPES,
    normalizeOutputNodeState,
    normalizeProgramInputState,
    normalizeType,
    sanitizeLabel,
} from "./ProgramTypes.js";

export {
    OUTPUT_NODE_MAX_OUTPUTS,
    SUPPORTED_TYPES,
    createOutputNodePort,
    createProgramInputState,
    getInitialData,
    hasDuplicateOutputLabels,
    normalizeOutputNodeState,
    normalizeProgramInputState,
    normalizeType,
    parseValueByType,
    sanitizeLabel,
} from "./ProgramTypes.js";

export {
    OutputNodeBlock,
    ProgramInputBlock,
} from "./ProgramIO.block.js";

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
