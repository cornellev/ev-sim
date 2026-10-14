'use client';

import { useState } from "react";
import { Button, DialogSurface, Field } from "../../../ui";
import { isValidVehicleId } from "../../VehicleManifest.js";

function nextCopyId(baseId, existing) {
    let id = baseId;
    let suffix = 2;
    while (existing.has(id)) id = `${baseId}-${suffix++}`;
    return id;
}

export function VehiclePickerDialog({
    open,
    onOpenChange,
    vehicles,
    selectedId,
    dirty,
    busy,
    onOpenVehicle,
    onCreateBlank,
    onImportBundle,
    onDuplicate,
    onRename,
    onDelete,
    onChangeId,
    onExportBundle,
    onExportUrdf,
    returnFocusRef,
}) {
    const [activeId, setActiveId] = useState(selectedId);
    const [openedFor, setOpenedFor] = useState(null);
    const [fieldFor, setFieldFor] = useState(null);
    const [rename, setRename] = useState("");
    const [nextId, setNextId] = useState("");
    const [confirm, setConfirm] = useState(null);
    if (open && openedFor !== selectedId) {
        setOpenedFor(selectedId);
        setActiveId(selectedId);
        setConfirm(null);
    } else if (!open && openedFor !== null) {
        setOpenedFor(null);
    }
    const active = vehicles.find((entry) => entry.id === activeId) ?? vehicles[0] ?? null;
    if (active && fieldFor !== active.id) {
        setFieldFor(active.id);
        setRename(active.name ?? "");
        setNextId(active.builtIn ? "" : `${active.id}-next`);
    }
    const openAndDirty = Boolean(dirty && active && active.id === selectedId);
    const readOnly = Boolean(active?.builtIn);

    const move = (direction) => {
        if (vehicles.length === 0) return;
        const index = Math.max(0, vehicles.findIndex((entry) => entry.id === active?.id));
        const next = vehicles[Math.min(vehicles.length - 1, Math.max(0, index + direction))];
        setActiveId(next.id);
    };

    const onListKeyDown = (event) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
        } else if (event.key === "Home") {
            event.preventDefault();
            setActiveId(vehicles[0]?.id ?? null);
        } else if (event.key === "End") {
            event.preventDefault();
            setActiveId(vehicles.at(-1)?.id ?? null);
        } else if (event.key === "Enter" && active) {
            event.preventDefault();
            onOpenVehicle(active.id);
        }
    };

    return (
        <>
            <DialogSurface
                open={open}
                onOpenChange={onOpenChange}
                title="Vehicles"
                description="Open a vehicle, or inspect one without replacing the editor."
                className="max-w-3xl"
                onCloseAutoFocus={(event) => {
                    if (!returnFocusRef?.current) return;
                    event.preventDefault();
                    returnFocusRef.current.focus();
                }}
                footer={(
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => onOpenChange(false)}>Close</Button>
                        <Button onClick={() => active && onOpenVehicle(active.id)} disabled={!active || busy}>Open</Button>
                    </div>
                )}
            >
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
                    <div>
                        <div className="mb-2 flex gap-2">
                            <Button onClick={onCreateBlank} disabled={busy}>New</Button>
                            <Button onClick={onImportBundle} disabled={busy}>Import</Button>
                        </div>
                        <div
                            role="listbox"
                            aria-label="Vehicle catalog"
                            tabIndex={0}
                            className="mod-scrollbar max-h-80 overflow-y-auto rounded-[var(--radius)] border border-[var(--slate-border)] p-1 outline-none"
                            onKeyDown={onListKeyDown}
                        >
                            {vehicles.map((entry, index) => {
                                const heading = index === 0 || vehicles[index - 1]?.builtIn !== entry.builtIn;
                                return (
                                    <div key={entry.id}>
                                        {heading && <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--slate-muted)]">{entry.builtIn ? "Built-in vehicles" : "Custom vehicles"}</p>}
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={entry.id === active?.id}
                                            className={`mb-1 w-full rounded-[var(--radius)] px-3 py-2 text-left ${entry.id === active?.id ? "bg-[var(--slate-surface-3)]" : "hover:bg-[var(--slate-surface-2)]"}`}
                                            onClick={() => setActiveId(entry.id)}
                                            onDoubleClick={() => onOpenVehicle(entry.id)}
                                        >
                                            <span className="block truncate text-xs font-semibold">{entry.name}</span>
                                            <span className={`mt-1 block truncate font-mono text-[11px] ${entry.id === active?.id ? "text-[var(--slate-fg-3)]" : "text-[var(--slate-muted)]"}`}>
                                                {entry.builtIn ? `${entry.id} · read only` : `${entry.id} · r${entry.revision ?? 0}`}
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                            {vehicles.length === 0 && <p className="px-2 py-6 text-center text-[11px] text-[var(--slate-muted)]">No vehicles yet.</p>}
                        </div>
                    </div>
                    {active && (
                        <div className="space-y-3 text-[12px]">
                            <p className="font-medium">{active.name}</p>
                            <p className="break-all font-mono text-[11px] text-[var(--slate-muted)]">{active.id}{active.definitionHash ? ` · ${active.definitionHash}` : ""}</p>
                            <Button onClick={() => onDuplicate(active)} disabled={busy}>Duplicate</Button>
                            <Button onClick={() => onExportBundle(active)} disabled={busy || (dirty && active.id === selectedId) || readOnly}>Export bundle</Button>
                            <Button onClick={() => onExportUrdf(active)} disabled={busy || readOnly || active.id !== selectedId}>Export URDF</Button>
                            {openAndDirty && <p className="text-[11px] leading-relaxed text-[var(--slate-warning)]">Save or discard the open draft before renaming, deleting, or changing this id.</p>}
                            {!readOnly && (
                                <>
                                    <Field label="Name">
                                        <input className="sf-input" aria-label="Rename vehicle" value={rename} onChange={(event) => setRename(event.target.value)} disabled={openAndDirty || busy} />
                                    </Field>
                                    <Button onClick={() => onRename(active, rename)} disabled={openAndDirty || busy || !rename.trim()}>Rename</Button>
                                    <Field label="New id" hint="Run and scenario references are not rewritten.">
                                        <input className="sf-input" aria-label="New vehicle id" value={nextId} onChange={(event) => setNextId(event.target.value)} disabled={openAndDirty || busy} />
                                    </Field>
                                    <Button onClick={() => setConfirm({ kind: "change-id", id: nextId })} disabled={openAndDirty || busy || !isValidVehicleId(nextId) || nextId === active.id}>Change id</Button>
                                    <Button onClick={() => setConfirm({ kind: "delete" })} disabled={openAndDirty || busy}>Delete</Button>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </DialogSurface>
            <DialogSurface
                open={Boolean(confirm)}
                onOpenChange={(next) => { if (!next) setConfirm(null); }}
                title={confirm?.kind === "delete" ? "Delete vehicle" : "Change vehicle id"}
                description={confirm?.kind === "delete"
                    ? `Delete “${active?.name ?? ""}”? This cannot be undone.`
                    : `Change “${active?.id ?? ""}” to “${confirm?.id ?? ""}”. Runs and scenarios that name the old id are not rewritten.`}
                footer={(
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => setConfirm(null)}>Cancel</Button>
                        <Button onClick={() => {
                            const pending = confirm;
                            setConfirm(null);
                            if (pending?.kind === "delete") onDelete(active);
                            if (pending?.kind === "change-id") onChangeId(active, pending.id);
                        }}
                        >
                            {confirm?.kind === "delete" ? "Delete" : "Change id"}
                        </Button>
                    </div>
                )}
            />
        </>
    );
}

export function copyIdFor(entry, existing) {
    const baseId = entry.builtIn ? `${entry.id}-custom` : `${entry.id}-copy`;
    return nextCopyId(baseId, existing);
}
