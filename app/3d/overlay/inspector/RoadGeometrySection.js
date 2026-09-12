'use client';

import { useState } from "react";
import { Button } from "../../../ui";
import {
    connectRoadEndpoint,
    convertRoadGeometry,
    detachRoadEndpoint,
    insertRoadKnot,
    removeRoadKnot,
    setRoadKnot,
    splitRoad,
} from "../../editor/commands/roadCommands.js";
import { resolveRoadEdge } from "../../../roads/RoadGeometryRecord.js";
import { Vector3Field } from "../fields/Vector3Field";

const POSITION = Object.freeze({ path: ["position"], label: "Knot position", control: "vector3", units: "m", step: 0.1 });

export function RoadGeometrySection({ data, section, onResult }) {
    const [targetNodeId, setTargetNodeId] = useState("");
    const [targetEdgeId, setTargetEdgeId] = useState("");
    const [span, setSpan] = useState(0);
    const [u, setU] = useState(0.5);
    const document = data?.environment?.()?.getDocument?.();
    const edge = document?.getEdge?.(section.edgeId);
    if (!edge) return null;
    const v2 = Number(document.roads?.geometryVersion ?? 1) === 2 && edge.geometry;
    const selection = data?.selection?.();
    const sub = selection?.sub?.edgeId === edge.id ? selection.sub : null;
    const run = (command) => {
        const result = data?.commands?.()?.execute(command);
        data?.simulation?.()?.render?.();
        onResult?.(result);
        return result;
    };
    const at = { span: Math.max(0, Math.trunc(Number(span) || 0)), u: Math.max(0.001, Math.min(0.999, Number(u) || 0.5)) };
    const resolved = v2 ? resolveRoadEdge(edge, document.index().nodes) : null;
    const knot = sub?.knotId ? resolved?.geometry?.knots?.find((value) => value.id === sub.knotId) : null;
    const authorKnot = sub?.knotId ? edge.geometry?.knots?.find((value) => value.id === sub.knotId) : null;
    const chooseKnot = (value) => selection?.select?.(edge.id, { mode: "replace", sub: { kind: "road-knot", edgeId: edge.id, knotId: value.id } });
    return (
        <div className="space-y-2 py-1 text-[12px]">
            <div className="flex flex-wrap gap-1">
                <Button size="compact" variant="ghost" onClick={() => run(convertRoadGeometry({ edgeId: edge.id, kind: v2 && edge.geometry.kind === "cubic-bezier" ? "polyline" : "cubic-bezier" }))}>
                    {v2 && edge.geometry.kind === "cubic-bezier" ? "Convert to polyline" : "Convert to Bézier"}
                </Button>
                {v2 && <Button size="compact" variant="ghost" onClick={() => run(insertRoadKnot({ edgeId: edge.id, at }))}>Insert knot</Button>}
                {v2 && <Button size="compact" variant="ghost" onClick={() => run(splitRoad({ edgeId: edge.id, at }))}>Split</Button>}
            </div>
            {v2 && (
                <div className="grid grid-cols-2 gap-1">
                    <label>Span<input aria-label="Road span" type="number" min="0" step="1" value={span} onChange={(event) => setSpan(event.target.value)} className="mt-0.5 w-full rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1" /></label>
                    <label>Fraction<input aria-label="Road span fraction" type="number" min="0.001" max="0.999" step="0.05" value={u} onChange={(event) => setU(event.target.value)} className="mt-0.5 w-full rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1" /></label>
                </div>
            )}
            {v2 && (
                <div>
                    <p className="mb-1 text-[11px] text-[var(--slate-muted)]">Knots</p>
                    <div className="flex flex-wrap gap-1">
                        {edge.geometry.knots.map((value) => <Button key={value.id} size="compact" variant={sub?.knotId === value.id ? "primary" : "ghost"} onClick={() => chooseKnot(value)}>{value.id}</Button>)}
                    </div>
                </div>
            )}
            {knot && (
                <div className="space-y-1 border-t border-[var(--slate-border-60)] pt-2">
                    <Vector3Field id={`road-knot-${edge.id}-${knot.id}`} descriptor={POSITION} value={knot.position} onCommit={(position) => run(setRoadKnot({ edgeId: edge.id, knotId: knot.id, patch: { position } }))} />
                    {edge.geometry.kind === "cubic-bezier" && (
                        <label className="flex items-center justify-between gap-2">Handle mode
                            <select value={authorKnot?.mode ?? "auto"} onChange={(event) => run(setRoadKnot({ edgeId: edge.id, knotId: knot.id, patch: { mode: event.target.value } }))} className="rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-1 py-0.5">
                                <option value="auto">Auto</option><option value="aligned">Aligned</option><option value="free">Free</option>
                            </select>
                        </label>
                    )}
                    {!['start', 'end'].includes(knot.id) && <Button size="compact" variant="danger" onClick={() => run(removeRoadKnot({ edgeId: edge.id, knotId: knot.id }))}>Remove knot</Button>}
                </div>
            )}
            {v2 && (
                <div className="space-y-1 border-t border-[var(--slate-border-60)] pt-2">
                    <div className="flex gap-1"><Button size="compact" variant="ghost" onClick={() => run(detachRoadEndpoint({ edgeId: edge.id, end: "start" }))}>Detach start</Button><Button size="compact" variant="ghost" onClick={() => run(detachRoadEndpoint({ edgeId: edge.id, end: "end" }))}>Detach end</Button></div>
                    <input aria-label="Target road node ID" placeholder="Target node ID" value={targetNodeId} onChange={(event) => setTargetNodeId(event.target.value)} className="w-full rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1" />
                    <input aria-label="Target road edge ID" placeholder="Or target edge ID" value={targetEdgeId} onChange={(event) => setTargetEdgeId(event.target.value)} className="w-full rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1" />
                    <div className="flex gap-1"><Button size="compact" variant="ghost" disabled={!targetNodeId && !targetEdgeId} onClick={() => run(connectRoadEndpoint({ edgeId: edge.id, end: "start", target: targetNodeId ? { nodeId: targetNodeId } : { edgeId: targetEdgeId, at } }))}>Connect start</Button><Button size="compact" variant="ghost" disabled={!targetNodeId && !targetEdgeId} onClick={() => run(connectRoadEndpoint({ edgeId: edge.id, end: "end", target: targetNodeId ? { nodeId: targetNodeId } : { edgeId: targetEdgeId, at } }))}>Connect end</Button></div>
                </div>
            )}
        </div>
    );
}
