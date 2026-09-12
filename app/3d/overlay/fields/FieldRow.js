'use client';

import { IconRestore } from "@tabler/icons-react";
import { IconButton } from "../../../ui";
import { cn } from "../ui/cn";

/** Label + control row with an optional units suffix, reset button, and inline issue. */
export function FieldRow({ id, label, units, issues = [], canReset = false, onReset, mixed = false, children, className, scrubHandlers = null }) {
    const issue = issues.find((entry) => entry.severity === "error") ?? issues[0] ?? null;
    const describedBy = issue ? `${id}-issue` : undefined;
    return (
        <div className={cn("grid grid-cols-[minmax(0,88px)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 py-1", className)} data-field={id} data-mixed={mixed || undefined}>
            <label
                htmlFor={id}
                className={cn("min-w-0 truncate text-[12px] text-[var(--slate-fg-2)]", scrubHandlers && "cursor-ew-resize select-none")}
                title={scrubHandlers ? `${label} — drag to adjust` : label}
                {...(scrubHandlers ?? {})}
            >
                {label}
            </label>
            <div className="flex min-w-0 items-center gap-1">
                <div className="min-w-0 flex-1" data-field-control>{children}</div>
                {units && <span className="shrink-0 text-[11px] text-[var(--slate-muted)]" aria-hidden="true">{units}</span>}
                {canReset && onReset && (
                    <IconButton label={`Reset ${label.toLowerCase()} to default`} size="compact" variant="ghost" className="h-7 w-7" onClick={onReset}>
                        <IconRestore size={13} stroke={1.75} />
                    </IconButton>
                )}
            </div>
            {issue && (
                <p id={describedBy} role="alert" className="col-span-2 text-[11px] leading-snug text-[var(--slate-danger)]">
                    {issue.message}
                </p>
            )}
        </div>
    );
}

export const MIXED_HINT_ID = "inspector-mixed-hint";

export function controlDescribedBy(id, issues, mixed = false) {
    const parts = [issues?.length ? `${id}-issue` : null, mixed ? MIXED_HINT_ID : null].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
}
