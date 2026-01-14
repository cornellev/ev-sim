import Unit from "../Unit";

export function RandomNumber({ _uuid }) {
    return (
        <Unit title="Random Number" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}