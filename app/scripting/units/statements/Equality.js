import { useState } from "react";
import { requestUnitReconfiguration } from "../../ScriptManager";
import Unit from "../Unit";

export function Equality({ _uuid, initialData = "eq", portTypes = {} }) {
    const [type, setType] = useState(() => initialData || "eq");
    const inputType = portTypes.inputs?.["input a"] || portTypes.inputs?.["input b"] || "generic";

    const commitType = (nextType) => {
        const result = requestUnitReconfiguration(_uuid, { storedData: nextType });
        if (result.ok) setType(nextType);
    };

    return (
        <Unit title="Equality" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "input a", type: inputType },
                { label: "input b", type: inputType },
            ]}
            outputs={
                [
                    {label: "out", type: "boolean"}
                ]
            }>

            <div className="w-full h-full flex items-center justify-center">
                <select value={type} onChange={e => commitType(e.target.value)} className="rounded-[4px] border border-white/10 bg-[var(--slate-bg)] p-2 outline-none focus:border-white/30">
                    <option value="eq">==</option>
                    <option value="neq">!=</option>
                    <option value="gt">&gt;</option>
                    <option value="lt">&lt;</option>
                    <option value="gte">&gt;=</option>
                    <option value="lte">&lt;=</option>
                </select>
            </div>
        </Unit>
    )
}

export function Conjugation({ _uuid, initialData = "and" }) {
    const [type, setType] = useState(() => initialData || "and");

    const commitType = (nextType) => {
        const result = requestUnitReconfiguration(_uuid, { storedData: nextType });
        if (result.ok) setType(nextType);
    };

    return (
        <Unit title="Conjugation" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "bool a", type: "boolean" },
                { label: "bool b", type: "boolean" },
            ]}
            outputs={
                [
                    {label: "out", type: "boolean"}
                ]
            }>

            <div className="w-full h-full flex items-center justify-center">
                <select value={type} onChange={e => commitType(e.target.value)} className="rounded-[4px] border border-white/10 bg-[var(--slate-bg)] p-2 outline-none focus:border-white/30">
                    <option value="and">AND</option>
                    <option value="or">OR</option>
                    <option value="xor">XOR</option>
                </select>
            </div>
        </Unit>
    )
}
export { EqualityBlock, ConjugationBlock } from "./Equality.block.js";
