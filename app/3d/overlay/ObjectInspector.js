'use client';

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import {
    IconArrowsMove as FaArrowsAlt,
    IconCrosshair as FaCrosshairs,
    IconEye as FaEye,
    IconEyeOff as FaEyeSlash,
    IconPointer as FaMousePointer,
    IconRotateClockwise as FaRedo,
    IconAdjustmentsHorizontal as FaSlidersH,
    IconTrash,
    IconX as FaTimes,
} from "@tabler/icons-react";
import { EDITOR_TOOLS } from "../editor/EditorState";
import { objectCommands } from "../editor/commands/index.js";
import { editorPresentationRegistry } from "../editor/presentation/EditorPresentationRegistry.js";
import { deltaBetweenFrames } from "../editor/objects/transformDelta.js";
import { resolveTransformTargets } from "../editor/tools/TransformTool.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";
import { readGroupFrameFieldsPreference } from "../../ui/environmentEditorPreferences.js";
import { MenuButton } from "./ui/MenuButton";
import { PresentationIcon, registerBuiltinPresentations } from "./presentation/builtinPresentations.js";

const INSPECTOR_CONTROL_LOCK = "environment-object-inspector";

function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(digits);
}

function formatVector(vector) {
    if (!vector) return "0, 0, 0";
    return [formatNumber(vector.x), formatNumber(vector.y), formatNumber(vector.z)].join(", ");
}

function formatFieldValue(field, value) {
    if (value === null || value === undefined) return "—";
    if (field.control === "vector3" && typeof value === "object") return formatVector(value);
    if (field.control === "toggle") return value ? "Yes" : "No";
    if (typeof value === "number") return `${formatNumber(value, field.step && field.step < 0.1 ? 3 : 2)}${field.units ? ` ${field.units}` : ""}`;
    if (Array.isArray(value)) return value.join(", ") || "—";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function unionSize(object3Ds) {
    if (!object3Ds?.length) return null;
    const box = new THREE.Box3();
    for (const object3D of object3Ds) box.union(new THREE.Box3().setFromObject(object3D));
    if (box.isEmpty()) return null;
    return box.getSize(new THREE.Vector3());
}

function Field({ label, value, mono = false }) {
    return (
        <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
            <p className={`${mono ? "font-mono" : ""} mt-0.5 truncate text-[11px] text-zinc-200`} title={String(value ?? "")}>
                {value ?? "None"}
            </p>
        </div>
    );
}

function NumberInput({ label, value, step = 0.1, onCommit }) {
    // Adjust the draft during render when the committed value changes (no effect needed).
    const [state, setState] = useState(() => ({ value, draft: String(formatNumber(value, 3)) }));
    if (state.value !== value) setState({ value, draft: String(formatNumber(value, 3)) });
    const draft = state.value === value ? state.draft : String(formatNumber(value, 3));
    const setDraft = (next) => setState({ value, draft: next });
    const commit = () => {
        const next = Number(draft);
        if (Number.isFinite(next) && Math.abs(next - value) > 1e-9) onCommit(next);
        else setDraft(String(formatNumber(value, 3)));
    };
    return (
        <label className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1">
            <span className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">{label}</span>
            <input
                type="number"
                step={step}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => { if (event.key === "Enter") commit(); event.stopPropagation(); }}
                className="w-24 rounded-[var(--radius)] border border-zinc-700 bg-zinc-950 px-1 text-right font-mono text-[11px] text-zinc-100 outline-none"
            />
        </label>
    );
}

function GroupFrameFields({ record, transform, onCommit }) {
    const frame = record.components?.transform ?? { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 };
    const commit = (patch) => onCommit({ ...frame, ...patch, position: { ...frame.position, ...(patch.position ?? {}) } });
    return (
        <div className="grid gap-1">
            <NumberInput label="X" value={frame.position.x} onCommit={(x) => commit({ position: { x } })} />
            <NumberInput label="Y" value={frame.position.y} onCommit={(y) => commit({ position: { y } })} />
            <NumberInput label="Z" value={frame.position.z} onCommit={(z) => commit({ position: { z } })} />
            <NumberInput label="Yaw (rad)" value={frame.rotationY} step={0.01} onCommit={(rotationY) => commit({ rotationY })} />
            <NumberInput label="Scale" value={frame.scale} step={0.01} onCommit={(scale) => commit({ scale: Math.max(0.01, scale) })} />
            <p className="text-[11px] text-zinc-500">World pivot: {formatVector(transform?.position)}</p>
        </div>
    );
}

