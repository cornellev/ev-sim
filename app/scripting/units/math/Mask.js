import { useEffect, useRef } from "react";
import Unit from "../Unit";

export function Mask({ _uuid }) {
    return (
        <Unit title="Mask" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "tex2", type: "tex2" },
                { label: "mask", type: "float64" }
            ]}
            outputs={
                [
                    {label: "out", type: "tex2"}
                ]
            } >
        </Unit>
    );
}