import { useEffect, useState } from "react";
import { requestUnitReconfiguration, storeData } from "../../ScriptManager";
import Unit from "../Unit";
import { ARRAY_ITEM_TYPES, normalizeItemType } from "../valueOps.js";
import {
    arrayAppendPorts,
    arrayConcatPorts,
    arrayContainsPorts,
    arrayGetPorts,
    arrayLengthPorts,
    arrayLiteralPorts,
    arraySetPorts,
    arraySlicePorts,
    LINSPACE_PORTS,
} from "./ArrayBlocks.block.js";

const CONTROL_CLASS = "w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";
const LABEL_CLASS = "flex flex-col gap-1 text-xs text-zinc-300";

function jsonToText(value) {
    if (value === undefined) return "[]";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return "[]";
    }
}

function parseFallback(text) {
    const trimmed = String(text ?? "").trim();
    if (trimmed.length === 0) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return text;
    }
}

function TypeField({ value, onChange }) {
    return (
        <label className={LABEL_CLASS}>
            <span>Item type</span>
            <select value={value} className={CONTROL_CLASS} onChange={(event) => onChange(event.target.value)}>
                {ARRAY_ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                ))}
            </select>
        </label>
    );
}

function ItemTypeUnit({ _uuid, title, initialState = {}, extras, portsFor, extraFields }) {
    const [data, setData] = useState(() => ({
        itemType: normalizeItemType(initialState.itemType),
        ...extras?.(initialState),
    }));

    const commit = (patch) => {
        const next = {
            itemType: normalizeItemType(patch.itemType ?? data.itemType),
            ...extras?.({ ...data, ...patch }),
        };
        const result = requestUnitReconfiguration(_uuid, { state: next });
        if (result.ok) setData(next);
        return result;
    };

    const ports = portsFor(data);
    return (
        <Unit
            title={title}
            hasOptions={true}
            _uuid={_uuid}
            inputs={[...ports.inputs]}
            outputs={[...ports.outputs]}
        >
            <div className="flex flex-col gap-3 text-xs text-zinc-300">
                <TypeField value={data.itemType} onChange={(itemType) => commit({ itemType })} />
                {extraFields?.(data, commit)}
            </div>
        </Unit>
    );
}

export function ArrayLiteralUnit({ _uuid, initialData = [], initialState = {} }) {
    const [itemType, setItemType] = useState(() => normalizeItemType(initialState.itemType));
    const [text, setText] = useState(() => jsonToText(initialData ?? []));

    useEffect(() => {
        try {
            storeData(_uuid, text.trim() === "" ? [] : JSON.parse(text));
        } catch {
            // Keep the last valid stored array until the textarea parses.
        }
    }, [text, _uuid]);

    const commitType = (nextType) => {
        const normalized = normalizeItemType(nextType);
        const result = requestUnitReconfiguration(_uuid, { state: { itemType: normalized } });
        if (result.ok) setItemType(normalized);
    };

    const ports = arrayLiteralPorts({ itemType });
    return (
        <Unit
            title="Array Literal"
            hasOptions={true}
            _uuid={_uuid}
            inputs={[...ports.inputs]}
            outputs={[...ports.outputs]}
        >
            <div className="flex flex-col gap-3 text-xs text-zinc-300">
                <TypeField value={itemType} onChange={commitType} />
                <label className={LABEL_CLASS}>
                    <span>Items</span>
                    <textarea
                        value={text}
                        className={`${CONTROL_CLASS} min-h-[4.5rem] resize-y font-mono text-[11px]`}
                        onChange={(event) => setText(event.target.value)}
                    />
                </label>
            </div>
        </Unit>
    );
}

export function ArrayLengthUnit(props) {
    return (
        <ItemTypeUnit
            {...props}
            title="Array Length"
            portsFor={arrayLengthPorts}
        />
    );
}

export function ArrayGetUnit(props) {
    return (
        <ItemTypeUnit
            {...props}
            title="Array Get"
            extras={(state) => ({
                fallback: Object.prototype.hasOwnProperty.call(state, "fallback") ? state.fallback : null,
            })}
            portsFor={arrayGetPorts}
            extraFields={(data, commit) => (
                <label className={LABEL_CLASS}>
                    <span>Fallback</span>
                    <textarea
                        value={jsonToText(data.fallback)}
                        className={`${CONTROL_CLASS} min-h-[4.5rem] resize-y font-mono text-[11px]`}
                        onChange={(event) => commit({ fallback: parseFallback(event.target.value) })}
                    />
                </label>
            )}
        />
    );
}

export function ArraySetUnit(props) {
    return <ItemTypeUnit {...props} title="Array Set" portsFor={arraySetPorts} />;
}

export function ArrayAppendUnit(props) {
    return <ItemTypeUnit {...props} title="Array Append" portsFor={arrayAppendPorts} />;
}

export function ArrayConcatUnit(props) {
    return <ItemTypeUnit {...props} title="Array Concat" portsFor={arrayConcatPorts} />;
}

export function ArraySliceUnit(props) {
    return <ItemTypeUnit {...props} title="Array Slice" portsFor={arraySlicePorts} />;
}

export function ArrayContainsUnit(props) {
    return <ItemTypeUnit {...props} title="Array Contains" portsFor={arrayContainsPorts} />;
}

export function LinspaceUnit({ _uuid }) {
    return (
        <Unit
            title="Linspace"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[...LINSPACE_PORTS.inputs]}
            outputs={[...LINSPACE_PORTS.outputs]}
        />
    );
}

export {
    ArrayAppendBlock,
    ArrayConcatBlock,
    ArrayContainsBlock,
    ArrayGetBlock,
    ArrayLengthBlock,
    ArrayLiteralBlock,
    ArraySetBlock,
    ArraySliceBlock,
    LinspaceBlock,
} from "./ArrayBlocks.block.js";
