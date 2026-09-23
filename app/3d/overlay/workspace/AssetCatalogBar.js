'use client';

import { useId } from "react";
import {
    IconAdjustmentsHorizontal,
    IconChevronDown,
    IconList,
    IconSearch,
    IconSquares,
    IconUpload,
    IconX,
} from "@tabler/icons-react";
import { IconButton, PopoverSurface, SegmentedControl } from "../../../ui";
import { MenuToggle } from "../ui/MenuToggle.js";
import { cn } from "../ui/cn";
import { catalogFiltersActive, showImportSourcePicker } from "./assetCatalogBarState.js";

const SORT_ITEMS = [
    { value: "name", label: "Name" },
    { value: "updated", label: "Updated" },
];

const KIND_ITEMS = [
    { value: "all", label: "All" },
    { value: "builtins", label: "Built-ins" },
    { value: "models", label: "Models" },
];

export function AssetCatalogBar({
    query,
    onQueryChange,
    kind,
    onKindChange,
    sort,
    onSortChange,
    view,
    onViewChange,
    showArchived,
    onShowArchivedChange,
    sources,
    sourceId,
    onSourceIdChange,
    canImport,
    importTitle,
    importDescribedBy,
    importInputId,
    onImportClick,
}) {
    const grantName = useId();
    const filtersActive = catalogFiltersActive({ kind, sort, showArchived });
    const grantPicker = showImportSourcePicker(sources);

    return (
        <div data-editor-chrome className="pointer-events-auto flex h-10 shrink-0 flex-nowrap items-center gap-1.5 border-b border-[var(--slate-border-60)] px-2">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded border border-[var(--slate-border-70)] px-2">
                <IconSearch size={13} className="shrink-0 text-[var(--slate-muted)]" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder="Search names or tags"
                    aria-label="Search assets"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--slate-fg)] outline-none placeholder:text-[var(--slate-muted)]"
                />
                {query ? (
                    <IconButton label="Clear search" tooltip="Clear search" className="sf-icon-button--tight" onClick={() => onQueryChange("")}>
                        <IconX size={14} stroke={1.75} />
                    </IconButton>
                ) : null}
            </div>
            <div role="group" aria-label="Catalog view" className="flex shrink-0 items-center">
                <IconButton label="Grid view" tooltip="Grid view" aria-pressed={view === "grid"} onClick={() => onViewChange("grid")}>
                    <IconSquares size={16} stroke={1.75} />
                </IconButton>
                <IconButton label="List view" tooltip="List view" aria-pressed={view === "list"} onClick={() => onViewChange("list")}>
                    <IconList size={16} stroke={1.75} />
                </IconButton>
            </div>
            <PopoverSurface
                align="end"
                trigger={(
                    <IconButton label="Display options" tooltip="Display options">
                        <IconAdjustmentsHorizontal size={16} stroke={1.75} />
                        {filtersActive ? <span aria-hidden="true" className="absolute top-1 right-1 size-[5px] rounded-full bg-[var(--slate-fg)]" /> : null}
                    </IconButton>
                )}
            >
                <div className="w-64 space-y-3 p-2" data-editor-chrome>
                    <p className="text-[12px] font-medium text-[var(--slate-fg-2)]">Display</p>
                    <div className="space-y-1">
                        <p className="text-[11px] text-[var(--slate-muted)]">Sort</p>
                        <SegmentedControl label="Sort assets" value={sort} onValueChange={onSortChange} items={SORT_ITEMS} className="w-full" />
                    </div>
                    <div className="space-y-1">
                        <p className="text-[11px] text-[var(--slate-muted)]">Kind</p>
                        <SegmentedControl label="Asset kind" value={kind} onValueChange={onKindChange} items={KIND_ITEMS} className="w-full" />
                    </div>
                    <MenuToggle label="Show archived" checked={showArchived} onChange={onShowArchivedChange} />
                </div>
            </PopoverSurface>
            <div className="flex shrink-0 items-center">
                <label
                    htmlFor={canImport ? importInputId : undefined}
                    data-editor-asset-import
                    data-import-source={sourceId || undefined}
                    aria-disabled={!canImport || undefined}
                    aria-describedby={importDescribedBy}
                    title={importTitle}
                    className={cn(
                        "flex h-8 items-center gap-1 rounded px-2 text-xs",
                        canImport ? "cursor-pointer hover:bg-[var(--slate-surface-hover)]" : "cursor-not-allowed opacity-45",
                    )}
                    onClick={onImportClick}
                >
                    <IconUpload size={14} aria-hidden="true" />
                    Import
                </label>
                {grantPicker ? (
                    <PopoverSurface
                        align="end"
                        trigger={(
                            <IconButton label="Upload grant" tooltip="Upload grant">
                                <IconChevronDown size={16} stroke={1.75} />
                            </IconButton>
                        )}
                    >
                        <div className="w-64 p-2" data-editor-chrome>
                            <p className="text-[12px] font-medium text-[var(--slate-fg-2)]">Upload grant</p>
                            <p className="mt-0.5 text-[11px] text-[var(--slate-muted)]">Rights source stamped on this import. It does not filter the catalog.</p>
                            <div role="radiogroup" aria-label="Upload grant" className="mt-2">
                                {sources.map((source) => (
                                    <label key={source.id} className="flex h-8 items-center gap-2 rounded px-1 text-[12px] text-[var(--slate-fg)] hover:bg-[var(--slate-surface-hover)]">
                                        <input
                                            type="radio"
                                            name={grantName}
                                            value={source.id}
                                            aria-label={source.label}
                                            checked={sourceId === source.id}
                                            onChange={() => onSourceIdChange(source.id)}
                                        />
                                        <span className="min-w-0 truncate">{source.label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </PopoverSurface>
                ) : null}
            </div>
        </div>
    );
}
