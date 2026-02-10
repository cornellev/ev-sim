
import Unit from "../Unit";

export function Scale({ _uuid }) {
    return (
        <Unit title="Scale Matrix" hasOptions={false} _uuid={_uuid}
        inputs={
            [
                {label: "tex2", type: "tex2"},
                {label: "scalar", type: "float64"}
            ]
        }
        outputs={
            [
                {label: "result", type: "tex2"}
            ]
        }>
        </Unit>
    )
}