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