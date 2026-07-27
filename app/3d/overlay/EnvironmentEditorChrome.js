'use client';

import { BakeProgressOverlay } from "./BakeProgressOverlay";
import { ChunkOutlines } from "./ChunkOutlines";
import { EnvironmentEditorMenu } from "./EnvironmentEditorMenu";
import { EarthImportBoundsOutline } from "./earth/EarthImportBoundsOutline";
import { EarthImportModeChrome } from "./earth/EarthImportModeChrome";
import { MapModeChrome } from "./map/MapModeChrome";
import { ObjectInspector } from "./ObjectInspector";
import { SceneHierarchy } from "./SceneHierarchy";
import { SelectionVisualizer } from "./SelectionVisualizer";
import { EDITOR_MODES } from "../editor/EditorState";
import { useEffect, useState } from "react";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";
import { useShortcut } from "../../ui";

export function EnvironmentEditorChrome({ data, activeEnvironmentId, onEnvironmentChange }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [hierarchyOpen, setHierarchyOpen] = useState(false);
    const [inspectorOpen, setInspectorOpen] = useState(false);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    useShortcut({
        id: "environment-compact-panel",
        keys: "Escape",
        priority: 20,
        enabled: hierarchyOpen || inspectorOpen,
        handler: () => {
            setHierarchyOpen(false);
            setInspectorOpen(false);
            return true;
        },
    });

    if (!data) return null;

    const editorMode = editorSnapshot?.editorMode;
    const inOverlayMode = editorMode === EDITOR_MODES.MAP
        || editorMode === EDITOR_MODES.EARTH_IMPORT;

    return (
        <>
            <EnvironmentSwitcher
                data={data}
                activeEnvironmentId={activeEnvironmentId}
                onEnvironmentChange={onEnvironmentChange}
            />
            {!inOverlayMode && <ChunkOutlines data={data} />}
            {!inOverlayMode && <SelectionVisualizer data={data} />}
            {!inOverlayMode && <SceneHierarchy data={data} compactOpen={hierarchyOpen} />}
            {!inOverlayMode && <ObjectInspector data={data} compactOpen={inspectorOpen} />}
            <BakeProgressOverlay data={data} />
            {!inOverlayMode && (
                <EnvironmentEditorMenu
                    data={data}
                    hierarchyOpen={hierarchyOpen}
                    inspectorOpen={inspectorOpen}
                    onToggleHierarchy={() => {
                        setHierarchyOpen((open) => !open);
                        setInspectorOpen(false);
                    }}
                    onToggleInspector={() => {
                        setInspectorOpen((open) => !open);
                        setHierarchyOpen(false);
                    }}
                />
            )}
            <MapModeChrome data={data} />
            <EarthImportBoundsOutline data={data} />
            <EarthImportModeChrome data={data} />
        </>
    );
}
