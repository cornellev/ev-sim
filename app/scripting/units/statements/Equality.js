import { useEffect, useState } from "react";
import { storeData, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function Equality({ _uuid }) {
    const [type, setType] = useState("eq");

    //types: eq, neq, gt, lt, gte, lte
    useEffect(() => {
        storeData(_uuid, type);
    }, [type])

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
                <select value={type} onChange={e => setType(e.target.value)} className="bg-[#393939] p-2 rounded-lg">
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


export class EqualityBlock extends UnitBlock {
    register() {
        this.registerInput("input a", "float64");
        this.registerInput("input b", "float64");
        this.registerOutput("out", "boolean");
    }

    valid() {
        return this.hasInput("input a") && this.hasInput("input b") && this.hasOutput("out");
    }

    execute() {
        const a = this.getInput("input a");
        const b = this.getInput("input b");

        let result;
        const typ = this.getStoredData();
        switch (typ) {
            case "eq":
                result = a === b;
                break;
            case "neq":
                result = a !== b;
                break;
            case "gt":
                result = a > b;
                break;
            case "lt":
                result = a < b;
                break;
            case "gte":
                result = a >= b;
                break;
            case "lte":
                result = a <= b;
                break;
            default:
                throw new Error("Invalid equality type");
        }

        return new BlockOutput()
            .set("out", result);
    }
}


export function Conjugation({ _uuid }) {
    const [type, setType] = useState("and");

    useState(() => {
        storeData(_uuid, type);
    }, [type])

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
                <select value={type} onChange={e => setType(e.target.value)} className="bg-[#393939] p-2 rounded-lg">
                    <option value="and">AND</option>
                    <option value="or">OR</option>
                    <option value="xor">XOR</option>
                </select>
            </div>
        </Unit>
    )
}

export class ConjugationBlock extends UnitBlock {
    register() {
        this.registerInput("bool a", "boolean");
        this.registerInput("bool b", "boolean");
        this.registerOutput("out", "boolean");
    }

    valid() {
        return this.hasInput("bool a") && this.hasInput("bool b") && this.hasOutput("out");
    }

    execute() {
        const a = this.getInput("bool a");
        const b = this.getInput("bool b");
        
        let result;
        const typ = this.getStoredData();
        switch (typ) {
            case "and":
                result = a && b;
                break;
            case "or":
                result = a || b;
                break;
            case "xor":
                result = (a || b) && !(a && b);
                break;
            default:
                throw new Error("Invalid conjugation type");
        }

        return new BlockOutput()
            .set("out", result);
    }
}
