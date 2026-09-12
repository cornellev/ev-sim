'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EDITOR_MODES } from "../../editor/EditorState";
import { fitMapViewportToContent, hydrateDocumentFromRuntime } from "../../editor/document/documentRuntimeHydration";
import {
    PANE_IDS,
    WORKSPACE_CHROME,
    clampPaneLayout,
    paneGridTemplate,
    paneLayoutsEqual,
    parsePaneLayout,
    resetPane,
    resizePane,
    serializePaneLayout,
    splitterAria,
    stepPaneSize,
    togglePaneCollapsed,
} from "../../editor/workspace/paneLayout.js";
import {
    ENVIRONMENT_EDITOR_PREFERENCE_KEYS,
    readEnvironmentEditorPreference,
    writeEnvironmentEditorPreference,
} from "../../../ui/environmentEditorPreferences.js";
import { BakeProgressOverlay } from "../BakeProgressOverlay";
import { EarthImportModeChrome } from "../earth/EarthImportModeChrome";
import { MapSurface } from "../map/MapSurface";
import { mapSelectionFromSelection } from "../../editor/selection/selectionIds.js";
import { ObjectInspector } from "../ObjectInspector";
import { SceneHierarchy } from "../SceneHierarchy";
import { VisualPreviewDiagnostic } from "../VisualPreviewDiagnostic";
import { AssetPane } from "./AssetPane";
import { EditorToolbar } from "./EditorToolbar";
import { EditorTopBar } from "./EditorTopBar";
import { PaneSplitter } from "./PaneSplitter";
import { WorkspacePane } from "./WorkspacePane";
import { useElementRect } from "./useElementRect";
import { AuthoringModeProvider } from "../../../ui";

const PANE_TITLES = { hierarchy: "Hierarchy", inspector: "Inspector", assets: "Assets" };

