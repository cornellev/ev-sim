'use client';

import { useEffect, useRef, useState } from "react";
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconArrowsMaximize,
    IconArrowsMove,
    IconBorderCorners,
    IconBox,
    IconBoxMultiple,
    IconBuilding,
    IconCube,
    IconFocusCentered,
    IconGrid4x4,
    IconHandStop,
    IconMagnet,
    IconMap,
    IconPointer,
    IconRoad,
    IconRotateClockwise,
    IconStack2,
    IconTrafficLights,
    IconWorld,
} from "@tabler/icons-react";
import { IconButton, PopoverSurface } from "../../../ui";
import { LAYER_ITEMS, TOOLBAR_ACTIONS, buildToolbarModel, runToolbarAction } from "../../editor/workspace/toolbarModel.js";
import { focusCameraOnSelection } from "../../editor/tools/cameraFocus.js";
import { MenuToggle } from "../ui/MenuToggle";
import { cn } from "../ui/cn";

const ICONS = {
    pointer: IconPointer,
    move: IconArrowsMove,
    rotate: IconRotateClockwise,
    scale: IconArrowsMaximize,
    hand: IconHandStop,
    intersection: IconTrafficLights,
    road: IconRoad,
    building: IconBuilding,
    world: IconWorld,
    local: IconBox,
    magnet: IconMagnet,
    scene: IconCube,
    map: IconMap,
    grid: IconGrid4x4,
    chunks: IconBoxMultiple,
    bounds: IconBorderCorners,
    undo: IconArrowBackUp,
    redo: IconArrowForwardUp,
    frame: IconFocusCentered,
};

function ToolbarItem({ item, onRun }) {
    const Icon = ICONS[item.icon] ?? IconCube;
    return (
        <IconButton
            label={item.label}
            tooltip={item.tooltip}
            size="compact"
            variant={item.active ? "default" : "ghost"}
            active={item.active || undefined}
            aria-pressed={item.kind === "toggle" ? item.active : undefined}
            disabled={item.disabled}
            data-toolbar-item={item.id}
            onClick={() => onRun(item.action)}
        >
            <Icon size={16} stroke={1.75} />
        </IconButton>
    );
}

/**
 * Scene toolbar: one `role="toolbar"` with roving Arrow-key focus over the
 * groups the model produces for the current view. Tooltips, accessible
 * names, and pressed state come from `IconButton`.
 */
export function EditorToolbar({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [busSnapshot, setBusSnapshot] = useState(null);
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const rootRef = useRef(null);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);
    useEffect(() => data?.commands?.()?.subscribe?.(setBusSnapshot), [data]);
    useEffect(() => data?.selection?.()?.subscribe?.(setSelectionSnapshot), [data]);

    if (!data || !editorSnapshot) return null;
    const groups = buildToolbarModel({ editorSnapshot, busSnapshot, selectionSnapshot });
    const layers = editorSnapshot.layers ?? {};
    const run = (action) => {
        runToolbarAction(data, action, { focus: () => focusCameraOnSelection({ data }) });
    };
    const onKeyDown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = [...(rootRef.current?.querySelectorAll("button:not([disabled])") ?? [])];
        if (buttons.length === 0) return;
        const index = buttons.indexOf(document.activeElement);
        let next = index;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = buttons.length - 1;
        else if (event.key === "ArrowRight") next = index < 0 ? 0 : (index + 1) % buttons.length;
        else next = index <= 0 ? buttons.length - 1 : index - 1;
        event.preventDefault();
        buttons[next]?.focus();
    };

    return (
        <div
            ref={rootRef}
            role="toolbar"
            aria-label="Scene tools"
            aria-orientation="horizontal"
            data-editor-toolbar
            onKeyDown={onKeyDown}
            className="pointer-events-auto flex h-9 shrink-0 items-center gap-1 border-b border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] px-2 text-[var(--slate-fg)]"
        >
            {groups.map((group, index) => (
                <div key={group.id} role="group" aria-label={group.label} className={cn("flex items-center gap-0.5", index > 0 && "ml-1 border-l border-[var(--slate-border-60)] pl-1.5")}>
                    {group.items.map((item) => <ToolbarItem key={item.id} item={item} onRun={run} />)}
                    {group.id === "overlays" && (
                        <PopoverSurface
                            align="start"
                            trigger={(
                                <IconButton label="Layers" tooltip="Layer visibility" size="compact" variant="ghost" data-toolbar-item="layers">
                                    <IconStack2 size={16} stroke={1.75} />
                                </IconButton>
                            )}
                        >
                            <div className="w-64 p-1" data-editor-chrome>
                                <p className="px-1 pb-1 text-[12px] font-medium text-[var(--slate-fg-2)]">Layers</p>
                                {LAYER_ITEMS.map((layer) => (
                                    <MenuToggle
                                        key={layer.id}
                                        label={layer.label}
                                        hint={layer.hint}
                                        checked={layers[layer.id] !== false}
                                        onChange={(visible) => run({ type: TOOLBAR_ACTIONS.SET_LAYER, layer: layer.id, visible })}
                                    />
                                ))}
                            </div>
                        </PopoverSurface>
                    )}
                </div>
            ))}
        </div>
    );
}
