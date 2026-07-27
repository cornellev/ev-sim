import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";
import Unit from "../Unit";

export function Equality({ _uuid, initialData = "eq" }) {
    const [type, setType] = useState(() => initialData || "eq");

    //types: eq, neq, gt, lt, gte, lte
    useEffect(() => {
        storeData(_uuid, type);
    }, [type, _uuid])

    return (
        <Unit title="Equality" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "input a", type: "float64" },
                { label: "input b", type: "float64" },
            ]}
            outputs={
                [
                    {label: "out", type: "boolean"}
                ]
            }>

            <div className="w-full h-full flex items-center justify-center">
                <select value={type} onChange={e => setType(e.target.value)} className="rounded-[4px] border border-white/10 bg-[var(--slate-bg)] p-2 outline-none focus:border-white/30">
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

    useEffect(() => {
        storeData(_uuid, type);
    }, [type, _uuid])

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
                <select value={type} onChange={e => setType(e.target.value)} className="rounded-[4px] border border-white/10 bg-[var(--slate-bg)] p-2 outline-none focus:border-white/30">
                    <option value="and">AND</option>
                    <option value="or">OR</option>
                    <option value="xor">XOR</option>
                </select>
            </div>
        </Unit>
    )
}
export { EqualityBlock, ConjugationBlock } from "./Equality.block.js";
