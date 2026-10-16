'use client';

import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconArrowsMove,
    IconCube,
    IconFileCheck,
    IconFileImport,
    IconRadar2,
    IconRotateClockwise,
    IconView360,
} from "@tabler/icons-react";
import { IconButton } from "../../../ui";

function Group({ label, first = false, children }) {
    return (
        <div
            role="group"
            aria-label={label}
            className={`flex items-center gap-0.5 ${first ? "" : "ml-1 border-l border-[var(--slate-border-60)] pl-1.5"}`}
        >
            {children}
        </div>
    );
}

function ToolIcon({ icon: Icon }) {
    return <Icon size={16} stroke={1.75} />;
}

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
    urdfButtonRef = null,
    onCreateUrdf,
    onApplyUrdf,
    createUrdfDisabled = false,
    applyUrdfDisabled = false,
    coverageEnabled = false,
    onCoverageEnabled,
    coverageDisabled = false,
}) {
    const move = gizmoMode === "translate";
    const rotate = gizmoMode === "rotate";
    return (
        <div
            className="flex h-11 items-center gap-1 border-b border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] px-3 text-[var(--slate-fg)]"
            role="toolbar"
            aria-label="Vehicle editor"
            aria-orientation="horizontal"
        >
            <Group label="History" first>
                <IconButton label="Undo" onClick={onUndo} disabled={!canUndo || readOnly}><ToolIcon icon={IconArrowBackUp} /></IconButton>
                <IconButton label="Redo" onClick={onRedo} disabled={!canRedo || readOnly}><ToolIcon icon={IconArrowForwardUp} /></IconButton>
            </Group>
            <Group label="Gizmo">
                <IconButton
                    label="Move"
                    variant={move ? "default" : "ghost"}
                    active={move || undefined}
                    aria-pressed={move}
                    onClick={() => onGizmoMode("translate")}
                >
                    <ToolIcon icon={IconArrowsMove} />
                </IconButton>
                <IconButton
                    label="Rotate"
                    variant={rotate ? "default" : "ghost"}
                    active={rotate || undefined}
                    aria-pressed={rotate}
                    onClick={() => onGizmoMode("rotate")}
                >
                    <ToolIcon icon={IconRotateClockwise} />
                </IconButton>
            </Group>
            <Group label="Visibility">
                <IconButton
                    label={modelVisible ? "Hide model" : "Show model"}
                    variant={modelVisible ? "default" : "ghost"}
                    active={modelVisible || undefined}
                    aria-pressed={modelVisible}
                    onClick={() => onModelVisible(!modelVisible)}
                >
                    <ToolIcon icon={IconCube} />
                </IconButton>
                <IconButton
                    label={zoneVisible ? "Hide LiDAR zone" : "Show LiDAR zone"}
                    variant={zoneVisible ? "default" : "ghost"}
                    active={zoneVisible || undefined}
                    aria-pressed={zoneVisible}
                    onClick={() => onZoneVisible(!zoneVisible)}
                >
                    <ToolIcon icon={IconRadar2} />
                </IconButton>
            </Group>
            <Group label="Coverage">
                <IconButton
                    label="Coverage"
                    variant={coverageEnabled ? "default" : "ghost"}
                    active={coverageEnabled || undefined}
                    aria-pressed={coverageEnabled}
                    disabled={coverageDisabled}
                    onClick={() => onCoverageEnabled?.(!coverageEnabled)}
                >
                    <ToolIcon icon={IconView360} />
                </IconButton>
            </Group>
            <Group label="Import">
                <IconButton ref={urdfButtonRef} label="URDF" onClick={onCreateUrdf} disabled={createUrdfDisabled}>
                    <ToolIcon icon={IconFileImport} />
                </IconButton>
                <IconButton label="Apply URDF" onClick={onApplyUrdf} disabled={applyUrdfDisabled}>
                    <ToolIcon icon={IconFileCheck} />
                </IconButton>
            </Group>
        </div>
    );
}