export function ObjectInspector({ data, compactOpen = false }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const [registrySnapshot, setRegistrySnapshot] = useState({ entities: [] });
    const [groupFieldsEnabled] = useState(() => readGroupFrameFieldsPreference());
    const [lastIssue, setLastIssue] = useState(null);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(INSPECTOR_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(INSPECTOR_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => {
        registerBuiltinPresentations();
    }, []);
    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);
    useEffect(() => data?.selection?.()?.subscribe?.(setSelectionSnapshot), [data]);
    useEffect(() => data?.environment?.()?.objects?.()?.subscribe?.(setRegistrySnapshot), [data]);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        return document?.subscribe?.((snapshot, event) => {
            if (event?.transient) return;
            setDocumentSnapshot(snapshot);
        });
    }, [data]);

    if (!data) return null;

    const registry = data.environment()?.objects?.();
    const document = data.environment()?.getDocument?.();
    const bus = data.commands?.();
    const selection = data.selection?.();
    const primaryId = selectionSnapshot?.primary ?? null;
    const primaryRecord = primaryId ? document?.getObject?.(primaryId) ?? null : null;
    const selectionCount = selectionSnapshot?.ids?.length ?? 0;
    const activeTool = editorSnapshot?.activeTool ?? EDITOR_TOOLS.SELECT;
    const presentation = primaryRecord ? editorPresentationRegistry.forRecord(primaryRecord) : null;
    const targets = resolveTransformTargets({ selectionSnapshot, document, registry });
    const size = unionSize(targets.object3Ds);
    const sections = primaryRecord
        ? presentation.getInspectorSections({ data, record: primaryRecord, document, bus, selection, commands: objectCommands, sky: data.sky?.()?.toManifest?.() ?? null })
        : [];
    const hidden = primaryRecord?.components?.editorHidden === true;
    const locked = primaryRecord?.components?.locked === true;
    const registryVersion = registrySnapshot.entities.length;

    const report = (result) => {
        setLastIssue(result?.ok ? null : (result?.issues?.[0]?.message ?? result?.error ?? "Command rejected."));
        data.simulation?.()?.render?.();
        return result?.ok === true;
    };

    const clearSelection = () => {
        selection?.clear();
        data.simulation?.()?.render?.();
    };

    const setTool = (tool) => {
        data.editor()?.setActiveTool?.(tool);
        data.simulation?.()?.render?.();
    };

    const setVisible = (visible) => {
        const ids = selectionSnapshot?.ids?.length ? selectionSnapshot.ids : [primaryRecord.id];
        report(bus?.execute(objectCommands.setObjectsHidden({ objectIds: ids, hidden: !visible })));
    };

    const deleteSelection = () => {
        const ids = selectionSnapshot?.ids?.length ? selectionSnapshot.ids : [primaryRecord.id];
        report(bus?.execute(objectCommands.deleteObjects({ objectIds: ids })));
    };

    const commitGroupFrame = (nextFrame) => {
        const current = primaryRecord.components?.transform ?? { position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 };
        report(bus?.execute(objectCommands.transformObjects({
            objectIds: [primaryRecord.id],
            delta: deltaBetweenFrames(current, nextFrame),
            label: "Edit group frame",
        })));
    };

    return (
        <div
            className={`absolute right-3 top-3 z-30 w-[336px] max-w-[calc(100vw-24px)] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] pointer-events-auto max-[1023px]:top-[58px] ${compactOpen ? "" : "max-[1023px]:hidden"}`}
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
            data-registry-version={registryVersion}
        >
            <div className="mb-2 flex items-start justify-between rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 p-2">
                <div className="flex min-w-0 items-start gap-2">
                    {presentation && <PresentationIcon presentation={presentation} className="mt-1 h-4 w-4 shrink-0 text-zinc-400" />}
                    <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Inspector</p>
                        <p className="mt-0.5 truncate text-[13px] font-semibold text-zinc-100">
                            {selectionCount > 1 ? `${selectionCount} objects` : (primaryRecord?.name ?? "No object selected")}
                        </p>
                        {primaryRecord && (
                            <p className="truncate font-mono text-[11px] text-zinc-500" title={primaryRecord.id}>
                                {presentation.label} · {primaryRecord.id}
                            </p>
                        )}
                    </div>
                </div>
                {primaryRecord && (
                    <MenuButton iconOnly variant="ghost" className="h-7 w-7 rounded-[var(--radius)]" onClick={clearSelection} title="Clear selection" ariaLabel="Clear selection">
                        <FaTimes className="h-3 w-3" />
                    </MenuButton>
                )}
            </div>

            {lastIssue && (
                <p role="status" className="mb-2 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">{lastIssue}</p>
            )}

            {!primaryRecord ? (
                <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-3 text-[11px] text-zinc-400">
                    No object is currently selected.
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-2">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Tools</p>
                            <div className="flex items-center gap-1">
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.SELECT} className="h-7 w-7 rounded-[var(--radius)]" onClick={() => setTool(EDITOR_TOOLS.SELECT)} title="Select (Q)">
                                    <FaMousePointer className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.TRANSLATE} className="h-7 w-7 rounded-[var(--radius)]" onClick={() => setTool(EDITOR_TOOLS.TRANSLATE)} title="Move (W)">
                                    <FaArrowsAlt className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.ROTATE} className="h-7 w-7 rounded-[var(--radius)]" onClick={() => setTool(EDITOR_TOOLS.ROTATE)} title="Rotate (E)">
                                    <FaRedo className="h-3 w-3" />
                                </MenuButton>
                                <MenuButton iconOnly active={activeTool === EDITOR_TOOLS.SCALE} className="h-7 w-7 rounded-[var(--radius)]" onClick={() => setTool(EDITOR_TOOLS.SCALE)} title="Scale (R)">
                                    <FaSlidersH className="h-3 w-3" />
                                </MenuButton>
                            </div>
                        </div>
                        {size && <Field label="Selection size" value={formatVector(size)} mono />}
                    </div>

                    {sections.map((section) => (
                        <div key={section.id} className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-2">
                            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{section.title}</p>
                            {section.kind === "object" && (
                                <div className="grid grid-cols-2 gap-1.5">
                                    <Field label="Type" value={presentation.label} />
                                    <Field label="Parent" value={section.record.parentId ?? "Root"} mono />
                                    <Field label="Tags" value={(section.record.components?.tags ?? []).join(", ") || "None"} />
                                    <Field label="State" value={[locked ? "Locked" : null, hidden ? "Hidden" : null].filter(Boolean).join(", ") || "Editable"} />
                                </div>
                            )}
                            {section.kind === "transform" && (
                                section.editable && groupFieldsEnabled
                                    ? <GroupFrameFields record={section.record ?? primaryRecord} transform={section.transform} onCommit={commitGroupFrame} />
                                    : (
                                        <div className="grid gap-1.5">
                                            <Field label="Position" value={formatVector(section.transform.position)} mono />
                                            <Field label="Yaw (rad)" value={formatNumber(section.transform.rotationY, 3)} mono />
                                            {typeof section.transform.scale === "number" && <Field label="Scale" value={formatNumber(section.transform.scale, 3)} mono />}
                                        </div>
                                    )
                            )}
                            {section.kind === "options" && (
                                <div className="grid grid-cols-2 gap-1.5">
                                    {section.fields.filter((field) => !field.advanced).map((field) => (
                                        <Field key={field.path.join(".")} label={field.label} value={formatFieldValue(field, field.path.reduce((value, key) => value?.[key], section.values))} mono={field.control === "number" || field.control === "vector3"} />
                                    ))}
                                </div>
                            )}
                            {section.kind === "unsupported" && (
                                <p className="text-[11px] text-amber-200">
                                    Type &quot;{section.typeId}&quot; (v{section.typeVersion}) is not registered. The record is preserved and cannot be edited or simulated here.
                                </p>
                            )}
                            {typeof section.render === "function" && section.render({ data, record: primaryRecord, document, bus, selection })}
                        </div>
                    ))}

                    <div className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-2">
                        <MenuButton compact variant="default" onClick={() => focusCameraOnSelection({ data })} title="Focus camera on selection (F)">
                            <FaCrosshairs className="h-3 w-3" />
                            Focus
                        </MenuButton>
                        <div className="flex items-center gap-1">
                            {hidden ? (
                                <MenuButton compact variant="primary" onClick={() => setVisible(true)} title="Show selected objects">
                                    <FaEye className="h-3 w-3" />
                                    Show
                                </MenuButton>
                            ) : (
                                <MenuButton compact variant="default" onClick={() => setVisible(false)} title="Hide selected objects">
                                    <FaEyeSlash className="h-3 w-3" />
                                    Hide
                                </MenuButton>
                            )}
                            <MenuButton compact variant="danger" onClick={deleteSelection} title="Delete selected objects (Delete)" disabled={locked}>
                                <IconTrash className="h-3 w-3" />
                                Delete
                            </MenuButton>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
