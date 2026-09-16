import { useState } from "react";
import { requestUnitReconfiguration } from "../../ScriptManager";
import Unit from "../Unit";
import { ARRAY_ITEM_TYPES, normalizeItemType } from "../valueOps.js";
import {
    JSON_BLOCK_PORTS,
    jsonGetPorts,
    jsonSetPorts,
    normalizeJsonPath,
} from "./JsonBlocks.block.js";

const CONTROL_CLASS = "w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 hover:border-white/20 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";
const LABEL_CLASS = "flex flex-col gap-1 text-xs text-zinc-300";

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

function jsonToText(value) {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return "";
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

function PathField({ value, onChange }) {
    return (
        <label className={LABEL_CLASS}>
            <span>Path</span>
            <input
                value={value}
                className={CONTROL_CLASS}
                onChange={(event) => onChange(event.target.value)}
                placeholder="items.0.name"
            />
        </label>
    );
}

function TypeField({ value, onChange }) {
    return (
        <label className={LABEL_CLASS}>
            <span>Value type</span>
            <select value={value} className={CONTROL_CLASS} onChange={(event) => onChange(event.target.value)}>
                {ARRAY_ITEM_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                ))}
            </select>
        </label>
    );
}

function PathTypeUnit({ _uuid, title, initialState = {}, defaults, portsFor, children }) {
    const [data, setData] = useState(() => defaults(initialState));

    const commit = (patch) => {
        const next = defaults({ ...data, ...patch });
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
                {children(data, commit)}
            </div>
        </Unit>
    );
}

export function JsonGetUnit({ _uuid, initialState = {} }) {
    return (
        <PathTypeUnit
            _uuid={_uuid}
            title="JSON Get"
            initialState={initialState}
            defaults={(state) => ({
                path: normalizeJsonPath(state.path),
                valueType: normalizeItemType(state.valueType, "json"),
                fallback: Object.prototype.hasOwnProperty.call(state, "fallback") ? state.fallback : null,
            })}
            portsFor={jsonGetPorts}
        >
            {(data, commit) => (
                <>
                    <PathField value={data.path} onChange={(path) => commit({ path })} />
                    <TypeField value={data.valueType} onChange={(valueType) => commit({ valueType })} />
                    <label className={LABEL_CLASS}>
                        <span>Fallback</span>
                        <textarea
                            value={jsonToText(data.fallback)}
                            className={`${CONTROL_CLASS} min-h-[4.5rem] resize-y font-mono text-[11px]`}
                            onChange={(event) => commit({ fallback: parseFallback(event.target.value) })}
                        />
                    </label>
                </>
            )}
        </PathTypeUnit>
    );
}

export function JsonSetUnit({ _uuid, initialState = {} }) {
    return (
        <PathTypeUnit
            _uuid={_uuid}
            title="JSON Set"
            initialState={initialState}
            defaults={(state) => ({
                path: normalizeJsonPath(state.path),
                valueType: normalizeItemType(state.valueType, "json"),
            })}
            portsFor={jsonSetPorts}
        >
            {(data, commit) => (
                <>
                    <PathField value={data.path} onChange={(path) => commit({ path })} />
                    <TypeField value={data.valueType} onChange={(valueType) => commit({ valueType })} />
                </>
            )}
        </PathTypeUnit>
    );
}

export function JsonHasUnit({ _uuid, initialState = {} }) {
    return (
        <PathTypeUnit
            _uuid={_uuid}
            title="JSON Has"
            initialState={initialState}
            defaults={(state) => ({ path: normalizeJsonPath(state.path) })}
            portsFor={() => JSON_BLOCK_PORTS.JsonHasBlock}
        >
            {(data, commit) => (
                <PathField value={data.path} onChange={(path) => commit({ path })} />
            )}
        </PathTypeUnit>
    );
}

export function JsonDeleteUnit({ _uuid, initialState = {} }) {
    return (
        <PathTypeUnit
            _uuid={_uuid}
            title="JSON Delete"
            initialState={initialState}
            defaults={(state) => ({ path: normalizeJsonPath(state.path) })}
            portsFor={() => JSON_BLOCK_PORTS.JsonDeleteBlock}
        >
            {(data, commit) => (
                <PathField value={data.path} onChange={(path) => commit({ path })} />
            )}
        </PathTypeUnit>
    );
}

export const JsonMergeUnit = staticPortsUnit("JSON Merge", JSON_BLOCK_PORTS.JsonMergeBlock);

export {
    JsonDeleteBlock,
    JsonGetBlock,
    JsonHasBlock,
    JsonMergeBlock,
    JsonSetBlock,
} from "./JsonBlocks.block.js";
