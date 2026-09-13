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
import { AssetCatalogInspector, AssetPreviewTab, AssetStudioHierarchy } from "./AssetPreviewTab";
import { EditorToolbar } from "./EditorToolbar";
import { EditorTopBar } from "./EditorTopBar";
import { PaneSplitter } from "./PaneSplitter";
import { WorkspacePane } from "./WorkspacePane";
import { useElementRect } from "./useElementRect";
import { AuthoringModeProvider } from "../../../ui";
import { assetStudioCommands } from "../../editor/commands/assetStudioCommands.js";
import { extractAssetSourceGeometries } from "../../editor/assets/AssetModelLoader.js";

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
    const [closingAssetTab, setClosingAssetTab] = useState(null);
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
    const workspace = editorSnapshot?.workspace ?? { activeTabId: "scene", assetTabs: [] };
    const activeAssetTab = workspace.assetTabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
    const sceneTabActive = !activeAssetTab;
    const inMap = editorMode === EDITOR_MODES.MAP && sceneTabActive;
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
                    {activeAssetTab ? <AssetStudioHierarchy data={data} tab={activeAssetTab} /> : <SceneHierarchy data={data} />}
                </WorkspacePane>
            )}
            {!panesHidden && splitter("hierarchy", "row-start-2 col-start-2")}

            <section
                aria-label={activeAssetTab ? "Asset preview" : (inMap ? "Map view" : "Scene view")}
                data-editor-center
                className="relative flex min-h-0 min-w-0 flex-col"
                style={{ gridColumn: panesHidden ? 1 : 3, gridRow: 2 }}
                onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-cev-editor-asset")) event.preventDefault(); }}
                onDrop={(event) => {
                    const raw = event.dataTransfer.getData("application/x-cev-editor-asset");
                    if (!raw) return;
                    event.preventDefault();
                    try {
                        const dropped = JSON.parse(raw);
                        if (activeAssetTab) {
                            const session = data.environment?.()?.assets?.()?.sessions?.get?.(activeAssetTab.id);
                            if (!session || dropped.kind !== "catalog") return;
                            const base = `ref-${String(dropped.assetId).replace(/[^A-Za-z0-9._-]/g, "-")}`;
                            let suffix = 1; let id = base;
                            while (session.document.getPart(id)) { suffix += 1; id = `${base}-${suffix}`; }
                            const runtime = data.environment?.()?.assets?.();
                            void (async () => {
                                const child = await runtime.repository.getRevision(dropped.assetId, dropped.revision);
                                const lease = await runtime.models.acquire(child.modelUseHash);
                                try {
                                    session.resolvedChildren[`${dropped.assetId}@${dropped.revision}`] = {
                                        ...child, geometry: Object.fromEntries(extractAssetSourceGeometries(lease)),
                                    };
                                    session.bus.execute(assetStudioCommands.addPart({
                                        id, parentId: null, order: session.document.parts.length,
                                        name: String(dropped.label ?? dropped.assetId),
                                        transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                                        content: { kind: "asset-reference", assetId: String(dropped.assetId), revision: Number(dropped.revision) },
                                        appearanceVisible: true, materialBindings: {},
                                    }));
                                } finally { lease.release(); }
                            })().catch((error) => {
                                session.error = error;
                                session.notify();
                            });
                        } else void data.environment?.()?.toolController?.dropAsset?.(dropped, event, event.currentTarget.getBoundingClientRect());
                    } catch { /* malformed external drag */ }
                }}
            >
                {!panesHidden && sceneTabActive && <EditorToolbar data={data} />}
                {!panesHidden && (
                    <nav aria-label="Workspace tabs" className="pointer-events-auto flex h-8 shrink-0 items-end gap-0.5 border-b border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] px-1">
                        <button type="button" aria-current={sceneTabActive ? "page" : undefined} onClick={() => data.editor?.()?.setWorkspaceTab?.("scene")} className="h-7 rounded-t px-3 text-xs hover:bg-[var(--slate-surface-hover)]">Scene</button>
                        {workspace.assetTabs.map((tab) => <span key={tab.id} className="flex h-7 items-center rounded-t bg-[var(--slate-surface-2)]">
                            <button type="button" aria-current={workspace.activeTabId === tab.id ? "page" : undefined} onClick={() => data.editor?.()?.setWorkspaceTab?.(tab.id)} onDoubleClick={() => data.editor?.()?.pinAssetTab?.(tab.id)} className="h-full max-w-40 truncate px-2 text-xs">{tab.name} · r{tab.revision}{tab.dirty ? " *" : tab.pinned ? " •" : ""}</button>
                            <button type="button" aria-label={`Close ${tab.name} studio`} onClick={() => {
                                const session = data.environment?.()?.assets?.()?.sessions?.get?.(tab.id);
                                if (tab.dirty || session?.dirty) { setClosingAssetTab({ ...tab, dirty: true }); return; }
                                if (data.editor?.()?.closeAssetTab?.(tab.id)) data.environment?.()?.assets?.()?.sessions?.close?.(tab.id, { discard: true });
                            }} className="h-full px-1.5 text-zinc-400 hover:text-zinc-100">×</button>
                        </span>)}
                    </nav>
                )}
                <div ref={canvasHostRef} data-editor-canvas-host className="relative min-h-0 min-w-0 flex-1">
                    {inMap && (
                        <MapSurface
                            data={data}
                            editorSnapshot={editorSnapshot}
                            documentSnapshot={documentSnapshot ?? emptyDocument}
                            mapSelection={mapSelection}
                        />
                    )}
                    {activeAssetTab && <AssetPreviewTab key={activeAssetTab.id} data={data} tab={activeAssetTab} />}
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
                        {activeAssetTab ? <AssetCatalogInspector data={data} tab={activeAssetTab} /> : <ObjectInspector data={data} />}
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
            {closingAssetTab && <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation">
                <div role="dialog" aria-modal="true" aria-labelledby="asset-close-title" className="w-96 rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
                    <h2 id="asset-close-title" className="text-sm font-medium text-zinc-100">Save changes to {closingAssetTab.name}?</h2>
                    <p className="mt-2 text-xs text-zinc-400">This asset studio has unpublished changes.</p>
                    <div className="mt-4 flex justify-end gap-2">
                        <button type="button" onClick={() => setClosingAssetTab(null)} className="rounded border border-zinc-700 px-3 py-1.5 text-xs">Cancel</button>
                        <button type="button" onClick={() => {
                            data.environment?.()?.assets?.()?.sessions?.close?.(closingAssetTab.id, { discard: true });
                            data.editor?.()?.closeAssetTab?.(closingAssetTab.id, { discard: true });
                            setClosingAssetTab(null);
                        }} className="rounded border border-zinc-700 px-3 py-1.5 text-xs">Discard</button>
                        <button type="button" onClick={() => {
                            const session = data.environment?.()?.assets?.()?.sessions?.get?.(closingAssetTab.id);
                            void session?.save({ publicationId: globalThis.crypto?.randomUUID?.() ?? `publication-${Date.now()}` }).then(() => {
                                data.environment?.()?.assets?.()?.sessions?.close?.(closingAssetTab.id, { discard: true });
                                data.editor?.()?.closeAssetTab?.(closingAssetTab.id, { discard: true });
                                setClosingAssetTab(null);
                            }).catch(() => {});
                        }} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">Save</button>
                    </div>
                </div>
            </div>}
        </div>
    );
}

export { PANE_IDS };
