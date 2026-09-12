'use client';

import { setRoadNodeElevation } from "../../editor/commands/legacyCommands.js";
import { NumberField } from "../fields/NumberField";

const ELEVATION = Object.freeze({ path: ["y"], label: "Elevation", control: "number", units: "m", step: 0.05 });

function Endpoint({ data, label, node, onResult }) {
    if (!node) return null;
    const commit = (y) => {
        const result = data?.commands?.()?.execute(setRoadNodeElevation({ nodeId: node.id, y }));
        data?.simulation?.()?.render?.();
        onResult?.(result);
    };
    const selectNode = () => {
        const selection = data?.selection?.();
        if (node.junction) selection?.select?.(node.id);
        else selection?.select?.([], { sub: { kind: "road-node", id: node.id } });
        data?.simulation?.()?.render?.();
    };
    return (
        <div className="py-1">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-[var(--slate-fg-2)]">{label}</span>
                <button
                    type="button"
                    onClick={selectNode}
                    className="max-w-[60%] truncate font-mono text-[11px] text-[var(--slate-muted)] hover:text-[var(--slate-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]"
                    title={node.junction ? "Select this intersection" : "Select this endpoint"}
                >
                    {node.id}
                </button>
            </div>
            <NumberField id={`road-endpoint-${node.id}-y`} descriptor={{ ...ELEVATION, label: `${label} elevation` }} value={node.y} onCommit={commit} />
        </div>
    );
}

/** Start and end node elevations of a road; junction nodes select the intersection. */
export function RoadEndpointsSection({ data, section, onResult }) {
    return (
        <div>
            <Endpoint data={data} label="Start" node={section.start} onResult={onResult} />
            <Endpoint data={data} label="End" node={section.end} onResult={onResult} />
        </div>
    );
}
