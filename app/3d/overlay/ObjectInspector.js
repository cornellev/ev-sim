'use client';

import { useEffect, useState } from "react";
import {
    IconCrosshair,
    IconCopy,
    IconEye,
    IconEyeOff,
    IconLock,
    IconLockOpen,
    IconTrash,
    IconX,
} from "@tabler/icons-react";
import { AdvancedSwitch, Button, IconButton, useAuthoringMode } from "../../ui";
import { objectCommands } from "../editor/commands/index.js";
import { objectTypeRegistry } from "../editor/objects/ObjectTypeRegistry.js";
import { deltaBetweenFrames } from "../editor/objects/transformDelta.js";
import { GROUP_TYPE_ID } from "../editor/objects/types/group.js";
import { EditorPresentationRegistry, editorPresentationRegistry, readObjectFieldValues } from "../editor/presentation/EditorPresentationRegistry.js";
import { SECTION_KINDS } from "../editor/presentation/builtinSections.js";
import {
    fieldKey,
    groupFields,
    hasAdvancedFields,
    isDefaultValue,
    issuesByPath,
    issuesForField,
    defaultValueFor,
    selectionFieldState,
} from "../editor/presentation/fieldModel.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";
import { PropertySection, commitObjectOptions, renderField } from "./fields";
import { TextField } from "./fields/SimpleFields";
import { Vector3Field } from "./fields/Vector3Field";
import { RoadEndpointsSection } from "./inspector/RoadEndpointsSection";
import { SkyLocalPreview } from "./inspector/SkyLocalPreview";
import { TurnRuleMatrix } from "./inspector/TurnRuleMatrix";
import { PresentationIcon, registerBuiltinPresentations } from "./presentation/builtinPresentations.js";
import { cn } from "./ui/cn";

const POSITIONAL_FIELDS = new Set(["x", "z", "position", "rotationY"]);
const POSITION_DESCRIPTOR = Object.freeze({ path: ["position"], label: "Position", control: "vector3", units: "m", step: 0.1 });
const TAGS_DESCRIPTOR = Object.freeze({ path: ["tags"], label: "Tags", control: "text", description: "Comma-separated" });
const EMPTY_ISSUES = Object.freeze({ index: new Map(), general: [] });

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : "0";
}

function ReadOnlyRow({ label, value, mono = false }) {
    return (
        <div className="grid grid-cols-[minmax(0,88px)_minmax(0,1fr)] items-center gap-x-2 py-1">
            <span className="truncate text-[12px] text-[var(--slate-fg-2)]">{label}</span>
            <span className={cn("truncate text-[12px] text-[var(--slate-fg)]", mono && "font-mono text-[11px]")} title={String(value ?? "")}>{value ?? "—"}</span>
        </div>
    );
}

function NameEditor({ record, onRename }) {
    const [draft, setDraft] = useState(null);
    const committed = record?.name ?? "";
    const commit = (text) => {
        setDraft(null);
        const next = String(text ?? "").trim();
        if (next && next !== committed) onRename(next);
    };
    return (
        <input
            value={draft ?? committed}
            aria-label="Object name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") { event.preventDefault(); commit(event.currentTarget.value); }
                if (event.key === "Escape") { event.preventDefault(); setDraft(null); event.currentTarget.blur(); }
            }}
            className="h-7 min-w-0 flex-1 rounded-[var(--radius)] border border-transparent bg-transparent px-1 text-[13px] font-medium text-[var(--slate-fg)] outline-none hover:border-[var(--slate-border-70)] focus-visible:border-[var(--slate-border-70)] focus-visible:bg-[var(--slate-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]"
        />
    );
}

/**
 * Inspector: sections come from the presentation registry, option fields
 * render from `ObjectOptions.getFields()` through the generic field
 * controls, and every edit is a command. Multi-selections of one type share
 * fields with mixed-value detection; rejected edits stay in the field with
 * their issue and never touch the document.
 */
