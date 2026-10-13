"use client";

import { useState } from "react";

import { Button, DialogSurface } from "../../ui";
import { buildWheelAssignmentState, WHEEL_ASSIGNMENT_ROLES } from "./wheelAssignmentState.js";

function formatMeters(value) {
    return Number.isFinite(value) ? `${value.toFixed(3)} m` : "—";
}

function geometryText(entry) {
    if (!entry.center) return "No measurable mesh";
    return `center ${entry.center.x.toFixed(3)}, ${entry.center.y.toFixed(3)}, ${entry.center.z.toFixed(3)} · radius ${formatMeters(entry.radius)} · width ${formatMeters(entry.width)}`;
}

export function WheelAssignmentDialog({
    open,
    catalog,
    measurement,
    initialRoles,
    onOpenChange,
    onAccept,
    onSuppress,
    onCloseAutoFocus,
}) {
    const [roles, setRoles] = useState(initialRoles ?? {});
    const state = buildWheelAssignmentState({ catalog, measurement, roles });
    const setRole = (nodeIndex, role) => {
        setRoles((current) => {
            const next = { ...current, [nodeIndex]: role };
            if (role !== "unassigned") {
                for (const [key, value] of Object.entries(next)) {
                    if (Number(key) !== nodeIndex && value === role) next[key] = "unassigned";
                }
            }
            return next;
        });
    };
    const clearPair = (pair) => {
        setRoles((current) => {
            const next = { ...current };
            if (pair.leftNodeIndex != null) next[pair.leftNodeIndex] = "unassigned";
            if (pair.rightNodeIndex != null) next[pair.rightNodeIndex] = "unassigned";
            return next;
        });
    };
    return (
        <DialogSurface
            open={open}
            onOpenChange={onOpenChange}
            title="Assign wheels"
            description="Bind model nodes to the front and rear axles. The name shown here is the glTF node name."
            onCloseAutoFocus={onCloseAutoFocus}
            className="max-w-xl"
            footer={(
                <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button
                        variant="primary"
                        disabled={!state.ready}
                        onClick={() => onAccept(state.pairs.filter((pair) => pair.withinTolerance))}
                    >
                        Accept assignment
                    </Button>
                </div>
            )}
        >
            <div role="listbox" aria-label="Model nodes" className="space-y-2">
                {state.entries.map((entry) => (
                    <div key={entry.nodeIndex} role="option" aria-selected={entry.role !== "unassigned"} className="grid grid-cols-[minmax(0,1fr)_9rem] gap-2 border border-[var(--slate-border)] p-2">
                        <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-[var(--slate-fg)]">{entry.name}</p>
                            <p className="truncate text-[11px] text-[var(--slate-muted)]">{entry.path || `Node ${entry.nodeIndex}`}</p>
                            <p className="mt-1 text-[11px] text-[var(--slate-fg-2)]">{geometryText(entry)}</p>
                        </div>
                        <label className="text-[11px] text-[var(--slate-muted)]">
                            Role
                            <select
                                aria-label={`Role for ${entry.name}`}
                                className="sf-input mt-1"
                                value={entry.role}
                                onChange={(event) => setRole(entry.nodeIndex, event.target.value)}
                            >
                                {WHEEL_ASSIGNMENT_ROLES.map((role) => (
                                    <option key={role.id} value={role.id}>{role.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                ))}
            </div>
            {state.messages.length > 0 && (
                <ul className="mt-3 space-y-1">
                    {state.messages.map((message) => (
                        <li key={message} className="text-[11px] text-[var(--slate-danger)]">{message}</li>
                    ))}
                </ul>
            )}
            {state.outOfTolerance.map((pair) => (
                <div key={pair.axle} className="mt-3 border border-[var(--slate-border)] p-2">
                    <p className="text-[12px] text-[var(--slate-fg)]">The {pair.axle} parts are outside axle tolerance.</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="compact" onClick={() => onOpenChange(false)}>Correct the source</Button>
                        <Button size="compact" onClick={() => clearPair(pair)}>Choose different parts</Button>
                        <Button
                            size="compact"
                            onClick={() => onSuppress([pair.leftNodeIndex, pair.rightNodeIndex].filter((index) => index != null))}
                        >
                            Hide parts and add generated wheels
                        </Button>
                    </div>
                </div>
            ))}
        </DialogSurface>
    );
}

export function PlacementAcceptanceDialog({
    open,
    review,
    onAccept,
    onReject,
    onCloseAutoFocus,
}) {
    const axles = review?.axles ?? [];
    return (
        <DialogSurface
            open={open}
            onOpenChange={(next) => { if (!next) onReject(); }}
            title="Accept wheel adjustments"
            description="The new placement stays within tolerance. The bound wheels will take the measured positions."
            onCloseAutoFocus={onCloseAutoFocus}
            footer={(
                <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" onClick={onReject}>Keep current placement</Button>
                    <Button variant="primary" onClick={onAccept}>Accept adjustments</Button>
                </div>
            )}
        >
            <ul className="space-y-1">
                {axles.map((entry) => (
                    <li key={entry.axle} className="text-[12px] text-[var(--slate-fg)]">
                        {entry.axle} wheels move {Number.isFinite(entry.movement) ? `${entry.movement.toFixed(6)} m` : "pending"}
                    </li>
                ))}
            </ul>
        </DialogSurface>
    );
}
