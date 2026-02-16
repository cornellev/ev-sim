import { UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function Equality({ _uuid }) {
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
            
        </Unit>
    )
}


export class EqualityBlock extends UnitBlock {
    register() {
        this.registerInput("input a", "float64");
        this.registerInput("input b", "float64");
        this.registerOutput("out", "boolean");
    }
}


export function Conjugation({ _uuid }) {
    const [type, setType] = useState("and");

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
        </Unit>
    );
}