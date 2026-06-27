'use client';

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import {
    FaArrowsAlt,
    FaCrosshairs,
    FaEye,
    FaEyeSlash,
    FaMousePointer,
    FaRedo,
    FaSlidersH,
    FaTimes,
} from "react-icons/fa";
import { EDITOR_TOOLS } from "../editor/EditorState";
import { MenuButton } from "./ui/MenuButton";

const INSPECTOR_CONTROL_LOCK = "environment-object-inspector";

function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(digits);
}

function formatVector(vector) {
    if (!vector) return "0, 0, 0";
    return [
        formatNumber(vector.x),
        formatNumber(vector.y),
        formatNumber(vector.z),
    ].join(", ");
}

function getMetrics(object3D) {
    if (!object3D) return null;

    const box = new THREE.Box3().setFromObject(object3D);
    if (box.isEmpty()) return null;

    const size = new THREE.Vector3();
    box.getSize(size);
    return size;
}

function Field({ label, value, mono = false }) {
    return (
        <div className="rounded-lg border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
            <p className={`${mono ? "font-mono" : ""} mt-0.5 truncate text-[11px] text-zinc-200`} title={String(value ?? "")}>
                {value ?? "None"}
            </p>
        </div>
    );
}

export function ObjectInspector({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [registrySnapshot, setRegistrySnapshot] = useState({ entities: [] });

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(INSPECTOR_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(INSPECTOR_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);
    useEffect(() => data?.environment?.()?.objects?.()?.subscribe?.(setRegistrySnapshot), [data]);

    if (!data) return null;

    const registry = data.environment()?.objects?.();
    const selectedId = editorSnapshot?.selection?.id ?? null;
    const entity = selectedId ? registry?.getEntity?.(selectedId) : null;
    const entitySummary = registrySnapshot.entities.find((item) => item.id === selectedId);
    const activeTool = editorSnapshot?.activeTool ?? EDITOR_TOOLS.SELECT;
    const metrics = getMetrics(entity?.object3D);
    const transform = entity?.object3D
        ? {
            position: entity.object3D.position,
            rotation: entity.object3D.rotation,
            scale: entity.object3D.scale,
        }
        : entitySummary?.transform;

    const clearSelection = () => {
        data.editor()?.clearSelection();
        data.simulation()?.render?.();
    };

    const setTool = (tool) => {
        data.editor()?.setActiveTool?.(tool);
        data.simulation()?.render?.();
    };

    const setVisible = (visible) => {
        if (!entity) return;
        registry.setEntityVisible(entity.id, visible);
        data.editor()?.setEntityHidden(entity.id, !visible);

        if (entity.kind === "building" && entity.sourceId) {
            if (visible) {
                data.splats?.()?.hiddenBuildings?.delete?.(entity.sourceId);
            } else {
                data.splats?.()?.hiddenBuildings?.add?.(entity.sourceId);
            }
        }

        data.simulation()?.render?.();
    };

    const focusCamera = () => {
        if (!entity?.object3D) return;
        const camera = data.three()?.camera;
        const controlsObject = data.simulation()?.controls;
        const box = new THREE.Box3().setFromObject(entity.object3D);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);

        const distance = Math.max(size.x, size.y, size.z, 4) * 1.8;
        camera.position.set(center.x + distance, center.y + distance, center.z + distance);
        camera.lookAt(center);
        controlsObject?.target?.copy?.(center);
        controlsObject?.update?.();
        data.simulation()?.render?.();
    };

    return (
        <div
            className="absolute right-3 top-3 z-30 w-[336px] rounded-2xl border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl pointer-events-auto max-[760px]:left-3 max-[760px]:right-auto max-[760px]:top-[536px] max-[760px]:w-[min(336px,calc(100vw-24px))]"
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
        >
            <div className="mb-2 flex items-start justify-between rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-2">
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Inspector</p>
                    <p className="mt-0.5 truncate text-[13px] font-semibold text-zinc-100">
                        {entitySummary?.label ?? "No object selected"}
                    </p>
                    {entitySummary && (
                        <p className="truncate font-mono text-[10px] text-zinc-500" title={entitySummary.id}>
                            {entitySummary.id}
                        </p>
                    )}
                </div>
                {entitySummary && (
                    <MenuButton
                        iconOnly
                        variant="ghost"
                        className="h-7 w-7 rounded-lg"
                        onClick={clearSelection}
                        title="Clear selection"
                        ariaLabel="Clear selection"
                    >
                        <FaTimes className="h-3 w-3" />
                    </MenuButton>
                )}
            </div>

            {!entitySummary ? (
                <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/45 p-3 text-[11px] text-zinc-400">
                    Select an object in the scene or hierarchy to inspect and edit it.
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-1.5">
                        <Field label="Kind" value={entitySummary.kind} />
                        <Field label="Layer" value={entitySummary.layer} />
                        <Field label="Primary Chunk" value={entitySummary.primaryChunk ?? "None"} mono />
                        <Field label="Covered Chunks" value={(entitySummary.coveredChunks ?? []).join(" ") || "None"} mono />
                    </div>

                    <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/45 p-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Transform</p>
                            <div className="flex items-center gap-1">
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.SELECT} className="h-7 w-7 rounded-lg" onClick={() => setTool(EDITOR_TOOLS.SELECT)} title="Select">
                                    <FaMousePointer className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.TRANSLATE} className="h-7 w-7 rounded-lg" onClick={() => setTool(EDITOR_TOOLS.TRANSLATE)} title="Move">
                                    <FaArrowsAlt className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.ROTATE} className="h-7 w-7 rounded-lg" onClick={() => setTool(EDITOR_TOOLS.ROTATE)} title="Rotate">
                                    <FaRedo className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.SCALE} className="h-7 w-7 rounded-lg" onClick={() => setTool(EDITOR_TOOLS.SCALE)} title="Scale">
                                    <FaSlidersH className="h-3 w-3" />
                                </MenuButton>
                            </div>
                        </div>
                        <div className="grid gap-1.5">
                            <Field label="Position" value={formatVector(transform?.position)} mono />
                            <Field label="Rotation" value={formatVector(transform?.rotation)} mono />
                            <Field label="Scale" value={formatVector(transform?.scale)} mono />
                        </div>
                    </div>

                    {metrics && (
                        <div className="grid grid-cols-3 gap-1.5">
                            <Field label="Width" value={formatNumber(metrics.x, 1)} mono />
                            <Field label="Height" value={formatNumber(metrics.y, 1)} mono />
                            <Field label="Depth" value={formatNumber(metrics.z, 1)} mono />
                        </div>
                    )}

                    {entitySummary.tags?.length > 0 && (
                        <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/45 p-2">
                            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Tags</p>
                            <div className="flex flex-wrap gap-1">
                                {entitySummary.tags.map((tag) => (
                                    <span key={tag} className="rounded-md border border-zinc-700/80 bg-zinc-950/70 px-1.5 py-0.5 text-[10px] text-zinc-300">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between gap-2 rounded-xl border border-zinc-800/90 bg-zinc-900/45 p-2">
                        <MenuButton compact variant="default" onClick={focusCamera} title="Focus camera on selection">
                            <FaCrosshairs className="h-3 w-3" />
                            Focus
                        </MenuButton>
                        {entitySummary.hidden || entitySummary.visible === false ? (
                            <MenuButton compact variant="primary" onClick={() => setVisible(true)} title="Show selected object">
                                <FaEye className="h-3 w-3" />
                                Show
                            </MenuButton>
                        ) : (
                            <MenuButton compact variant="danger" onClick={() => setVisible(false)} title="Hide selected object">
                                <FaEyeSlash className="h-3 w-3" />
                                Hide
                            </MenuButton>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
