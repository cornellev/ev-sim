import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function CalculationUnit({ _uuid }) {
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
                <select id={_uuid + "-operation"} className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400">
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

export class CalculationBlock extends UnitBlock {
    register() {
        this.registerInput("input A", "float64");
        this.registerInput("input B", "float64");
        this.registerOutput("result", "float64");
    }

    valid() {
        return this.hasInput("input A") && this.hasInput("input B");
    }

    execute() {
        const a = this.getInput("input A");
        const b = this.getInput("input B");
        const operation = document.getElementById(this.uuid + "-operation").value;

        let result;
        switch (operation) {
            case "add":
                result = a + b;
                break;
            case "subtract":
                result = a - b;
                break;
            case "multiply":
                result = a * b;
                break;
            case "divide":
                result = b !== 0 ? a / b : 0; // handle division by zero
                break;
            case "power":
                result = Math.pow(a, b);
                break;
            case "modulus":
                result = a % b;
                break;
            default:
                result = 0;
        }

        return new BlockOutput().set("result", result);
    }
}