
import Unit from "../Unit";
import { useState } from "react";

export function CalculationUnit({ _uuid, initialState = {} }) {
    const [operation, setOperation] = useState(() => initialState.operation || "add");

    return (
        <Unit title="Calculation" hasOptions={true} _uuid={_uuid}
        inputs={
            [
                {label: "input A", type: "float64"},
                {label: "input B", type: "float64"}
            ]
        }
        outputs={
            [
                {label: "result", type: "float64"}
            ]
        }>
            <div className="flex flex-col gap-2">
                <select
                    id={_uuid + "-operation"}
                    value={operation}
                    className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400"
                    onChange={(event) => setOperation(event.target.value)}
                >
                    <option value="add">Add</option>
                    <option value="subtract">Subtract</option>
                    <option value="multiply">Multiply</option>
                    <option value="divide">Divide</option>
                    <option value="power">Power</option>
                    <option value="modulus">Modulus</option>
                </select>
            </div>
        </Unit>
    )
}
export { CalculationBlock } from "./Calculation.block.js";
