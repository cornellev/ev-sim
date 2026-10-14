'use client';

import { IconArrowBackUp, IconArrowForwardUp } from "@tabler/icons-react";
import { IconButton, SegmentedControl } from "../../../ui";

export function VehicleToolbar({
    gizmoMode,
    onGizmoMode,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    readOnly,
    modelVisible,
    zoneVisible,
    onModelVisible,
    onZoneVisible,
    children = null,
}) {
    return (
        <div className="flex h-9 items-center gap-2 bg-[var(--slate-surface-1)] px-3" role="toolbar" aria-label="Vehicle editor">
            <IconButton label="Undo" onClick={onUndo} disabled={!canUndo || readOnly}><IconArrowBackUp size={15} stroke={1.75} /></IconButton>
            <IconButton label="Redo" onClick={onRedo} disabled={!canRedo || readOnly}><IconArrowForwardUp size={15} stroke={1.75} /></IconButton>
            <SegmentedControl
                value={gizmoMode}
                onValueChange={onGizmoMode}
                label="Gizmo mode"
                items={[{ value: "translate", label: "Move" }, { value: "rotate", label: "Rotate" }]}
            />
            <IconButton label={modelVisible ? "Hide model" : "Show model"} aria-pressed={modelVisible} onClick={() => onModelVisible(!modelVisible)}>Model</IconButton>
            <IconButton label={zoneVisible ? "Hide LiDAR zone" : "Show LiDAR zone"} aria-pressed={zoneVisible} onClick={() => onZoneVisible(!zoneVisible)}>Zone</IconButton>
            {children}
        </div>
    );
}
