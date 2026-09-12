'use client';

import { useState } from "react";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { cn } from "../ui/cn";
import {
    ENVIRONMENT_EDITOR_PREFERENCE_KEYS,
    readEnvironmentEditorPreference,
    writeEnvironmentEditorPreference,
} from "../../../ui/environmentEditorPreferences.js";

function readCollapsed() {
    const stored = readEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.INSPECTOR_SECTIONS, null);
    return stored && typeof stored === "object" ? stored : {};
}

/** Collapsible inspector section; open state is remembered per section id as an editor preference. */
export function PropertySection({ id, title, actions = null, children, className, defaultOpen = true }) {
    const [open, setOpen] = useState(() => {
        const collapsed = readCollapsed()[id];
        return collapsed === undefined ? defaultOpen : !collapsed;
    });
    const toggle = () => {
        const next = !open;
        setOpen(next);
        const collapsed = readCollapsed();
        if (next) delete collapsed[id];
        else collapsed[id] = true;
        writeEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.INSPECTOR_SECTIONS, collapsed);
    };
    const bodyId = `property-section-${id}`;
    return (
        <section className={cn("border-b border-[var(--slate-border-60)] last:border-b-0", className)} data-property-section={id}>
            <div className="flex h-8 items-center justify-between gap-2 pr-1">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={toggle}
                    className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius)] px-1 text-left text-[12px] font-medium text-[var(--slate-fg-2)] hover:text-[var(--slate-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]"
                >
                    {open ? <IconChevronDown size={14} stroke={1.75} aria-hidden="true" /> : <IconChevronRight size={14} stroke={1.75} aria-hidden="true" />}
                    <span className="truncate">{title}</span>
                </button>
                {actions}
            </div>
            <div id={bodyId} hidden={!open} className="px-1 pb-2">
                {open && children}
            </div>
        </section>
    );
}
