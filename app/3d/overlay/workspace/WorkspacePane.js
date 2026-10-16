'use client';

import { memo, useMemo } from "react";
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
export const WorkspacePane = memo(function WorkspacePane({ paneId, title, collapsed, onToggle, actions = null, children, data, className, bodyClassName, style, idPrefix = "environment-pane" }) {
    const domId = `${idPrefix}-${paneId}`;
    const controls = useMemo(() => {
        const settings = data?.settings?.();
        const lock = domId;
        return {
            disable: () => settings?.disableControls?.(lock),
            enable: () => settings?.enableControls?.(lock),
        };
    }, [data, domId]);
    const [CollapseIcon, ExpandIcon] = COLLAPSE_ICONS[paneId] ?? COLLAPSE_ICONS.hierarchy;
    const horizontal = paneId === "assets";

    if (collapsed) {
        return (
            <aside
                id={domId}
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
                <IconButton label={`Expand ${title.toLowerCase()}`} size="compact" onClick={onToggle} aria-expanded={false} aria-controls={`${domId}-body`}>
                    <ExpandIcon size={16} stroke={1.75} />
                </IconButton>
            </aside>
        );
    }

    return (
        <aside
            id={domId}
            aria-label={title}
            data-pane={paneId}
            style={style}
            className={cn("pointer-events-auto flex min-h-0 min-w-0 flex-col bg-[var(--slate-surface-1)] text-[var(--slate-fg)]", className)}
            onPointerDown={controls.disable}
            onPointerUp={controls.enable}
            onPointerLeave={controls.enable}
        >
            <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-[var(--slate-border-60)] px-3">
                <h2 className="min-w-0 truncate text-[13px] font-medium text-[var(--slate-fg)]">{title}</h2>
                <div className="flex items-center gap-1">
                    {actions}
                    <IconButton label={`Collapse ${title.toLowerCase()}`} size="compact" onClick={onToggle} aria-expanded aria-controls={`${domId}-body`}>
                        <CollapseIcon size={16} stroke={1.75} />
                    </IconButton>
                </div>
            </header>
            <div id={`${domId}-body`} className={cn("min-h-0 min-w-0 flex-1", bodyClassName)}>
                {children}
            </div>
        </aside>
    );
});
