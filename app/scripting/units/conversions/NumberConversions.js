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