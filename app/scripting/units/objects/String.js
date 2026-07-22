import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";
import Unit from "../Unit";

export function StringUnit({ _uuid, initialData = "" }) {
    const [value, setValue] = useState(() => initialData ?? "");

    useEffect(() => {
        storeData(_uuid, value);
    }, [value, _uuid])

    return (
        <Unit title="String" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "string"}
                ]
            }>
            <input type="text" value={value} className="w-full p-2 border border-gray-300 rounded" onChange={(e) => setValue(e.target.value)} />
        </Unit>
    )
}
export { StringBlock } from "./String.block.js";
