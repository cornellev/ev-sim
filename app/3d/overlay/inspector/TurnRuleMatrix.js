'use client';

import { setTurnRule } from "../../editor/commands/legacyCommands.js";

function shortId(value) {
    const text = String(value ?? "");
    return text.length <= 18 ? text : `${text.slice(0, 10)}...${text.slice(-4)}`;
}

/** Allowed-movement matrix for a junction: incoming roads are rows, outgoing roads are columns. */
export function TurnRuleMatrix({ data, section, onResult }) {
    const { movements, nodeId, connectedRoads } = section;
    const setAllowed = (fromEdgeId, toEdgeId, allowed) => {
        const result = data?.commands?.()?.execute(setTurnRule({ nodeId, fromEdgeId, toEdgeId, allowed }));
        data?.simulation?.()?.render?.();
        onResult?.(result);
    };
    return (
        <div>
            <p className="mb-1.5 text-[11px] text-[var(--slate-muted)]">
                {connectedRoads} connected road{connectedRoads === 1 ? "" : "s"}. Incoming roads are rows; outgoing roads are columns.
            </p>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11px]" data-intersection-movement-matrix>
                    <thead>
                        <tr>
                            <th scope="col" className="p-1 text-left font-medium text-[var(--slate-muted)]">From ↓ / To →</th>
                            {movements.incident.map((edge) => (
                                <th key={`to-${edge.id}`} scope="col" className="p-1 font-mono font-medium text-[var(--slate-fg-2)]" title={edge.id}>
                                    {shortId(edge.id)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {movements.incident.map((fromEdge) => (
                            <tr key={`from-${fromEdge.id}`}>
                                <th scope="row" className="p-1 text-left font-mono font-medium text-[var(--slate-fg-2)]" title={fromEdge.id}>
                                    {shortId(fromEdge.id)}
                                </th>
                                {movements.incident.map((toEdge) => {
                                    const cell = movements.cells.find((candidate) => candidate.fromEdgeId === fromEdge.id && candidate.toEdgeId === toEdge.id);
                                    return (
                                        <td key={`${fromEdge.id}-${toEdge.id}`} className="p-1 text-center">
                                            <input
                                                type="checkbox"
                                                aria-label={`Allow movement from ${fromEdge.id} to ${toEdge.id}`}
                                                checked={cell?.allowed === true}
                                                disabled={!cell}
                                                data-overridden={cell?.overridden || undefined}
                                                onChange={(event) => setAllowed(fromEdge.id, toEdge.id, event.target.checked)}
                                                className="h-3.5 w-3.5 accent-[var(--slate-fg)] disabled:opacity-25"
                                            />
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
