'use client';

import { useEffect, useState } from "react";
import { PaneSplitter } from "../../../3d/overlay/workspace/PaneSplitter.js";
import { WorkspacePane } from "../../../3d/overlay/workspace/WorkspacePane.js";
import {
    clampVehiclePaneLayout,
    resetVehiclePane,
    resizeVehiclePane,
    stepVehiclePaneSize,
    toggleVehiclePane,
    vehiclePaneGridTemplate,
    vehiclePaneLayoutsEqual,
    vehicleSplitterAria,
} from "./vehiclePaneLayout.js";

function viewportSize() {
    if (typeof window === "undefined") return { width: 1280, height: 720 };
    return { width: window.innerWidth, height: window.innerHeight };
}

export function VehicleWorkspace({
    layout,
    onLayoutChange,
    topBar,
    toolbar,
    hierarchy,
    center,
    inspector,
    controls = null,
}) {
    const [viewport, setViewport] = useState(viewportSize);
    useEffect(() => {
        const onResize = () => {
            const nextViewport = viewportSize();
            setViewport(nextViewport);
            onLayoutChange((current) => {
                const next = clampVehiclePaneLayout(current, nextViewport);
                return vehiclePaneLayoutsEqual(next, current) ? current : next;
            });
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [onLayoutChange]);

    const update = (producer) => onLayoutChange((current) => {
        const next = clampVehiclePaneLayout(producer(current), viewport);
        return vehiclePaneLayoutsEqual(next, current) ? current : next;
    });
    const template = vehiclePaneGridTemplate(layout);
    const splitter = (paneId) => (
        <PaneSplitter
            paneId={paneId}
            idPrefix="vehicle-pane"
            label={`Resize ${paneId}`}
            aria={vehicleSplitterAria(layout, paneId)}
            disabled={layout.panes[paneId].collapsed}
            controls={controls}
            onResize={(size) => update((current) => resizeVehiclePane(current, paneId, size))}
            onStep={(direction, options) => update((current) => stepVehiclePaneSize(current, paneId, direction, options))}
            onToggle={() => update((current) => toggleVehiclePane(current, paneId))}
            onReset={() => update((current) => resetVehiclePane(current, paneId))}
        />
    );

    return (
        <div
            data-vehicle-workspace
            className="grid h-full min-h-0 min-w-0 bg-[var(--slate-bg)] text-[var(--slate-fg)]"
            style={{ gridTemplateColumns: template.columns, gridTemplateRows: template.rows }}
        >
            <div className="min-w-0" style={{ gridColumn: "1 / -1" }}>{topBar}</div>
            <div className="min-w-0 border-b border-[var(--slate-border)]" style={{ gridColumn: "1 / -1" }}>{toolbar}</div>
            <WorkspacePane
                paneId="hierarchy"
                idPrefix="vehicle-pane"
                title="Hierarchy"
                collapsed={layout.panes.hierarchy.collapsed}
                onToggle={() => update((current) => toggleVehiclePane(current, "hierarchy"))}
                className="min-h-0 border-r border-[var(--slate-border)]"
                bodyClassName="overflow-hidden"
            >
                {hierarchy}
            </WorkspacePane>
            {splitter("hierarchy")}
            <div className="relative min-h-0 min-w-0">{center}</div>
            {splitter("inspector")}
            <WorkspacePane
                paneId="inspector"
                idPrefix="vehicle-pane"
                title="Inspector"
                collapsed={layout.panes.inspector.collapsed}
                onToggle={() => update((current) => toggleVehiclePane(current, "inspector"))}
                className="min-h-0 border-l border-[var(--slate-border)]"
                bodyClassName="flex min-h-0 flex-col overflow-hidden"
            >
                {inspector}
            </WorkspacePane>
        </div>
    );
}
