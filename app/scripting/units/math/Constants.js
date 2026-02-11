import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function PI({ _uuid }) {
    return (
        <Unit title="PI" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

export class PIBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", Math.PI);
    }
}

export function E({ _uuid }) {
    return (
        <Unit title="E" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

export class EBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", Math.E);
    }
}

export function Tau({ _uuid }) {
    return (
        <Unit title="Tau" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

export class TauBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", 2 * Math.PI);
    }
}

export function GoldenRatio({ _uuid }) {
    return (
        <Unit title="Golden Ratio" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

export class GoldenRatioBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", (1 + Math.sqrt(5)) / 2);
    }
}