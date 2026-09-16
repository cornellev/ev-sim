import { useEffect, useState } from "react";
import { storeData } from "../../ScriptManager";
import Unit from "../Unit";
import { finiteInt32 } from "../../types/PortTypes";
import {
    SCALAR_BLOCK_PORTS,
} from "./ScalarBlocks.block.js";

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

export function IntegerUnit({ _uuid, initialData = 0 }) {
    const [value, setValue] = useState(() => initialData ?? 0);

    useEffect(() => {
        if (value === "" || Number.isNaN(value)) return;
        const numericValue = Number.parseFloat(value);
        if (Number.isNaN(numericValue)) return;
        storeData(_uuid, finiteInt32(numericValue));
    }, [value, _uuid]);

    return (
        <Unit
            title="Integer"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[]}
            outputs={[...SCALAR_BLOCK_PORTS.IntegerBlock.outputs]}
        >
            <input
                value={Number.isNaN(value) ? "" : value}
                className="w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                id={_uuid + "-input"}
                type="number"
                step="1"
                onChange={(event) => setValue(Number.parseFloat(event.target.value))}
            />
        </Unit>
    );
}

function jsonToText(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return "";
    }
}

export function JsonUnit({ _uuid, initialData = null }) {
    const [text, setText] = useState(() => jsonToText(initialData ?? null));

    useEffect(() => {
        try {
            storeData(_uuid, text.trim() === "" ? null : JSON.parse(text));
        } catch {
            // Keep the last valid stored JSON until the textarea parses.
        }
    }, [text, _uuid]);

    return (
        <Unit
            title="JSON"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[]}
            outputs={[...SCALAR_BLOCK_PORTS.JsonBlock.outputs]}
        >
            <textarea
                value={text}
                className="min-h-[4.5rem] w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 font-mono text-[11px] text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30"
                id={_uuid + "-input"}
                onChange={(event) => setText(event.target.value)}
            />
        </Unit>
    );
}

export const AddUnit = staticPortsUnit("Add", SCALAR_BLOCK_PORTS.AddBlock);
export const SubtractUnit = staticPortsUnit("Subtract", SCALAR_BLOCK_PORTS.SubtractBlock);
export const MultiplyUnit = staticPortsUnit("Multiply", SCALAR_BLOCK_PORTS.MultiplyBlock);
export const DivideUnit = staticPortsUnit("Divide", SCALAR_BLOCK_PORTS.DivideBlock);
export const ModuloUnit = staticPortsUnit("Modulo", SCALAR_BLOCK_PORTS.ModuloBlock);
export const PowerUnit = staticPortsUnit("Power", SCALAR_BLOCK_PORTS.PowerBlock);
export const MinimumUnit = staticPortsUnit("Minimum", SCALAR_BLOCK_PORTS.MinimumBlock);
export const MaximumUnit = staticPortsUnit("Maximum", SCALAR_BLOCK_PORTS.MaximumBlock);
export const NegateUnit = staticPortsUnit("Negate", SCALAR_BLOCK_PORTS.NegateBlock);
export const AbsoluteUnit = staticPortsUnit("Absolute", SCALAR_BLOCK_PORTS.AbsoluteBlock);
export const SignUnit = staticPortsUnit("Sign", SCALAR_BLOCK_PORTS.SignBlock);
export const SquareRootUnit = staticPortsUnit("Square Root", SCALAR_BLOCK_PORTS.SquareRootBlock);
export const ExponentialUnit = staticPortsUnit("Exponential", SCALAR_BLOCK_PORTS.ExponentialBlock);
export const NaturalLogUnit = staticPortsUnit("Natural Log", SCALAR_BLOCK_PORTS.NaturalLogBlock);
export const Log10Unit = staticPortsUnit("Log10", SCALAR_BLOCK_PORTS.Log10Block);
export const ClampUnit = staticPortsUnit("Clamp", SCALAR_BLOCK_PORTS.ClampBlock);
export const LerpUnit = staticPortsUnit("Lerp", SCALAR_BLOCK_PORTS.LerpBlock);
export const InverseLerpUnit = staticPortsUnit("Inverse Lerp", SCALAR_BLOCK_PORTS.InverseLerpBlock);
export const SmoothstepUnit = staticPortsUnit("Smoothstep", SCALAR_BLOCK_PORTS.SmoothstepBlock);
export const DeadbandUnit = staticPortsUnit("Deadband", SCALAR_BLOCK_PORTS.DeadbandBlock);
export const SinUnit = staticPortsUnit("Sin", SCALAR_BLOCK_PORTS.SinBlock);
export const CosUnit = staticPortsUnit("Cos", SCALAR_BLOCK_PORTS.CosBlock);
export const TanUnit = staticPortsUnit("Tan", SCALAR_BLOCK_PORTS.TanBlock);
export const AsinUnit = staticPortsUnit("Asin", SCALAR_BLOCK_PORTS.AsinBlock);
export const AcosUnit = staticPortsUnit("Acos", SCALAR_BLOCK_PORTS.AcosBlock);
export const AtanUnit = staticPortsUnit("Atan", SCALAR_BLOCK_PORTS.AtanBlock);
export const DegreesToRadiansUnit = staticPortsUnit("Degrees to Radians", SCALAR_BLOCK_PORTS.DegreesToRadiansBlock);
export const RadiansToDegreesUnit = staticPortsUnit("Radians to Degrees", SCALAR_BLOCK_PORTS.RadiansToDegreesBlock);
export const WrapRadiansUnit = staticPortsUnit("Wrap Radians", SCALAR_BLOCK_PORTS.WrapRadiansBlock);
export const Atan2Unit = staticPortsUnit("Atan2", SCALAR_BLOCK_PORTS.Atan2Block);

export {
    AbsoluteBlock,
    AcosBlock,
    AddBlock,
    AsinBlock,
    Atan2Block,
    AtanBlock,
    ClampBlock,
    CosBlock,
    DeadbandBlock,
    DegreesToRadiansBlock,
    DivideBlock,
    ExponentialBlock,
    IntegerBlock,
    InverseLerpBlock,
    JsonBlock,
    LerpBlock,
    Log10Block,
    MaximumBlock,
    MinimumBlock,
    ModuloBlock,
    MultiplyBlock,
    NaturalLogBlock,
    NegateBlock,
    PowerBlock,
    RadiansToDegreesBlock,
    SignBlock,
    SinBlock,
    SmoothstepBlock,
    SquareRootBlock,
    SubtractBlock,
    TanBlock,
    WrapRadiansBlock,
} from "./ScalarBlocks.block.js";
