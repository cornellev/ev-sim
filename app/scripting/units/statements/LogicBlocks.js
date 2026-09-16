import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";
import Unit from "../Unit";
import {
    LOGIC_BLOCK_PORTS,
} from "./LogicBlocks.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

function compareUnit(title, ports) {
    function CompareUnit({ _uuid, portTypes = {} }) {
        const inputs = ports.inputs.map((port) => ({
            ...port,
            type: portTypes.inputs?.[port.label] || port.type,
        }));
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={inputs}
                outputs={[...ports.outputs]}
            />
        );
    }
    CompareUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return CompareUnit;
}

export function BooleanUnit({ _uuid, initialData = false }) {
    const [value, setValue] = useState(() => initialData ?? false);

    useEffect(() => {
        storeData(_uuid, value === true);
    }, [value, _uuid]);

    return (
        <Unit
            title="Boolean"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[]}
            outputs={[...LOGIC_BLOCK_PORTS.BooleanBlock.outputs]}
        >
            <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input
                    type="checkbox"
                    checked={value === true}
                    id={_uuid + "-input"}
                    onChange={(event) => setValue(event.target.checked)}
                />
                {value === true ? "true" : "false"}
            </label>
        </Unit>
    );
}

export const NotUnit = staticPortsUnit("Not", LOGIC_BLOCK_PORTS.NotBlock);
export const AndUnit = staticPortsUnit("And", LOGIC_BLOCK_PORTS.AndBlock);
export const OrUnit = staticPortsUnit("Or", LOGIC_BLOCK_PORTS.OrBlock);
export const XorUnit = staticPortsUnit("Xor", LOGIC_BLOCK_PORTS.XorBlock);
export const EqualUnit = compareUnit("Equal", LOGIC_BLOCK_PORTS.EqualBlock);
export const NotEqualUnit = compareUnit("Not Equal", LOGIC_BLOCK_PORTS.NotEqualBlock);
export const LessUnit = compareUnit("Less", LOGIC_BLOCK_PORTS.LessBlock);
export const LessEqualUnit = compareUnit("Less Equal", LOGIC_BLOCK_PORTS.LessEqualBlock);
export const GreaterUnit = compareUnit("Greater", LOGIC_BLOCK_PORTS.GreaterBlock);
export const GreaterEqualUnit = compareUnit("Greater Equal", LOGIC_BLOCK_PORTS.GreaterEqualBlock);
export const NearlyEqualUnit = staticPortsUnit("Nearly Equal", LOGIC_BLOCK_PORTS.NearlyEqualBlock);
export const IsFiniteUnit = staticPortsUnit("Is Finite", LOGIC_BLOCK_PORTS.IsFiniteBlock);

export {
    AndBlock,
    BooleanBlock,
    EqualBlock,
    GreaterBlock,
    GreaterEqualBlock,
    IsFiniteBlock,
    LessBlock,
    LessEqualBlock,
    NearlyEqualBlock,
    NotBlock,
    NotEqualBlock,
    OrBlock,
    XorBlock,
} from "./LogicBlocks.block.js";
