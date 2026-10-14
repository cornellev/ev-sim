'use client';

import { IconAlertTriangle, IconCloudUpload, IconDeviceFloppy, IconLayoutGrid } from "@tabler/icons-react";
import { Button } from "../../../ui";

const STATUS = {
    idle: { label: "Saved", icon: IconDeviceFloppy },
    saving: { label: "Saving", icon: IconCloudUpload },
    dirty: { label: "Unsaved changes", icon: IconDeviceFloppy },
    conflict: { label: "Save conflict", icon: IconAlertTriangle },
    "expired-stage": { label: "Stage expired", icon: IconAlertTriangle },
    error: { label: "Save failed", icon: IconAlertTriangle },
};

export function VehicleTopBar({
    name,
    readOnly,
    dirty,
    saveState,
    saveMessage,
    onOpenWorkspace,
    onOpenCatalog,
    catalogRef,
    onValidate,
    onSave,
    validateDisabled,
    saveDisabled,
    extra = null,
}) {
    const key = saveState === "idle" && dirty ? "dirty" : (saveState || "idle");
    const status = STATUS[key] ?? STATUS.idle;
    const Icon = status.icon;
    const conflict = key === "conflict" || key === "expired-stage" || key === "error";
    return (
        <header className="flex h-10 items-center justify-between gap-3 border-b border-[var(--slate-border)] bg-[var(--slate-surface-1)] px-3">
            <div className="flex min-w-0 items-center gap-2">
                <button type="button" className="flex shrink-0 items-center gap-2 text-left" onClick={onOpenWorkspace} aria-label="Open workspace switcher">
                    <span className="text-[11px] font-medium text-[var(--slate-muted)]">cev-sim</span>
                    <span aria-hidden="true" className="h-3 w-px bg-[var(--slate-border)]" />
                    <IconLayoutGrid size={15} stroke={1.75} aria-hidden="true" />
                    <span className="text-[13px] font-semibold">Vehicle Editor</span>
                </button>
                <button ref={catalogRef} type="button" className="min-w-0 truncate rounded-[var(--radius)] px-2 py-1 text-left text-[13px] font-medium hover:bg-[var(--slate-surface-2)]" onClick={onOpenCatalog} aria-haspopup="dialog" aria-label={`Open vehicle catalog: ${name || "Vehicles"}`}>
                    {name || "Vehicles"}
                </button>
            </div>
            <div className="flex items-center gap-2">
                {readOnly && <span className="text-[11px] font-medium text-[var(--slate-muted)]">Built-in · read only</span>}
                <span
                    role="status"
                    aria-live="polite"
                    data-save-status={key}
                    title={saveMessage || undefined}
                    className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--radius)] border px-2 text-[11px] ${conflict ? "border-[var(--slate-danger-border)] text-[var(--slate-danger)]" : "border-[var(--slate-border)] text-[var(--slate-muted)]"}`}
                >
                    <Icon size={13} stroke={1.75} aria-hidden="true" className={key === "saving" ? "animate-pulse" : undefined} />
                    <span className="max-w-64 truncate">{conflict && saveMessage ? saveMessage : status.label}</span>
                </span>
                {extra}
                <Button onClick={onValidate} disabled={validateDisabled}>Validate</Button>
                <Button onClick={onSave} disabled={saveDisabled}>Save</Button>
            </div>
        </header>
    );
}
