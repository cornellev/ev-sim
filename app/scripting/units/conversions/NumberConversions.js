import { UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function Float64ToInt32({ _uuid }) {
    return (
        <Unit title="Float64 to Int32" hasOptions={false} _uuid={_uuid}
            inputs={
                [
                    {label: "in", type: "float64"}
                ]
            }
            outputs={
                [
                    {label: "out", type: "int32"}
                ]
            }>
        </Unit>
    );
}

export class Float64ToInt32Block extends UnitBlock {
    register() {
        this.registerInput("in", "float64");
        this.registerOutput("out", "int32");
    }

    valid() {
        return this.hasInput("in") && this.hasOutput("out");
    }

    execute() {
        const inputValue = this.getInput("in");
        const outputValue = Math.floor(inputValue); // simple conversion, can be improved with error handling
        return new BlockOutput().set("out", outputValue);
    }
}

export function Int32ToFloat64({ _uuid }) {
    return (
        <Unit title="Int32 to Float64" hasOptions={false} _uuid={_uuid}
            inputs={
                [
                    {label: "in", type: "int32"}
                ]
            }
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

export class Int32ToFloat64Block extends UnitBlock {
    register() {
        this.registerInput("in", "int32");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("in") && this.hasOutput("out");
    }

    execute() {
        const inputValue = this.getInput("in");
        const outputValue = Number(inputValue); // simple conversion, can be improved with error handling
        return new BlockOutput().set("out", outputValue);
    }
}