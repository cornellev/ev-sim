'use client';

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
    IconWorld as FaGlobeAmericas,
    IconRoad as FaRoad,
    IconX as FaTimes,
    IconArrowsMaximize as FaExpand,
} from "@tabler/icons-react";
import {
    EARTH_IMPORT_STATUS,
    EDITOR_MODES,
} from "../../editor/EditorState";
import {
    editorStateToGeoBounds,
    geoBoundsToEarthImportPatch,
    summarizeBounds,
} from "../../earth/map/GeoBoundsSelection.js";
import {
    getGoogleMapsApiKey,
    ROAD_PROVIDER_IDS,
} from "../../earth/EarthImportConfig";
import {
    EarthImportMapPicker,
    EarthImportMapPickerOverlay,
} from "./EarthImportMapPicker";
import { FlyoutPanel } from "../ui/FlyoutPanel";
import { MenuButton } from "../ui/MenuButton";
import { MenuToggle } from "../ui/MenuToggle";
import { PanelSection } from "../ui/PanelSection";

const MENU_CONTROL_LOCK = "earth-import-editor";
const MAP_PICKER_CONTROL_LOCK = "earth-import-map-picker";

function normalizeAttributionEntry(entry) {
    if (typeof entry === "string") return { type: "string", value: entry };
    return entry ?? null;
}

function NumberField({ label, value, onChange, step = "any", readOnly = false }) {
    return (
        <label className="grid gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{label}</span>
            <input
                type="number"
                step={step}
                value={value}
                readOnly={readOnly}
                onChange={readOnly ? undefined : (event) => onChange(Number(event.target.value))}
                className={[
                    "rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/90 px-2 py-1.5 text-[11px] text-zinc-100 outline-none focus:border-emerald-400/60",
                    readOnly ? "cursor-default text-zinc-400" : "",
                ].join(" ")}
            />
        </label>
    );
}

function StatusBadge({ status, message, busy = false }) {
    const isError = status === EARTH_IMPORT_STATUS.ERROR;
    const isLoading = busy
        || status === EARTH_IMPORT_STATUS.LOADING_TILES
        || status === EARTH_IMPORT_STATUS.LOADING_ROADS;
    const isReady = status === EARTH_IMPORT_STATUS.PREVIEW
        || status === EARTH_IMPORT_STATUS.APPLIED;

    return (
        <div
            className={[
                "rounded-[var(--radius)] border px-2.5 py-2 text-[11px]",
                isError
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-100"
                    : isLoading
                        ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                        : isReady
                            ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100"
                            : "border-zinc-700/80 bg-zinc-900/70 text-zinc-300",
            ].join(" ")}
        >
            <p className="font-semibold uppercase tracking-[0.14em]">
                {isError ? "Import Error" : isLoading ? "Importing" : isReady ? "Import Ready" : "Idle"}
            </p>
            {message && <p className="mt-1 leading-snug">{message}</p>}
        </div>
    );
}

