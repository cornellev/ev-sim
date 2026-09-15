import Unit from "../Unit";

export function IfUnit({ _uuid, portTypes = {} }) {
    const trueType = portTypes.inputs?.["true value"] || "generic";
    const falseType = portTypes.inputs?.["false value"] || "generic";
    const outType = portTypes.outputs?.out || "generic";

    return (
        <Unit title="If" hasOptions={false} _uuid={_uuid}
            inputs={[
                {label: "condition", type: "boolean"},
                {label: "true value", type: trueType},
                {label: "false value", type: falseType}
            ]}
            outputs={[
                {label: "out", type: outType}
            ]}
        />
    );
}
export { IfBlock } from "./If.block.js";
