import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";

const { default: Unit } = require("../Unit")

export default function NumberUnit(props) {
    const [value, setValue] = useState(() => props.initialData ?? 0);

    useEffect(() => {
        if (value === "" || isNaN(value)) {
            return;
        }

        const numericValue = parseFloat(value);
        if (isNaN(numericValue)) {
            return;
        }

        storeData(props._uuid, numericValue);
    }, [value, props._uuid])

    return (
        <Unit title="Number" outputs={[
            {
                label: "number",
                type: "float64"
            }
        ]} hasOptions={true} _uuid={props._uuid}>
            <input
                value={isNaN(value) ? "" : value}
                className="w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                id={props._uuid + "-input"}
                type="number"
                onChange={(e) => setValue(parseFloat(e.target.value))}
            />
        </Unit>
    )
}
export { NumberUnitClass } from "./Number.block.js";