export function EarthImportModeChrome({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const [busy, setBusy] = useState(false);
    const [attributions, setAttributions] = useState([]);
    const [showAdvancedCoords, setShowAdvancedCoords] = useState(false);
    const [mapExpanded, setMapExpanded] = useState(false);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(MENU_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(MENU_CONTROL_LOCK),
            disableMap: () => settings?.disableControls?.(MAP_PICKER_CONTROL_LOCK),
            enableMap: () => settings?.enableControls?.(MAP_PICKER_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        if (!document?.subscribe) return undefined;
        return document.subscribe(setDocumentSnapshot);
    }, [data]);

    useEffect(() => {
        const interval = setInterval(() => {
            const manager = data?.earthTilesManager?.();
            if (!manager) return;
            setAttributions(manager.attributions ?? []);
        }, 1000);
        return () => clearInterval(interval);
    }, [data]);

    useEffect(() => {
        const keys = data?.keys?.();
        if (!keys) return undefined;

        const dispose = keys.registerKeyDown?.("Escape", () => {
            const editor = data.editor();
            if (editor.snapshot().editorMode !== EDITOR_MODES.EARTH_IMPORT) return;

            if (mapExpanded) {
                setMapExpanded(false);
                return;
            }

            const controller = data.earthImportController?.();
            if (editor.snapshot().earthImport.previewActive) {
                controller?.cancelPreview?.();
                return;
            }

            editor.setEditorMode(EDITOR_MODES.SCENE);
        });

        return () => dispose?.();
    }, [data, mapExpanded]);

    if (!editorSnapshot || editorSnapshot.editorMode !== EDITOR_MODES.EARTH_IMPORT) {
        return null;
    }

    const earthImport = editorSnapshot.earthImport;
    const boundsSummary = summarizeBounds(editorStateToGeoBounds(earthImport));
    const apiKeyConfigured = Boolean(getGoogleMapsApiKey());
    const canImport = apiKeyConfigured && boundsSummary.valid && !busy;
    const controller = data?.earthImportController?.();
    const patch = (values) => data.editor().patchEarthImport(values);
    const patchBounds = (partial) => {
        const next = { ...editorStateToGeoBounds(earthImport), ...partial };
        patch(geoBoundsToEarthImportPatch(next));
    };
    const attributionEntries = attributions.map(normalizeAttributionEntry).filter((entry) => entry?.value);
    const attributionImages = attributionEntries.filter((entry) => entry.type === "image");
    const attributionText = attributionEntries
        .filter((entry) => entry.type !== "image")
        .map((entry) => entry.value)
        .join(" · ");

    const runPreview = async () => {
        if (!controller) {
            console.warn("Earth import controller is not ready yet.");
            return;
        }
        if (!canImport) return;
        setBusy(true);
        try {
            await controller.preview();
        } catch (error) {
            console.error("Earth import preview failed:", error);
        } finally {
            setBusy(false);
        }
    };

    const runApply = async () => {
        if (!controller) {
            console.warn("Earth import controller is not ready yet.");
            return;
        }
        if (!canImport) return;
        setBusy(true);
        try {
            await controller.apply();
        } catch (error) {
            console.error("Earth import apply failed:", error);
        } finally {
            setBusy(false);
        }
    };

    const exitMode = () => data.editor().setEditorMode(EDITOR_MODES.SCENE);

    return (
        <>
            {mapExpanded && (
                <EarthImportMapPickerOverlay
                    earthImport={earthImport}
                    onPatch={patch}
                    onClose={() => setMapExpanded(false)}
                    onInteractionStart={controls.disableMap}
                    onInteractionEnd={controls.enableMap}
                />
            )}

            <div className="fixed right-3 top-3 z-[20] flex w-[340px] flex-col gap-2 pointer-events-auto">
                <div
                    className="earth-import-map-shell rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/95 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)]"
                    onMouseDown={controls.disableMap}
                    onMouseUp={controls.enableMap}
                    onMouseLeave={controls.enableMap}
                >
                    <div className="mb-2 flex items-center justify-between gap-2 border-b border-zinc-700/80 pb-2">
                        <div>
                            <p className="text-[11px] font-semibold tracking-wide text-zinc-100">Import Area</p>
                            <p className="mt-0.5 text-[11px] text-zinc-400">Draw bounds on OpenStreetMap</p>
                        </div>
                        <MenuButton
                            compact
                            onClick={() => setMapExpanded(true)}
                            title="Expand map picker"
                            ariaLabel="Expand map picker"
                        >
                            <FaExpand className="h-3 w-3" />
                            Expand
                        </MenuButton>
                    </div>
                    {!mapExpanded && (
                        <EarthImportMapPicker
                            earthImport={earthImport}
                            onPatch={patch}
                            onInteractionStart={controls.disableMap}
                            onInteractionEnd={controls.enableMap}
                        />
                    )}
                </div>

                <div
                    onMouseDown={controls.disable}
                    onMouseUp={controls.enable}
                    onMouseLeave={controls.enable}
                >
                    <FlyoutPanel
                        title="Google Earth Import"
                        subtitle="Select an area on the map, then preview or apply"
                    >
                        <PanelSection title="Status">
                            <StatusBadge
                                status={earthImport.status}
                                message={earthImport.statusMessage}
                                busy={busy}
                            />
                            <div className="rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 px-2.5 py-2 text-[11px] text-zinc-300">
                                <p className="font-semibold uppercase tracking-[0.12em] text-zinc-400">API Key</p>
                                <p className="mt-1">
                                    {apiKeyConfigured
                                        ? "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is configured."
                                        : "Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY."}
                                </p>
                            </div>
                            {!boundsSummary.valid && (
                                <p className="text-[11px] leading-snug text-rose-200">
                                    {boundsSummary.error}
                                </p>
                            )}
                        </PanelSection>

                        <PanelSection title="Anchor">
                            <div className="grid grid-cols-2 gap-2">
                                <NumberField
                                    label="Latitude"
                                    value={earthImport.anchorLat}
                                    readOnly
                                    step="0.0001"
                                />
                                <NumberField
                                    label="Longitude"
                                    value={earthImport.anchorLng}
                                    readOnly
                                    step="0.0001"
                                />
                            </div>
                            <p className="text-[11px] leading-snug text-zinc-500">
                                Computed from the center of the selected bounds at preview/apply time.
                            </p>
                        </PanelSection>

                        <PanelSection title="Advanced Coordinates">
                            <MenuButton
                                compact
                                onClick={() => setShowAdvancedCoords((value) => !value)}
                                title={showAdvancedCoords ? "Hide coordinate fields" : "Show coordinate fields"}
                            >
                                {showAdvancedCoords ? "Hide bounds fields" : "Edit bounds manually"}
                            </MenuButton>
                            {showAdvancedCoords && (
                                <div className="grid grid-cols-2 gap-2">
                                    <NumberField
                                        label="North"
                                        value={earthImport.boundsNorth}
                                        onChange={(value) => patchBounds({ north: value })}
                                        step="0.0001"
                                    />
                                    <NumberField
                                        label="South"
                                        value={earthImport.boundsSouth}
                                        onChange={(value) => patchBounds({ south: value })}
                                        step="0.0001"
                                    />
                                    <NumberField
                                        label="East"
                                        value={earthImport.boundsEast}
                                        onChange={(value) => patchBounds({ east: value })}
                                        step="0.0001"
                                    />
                                    <NumberField
                                        label="West"
                                        value={earthImport.boundsWest}
                                        onChange={(value) => patchBounds({ west: value })}
                                        step="0.0001"
                                    />
                                </div>
                            )}
                        </PanelSection>

                        <PanelSection title="Quality">
                            <NumberField
                                label="Max Screen Space Error"
                                value={earthImport.maxScreenSpaceError}
                                onChange={(value) => {
                                    patch({ maxScreenSpaceError: value });
                                    data.earthTilesManager?.()?.setMaxScreenSpaceError?.(value);
                                }}
                                step="1"
                            />
                        </PanelSection>

                        <PanelSection title="Road Network">
                            <label className="grid gap-1">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                                    Provider
                                </span>
                                <select
                                    value={earthImport.roadProvider}
                                    onChange={(event) => patch({ roadProvider: event.target.value })}
                                    className="rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/90 px-2 py-1.5 text-[11px] text-zinc-100 outline-none focus:border-emerald-400/60"
                                >
                                    <option value={ROAD_PROVIDER_IDS.OVERPASS}>OpenStreetMap (Overpass)</option>
                                    <option value={ROAD_PROVIDER_IDS.GOOGLE} disabled>Google Roads (coming soon)</option>
                                    <option value={ROAD_PROVIDER_IDS.MESH} disabled>Mesh extraction (coming soon)</option>
                                </select>
                            </label>
                            <MenuToggle
                                label="Show imported roads"
                                icon={<FaRoad className="h-3 w-3" />}
                                checked={earthImport.roadsVisible}
                                onChange={(value) => {
                                    patch({ roadsVisible: value });
                                    data.editor().setLayerVisible("roads", value);
                                    data.environment().objects().setLayerVisible("roads", value);
                                    data.simulation()?.render?.();
                                }}
                                hint="Roads are staged in the document and appear after Apply"
                            />
                            <MenuToggle
                                label="Show Earth tiles"
                                icon={<FaGlobeAmericas className="h-3 w-3" />}
                                checked={earthImport.tilesVisible}
                                onChange={(value) => {
                                    patch({ tilesVisible: value });
                                    data.earthTilesManager?.()?.setVisible?.(value);
                                }}
                                hint="Toggle photorealistic tile meshes"
                            />
                        </PanelSection>

                        {documentSnapshot?.earth && (
                            <PanelSection title="Applied Source">
                                <p className="text-[11px] text-zinc-400">
                                    Last import: {documentSnapshot.earth.importedAt ?? "unknown"}
                                </p>
                                <p className="text-[11px] text-zinc-500">
                                    Layers: {documentSnapshot.earth.importedLayerIds.join(", ") || "none"}
                                </p>
                            </PanelSection>
                        )}

                        <PanelSection title="Actions">
                            {(earthImport.previewActive
                                || earthImport.status === EARTH_IMPORT_STATUS.PREVIEW) && (
                                <p className="text-[11px] leading-snug text-zinc-500">
                                    Red boundary marks the selected import area. Tiles may extend beyond it.
                                </p>
                            )}
                            <div className="grid grid-cols-2 gap-1.5">
                                <MenuButton
                                    compact
                                    disabled={!canImport}
                                    onClick={runPreview}
                                    title="Load tiles and roads without committing"
                                >
                                    Preview
                                </MenuButton>
                                <MenuButton
                                    compact
                                    variant="primary"
                                    disabled={!canImport}
                                    onClick={runApply}
                                    title="Import tiles and roads into the environment"
                                >
                                    Apply
                                </MenuButton>
                            </div>
                        </PanelSection>
                    </FlyoutPanel>
                </div>
            </div>

            {attributionEntries.length > 0 && (
                <div className="fixed bottom-3 left-3 right-[360px] z-[20] pointer-events-none">
                    <div className="mx-auto flex max-w-4xl items-center justify-center gap-2 rounded-[var(--radius)] border border-zinc-700/70 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-300">
                        {attributionImages.map((entry) => (
                            <Image
                                key={entry.value}
                                unoptimized
                                width={80}
                                height={16}
                                src={entry.value}
                                alt={entry.alt ?? "Google"}
                                className="h-4 w-auto rounded-sm bg-white px-1 py-0.5"
                            />
                        ))}
                        {attributionText && <span>{attributionText}</span>}
                    </div>
                </div>
            )}

            <div className="fixed bottom-0 left-0 right-0 z-[20] px-3 pb-3 pointer-events-auto">
                <div
                    className="relative mx-auto w-fit"
                    onMouseDown={controls.disable}
                    onMouseUp={controls.enable}
                    onMouseLeave={controls.enable}
                >
                    <div className="flex items-center gap-2 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/70 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)]">
                        <div className="rounded-[var(--radius)] border border-sky-500/40 bg-sky-500/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-100">
                            Earth Import
                        </div>
                        <div className="h-7 w-px bg-zinc-700/80" />
                        <MenuButton
                            compact
                            onClick={runPreview}
                            disabled={!canImport}
                            title="Preview import"
                        >
                            Preview
                        </MenuButton>
                        <MenuButton
                            compact
                            variant="primary"
                            onClick={runApply}
                            disabled={!canImport}
                            title="Apply import"
                        >
                            Apply
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={exitMode}
                            title="Exit Earth import mode (Esc)"
                            ariaLabel="Exit Earth import mode"
                        >
                            <FaTimes className="h-3 w-3" />
                        </MenuButton>
                    </div>
                </div>
            </div>
        </>
    );
}