export function ObjectInspector({ data }) {
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const [documentVersion, setDocumentVersion] = useState(0);
    const [registryVersion, setRegistryVersion] = useState(0);
    const [presentationVersion, setPresentationVersion] = useState(0);
    const [issues, setIssues] = useState(EMPTY_ISSUES);
    const { advanced } = useAuthoringMode();

    useEffect(() => {
        registerBuiltinPresentations();
        return editorPresentationRegistry.subscribe(() => setPresentationVersion((version) => version + 1));
    }, []);
    useEffect(() => data?.selection?.()?.subscribe?.((snapshot) => {
        setSelectionSnapshot(snapshot);
        setIssues(EMPTY_ISSUES);
    }), [data]);
    useEffect(() => data?.environment?.()?.objects?.()?.subscribe?.((snapshot) => setRegistryVersion(snapshot?.entities?.length ?? 0)), [data]);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        return document?.subscribe?.((snapshot, event) => {
            if (event?.transient) return;
            setDocumentVersion(event?.version ?? 0);
        });
    }, [data]);

    const document = data?.environment?.()?.getDocument?.();
    const bus = data?.commands?.();
    const selection = data?.selection?.();
    const skyManifest = document?.sky ?? data?.sky?.()?.toManifest?.() ?? null;

    // Recomputed whenever the document, registry, or presentation versions
    // change. Records are mutated in place by commands, so the version
    // counters are read here on purpose: they are what makes this derivation
    // (auto-memoized by the React Compiler) recompute.
    const model = (() => {
        if (!document) return null;
        const version = `${documentVersion}:${registryVersion}:${presentationVersion}`;
        const ids = (selectionSnapshot?.ids ?? []).map(String);
        const records = ids.map((id) => document.getObject(id)).filter(Boolean);
        const primary = document.getObject(selectionSnapshot?.primary ?? "") ?? records[0] ?? null;
        const read = (record) => readObjectFieldValues(record, document, { sky: skyManifest });
        const state = selectionFieldState(records, read);
        const presentation = primary ? editorPresentationRegistry.forRecord(primary) : null;
        const definition = primary ? objectTypeRegistry.get(primary.typeId, primary.typeVersion) ?? objectTypeRegistry.get(primary.typeId) : null;
        const sections = records.length === 1 && primary && presentation
            ? presentation.getInspectorSections({ data, record: primary, document, bus, selection, commands: objectCommands, sky: skyManifest })
            : [];
        return { version, ids, records, primary, presentation, definition, state, sections, defaults: definition?.options?.getDefaults?.() ?? null };
    })();

    if (!data || !model) return null;
    const { ids, records, primary, presentation, definition, state, sections, defaults } = model;
    const locked = records.length > 0 && records.every((record) => record.components?.locked === true);
    const anyLocked = records.some((record) => record.components?.locked === true);
    const hidden = records.length > 0 && records.every((record) => record.components?.editorHidden === true);
    const multi = records.length > 1;

    const report = (result) => {
        if (!result) return false;
        if (result.ok) {
            setIssues(EMPTY_ISSUES);
            return true;
        }
        const index = issuesByPath(result.issues ?? []);
        const general = index.get("") ?? [];
        if (index.size === 0 && result.error) general.push({ message: result.error, severity: "error" });
        setIssues({ index, general: [...general, ...[...index.entries()].filter(([key]) => key && key.startsWith("command")).flatMap(([, list]) => list)] });
        return false;
    };
    const run = (command) => {
        const result = bus?.execute(command);
        data.simulation?.()?.render?.();
        return report(result);
    };
    const commitPatch = (entries) => report(commitObjectOptions({ data, objectIds: ids, patch: entries }));

    const fieldControl = (descriptor, { value, mixed = false }) => {
        const key = fieldKey(descriptor);
        const canReset = !mixed && !descriptor.readOnly && defaults !== null && !isDefaultValue(descriptor, value, defaults);
        return renderField(descriptor, {
            id: `inspector-field-${key.replace(/\W+/g, "-")}`,
            value,
            mixed,
            disabled: anyLocked,
            issues: issuesForField(issues.index, descriptor),
            onCommit: (next) => commitPatch([{ path: [...descriptor.path], value: next }]),
            canReset,
            onReset: () => commitPatch([{ path: [...descriptor.path], value: defaultValueFor(descriptor, defaults) }]),
        });
    };

    const renderOptionGroups = (fields, states = null) => groupFields(fields, { advanced }).map((group) => (
        <PropertySection key={group.id} id={`${state.typeId ?? primary?.typeId}:${group.id}`} title={group.title}>
            {group.fields.map((descriptor) => {
                const entry = states?.get(fieldKey(descriptor));
                return fieldControl(descriptor, entry ?? { value: undefined, mixed: false });
            })}
        </PropertySection>
    ));

    const renderSection = (section) => {
        switch (section.kind) {
            case "object":
                return (
                    <PropertySection key={section.id} id="object" title="Object">
                        <ReadOnlyRow label="Type" value={presentation.label} />
                        <ReadOnlyRow label="Parent" value={section.record.parentId ? document.getObject(section.record.parentId)?.name ?? section.record.parentId : "Root"} />
                        <ReadOnlyRow label="ID" value={section.record.id} mono />
                        <TextField
                            id="inspector-tags"
                            descriptor={TAGS_DESCRIPTOR}
                            value={(section.record.components?.tags ?? []).join(", ")}
                            disabled={anyLocked}
                            issues={issuesForField(issues.index, TAGS_DESCRIPTOR)}
                            onCommit={(text) => run(objectCommands.setObjectComponent({
                                objectId: section.record.id,
                                key: "tags",
                                value: String(text).split(",").map((tag) => tag.trim()).filter(Boolean),
                                label: "Edit tags",
                            }))}
                        />
                    </PropertySection>
                );
            case "transform": {
                if (primary.typeId === GROUP_TYPE_ID) return null;
                const positional = (state.fields ?? []).some((descriptor) => POSITIONAL_FIELDS.has(descriptor.path[0]));
                if (positional) return null;
                const transform = section.transform;
                const transformable = definition?.getCapabilities?.(primary)?.transformable === true;
                const current = { position: { ...transform.position }, rotationY: transform.rotationY ?? 0, scale: 1 };
                return (
                    <PropertySection key={section.id} id="transform" title="Transform">
                        {transformable
                            ? (
                                <Vector3Field
                                    id="inspector-transform-position"
                                    descriptor={POSITION_DESCRIPTOR}
                                    value={transform.position}
                                    disabled={anyLocked}
                                    issues={issuesForField(issues.index, { path: ["transform"] })}
                                    onCommit={(position) => run(objectCommands.transformObjects({
                                        objectIds: [primary.id],
                                        delta: deltaBetweenFrames(current, { ...current, position }),
                                        label: "Move",
                                    }))}
                                />
                            )
                            : <ReadOnlyRow label="Position" value={[transform.position.x, transform.position.y, transform.position.z].map((axis) => formatNumber(axis, 2)).join(", ")} mono />}
                        <ReadOnlyRow label="Yaw" value={`${formatNumber(transform.rotationY, 3)} rad`} mono />
                        {typeof transform.scale === "number" && <ReadOnlyRow label="Scale" value={formatNumber(transform.scale, 3)} mono />}
                    </PropertySection>
                );
            }
            case "options":
                return renderOptionGroups(state.fields.length > 0 ? state.fields : section.fields, state.states);
            case "unsupported":
                return (
                    <PropertySection key={section.id} id="unsupported" title={section.title}>
                        <p role="status" className="py-1 text-[12px] text-[var(--slate-warning)]">
                            Type &quot;{section.typeId}&quot; (v{section.typeVersion}) is not registered. The record is preserved and cannot be edited or simulated here.
                        </p>
                    </PropertySection>
                );
            case SECTION_KINDS.TURN_RULES:
                return (
                    <PropertySection key={section.id} id={section.id} title={section.title}>
                        <TurnRuleMatrix data={data} section={section} onResult={report} />
                    </PropertySection>
                );
            case SECTION_KINDS.ROAD_ENDPOINTS:
                return (
                    <PropertySection key={section.id} id={section.id} title={section.title}>
                        <RoadEndpointsSection data={data} section={section} onResult={report} />
                    </PropertySection>
                );
            case SECTION_KINDS.SKY_PREVIEW:
                return (
                    <PropertySection key={section.id} id={section.id} title={section.title} defaultOpen={false}>
                        <SkyLocalPreview data={data} />
                    </PropertySection>
                );
            default:
                if (typeof section.render === "function") {
                    return (
                        <PropertySection key={section.id} id={section.id} title={section.title ?? section.id}>
                            {section.render({ data, record: primary, document, bus, selection })}
                        </PropertySection>
                    );
                }
                return null;
        }
    };

    if (records.length === 0) {
        return (
            <div className="p-3 text-[12px] text-[var(--slate-muted)]" data-object-inspector data-registry-version={registryVersion}>
                Select an object in the hierarchy or the scene to edit its properties.
            </div>
        );
    }

    const showAdvancedSwitch = hasAdvancedFields(multi ? state.fields : sections.flatMap((section) => section.fields ?? []));

    return (
        <div className="flex min-h-full flex-col text-[var(--slate-fg)]" data-object-inspector data-registry-version={registryVersion}>
            <span id="inspector-mixed-hint" hidden>Mixed values across the selection</span>
            <header className="flex items-start gap-2 border-b border-[var(--slate-border-60)] p-2">
                {presentation && <PresentationIcon presentation={presentation} className="mt-1.5 h-4 w-4 shrink-0 text-[var(--slate-muted)]" />}
                <div className="min-w-0 flex-1">
                    {multi
                        ? <p className="h-7 truncate px-1 text-[13px] font-medium leading-7">{records.length} objects</p>
                        : <NameEditor record={primary} onRename={(name) => run(objectCommands.renameObject({ objectId: primary.id, name }))} />}
                    <p className="truncate px-1 text-[11px] text-[var(--slate-muted)]">
                        {multi
                            ? (state.mixedTypes ? "Mixed types" : `${presentation?.label ?? state.typeId}s`)
                            : <>{presentation?.label} · <span className="font-mono">{primary.id}</span></>}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton label={locked ? "Unlock" : "Lock"} size="compact" variant="ghost" aria-pressed={locked} onClick={() => run(objectCommands.setObjectsLocked({ objectIds: ids, locked: !locked }))}>
                        {locked ? <IconLock size={15} stroke={1.75} /> : <IconLockOpen size={15} stroke={1.75} />}
                    </IconButton>
                    <IconButton label={hidden ? "Show" : "Hide"} size="compact" variant="ghost" aria-pressed={hidden} onClick={() => run(objectCommands.setObjectsHidden({ objectIds: ids, hidden: !hidden }))}>
                        {hidden ? <IconEyeOff size={15} stroke={1.75} /> : <IconEye size={15} stroke={1.75} />}
                    </IconButton>
                    <IconButton label="Clear selection" size="compact" variant="ghost" onClick={() => { selection?.clear(); data.simulation?.()?.render?.(); }}>
                        <IconX size={15} stroke={1.75} />
                    </IconButton>
                </div>
            </header>

            {issues.general.length > 0 && (
                <p role="alert" className="mx-2 mt-2 rounded-[var(--radius)] border border-[var(--slate-danger-border)] px-2 py-1 text-[11px] text-[var(--slate-danger)]">
                    {issues.general[0].message}
                </p>
            )}
            {showAdvancedSwitch && (
                <div className="border-b border-[var(--slate-border-60)] px-2 py-1 [&_.sf-switch-row]:min-h-0 [&_.sf-switch-copy__label]:text-[12px]">
                    <AdvancedSwitch />
                </div>
            )}

            <div className="min-h-0 flex-1 px-1">
                {multi
                    ? (state.mixedTypes
                        ? <p className="px-2 py-3 text-[12px] text-[var(--slate-muted)]">Objects of different types share no editable properties. Lock, hide, and delete still apply to all of them.</p>
                        : renderOptionGroups(state.fields, state.states))
                    : sections.map(renderSection)}
            </div>

            <footer className="flex items-center justify-between gap-2 border-t border-[var(--slate-border-60)] p-2">
                <Button size="compact" variant="ghost" onClick={() => focusCameraOnSelection({ data })} title="Frame selection (F)">
                    <IconCrosshair size={14} stroke={1.75} aria-hidden="true" />
                    Frame
                </Button>
                <div className="flex items-center gap-1">
                    <Button
                        size="compact"
                        variant="ghost"
                        title="Duplicate (Mod+D)"
                        disabled={anyLocked}
                        onClick={() => {
                            const result = bus?.execute(objectCommands.duplicateObjects({ objectIds: ids }));
                            if (result?.ok && result.result?.rootIds?.length) selection?.select(result.result.rootIds);
                            report(result);
                        }}
                    >
                        <IconCopy size={14} stroke={1.75} aria-hidden="true" />
                        Duplicate
                    </Button>
                    <Button size="compact" variant="danger" title="Delete (Delete)" disabled={anyLocked} onClick={() => run(objectCommands.deleteObjects({ objectIds: ids }))}>
                        <IconTrash size={14} stroke={1.75} aria-hidden="true" />
                        Delete
                    </Button>
                </div>
            </footer>
        </div>
    );
}

export { EditorPresentationRegistry };
