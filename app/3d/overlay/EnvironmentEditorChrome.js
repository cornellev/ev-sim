'use client';

import { ChunkOutlines } from "./ChunkOutlines";
import { EarthImportBoundsOutline } from "./earth/EarthImportBoundsOutline";
import { SelectionVisualizer } from "./SelectionVisualizer";
import { EditorCommandShortcuts } from "./EditorCommandShortcuts";
import { EditorGridOverlay } from "./workspace/EditorGridOverlay";
import { EditorWorkspace } from "./workspace/EditorWorkspace";

/**
 * Environment editor chrome: the pane workspace (top bar, hierarchy, scene
 * toolbar and view, inspector, asset pane) plus the Three-side overlays
 * (selection, chunk outlines, working grid, Earth bounds) and the
 * workspace-scoped shortcuts. `onViewportChange` publishes the scene pane's
 * rectangle so the renderer and camera resize with it.
 */
export function EnvironmentEditorChrome({ data, activeEnvironmentId, onEnvironmentChange, onViewportChange }) {
    if (!data) return null;
    return (
        <>
            <EditorCommandShortcuts data={data} />
            <ChunkOutlines data={data} />
            <SelectionVisualizer data={data} />
            <EditorGridOverlay data={data} />
            <EarthImportBoundsOutline data={data} />
            <EditorWorkspace
                data={data}
                activeEnvironmentId={activeEnvironmentId}
                onEnvironmentChange={onEnvironmentChange}
                onViewportChange={onViewportChange}
            />
        </>
    );
}
