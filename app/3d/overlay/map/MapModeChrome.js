'use client';

import { useEffect, useMemo, useState } from "react";
import {
    FaArrowsAlt,
    FaBuilding,
    FaHandPaper,
    FaMap,
    FaMousePointer,
    FaRoad,
    FaTh,
    FaTimes,
    FaTrafficLight,
} from "react-icons/fa";
import {
    EDITOR_LAYERS,
    EDITOR_MODES,
    MAP_TOOLS,
} from "../../editor/EditorState";
import { PLACEMENT_CATALOG } from "../../editor/placement/PlacementCatalog";
import { cancelRoadPen, finalizeRoadPen, handleMapDelete } from "../../editor/map/MapToolLogic";
import {
    fitMapViewportToContent,
    hydrateDocumentFromRuntime,
} from "../../editor/document/documentRuntimeHydration";
import { MapInspector } from "./MapInspector";
import { MapSurface } from "./MapSurface";
import { FlyoutPanel } from "../ui/FlyoutPanel";
import { MenuButton } from "../ui/MenuButton";
import { MenuToggle } from "../ui/MenuToggle";
import { PanelSection } from "../ui/PanelSection";

const MENU_CONTROL_LOCK = "map-editor-menu";

export function MapModeChrome({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const [openPanel, setOpenPanel] = useState(null);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(MENU_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(MENU_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        if (!document?.subscribe) return undefined;
        return document.subscribe(setDocumentSnapshot);
    }, [data]);

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

    useEffect(() => {
        const keys = data?.keys?.();
        if (!keys) return undefined;

        const disposers = [
            keys.registerKeyDown?.("Escape", () => {
                const editor = data.editor();
                const draft = editor.snapshot().map.draft;
                if (draft?.type === "road-pen") {
                    cancelRoadPen(editor);
                    return;
                }
                if (draft) {
                    editor.clearMapDraft();
                    return;
                }
                if (editor.snapshot().map.selection) {
                    editor.clearMapSelection();
                    return;
                }
                editor.setEditorMode(EDITOR_MODES.SCENE);
            }),
            keys.registerKeyDown?.("Enter", () => {
                const editor = data.editor();
                if (editor.snapshot().map.draft?.type === "road-pen") {
                    finalizeRoadPen(editor);
                }
            }),
            keys.registerKeyDown?.("Delete", () => {
                const editor = data.editor();
                const selection = editor.snapshot().map.selection;
                if (!selection) return;

                const environment = data.environment?.();
                const scene = data?.three?.()?.scene ?? data?.scene ?? null;
                if (!environment || !scene) return;

                handleMapDelete({
                    document: environment.getDocument(),
                    editor,
                    data,
                    scene,
                    selection,
                });
            }),
        ].filter(Boolean);

        return () => disposers.forEach((dispose) => dispose?.());
    }, [data]);

    if (!editorSnapshot || editorSnapshot.editorMode !== EDITOR_MODES.MAP) {
        return null;
    }

    const map = editorSnapshot.map;
    const layers = editorSnapshot.layers;
    const activeTool = map.activeMapTool;

    const setTool = (tool) => data?.editor?.()?.setActiveMapTool?.(tool);
    const setFeature = (type) => data?.editor?.()?.setMapFeatureType?.(type);
    const exitMap = () => data?.editor?.()?.setEditorMode?.(EDITOR_MODES.SCENE);

    return (
        <>
            <MapSurface
                data={data}
                editorSnapshot={editorSnapshot}
                documentSnapshot={documentSnapshot ?? { roads: { nodes: [], edges: [] }, buildings: [], features: [] }}
            />

            <MapInspector
                data={data}
                editorSnapshot={editorSnapshot}
                documentSnapshot={documentSnapshot ?? { roads: { nodes: [], edges: [] }, buildings: [], features: [] }}
            />

            <div className="fixed bottom-0 left-0 right-0 z-[20] px-3 pb-3 pointer-events-auto">
                <div
                    className="relative mx-auto w-fit"
                    onMouseDown={controls.disable}
                    onMouseUp={controls.enable}
                    onMouseLeave={controls.enable}
                >
                    {openPanel && (
                        <div className="absolute bottom-[calc(100%+10px)] right-0">
                            {openPanel === "layers" && (
                                <FlyoutPanel title="Map Layers" subtitle="Toggle footprint visibility">
                                    <PanelSection title="Content">
                                        <MenuToggle
                                            label="Buildings"
                                            icon={<FaBuilding className="h-3 w-3" />}
                                            checked={layers.buildings}
                                            onChange={(value) => {
                                                data.editor().setLayerVisible(EDITOR_LAYERS.BUILDINGS, value);
                                                data.environment().objects().setLayerVisible(EDITOR_LAYERS.BUILDINGS, value);
                                            }}
                                            hint="Building footprints"
                                        />
                                        <MenuToggle
                                            label="Roads"
                                            icon={<FaRoad className="h-3 w-3" />}
                                            checked={layers.roads}
                                            onChange={(value) => {
                                                data.editor().setLayerVisible(EDITOR_LAYERS.ROADS, value);
                                                data.environment().objects().setLayerVisible(EDITOR_LAYERS.ROADS, value);
                                            }}
                                            hint="Road centerlines and intersections"
                                        />
                                        <MenuToggle
                                            label="Features"
                                            icon={<FaTh className="h-3 w-3" />}
                                            checked={layers.props}
                                            onChange={(value) => {
                                                data.editor().setLayerVisible(EDITOR_LAYERS.PROPS, value);
                                                data.environment().objects().setLayerVisible(EDITOR_LAYERS.PROPS, value);
                                            }}
                                            hint="Signs, barrels, and markers"
                                        />
                                        <MenuToggle
                                            label="Grid"
                                            icon={<FaTh className="h-3 w-3" />}
                                            checked={map.gridVisible}
                                            onChange={(value) => data.editor().setMapGridVisible(value)}
                                            hint="20m chunk grid"
                                        />
                                        <MenuToggle
                                            label="Snap"
                                            icon={<FaArrowsAlt className="h-3 w-3" />}
                                            checked={map.snapEnabled}
                                            onChange={(value) => data.editor().setMapSnapEnabled(value)}
                                            hint="Snap placements to grid"
                                        />
                                    </PanelSection>
                                </FlyoutPanel>
                            )}

                            {openPanel === "features" && (
                                <FlyoutPanel title="Place Features" subtitle="Click map to place markers">
                                    <PanelSection title="Catalog">
                                        <div className="grid grid-cols-2 gap-1.5">
                                            {PLACEMENT_CATALOG.map((asset) => (
                                                <MenuButton
                                                    key={asset.id}
                                                    compact
                                                    active={activeTool === MAP_TOOLS.FEATURE_PLACE && map.activeFeatureType === asset.id}
                                                    className="justify-start"
                                                    onClick={() => setFeature(asset.id)}
                                                    title={`Place ${asset.label}`}
                                                >
                                                    <span
                                                        className="h-2 w-2 shrink-0 rounded-full"
                                                        style={{ backgroundColor: asset.mapColor }}
                                                    />
                                                    {asset.label}
                                                </MenuButton>
                                            ))}
                                        </div>
                                    </PanelSection>
                                </FlyoutPanel>
                            )}
                        </div>
                    )}

                    <div className="flex items-center gap-2 rounded-2xl border border-zinc-700/80 bg-zinc-950/70 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
                        <div className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-100">
                            Map Mode
                        </div>

                        <div className="h-7 w-px bg-zinc-700/80" />

                        <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
                            <MenuButton
                                iconOnly
                                active={activeTool === MAP_TOOLS.SELECT}
                                onClick={() => setTool(MAP_TOOLS.SELECT)}
                                title="Select"
                                ariaLabel="Select"
                            >
                                <FaMousePointer className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={activeTool === MAP_TOOLS.PAN}
                                onClick={() => setTool(MAP_TOOLS.PAN)}
                                title="Pan (or hold Alt)"
                                ariaLabel="Pan"
                            >
                                <FaHandPaper className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={activeTool === MAP_TOOLS.INTERSECTION}
                                onClick={() => setTool(MAP_TOOLS.INTERSECTION)}
                                title="Place intersection"
                                ariaLabel="Intersection"
                            >
                                <FaTrafficLight className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={activeTool === MAP_TOOLS.ROAD_PEN}
                                onClick={() => setTool(MAP_TOOLS.ROAD_PEN)}
                                title="Road pen — click nodes and intersections"
                                ariaLabel="Road pen"
                            >
                                <FaRoad className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={activeTool === MAP_TOOLS.BUILDING_RECT}
                                onClick={() => setTool(MAP_TOOLS.BUILDING_RECT)}
                                title="Building rectangle"
                                ariaLabel="Building rectangle"
                            >
                                <FaBuilding className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={openPanel === "features"}
                                onClick={() => setOpenPanel((current) => (current === "features" ? null : "features"))}
                                title="Place features"
                                ariaLabel="Features"
                            >
                                <FaMap className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                active={openPanel === "layers"}
                                onClick={() => setOpenPanel((current) => (current === "layers" ? null : "layers"))}
                                title="Layers and snap"
                                ariaLabel="Layers"
                            >
                                <FaTh className="h-3 w-3" />
                            </MenuButton>
                            <MenuButton
                                iconOnly
                                onClick={exitMap}
                                title="Exit map mode"
                                ariaLabel="Exit map"
                            >
                                <FaTimes className="h-3 w-3" />
                            </MenuButton>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
