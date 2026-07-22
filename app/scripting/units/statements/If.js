import { useState } from "react";
import { reregister } from "../../ScriptManager";
import Unit from "../Unit";

export function IfUnit({ _uuid, initialState = {} }) {
    const [outputType, setOutputType] = useState(() => initialState.type || "float64");

    const onChange = (e) => {
        const type = e.target.value;
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
                <select
                    value={outputType}
                    onChange={onChange}
                    id={_uuid + "-type"}
                    className="w-full px-2 py-1 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:border-blue-500 hover:border-gray-400"
                >
                    <option value="float64">Float64</option>
                    <option value="int32">Int32</option>
                    <option value="boolean">Boolean</option>
                    <option value="string">String</option>
                </select>
            </div>
        </Unit>
    );
}
export { IfBlock } from "./If.block.js";
