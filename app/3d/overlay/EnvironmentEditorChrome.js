'use client';

import { BakeProgressOverlay } from "./BakeProgressOverlay";
import { ChunkOutlines } from "./ChunkOutlines";
import { EnvironmentEditorMenu } from "./EnvironmentEditorMenu";
import { MapModeChrome } from "./map/MapModeChrome";
import { ObjectInspector } from "./ObjectInspector";
import { SceneHierarchy } from "./SceneHierarchy";
import { SelectionVisualizer } from "./SelectionVisualizer";
import { EDITOR_MODES } from "../editor/EditorState";
import { useEffect, useState } from "react";

export function EnvironmentEditorChrome({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    if (!data) return null;

    const inMapMode = editorSnapshot?.editorMode === EDITOR_MODES.MAP;

    return (
        <>
            {!inMapMode && <ChunkOutlines data={data} />}
            {!inMapMode && <SelectionVisualizer data={data} />}
            {!inMapMode && <SceneHierarchy data={data} />}
            {!inMapMode && <ObjectInspector data={data} />}
            <BakeProgressOverlay data={data} />
            {!inMapMode && <EnvironmentEditorMenu data={data} />}
            <MapModeChrome data={data} />
        </>
    );
}
