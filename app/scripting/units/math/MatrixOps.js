import { useEffect, useRef } from "react";
import Unit from "../Unit";

export function AddMatrix({ _uuid }) {
    return (
        <Unit title="Add Matrix" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "tex2", type: "matrix a" },
                { label: "tex2", type: "matrix b" }
            ]}
            outputs={
                [
                    {label: "out", type: "tex2"}
                ]
            } >
        </Unit>
    );
}