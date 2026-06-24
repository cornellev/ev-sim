import { useEffect, useState } from "react";
import { BlockOutput, storeData, UnitBlock } from "../../ScriptManager";
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

export class StringBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "string");
    }

    valid() {
        return this.hasOutput("out");
    }

    execute() {
        const value = this.getStoredData() || "";
        return new BlockOutput().set("out", value);
    }
}
