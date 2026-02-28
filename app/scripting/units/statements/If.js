import { useRef, useState } from "react";
import { BlockOutput, reregister, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function IfUnit({ _uuid }) {
    const selectRef = useRef();
    const [outputType, setOutputType] = useState("float64");

    const onChange = (e) => {
        const type = selectRef.current.value;
        setOutputType(type);

        reregister(_uuid);
    }

    return (
        <Unit title="If" hasOptions={true} _uuid={_uuid}
            inputs={[
                {label: "condition", type: "boolean"},
                {label: "true value", type: outputType},
                {label: "false value", type: outputType}
            ]}
            outputs={
                [
                    {label: "out", type: outputType}
                ]
            }>

            <div className="flex flex-col gap-2">
                <select onChange={onChange} id={_uuid + "-type"} className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400" ref={selectRef}>
                    <option value="float64">Float64</option>
                    <option value="int32">Int32</option>
                    <option value="boolean">Boolean</option>
                    <option value="string">String</option>
                </select>
            </div>
        </Unit>
    );
}

export class IfBlock extends UnitBlock {
    register() {
        const outputType = this.getStateValue("type", this.uuid + "-type", "float64");

        this.registerInput("condition", "boolean");
        this.registerInput("true value", outputType);
        this.registerInput("false value", outputType);
        this.registerOutput("out", outputType);
    }

    serializeState() {
        return {
            type: this.getStateValue("type", this.uuid + "-type", "float64")
        };
    }
    
    valid() {
        return this.hasInput("condition") && this.hasInput("true value") && this.hasInput("false value") && this.hasOutput("out");
    }

    execute() {
        const condition = this.getInput("condition");
        const trueValue = this.getInput("true value");
        const falseValue = this.getInput("false value");

        const outputValue = condition ? trueValue : falseValue;
        return new BlockOutput().set("out", outputValue);
    }
}