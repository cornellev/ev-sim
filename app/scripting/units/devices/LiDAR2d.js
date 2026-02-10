import { useEffect, useRef } from "react";
import Unit from "../Unit";

export function LiDAR2DUnit({ _uuid }) {
    return (
        <Unit title="LiDAR 2D Device" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "tex2"}
                ]
            } >
        </Unit>
    );
}