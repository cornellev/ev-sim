'use client';

import { useEffect, useState } from "react";
import {
    IconAlertTriangle,
    IconChevronDown,
    IconCloudUpload,
    IconDeviceFloppy,
    IconPlayerPlay,
    IconPlayerStop,
    IconSun,
    IconWorld,
    IconMapPin,
} from "@tabler/icons-react";
import { Button, IconButton, PopoverSurface } from "../../../ui";
import { PANE_IDS } from "../../editor/workspace/paneLayout.js";
import { SKYBOX_OBJECT_ID } from "../../editor/objects/objectRecord.js";
import { EnvironmentSwitcher } from "../EnvironmentSwitcher";
import { MenuToggle } from "../ui/MenuToggle";
import { cn } from "../ui/cn";
import { GeoregistrationDialog } from "./GeoregistrationDialog";

const PANE_LABELS = { hierarchy: "Hierarchy", inspector: "Inspector", assets: "Assets" };

function SaveStatus({ data }) {
    const [status, setStatus] = useState(null);
    useEffect(() => {
        const persistence = data?.environment?.()?.persistence;
        if (!persistence?.subscribe) return undefined;
        return persistence.subscribe(setStatus);
    }, [data]);
    if (!status) return null;
    const conflict = Boolean(status.conflict);
    const label = conflict ? "Save conflict" : status.sending ? "Saving" : status.dirty ? "Unsaved changes" : "Saved";
    const Icon = conflict ? IconAlertTriangle : status.sending ? IconCloudUpload : IconDeviceFloppy;
    return (
        <span
            role="status"
            aria-live="polite"
            data-save-status={conflict ? "conflict" : status.sending ? "saving" : status.dirty ? "dirty" : "saved"}
            className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[var(--radius)] border px-2 text-[11px]",
                conflict
                    ? "border-[var(--slate-danger-border)] text-[var(--slate-danger)]"
                    : "border-[var(--slate-border-60)] text-[var(--slate-muted)]",
            )}
        >
            <Icon size={13} stroke={1.75} aria-hidden="true" className={status.sending ? "animate-pulse" : undefined} />
            {label}
        </span>
    );
}

/**
 * Workspace top bar: environment switcher, view menu (pane visibility),
 * Earth import, atmosphere, bake, and the save status.
 */
export function EditorTopBar({
    data,
    activeEnvironmentId,
    onEnvironmentChange,
    layout,
    onTogglePane,
    earthImportOpen,
    onEarthImportToggle,
}) {
    const [bakeRunning, setBakeRunning] = useState(false);
    const [georegistrationOpen, setGeoregistrationOpen] = useState(false);
    const inEarthImport = Boolean(earthImportOpen);
    const document = data?.environment?.()?.getDocument?.();
    const showGeoregistration = Boolean(!document?.geoFrame && document?.earth?.anchor);
    useEffect(() => {
        const harness = data?.baking?.();
        if (!harness?.subscribe) return undefined;
        return harness.subscribe((snapshot) => setBakeRunning(snapshot?.status === "running" || snapshot?.status === "preparing"));
    }, [data]);

    const toggleBake = async () => {
        const harness = data?.baking?.();
        const sim = data?.simulation?.();
        if (!harness || !sim) return;
        if (harness.running) {
            harness.stop();
            sim.setModule("baking", false);
            sim.pause();
            setBakeRunning(false);
            return;
        }
        await harness.start();
        sim.setModule("baking", true);
        sim.play();
        setBakeRunning(true);
    };
    return (
        <header
            data-editor-topbar
            className="pointer-events-auto flex h-10 items-center justify-between gap-3 border-b border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] px-3 text-[var(--slate-fg)]"
        >
            {georegistrationOpen && <GeoregistrationDialog data={data} onClose={() => setGeoregistrationOpen(false)} />}
            <div className="flex min-w-0 items-center gap-2">
                <EnvironmentSwitcher data={data} activeEnvironmentId={activeEnvironmentId} onEnvironmentChange={onEnvironmentChange} />
            </div>
            <div className="flex items-center gap-1">
                <PopoverSurface
                    align="end"
                    trigger={(
                        <Button size="compact" variant="ghost" aria-label="View menu">
                            View
                            <IconChevronDown size={14} stroke={1.75} aria-hidden="true" />
                        </Button>
                    )}
                >
                    <div className="w-60 p-2" data-editor-chrome>
                        <p className="px-2 pb-2 text-[12px] font-medium text-[var(--slate-fg-2)]">Panes</p>
                        {PANE_IDS.map((paneId) => (
                            <MenuToggle
                                key={paneId}
                                label={PANE_LABELS[paneId]}
                                checked={!layout.panes[paneId].collapsed}
                                onChange={(visible) => onTogglePane(paneId, !visible)}
                            />
                        ))}
                    </div>
                </PopoverSurface>
                <IconButton
                    label={inEarthImport ? "Leave Earth import" : "Earth import"}
                    tooltip={inEarthImport ? "Leave Earth import" : "Import Google Earth tiles and roads"}
                    size="compact"
                    variant={inEarthImport ? "default" : "ghost"}
                    active={inEarthImport || undefined}
                    aria-pressed={inEarthImport}
                    onClick={() => onEarthImportToggle?.()}
                >
                    <IconWorld size={16} stroke={1.75} />
                </IconButton>
                {showGeoregistration && (
                    <IconButton
                        label="Correct georegistration"
                        tooltip="Migrate legacy geographic coordinates"
                        size="compact"
                        variant="ghost"
                        onClick={() => setGeoregistrationOpen(true)}
                    >
                        <IconMapPin size={16} stroke={1.75} />
                    </IconButton>
                )}
                <IconButton
                    label="Atmosphere"
                    tooltip="Select the Skybox to edit sky and atmosphere"
                    size="compact"
                    variant="ghost"
                    onClick={() => {
                        data?.selection?.()?.select?.(SKYBOX_OBJECT_ID);
                        data?.simulation?.()?.render?.();
                    }}
                >
                    <IconSun size={16} stroke={1.75} />
                </IconButton>
                <IconButton
                    label={bakeRunning ? "Stop bake" : "Start bake"}
                    tooltip={bakeRunning ? "Stop bake run" : "Start bake run (B)"}
                    size="compact"
                    variant={bakeRunning ? "default" : "ghost"}
                    active={bakeRunning || undefined}
                    aria-pressed={bakeRunning}
                    onClick={toggleBake}
                >
                    {bakeRunning ? <IconPlayerStop size={16} stroke={1.75} /> : <IconPlayerPlay size={16} stroke={1.75} />}
                </IconButton>
                <SaveStatus data={data} />
            </div>
        </header>
    );
}