function viewportSize() {
    if (typeof window === "undefined") return { width: 1280, height: 720 };
    return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The environment editor workspace: a fixed arrangement of resizable panes
 * around the scene. The center cell stays `pointer-events-none` so pointer
 * events reach the canvas beneath the overlay; the scene pane's rectangle is
 * published to `TotalScene`, which sizes the renderer and camera from it.
 */
export function EditorWorkspace({ data, activeEnvironmentId, onEnvironmentChange, onViewportChange }) {
    // The workspace mounts client-side once the scene is ready, so the stored
    // layout can seed state directly; every change persists as a preference.
    const [layout, setLayout] = useState(() => (
        clampPaneLayout(parsePaneLayout(readEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.PANE_LAYOUT, null)), viewportSize())
    ));
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const canvasHostRef = useRef(null);

    useEffect(() => {
        const viewOptions = readEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.VIEW_OPTIONS, null);
        if (viewOptions && typeof viewOptions === "object") data?.editor?.()?.applyViewOptions?.(viewOptions);
    }, [data]);
    useEffect(() => {
        writeEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.PANE_LAYOUT, serializePaneLayout(layout));
    }, [layout]);
    useEffect(() => {
        const editor = data?.editor?.();
        if (!editor) return undefined;
        let lastKey = null;
        return editor.subscribe((snapshot) => {
            setEditorSnapshot(snapshot);
            if (typeof editor.viewOptionsSnapshot !== "function") return;
            const options = editor.viewOptionsSnapshot();
            const key = JSON.stringify(options);
            if (key === lastKey) return;
            lastKey = key;
            writeEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.VIEW_OPTIONS, options);
        });
    }, [data]);
    useEffect(() => data?.selection?.()?.subscribe?.(setSelectionSnapshot), [data]);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        return document?.subscribe?.((snapshot, event) => {
            if (event?.transient) return;
            setDocumentSnapshot(snapshot);
        });
    }, [data]);

    // Re-clamp when the window shrinks so the scene keeps its minimum size.
    useEffect(() => {
        const onResize = () => setLayout((current) => {
            const next = clampPaneLayout(current, viewportSize());
            return paneLayoutsEqual(next, current) ? current : next;
        });
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // Map view: hydrate and frame the document when the view opens (moved from MapModeChrome).
    useEffect(() => {
        const editor = data?.editor?.();
        if (!editor) return undefined;
        editor.setMapModeEnterHandler(() => {
            const document = data?.environment?.()?.getDocument?.();
            if (!document) return;
            hydrateDocumentFromRuntime(data, document);
            fitMapViewportToContent(editor, document);
        });
        return () => editor.setMapModeEnterHandler(null);
    }, [data]);

    const publishViewport = useCallback((rect) => onViewportChange?.(rect), [onViewportChange]);
    useElementRect(canvasHostRef, publishViewport, { enabled: Boolean(onViewportChange) });
    useEffect(() => () => onViewportChange?.(null), [onViewportChange]);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.("environment-pane-splitter"),
            enable: () => settings?.enableControls?.("environment-pane-splitter"),
        };
    }, [data]);

    const update = (producer) => setLayout((current) => {
        const next = clampPaneLayout(producer(current), viewportSize());
        return paneLayoutsEqual(next, current) ? current : next;
    });
    const togglePane = (paneId, collapsed) => update((current) => togglePaneCollapsed(current, paneId, collapsed));

    const editorMode = editorSnapshot?.editorMode ?? EDITOR_MODES.SCENE;
    const inMap = editorMode === EDITOR_MODES.MAP;
    const panesHidden = editorMode === EDITOR_MODES.EARTH_IMPORT;
    const template = paneGridTemplate(layout, WORKSPACE_CHROME, { panesHidden });
    const emptyDocument = { roads: { nodes: [], edges: [] }, buildings: [], features: [] };
    const mapSelection = inMap ? mapSelectionFromSelection(selectionSnapshot, documentSnapshot) : null;

    const splitter = (paneId, className) => (
        <PaneSplitter
            paneId={paneId}
            label={`Resize ${PANE_TITLES[paneId].toLowerCase()}`}
            aria={splitterAria(layout, paneId)}
            disabled={layout.panes[paneId].collapsed}
            controls={controls}
            onResize={(size) => update((current) => resizePane(current, paneId, size))}
            onStep={(direction, options) => update((current) => stepPaneSize(current, paneId, direction, options))}
            onToggle={() => togglePane(paneId)}
            onReset={() => update((current) => resetPane(current, paneId))}
            className={className}
        />
    );

    return (
        <div
            data-editor-workspace
            data-editor-mode={editorMode}
            className="pointer-events-none absolute inset-0 grid min-h-0 min-w-0 text-[var(--slate-fg)]"
            style={{ gridTemplateColumns: template.columns, gridTemplateRows: template.rows }}
        >
            <div className="min-w-0" style={{ gridColumn: "1 / -1", gridRow: 1 }}>
                <EditorTopBar
                    data={data}
                    activeEnvironmentId={activeEnvironmentId}
                    onEnvironmentChange={onEnvironmentChange}
                    layout={layout}
                    onTogglePane={togglePane}
                    editorMode={editorMode}
                />
            </div>

            {!panesHidden && (
                <WorkspacePane
                    paneId="hierarchy"
                    title={PANE_TITLES.hierarchy}
                    collapsed={layout.panes.hierarchy.collapsed}
                    onToggle={() => togglePane("hierarchy")}
                    data={data}
                    style={{ gridColumn: 1, gridRow: 2 }}
                    className="border-r border-[var(--slate-border-60)]"
                >
                    <SceneHierarchy data={data} />
                </WorkspacePane>
            )}
            {!panesHidden && splitter("hierarchy", "row-start-2 col-start-2")}

            <section
                aria-label={inMap ? "Map view" : "Scene view"}
                data-editor-center
                className="relative flex min-h-0 min-w-0 flex-col"
                style={{ gridColumn: panesHidden ? 1 : 3, gridRow: 2 }}
            >
                {!panesHidden && <EditorToolbar data={data} />}
                <div ref={canvasHostRef} data-editor-canvas-host className="relative min-h-0 min-w-0 flex-1">
                    {inMap && (
                        <MapSurface
                            data={data}
                            editorSnapshot={editorSnapshot}
                            documentSnapshot={documentSnapshot ?? emptyDocument}
                            mapSelection={mapSelection}
                        />
                    )}
                    {panesHidden && <EarthImportModeChrome data={data} />}
                    <BakeProgressOverlay data={data} />
                    <VisualPreviewDiagnostic data={data} />
                </div>
            </section>

            {!panesHidden && splitter("inspector", "row-start-2 col-start-4")}
            {!panesHidden && (
                <WorkspacePane
                    paneId="inspector"
                    title={PANE_TITLES.inspector}
                    collapsed={layout.panes.inspector.collapsed}
                    onToggle={() => togglePane("inspector")}
                    data={data}
                    style={{ gridColumn: 5, gridRow: 2 }}
                    className="border-l border-[var(--slate-border-60)]"
                    bodyClassName="overflow-auto"
                >
                    <AuthoringModeProvider>
                        <ObjectInspector data={data} />
                    </AuthoringModeProvider>
                </WorkspacePane>
            )}

            {!panesHidden && (
                <div style={{ gridColumn: "1 / -1", gridRow: 3 }} className="flex min-w-0">
                    {splitter("assets", "flex-1")}
                </div>
            )}
            {!panesHidden && (
                <WorkspacePane
                    paneId="assets"
                    title={PANE_TITLES.assets}
                    collapsed={layout.panes.assets.collapsed}
                    onToggle={() => togglePane("assets")}
                    data={data}
                    style={{ gridColumn: "1 / -1", gridRow: 4 }}
                    className="border-t border-[var(--slate-border-60)]"
                >
                    <AssetPane data={data} />
                </WorkspacePane>
            )}
        </div>
    );
}

export { PANE_IDS };
