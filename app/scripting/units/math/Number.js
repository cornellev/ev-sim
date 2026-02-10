import { useState } from "react";
import { UnitBlock } from "../../ScriptManager";

const { default: Unit } = require("../Unit")

export default function NumberUnit(props) {
    const [value, setValue] = useState(0);

    return (
        <Unit title="Number" outputs={[
            {
                label: "number",
                type: "float64"
            }
        ]} hasOptions={true} _uuid={props._uuid}>
            <input 
                value={isNaN(value) ? "" : value} 
                className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400" 
                id={props._uuid + "-input"}
                type="number"
                onChange={(e) => setValue(parseFloat(e.target.value))}
            />
        </Unit>
    )
}

export class NumberUnitClass extends UnitBlock {
    valid() {
        return true;
    }

    execute() {
        const value = parseFloat(document.getElementById(this.uuid + "-input").value);
        return value;
    }
}