'use client';

import { useMemo } from "react";
import {
    IconLayoutBottombarCollapse,
    IconLayoutBottombarExpand,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarLeftExpand,
    IconLayoutSidebarRightCollapse,
    IconLayoutSidebarRightExpand,
} from "@tabler/icons-react";
import { IconButton } from "../../../ui";
import { cn } from "../ui/cn";

const COLLAPSE_ICONS = {
    hierarchy: [IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand],
    inspector: [IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand],
    assets: [IconLayoutBottombarCollapse, IconLayoutBottombarExpand],
};

/** Pane frame: header with title, actions, and collapse; body fills the rest. Camera orbit is locked while the pointer is inside. */
export function WorkspacePane({ paneId, title, collapsed, onToggle, actions = null, children, data, className, bodyClassName, style }) {
    const controls = useMemo(() => {
        const settings = data?.settings?.();
        const lock = `environment-pane-${paneId}`;
        return {
            disable: () => settings?.disableControls?.(lock),
            enable: () => settings?.enableControls?.(lock),
        };
    }, [data, paneId]);
    const [CollapseIcon, ExpandIcon] = COLLAPSE_ICONS[paneId] ?? COLLAPSE_ICONS.hierarchy;
    const horizontal = paneId === "assets";

    if (collapsed) {
        return (
            <aside
                id={`environment-pane-${paneId}`}
                aria-label={title}
                data-pane={paneId}
                data-collapsed="true"
                style={style}
                className={cn(
                    "pointer-events-auto flex min-h-0 min-w-0 items-center bg-[var(--slate-surface-1)] text-[var(--slate-fg)]",
                    horizontal ? "flex-row justify-start px-1" : "flex-col justify-start py-1",
                    className,
                )}
                onPointerDown={controls.disable}
                onPointerUp={controls.enable}
                onPointerLeave={controls.enable}
            >
                <IconButton label={`Expand ${title.toLowerCase()}`} size="compact" onClick={onToggle} aria-expanded={false} aria-controls={`environment-pane-${paneId}-body`}>
                    <ExpandIcon size={16} stroke={1.75} />
                </IconButton>
            </aside>
        );
    }

    return (
        <aside
            id={`environment-pane-${paneId}`}
            aria-label={title}
            data-pane={paneId}
            style={style}
            className={cn("pointer-events-auto flex min-h-0 min-w-0 flex-col bg-[var(--slate-surface-1)] text-[var(--slate-fg)]", className)}
            onPointerDown={controls.disable}
            onPointerUp={controls.enable}
            onPointerLeave={controls.enable}
        >
            <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--slate-border-60)] px-2">
                <h2 className="min-w-0 truncate text-[13px] font-medium text-[var(--slate-fg)]">{title}</h2>
                <div className="flex items-center gap-1">
                    {actions}
                    <IconButton label={`Collapse ${title.toLowerCase()}`} size="compact" onClick={onToggle} aria-expanded aria-controls={`environment-pane-${paneId}-body`}>
                        <CollapseIcon size={16} stroke={1.75} />
                    </IconButton>
                </div>
            </header>
            <div id={`environment-pane-${paneId}-body`} className={cn("min-h-0 min-w-0 flex-1", bodyClassName)}>
                {children}
            </div>
        </aside>
    );
}
