import { useEffect, useMemo, useRef, useState } from "react";
import Grid from "./Grid";
import { LineManager } from "./LineManager";
import {
    createOutputNodePort,
    createCompiledProgramUnit,
    createProgramInputState,
    hasDuplicateOutputLabels,
    OutputNodeBlock,
    OUTPUT_NODE_MAX_OUTPUTS,
    OutputNodeUnit,
    normalizeOutputNodeState,
    ProgramInputBlock,
    SUPPORTED_TYPES,
} from "./units/program/ProgramIO";
import { AddMenu } from "./AddMenu";
import {
    CompiledProgramUnitBlock,
    getRegisteredBlockType,
    LocalScriptProgramBlock,
    ScriptManager
} from "./ScriptManager";
import { registerBuiltInBlocks } from "./registerBuiltInBlocks";
import { TYPES } from "./Constants";
import { FaCheckCircle } from "react-icons/fa";
import { FaCircleXmark } from "react-icons/fa6";
import {
    createArtifactOnlyDocument,
    createDocumentId,
    createEmptyGraph,
    createScriptDocument,
    isCompiledArtifact,
    isEditorDocument,
    normalizeDocumentName,
    normalizeScriptDocument,
    nowIso,
    summarizeScriptDocument
} from "./EditorDocument";
import { serializeManagerGraph, wouldCreateScriptReferenceCycle } from "./GraphDocument";
import {
    deleteScriptDocument,
    getScriptDocument,
    getScriptSetting,
    listScriptDocuments,
    putScriptDocument,
    putScriptSetting
} from "./ScriptStorage";
import { createCatalogUnitUUID, getUnitCatalogEntry } from "./UnitCatalog";

registerBuiltInBlocks();

const CURRENT_SCRIPT_SETTING = "currentScriptId";
const AUTOSAVE_DELAY = 450;
const OUTPUT_NODE_DEFAULT = normalizeOutputNodeState({
    outputs: [createOutputNodePort(0)]
});

function getNextOutputPortId(outputs) {
    const existingIds = new Set(outputs.map((output) => output.id));
    let index = outputs.length + 1;
    let id = `output-${index}`;

    while (existingIds.has(id)) {
        index += 1;
        id = `output-${index}`;
    }

    return id;
}

function sortedScripts(documents) {
    return [...documents].sort((a, b) => {
        const left = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const right = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return right - left;
    });
}

function upsertScript(documents, document) {
    return sortedScripts([
        ...documents.filter((item) => item.id !== document.id),
        document
    ]);
}

function getScriptRevision(document) {
    return document?.compileStatus?.artifactUpdatedAt || document?.updatedAt || null;
}

function getCenterPosition() {
    if (typeof window === "undefined") return { x: 280, y: 180 };

    return {
        x: Math.max(24, window.innerWidth / 2 - 120),
        y: Math.max(72, window.innerHeight / 2 - 80)
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getFallbackNodePosition(index = 0) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    return {
        x: 220 + column * 230,
        y: 140 + row * 170
    };
}

function normalizeRestoredPosition(position, index = 0) {
    const fallback = getFallbackNodePosition(index);
    if (!position) return fallback;

    const rawX = Number(position.x);
    const rawY = Number(position.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return fallback;

    if (typeof window === "undefined") {
        return { x: rawX, y: rawY };
    }

    const maxX = Math.max(24, window.innerWidth - 260);
    const maxY = Math.max(88, window.innerHeight - 180);

    return {
        x: clamp(rawX, 24, maxX),
        y: clamp(rawY, 88, maxY)
    };
}

function normalizeOutputNodePosition(position) {
    const fallback = { x: 100, y: 100 };
    if (!position) return fallback;

    const rawX = Number(position.x);
    const rawY = Number(position.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return fallback;

    if (typeof window === "undefined") {
        return { x: rawX, y: rawY };
    }

    return {
        x: clamp(rawX, 24, Math.max(24, window.innerWidth - 260)),
        y: clamp(rawY, 88, Math.max(88, window.innerHeight - 180))
    };
}

function spreadCollapsedPositions(positions) {
    const entries = Object.entries(positions);
    if (entries.length <= 1) return positions;

    const xs = entries.map(([, position]) => position.x);
    const ys = entries.map(([, position]) => position.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    if (width > 24 || height > 24) return positions;

    return Object.fromEntries(
        entries.map(([uuid], index) => [uuid, normalizeRestoredPosition(null, index)])
    );
}

function applyPositionsAfterRender(positions, onComplete, isCurrent = () => true) {
    const apply = () => {
        if (!isCurrent()) return;

        Object.entries(positions || {}).forEach(([uuid, position]) => {
            if (!position) return;

            document.dispatchEvent(new CustomEvent("position-unit", {
                detail: { uuid, position }
            }));
        });
    };

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        setTimeout(() => {
            apply();
            if (isCurrent()) onComplete?.();
        }, 0);
        return;
    }

    window.requestAnimationFrame(() => {
        apply();
        window.requestAnimationFrame(() => {
            apply();
            window.setTimeout(() => {
                apply();
                if (isCurrent()) onComplete?.();
            }, 60);
        });
    });
}

function scheduleGraphLineRefresh(graphKey, isCurrent = () => true) {
    if (typeof window === "undefined") return;

    [80, 220].forEach((delay) => {
        window.setTimeout(() => {
            if (!isCurrent()) return;

            document.dispatchEvent(new CustomEvent("refresh-graph-lines", {
                detail: { graphKey }
            }));
        }, delay);
    });
}

function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

function safeFileName(name, suffix) {
    const cleaned = normalizeDocumentName(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `${cleaned || "script"}-${suffix}.json`;
}

function relativeTime(iso) {
    if (!iso) return "never";

    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return "unknown";

    const minutes = Math.max(0, Math.floor(diff / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;

    return `${Math.floor(hours / 24)}d`;
}

function getDocumentSummary(document) {
    return summarizeScriptDocument(document);
}

function compactError(error) {
    if (!error) return null;
    return String(error).replace(/^Error:\s*/, "");
}

function OutputNodeSidebar({ config, onChange, valid }) {
    const outputState = normalizeOutputNodeState(config);
    const outputs = outputState.outputs;
    const duplicateLabels = hasDuplicateOutputLabels(outputs);
    const canAddOutput = outputs.length < OUTPUT_NODE_MAX_OUTPUTS;

    const updateOutput = (id, patch) => {
        onChange({
            outputs: outputs.map((output) => (
                output.id === id
                    ? { ...output, ...patch }
                    : output
            ))
        });
    };

    const addOutput = () => {
        if (!canAddOutput) return;

        const nextIndex = outputs.length;
        const id = getNextOutputPortId(outputs);
        const previousType = outputs[outputs.length - 1]?.type || "float64";

        onChange({
            outputs: [
                ...outputs,
                createOutputNodePort(nextIndex, {
                    id,
                    label: `output ${nextIndex + 1}`,
                    type: previousType
                })
            ]
        });
    };

    const removeOutput = (id) => {
        if (outputs.length <= 1) return;

        onChange({
            outputs: outputs.filter((output) => output.id !== id)
        });
    };

    return (
        <aside className="fixed right-4 top-4 z-40 w-[300px] rounded-md border border-white/10 bg-[#202020]/95 text-white shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur">
            <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-medium tracking-normal">OutputNode</h2>
                    <span className={`rounded-sm px-2 py-1 text-[11px] ${valid && !duplicateLabels ? "bg-emerald-400/12 text-emerald-200" : "bg-white/8 text-zinc-300"}`}>
                        {valid && !duplicateLabels ? "Ready" : "Invalid"}
                    </span>
                </div>
            </div>

            <div className="max-h-[calc(100vh-112px)] overflow-y-auto px-4 py-4">
                <div className="space-y-3">
                    {outputs.map((output, index) => (
                        <div key={output.id} className="rounded-md border border-white/10 bg-[#171717] p-3">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="text-xs text-zinc-400">Output {index + 1}</div>
                                <button
                                    type="button"
                                    disabled={outputs.length <= 1}
                                    onClick={() => removeOutput(output.id)}
                                    className="rounded-sm px-2 py-1 text-[11px] text-zinc-400 transition-[transform,background-color,color] duration-150 hover:bg-white/8 hover:text-white active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
                                >
                                    Remove
                                </button>
                            </div>

                            <label className="block">
                                <span className="mb-1.5 block text-xs text-zinc-400">Label</span>
                                <input
                                    value={output.label}
                                    className="w-full rounded-sm border border-white/10 bg-[#101010] px-3 py-2 text-sm text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                                    onChange={(event) => updateOutput(output.id, { label: event.target.value })}
                                />
                            </label>

                            <label className="mt-3 block">
                                <span className="mb-1.5 block text-xs text-zinc-400">Type</span>
                                <div className="flex items-center gap-2">
                                    <span
                                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                                        style={{ backgroundColor: TYPES[output.type.replace(/\[.*?\]/, "")] || TYPES[output.type] || "rgb(150,150,150)" }}
                                    />
                                    <select
                                        value={output.type}
                                        className="min-w-0 flex-1 rounded-sm border border-white/10 bg-[#101010] px-3 py-2 text-sm text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                                        onChange={(event) => updateOutput(output.id, { type: event.target.value })}
                                    >
                                        {SUPPORTED_TYPES.map((type) => (
                                            <option key={type} value={type}>{type}</option>
                                        ))}
                                    </select>
                                </div>
                            </label>
                        </div>
                    ))}
                </div>

                {duplicateLabels && (
                    <p className="mt-3 text-xs text-rose-200">Output labels must be unique.</p>
                )}

                <button
                    type="button"
                    disabled={!canAddOutput}
                    onClick={addOutput}
                    className="mt-4 w-full rounded-sm border border-white/10 bg-white/8 px-3 py-2 text-sm text-white transition-[transform,background-color,border-color] duration-150 hover:border-white/18 hover:bg-white/12 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45"
                >
                    Add Output
                </button>
            </div>
        </aside>
    );
}

function StatusBadge({ compileState, valid }) {
    const hasStaleArtifact = Boolean(!compileState.valid && compileState.artifactUpdatedAt);
    const label = compileState.dirty
        ? "Saving"
        : compileState.valid
            ? "Valid"
            : hasStaleArtifact
                ? "Invalid, stale artifact"
                : valid
                    ? "Validating"
                    : "Invalid";
    const ok = compileState.valid || hasStaleArtifact;

    return (
        <span className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] ${ok ? "border-emerald-300/15 bg-emerald-400/10 text-emerald-200" : "border-rose-300/15 bg-rose-400/10 text-rose-200"}`}>
            {ok ? <FaCheckCircle size={11} /> : <FaCircleXmark size={11} />}
            {label}
        </span>
    );
}

function EditorToolbar({
    currentDocument,
    compileState,
    valid,
    backStack,
    onBack,
    onRename,
    onNew,
    onToggleScripts,
    onExecute,
    onDownloadEditable,
    onDownloadCompiled,
    onImport,
    downloadOpen,
    onToggleDownload
}) {
    return (
        <div className="fixed left-4 top-4 z-50 flex max-w-[calc(100vw-360px)] items-center gap-2 rounded-md border border-white/10 bg-[#202020]/95 px-2.5 py-2 text-white shadow-[0_18px_48px_rgba(0,0,0,0.28)] backdrop-blur">
            {backStack.length > 0 && (
                <button
                    type="button"
                    onClick={onBack}
                    className="rounded-sm border border-white/10 bg-white/8 px-2 py-1.5 text-xs text-zinc-200 transition-[transform,background-color,border-color] duration-150 hover:border-white/20 hover:bg-white/12 active:scale-[0.98]"
                >
                    Back
                </button>
            )}

            <input
                value={currentDocument?.name || ""}
                onChange={(event) => onRename(event.target.value)}
                className="min-w-[180px] max-w-[280px] rounded-sm border border-transparent bg-transparent px-2 py-1.5 text-sm font-medium text-white outline-none transition-[border-color,background-color] duration-150 hover:bg-white/5 focus:border-white/15 focus:bg-[#121212]"
            />

            <StatusBadge compileState={compileState} valid={valid} />

            <div className="mx-1 h-5 w-px bg-white/10" />

            <button type="button" onClick={onNew} className="toolbar-btn">New</button>
            <button type="button" onClick={onToggleScripts} className="toolbar-btn">Scripts</button>
            <button type="button" onClick={onExecute} className="toolbar-btn">Execute</button>

            <div className="relative">
                <button type="button" onClick={onToggleDownload} className="toolbar-btn">Download</button>
                {downloadOpen && (
                    <div className="absolute left-0 top-[calc(100%+8px)] w-56 rounded-md border border-white/10 bg-[#1b1b1b] p-1 text-sm shadow-[0_16px_48px_rgba(0,0,0,0.32)]">
                        <button
                            type="button"
                            onClick={onDownloadEditable}
                            className="block w-full rounded-sm px-3 py-2 text-left text-zinc-200 transition-[transform,background-color] duration-150 hover:bg-white/8 active:scale-[0.98]"
                        >
                            Download Editable Script
                        </button>
                        <button
                            type="button"
                            onClick={onDownloadCompiled}
                            className="block w-full rounded-sm px-3 py-2 text-left text-zinc-200 transition-[transform,background-color] duration-150 hover:bg-white/8 active:scale-[0.98]"
                        >
                            Download Compiled Artifact
                        </button>
                    </div>
                )}
            </div>

            <button type="button" onClick={onImport} className="toolbar-btn">Import</button>
        </div>
    );
}

function ScriptLibraryDrawer({
    open,
    scripts,
    currentScriptId,
    isScriptUsable,
    search,
    onSearch,
    onClose,
    onCreate,
    onOpen,
    onUse,
    onDuplicate,
    onRename,
    onDelete,
    onDownloadEditable,
    onDownloadCompiled,
    onImport
}) {
    const visibleScripts = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return scripts;

        return scripts.filter((document) => document.name.toLowerCase().includes(query));
    }, [scripts, search]);

    if (!open) return null;

    return (
        <aside className="fixed left-4 top-[72px] z-40 flex max-h-[calc(100vh-92px)] w-[360px] flex-col rounded-md border border-white/10 bg-[#202020]/95 text-white shadow-[0_18px_52px_rgba(0,0,0,0.34)] backdrop-blur">
            <div className="border-b border-white/10 px-3 py-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-medium">Scripts</h2>
                        <p className="text-[11px] text-zinc-500">Browser local to this origin</p>
                    </div>
                    <button type="button" onClick={onClose} className="toolbar-btn px-2">Close</button>
                </div>
                <div className="flex gap-2">
                    <input
                        value={search}
                        onChange={(event) => onSearch(event.target.value)}
                        placeholder="Search scripts"
                        className="min-w-0 flex-1 rounded-sm border border-white/10 bg-[#101010] px-3 py-2 text-sm text-white outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-zinc-600 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
                    />
                    <button type="button" onClick={onCreate} className="toolbar-btn">New</button>
                    <button type="button" onClick={onImport} className="toolbar-btn">Import</button>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {visibleScripts.map((document) => {
                    const summary = getDocumentSummary(document);
                    const isCurrent = document.id === currentScriptId;
                    const editable = summary.editable;
                    const valid = summary.valid;
                    const usability = isScriptUsable(document);
                    const canUse = usability.usable;

                    return (
                        <div
                            key={document.id}
                            className={`mb-2 rounded-md border p-2.5 transition-[border-color,background-color] duration-150 ${isCurrent ? "border-white/24 bg-white/8" : "border-white/10 bg-[#171717] hover:border-white/18"}`}
                        >
                            <div className="mb-2 flex items-start justify-between gap-3">
                                <button
                                    type="button"
                                    disabled={!editable}
                                    onClick={() => editable && onOpen(document.id)}
                                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                                >
                                    <div className="truncate text-sm font-medium text-white">{document.name}</div>
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                                        <span className={`rounded-sm px-1.5 py-0.5 ${valid ? "bg-emerald-400/10 text-emerald-200" : "bg-rose-400/10 text-rose-200"}`}>
                                            {valid ? "valid" : "invalid"}
                                        </span>
                                        <span>{summary.inputs} in</span>
                                        <span>/</span>
                                        <span>{summary.outputs} out</span>
                                        <span>/</span>
                                        <span>{editable ? "editable" : "artifact"}</span>
                                        <span>/</span>
                                        <span>{relativeTime(summary.updatedAt)}</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    disabled={!canUse}
                                    title={usability.reason || "Use as Block"}
                                    onClick={() => onUse(document)}
                                    className="rounded-sm border border-white/10 bg-white/8 px-2 py-1.5 text-xs text-zinc-200 transition-[transform,background-color,border-color] duration-150 hover:border-white/20 hover:bg-white/12 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
                                >
                                    {usability.code === IMPORT_CODE.CYCLE ? "Dependent" : "Use"}
                                </button>
                            </div>

                            {summary.error && (
                                <div className="mb-2 line-clamp-2 rounded-sm border border-rose-300/10 bg-rose-400/8 px-2 py-1.5 text-[11px] text-rose-100">
                                    {compactError(summary.error)}
                                </div>
                            )}

                            <div className="flex flex-wrap gap-1.5">
                                <button type="button" disabled={!editable} onClick={() => onOpen(document.id)} className="mini-btn">Open</button>
                                <button type="button" onClick={() => onDuplicate(document)} className="mini-btn">Duplicate</button>
                                <button type="button" onClick={() => onRename(document)} className="mini-btn">Rename</button>
                                <button type="button" disabled={!editable} onClick={() => onDownloadEditable(document)} className="mini-btn">Export</button>
                                <button type="button" disabled={!document.latestValidArtifact} onClick={() => onDownloadCompiled(document)} className="mini-btn">Download Compiled</button>
                                <button type="button" onClick={() => onDelete(document)} className="mini-btn text-rose-200">Delete</button>
                            </div>
                        </div>
                    );
                })}

                {visibleScripts.length === 0 && (
                    <div className="rounded-md border border-white/10 bg-[#171717] px-3 py-8 text-center text-sm text-zinc-500">
                        No matching scripts.
                    </div>
                )}
            </div>
        </aside>
    );
}

function getNextProgramInputState(manager) {
    const usedLabels = new Set(
        manager.units
            .filter((unit) => unit instanceof ProgramInputBlock)
            .map((unit) => unit.state?.label)
            .filter(Boolean)
    );
    let index = 0;
    let next = createProgramInputState(index);

    while (usedLabels.has(next.label)) {
        index += 1;
        next = createProgramInputState(index);
    }

    return next;
}

export const IMPORT_CODE = {
    USABLE: 0,
    INCOMPLETE: 1,
    CYCLE: 2
};

export default function Scripting() {
    const headUUID = useRef("head-uuid");
    const manager = useRef(new ScriptManager());
    const positionsRef = useRef({});
    const outputNodeConfigRef = useRef(OUTPUT_NODE_DEFAULT);
    const currentDocumentRef = useRef(null);
    const currentScriptIdRef = useRef(null);
    const scriptsRef = useRef([]);
    const loadingRef = useRef(false);
    const loadSequenceRef = useRef(0);
    const renderGraphIdRef = useRef(0);
    const saveTimerRef = useRef(null);
    const saveFeedbackTimerRef = useRef(null);
    const importInputRef = useRef(null);
    const unitParentRef = useRef();

    const [valid, setValid] = useState(false);
    const [outputNodeConfig, setOutputNodeConfig] = useState(OUTPUT_NODE_DEFAULT);
    const [unitChildren, setUnitChildren] = useState([]);
    const [positions, setPositions] = useState({});
    const [scripts, setScripts] = useState([]);
    const [currentScriptId, setCurrentScriptId] = useState(null);
    const [currentDocument, setCurrentDocument] = useState(null);
    const [compileState, setCompileState] = useState({
        valid: false,
        error: null,
        artifactUpdatedAt: null,
        dirty: false
    });
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [librarySearch, setLibrarySearch] = useState("");
    const [downloadOpen, setDownloadOpen] = useState(false);
    const [backStack, setBackStack] = useState([]);
    const [lastRun, setLastRun] = useState(null);
    const [saveFeedbackVisible, setSaveFeedbackVisible] = useState(false);
    const [graphVersion, setGraphVersion] = useState(0);
    const [renderGraphId, setRenderGraphId] = useState(0);
    const [connectionSnapshot, setConnectionSnapshot] = useState([]);

    useEffect(() => {
        scriptsRef.current = scripts;
    }, [scripts]);

    useEffect(() => {
        currentDocumentRef.current = currentDocument;
    }, [currentDocument]);

    useEffect(() => {
        currentScriptIdRef.current = currentScriptId;
    }, [currentScriptId]);

    useEffect(() => {
        outputNodeConfigRef.current = outputNodeConfig;
    }, [outputNodeConfig]);

    useEffect(() => {
        positionsRef.current = positions;
    }, [positions]);

    useEffect(() => {
        if (loadingRef.current) return;
        if (refreshLocalBlocksFromLibrary()) {
            markGraphChanged();
        }
    // refreshLocalBlocksFromLibrary intentionally reads manager/script refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scripts]);

    const setScriptsWithRef = (updater) => {
        setScripts((previous) => {
            const next = typeof updater === "function" ? updater(previous) : updater;
            scriptsRef.current = next;
            return next;
        });
    };

    const renderCompiledProgramElement = (uuid, compiledProgram, title) => {
        const CompiledUnit = createCompiledProgramUnit(compiledProgram, title);
        return <CompiledUnit key={uuid} _uuid={uuid} />;
    };

    const renderCatalogElement = (entry, node) => {
        if (!entry?.Component) return null;

        const Component = entry.Component;
        return (
            <Component
                key={node.uuid}
                _uuid={node.uuid}
                initialData={node.storedData}
                initialState={node.state || {}}
            />
        );
    };

    const renderNodeElement = (node) => {
        if (!node) return null;

        if (node.type === "CompiledProgramUnitBlock" || node.type === "LocalScriptProgramBlock") {
            return renderCompiledProgramElement(
                node.uuid,
                node.state?.compiledProgram,
                node.state?.name || node.state?.compiledProgram?.name || "Program"
            );
        }

        return renderCatalogElement(getUnitCatalogEntry(node.type), node);
    };

    const markGraphChanged = () => {
        if (loadingRef.current) return;

        const isValid = manager.current.checkValidity();
        setValid(isValid);
        setCompileState((previous) => ({
            ...previous,
            dirty: true
        }));
        setGraphVersion((value) => value + 1);
    };

    const refreshLocalBlocksFromLibrary = () => {
        let changed = false;
        const refreshedChildren = [];

        manager.current.units.forEach((unit) => {
            if (!(unit instanceof LocalScriptProgramBlock)) return;

            const source = scriptsRef.current.find((document) => document.id === unit.state?.sourceScriptId);
            if (!source?.latestValidArtifact) return;

            const sourceRevision = getScriptRevision(source);
            if (unit.state?.sourceRevision === sourceRevision && unit.state?.name === source.name) return;

            unit.hydrateState({
                ...unit.state,
                name: source.name,
                sourceRevision,
                compiledProgram: source.latestValidArtifact
            });

            refreshedChildren.push({
                uuid: unit.uuid,
                element: renderCompiledProgramElement(unit.uuid, source.latestValidArtifact, source.name)
            });
            changed = true;
        });

        if (!changed) return false;

        setUnitChildren((previous) => previous.map((child) => {
            const refreshed = refreshedChildren.find((item) => item.uuid === child.props._uuid);
            return refreshed ? refreshed.element : child;
        }));
        setValid(manager.current.checkValidity());
        return true;
    };

    const getScriptBlockUsability = (scriptDocument) => {
        if (!scriptDocument?.latestValidArtifact) {
            return { usable: false, reason: "No valid compiled artifact yet", code: IMPORT_CODE.INCOMPLETE };
        }

        if (wouldCreateScriptReferenceCycle(currentScriptIdRef.current, scriptDocument.id, scriptsRef.current)) {
            return { usable: false, reason: "Would create a script-reference cycle", code: IMPORT_CODE.CYCLE };
        }

        return { usable: true, reason: null, code: IMPORT_CODE.USABLE };
    };

    const saveCurrentScript = async () => {
        const document = currentDocumentRef.current;
        if (!document || document.editable === false) return document;

        const timestamp = nowIso();
        const graph = serializeManagerGraph(manager.current, {
            outputNodeConfig: outputNodeConfigRef.current,
            positions: positionsRef.current,
            headUUID: headUUID.current
        });

        let latestValidArtifact = document.latestValidArtifact || null;
        let compileStatus = {
            valid: false,
            error: null,
            artifactUpdatedAt: document.compileStatus?.artifactUpdatedAt || null
        };

        try {
            const artifact = manager.current.compile(normalizeDocumentName(document.name));
            latestValidArtifact = artifact;
            compileStatus = {
                valid: true,
                error: null,
                artifactUpdatedAt: timestamp
            };
        } catch (error) {
            compileStatus = {
                valid: false,
                error: error?.message || String(error),
                artifactUpdatedAt: document.compileStatus?.artifactUpdatedAt || null
            };
        }

        const nextDocument = {
            ...document,
            name: normalizeDocumentName(document.name),
            graph,
            latestValidArtifact,
            compileStatus,
            updatedAt: timestamp
        };

        currentDocumentRef.current = nextDocument;
        setCurrentDocument(nextDocument);
        setCompileState({
            ...compileStatus,
            dirty: false
        });

        await putScriptDocument(nextDocument);
        setScriptsWithRef((previous) => upsertScript(previous, nextDocument));
        refreshLocalBlocksFromLibrary();

        return nextDocument;
    };

    const showSavedFeedback = () => {
        if (saveFeedbackTimerRef.current) {
            window.clearTimeout(saveFeedbackTimerRef.current);
        }

        setSaveFeedbackVisible(true);
        saveFeedbackTimerRef.current = window.setTimeout(() => {
            setSaveFeedbackVisible(false);
        }, 1050);
    };

    useEffect(() => {
        const onSaveShortcut = (event) => {
            const isSaveShortcut = event.key?.toLowerCase() === "s" && (event.metaKey || event.ctrlKey);
            if (!isSaveShortcut) return;

            event.preventDefault();
            event.stopPropagation();

            if (saveTimerRef.current) {
                window.clearTimeout(saveTimerRef.current);
            }

            showSavedFeedback();
            saveCurrentScript().catch((error) => {
                console.error("Manual save shortcut failed:", error);
            });
        };

        document.addEventListener("keydown", onSaveShortcut);
        return () => {
            document.removeEventListener("keydown", onSaveShortcut);
            if (saveFeedbackTimerRef.current) {
                window.clearTimeout(saveFeedbackTimerRef.current);
            }
        };
    // saveCurrentScript intentionally reads mutable graph refs at shortcut time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadDocumentIntoEditor = (document, { pushCurrent = false } = {}) => {
        if (!document?.editable) return;

        loadingRef.current = true;
        loadSequenceRef.current += 1;
        const loadId = loadSequenceRef.current;

        const previousScriptId = currentScriptIdRef.current;
        const normalized = normalizeScriptDocument(document);
        const graph = normalized.graph || createEmptyGraph(OUTPUT_NODE_DEFAULT);
        const restoredOutputConfig = normalizeOutputNodeState(graph.outputNodeConfig || OUTPUT_NODE_DEFAULT);
        const nextManager = new ScriptManager();
        const headUnit = new OutputNodeBlock(headUUID.current);
        const nextChildren = [];
        let nextPositions = {};
        let nodeIndex = 0;

        nextManager.addUnit(headUnit);
        nextManager.setHead(headUUID.current);
        nextManager.storeData(headUUID.current, restoredOutputConfig);
        headUnit.hydrateState(restoredOutputConfig);

        (graph.nodes || []).forEach((node) => {
            const BlockClass = getRegisteredBlockType(node.type) || getUnitCatalogEntry(node.type)?.blockClass;
            if (!BlockClass) {
                console.warn(`Cannot restore unknown block type: ${node.type}`);
                return;
            }

            const restoredState = { ...(node.state || {}) };
            if (node.type === "LocalScriptProgramBlock") {
                const source = scriptsRef.current.find((script) => script.id === restoredState.sourceScriptId);
                if (source?.latestValidArtifact) {
                    restoredState.name = source.name;
                    restoredState.compiledProgram = source.latestValidArtifact;
                    restoredState.sourceRevision = getScriptRevision(source);
                }
            }

            const block = new BlockClass(node.uuid);
            block.hydrateState(restoredState);
            nextManager.addUnit(block);

            if (node.storedData !== undefined) {
                nextManager.storeData(node.uuid, node.storedData);
            }

            if (node.runtimeState && typeof block.hydrateRuntimeState === "function") {
                block.hydrateRuntimeState(node.runtimeState);
            }

            const child = renderNodeElement({
                ...node,
                state: restoredState
            });
            if (child) nextChildren.push(child);

            nextPositions[node.uuid] = normalizeRestoredPosition(node.position, nodeIndex);
            nodeIndex += 1;
        });

        nextPositions = {
            [headUUID.current]: normalizeOutputNodePosition(graph.headPosition),
            ...spreadCollapsedPositions(nextPositions)
        };

        (graph.connections || []).forEach((connection) => {
            nextManager.connectUnits(connection.from, connection.output, connection.to, connection.input);
        });

        manager.current = nextManager;
        positionsRef.current = nextPositions;
        outputNodeConfigRef.current = restoredOutputConfig;
        currentDocumentRef.current = normalized;
        currentScriptIdRef.current = normalized.id;

        if (pushCurrent && previousScriptId && previousScriptId !== normalized.id) {
            setBackStack((previous) => [...previous, previousScriptId]);
        }

        setOutputNodeConfig(restoredOutputConfig);
        setUnitChildren(nextChildren);
        setPositions(nextPositions);
        const nextRenderGraphId = renderGraphIdRef.current + 1;
        renderGraphIdRef.current = nextRenderGraphId;

        setConnectionSnapshot([...(graph.connections || [])]);
        setRenderGraphId(nextRenderGraphId);
        setCurrentDocument(normalized);
        setCurrentScriptId(normalized.id);
        setCompileState({
            valid: Boolean(normalized.compileStatus?.valid),
            error: normalized.compileStatus?.error || null,
            artifactUpdatedAt: normalized.compileStatus?.artifactUpdatedAt || null,
            dirty: false
        });
        setLastRun(null);
        setValid(nextManager.checkValidity());
        putScriptSetting(CURRENT_SCRIPT_SETTING, normalized.id);

        applyPositionsAfterRender(nextPositions, () => {
            loadingRef.current = false;
            scheduleGraphLineRefresh(nextRenderGraphId, () => loadSequenceRef.current === loadId);
        }, () => loadSequenceRef.current === loadId);
    };

    useEffect(() => {
        let mounted = true;

        async function boot() {
            const stored = await listScriptDocuments();
            const normalizedDocuments = stored
                .map((document) => {
                    try {
                        return normalizeScriptDocument(document);
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);

            let documents = sortedScripts(normalizedDocuments);
            if (documents.length === 0) {
                const created = createScriptDocument({
                    name: "Untitled Script",
                    graph: createEmptyGraph(OUTPUT_NODE_DEFAULT)
                });
                await putScriptDocument(created);
                documents = [created];
            }

            if (!mounted) return;

            setScriptsWithRef(documents);
            const preferredScriptId = await getScriptSetting(CURRENT_SCRIPT_SETTING);
            const current = documents.find((document) => document.id === preferredScriptId && document.editable)
                || documents.find((document) => document.editable);

            if (current) {
                loadDocumentIntoEditor(current);
            }
        }

        boot();

        return () => {
            mounted = false;
            if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        };
    // loadDocumentIntoEditor intentionally reads the latest refs while bootstrapping once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!currentScriptId || loadingRef.current) return;
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);

        saveTimerRef.current = window.setTimeout(() => {
            saveCurrentScript().catch((error) => {
                console.error("Autosave failed:", error);
            });
        }, AUTOSAVE_DELAY);

        return () => {
            if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        };
    // saveCurrentScript intentionally reads mutable graph refs at debounce time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [graphVersion, currentScriptId]);

    useEffect(() => {
        const onData = (event) => {
            const { uuid, data } = event.detail;
            manager.current.storeData(uuid, data);
            markGraphChanged();
        };

        const onReregister = (event) => {
            const { uuid } = event.detail;
            const block = manager.current.units.find((unit) => unit.uuid === uuid);
            if (block) {
                block.reregister();
                markGraphChanged();
            }
        };

        const onDeleteUnit = (event) => {
            const unitIdToDelete = event.detail.uuid;
            if (unitIdToDelete === headUUID.current) return;

            manager.current.removeUnit(unitIdToDelete);
            positionsRef.current = Object.fromEntries(
                Object.entries(positionsRef.current).filter(([uuid]) => uuid !== unitIdToDelete)
            );

            setPositions(positionsRef.current);
            setUnitChildren((previous) => previous.filter((unit) => unit.props._uuid !== unitIdToDelete));
            markGraphChanged();
        };

        const onPositionChanged = (event) => {
            const { uuid, position } = event.detail || {};
            if (!uuid || !position) return;

            positionsRef.current = {
                ...positionsRef.current,
                [uuid]: position
            };
            setPositions(positionsRef.current);
            markGraphChanged();
        };

        const onUnitDoubleClick = async (event) => {
            const { uuid } = event.detail || {};
            const block = manager.current.units.find((unit) => unit.uuid === uuid);
            if (!(block instanceof LocalScriptProgramBlock)) return;

            const sourceScriptId = block.state?.sourceScriptId;
            const source = scriptsRef.current.find((document) => document.id === sourceScriptId)
                || await getScriptDocument(sourceScriptId);

            if (!source?.editable) {
                console.info("This program block was imported as a compiled artifact and cannot be opened for editing.");
                return;
            }

            await saveCurrentScript();
            loadDocumentIntoEditor(source, { pushCurrent: true });
        };

        document.addEventListener("data-stored", onData);
        document.addEventListener("reregister-unit", onReregister);
        document.addEventListener("delete-unit", onDeleteUnit);
        document.addEventListener("unit-position-changed", onPositionChanged);
        document.addEventListener("unit-double-click", onUnitDoubleClick);

        return () => {
            document.removeEventListener("data-stored", onData);
            document.removeEventListener("reregister-unit", onReregister);
            document.removeEventListener("delete-unit", onDeleteUnit);
            document.removeEventListener("unit-position-changed", onPositionChanged);
            document.removeEventListener("unit-double-click", onUnitDoubleClick);
        };
    // Event handlers intentionally delegate through refs so subscriptions stay stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const disconnectOutputNodePorts = (portIds) => {
        if (portIds.length === 0) return;

        const block = manager.current.units.find((unit) => unit.uuid === headUUID.current);
        const uniquePortIds = [...new Set(portIds)];

        uniquePortIds.forEach((portId) => {
            const connection = block?.inputs?.[portId];
            if (!connection) return;

            const output = connection.getOutput();
            manager.current.disconnectUnits(output.unit.uuid, output.label, headUUID.current, portId);
        });

        document.dispatchEvent(new CustomEvent("delete-port-connections", {
            detail: {
                uuid: headUUID.current,
                labels: uniquePortIds,
                notifyBackend: false
            }
        }));
    };

    const updateOutputNodeConfig = (patch) => {
        const previous = normalizeOutputNodeState(outputNodeConfigRef.current);
        const next = normalizeOutputNodeState(patch);
        const nextById = new Map(next.outputs.map((output) => [output.id, output]));
        const disconnectedPortIds = previous.outputs
            .filter((output) => {
                const nextOutput = nextById.get(output.id);
                return !nextOutput || nextOutput.type !== output.type;
            })
            .map((output) => output.id);

        disconnectOutputNodePorts(disconnectedPortIds);

        outputNodeConfigRef.current = next;
        setOutputNodeConfig(next);
        manager.current.storeData(headUUID.current, next);

        const block = manager.current.units.find((unit) => unit.uuid === headUUID.current);
        if (block) {
            block.hydrateState(next);
        }

        markGraphChanged();
    };

    const addUnit = (catalogEntry, uuid, position) => {
        const Component = catalogEntry.Component;
        let storedData;
        let initialState = {};

        if (catalogEntry.blockClass) {
            const block = new catalogEntry.blockClass(uuid);

            if (catalogEntry.blockClass === ProgramInputBlock) {
                initialState = getNextProgramInputState(manager.current);
                storedData = initialState;
                block.hydrateState(initialState);
            }

            manager.current.addUnit(block);

            if (storedData !== undefined) {
                manager.current.storeData(uuid, storedData);
            }
        }

        const element = (
            <Component
                key={uuid}
                _uuid={uuid}
                initialData={storedData}
                initialState={initialState}
            />
        );

        setUnitChildren((previous) => [...previous, element]);

        if (position && uuid) {
            positionsRef.current = {
                ...positionsRef.current,
                [uuid]: position
            };
            setPositions(positionsRef.current);
            setTimeout(() => {
                document.dispatchEvent(new CustomEvent("position-unit", { detail: { uuid, position } }));
            }, 0);
        }

        markGraphChanged();
    };

    const addCompiledProgramBlock = (scriptDocument) => {
        const artifact = scriptDocument.latestValidArtifact;
        if (!artifact) return;

        const uuid = createCatalogUnitUUID();
        const block = new CompiledProgramUnitBlock(uuid);
        block.hydrateState({
            compiledProgram: artifact,
            name: scriptDocument.name || artifact.name || "Compiled Program"
        });
        manager.current.addUnit(block);

        const position = getCenterPosition();
        positionsRef.current = {
            ...positionsRef.current,
            [uuid]: position
        };

        setPositions(positionsRef.current);
        setUnitChildren((previous) => [
            ...previous,
            renderCompiledProgramElement(uuid, artifact, scriptDocument.name || artifact.name || "Compiled Program")
        ]);
        setTimeout(() => {
            document.dispatchEvent(new CustomEvent("position-unit", { detail: { uuid, position } }));
        }, 0);
        markGraphChanged();
    };

    const addLocalScriptBlock = (scriptDocument) => {
        if (!scriptDocument.latestValidArtifact) return;

        if (wouldCreateScriptReferenceCycle(currentScriptIdRef.current, scriptDocument.id, scriptsRef.current)) {
            console.error("Cannot insert script block because it would create a script-reference cycle.");
            return;
        }

        if (scriptDocument.editable === false) {
            addCompiledProgramBlock(scriptDocument);
            return;
        }

        const uuid = createCatalogUnitUUID();
        const block = new LocalScriptProgramBlock(uuid);
        block.hydrateState({
            sourceScriptId: scriptDocument.id,
            sourceRevision: getScriptRevision(scriptDocument),
            compiledProgram: scriptDocument.latestValidArtifact,
            name: scriptDocument.name
        });
        manager.current.addUnit(block);

        const position = getCenterPosition();
        positionsRef.current = {
            ...positionsRef.current,
            [uuid]: position
        };

        setPositions(positionsRef.current);
        setUnitChildren((previous) => [
            ...previous,
            renderCompiledProgramElement(uuid, scriptDocument.latestValidArtifact, scriptDocument.name)
        ]);
        setTimeout(() => {
            document.dispatchEvent(new CustomEvent("position-unit", { detail: { uuid, position } }));
        }, 0);
        markGraphChanged();
    };

    const onConnectUnits = (from, to) => {
        const outputUUID = to.uuid;
        const outputLabel = to.label;
        const inputUUID = from.uuid;
        const inputLabel = from.label;
        const connected = manager.current.connectUnits(outputUUID, outputLabel, inputUUID, inputLabel);

        if (connected) markGraphChanged();
        setValid(manager.current.checkValidity());
        return connected;
    };

    const onDeleteConnection = (from, to) => {
        if (!from || !to) return;

        manager.current.disconnectUnits(to.uuid, to.label, from.uuid, from.label);
        markGraphChanged();
    };

    const createNewScript = async () => {
        await saveCurrentScript();
        const created = createScriptDocument({
            name: "Untitled Script",
            graph: createEmptyGraph(OUTPUT_NODE_DEFAULT)
        });
        await putScriptDocument(created);
        setScriptsWithRef((previous) => upsertScript(previous, created));
        loadDocumentIntoEditor(created, { pushCurrent: true });
    };

    const openScript = async (scriptId) => {
        await saveCurrentScript();
        const document = scriptsRef.current.find((item) => item.id === scriptId) || await getScriptDocument(scriptId);
        if (!document?.editable) return;
        loadDocumentIntoEditor(document, { pushCurrent: true });
    };

    const goBack = async () => {
        const targetScriptId = backStack[backStack.length - 1];
        if (!targetScriptId) return;

        await saveCurrentScript();
        const document = scriptsRef.current.find((item) => item.id === targetScriptId) || await getScriptDocument(targetScriptId);
        setBackStack((previous) => previous.slice(0, -1));
        if (document?.editable) {
            loadDocumentIntoEditor(document);
        }
    };

    const renameCurrent = (name) => {
        const document = currentDocumentRef.current;
        if (!document) return;

        const next = {
            ...document,
            name
        };
        currentDocumentRef.current = next;
        setCurrentDocument(next);
        markGraphChanged();
    };

    const renameLibraryScript = async (document) => {
        const nextName = window.prompt("Rename script", document.name);
        if (!nextName) return;

        const nextDocument = {
            ...document,
            name: normalizeDocumentName(nextName),
            updatedAt: nowIso()
        };

        await putScriptDocument(nextDocument);
        setScriptsWithRef((previous) => upsertScript(previous, nextDocument));

        if (currentScriptIdRef.current === document.id) {
            currentDocumentRef.current = nextDocument;
            setCurrentDocument(nextDocument);
        }
    };

    const duplicateScript = async (document) => {
        let duplicated;
        const timestamp = nowIso();

        if (document.editable === false) {
            duplicated = createArtifactOnlyDocument(document.latestValidArtifact, {
                name: `${document.name} copy`
            });
        } else {
            duplicated = createScriptDocument({
                ...document,
                id: createDocumentId(),
                name: `${document.name} copy`,
                createdAt: timestamp,
                updatedAt: timestamp
            });
        }

        await putScriptDocument(duplicated);
        setScriptsWithRef((previous) => upsertScript(previous, duplicated));
    };

    const deleteScript = async (document) => {
        if (!window.confirm(`Delete "${document.name}" from local scripts?`)) return;

        await deleteScriptDocument(document.id);
        const remaining = scriptsRef.current.filter((item) => item.id !== document.id);
        setScriptsWithRef(sortedScripts(remaining));

        if (currentScriptIdRef.current === document.id) {
            const next = remaining.find((item) => item.editable);
            if (next) {
                loadDocumentIntoEditor(next);
            } else {
                const created = createScriptDocument({
                    name: "Untitled Script",
                    graph: createEmptyGraph(OUTPUT_NODE_DEFAULT)
                });
                await putScriptDocument(created);
                setScriptsWithRef((previous) => upsertScript(previous, created));
                loadDocumentIntoEditor(created);
            }
        }
    };

    const attemptExecute = () => {
        try {
            const run = manager.current.executeProgram();
            setLastRun(run);

            if (run.status === "failure") {
                console.error("Error during execution:", run.e);
                return;
            }

            console.log("Execution output:", run.outputs, run);
        } catch (err) {
            const failure = {
                status: "failure",
                outputs: {},
                e: {
                    message: err?.message || String(err)
                }
            };
            setLastRun(failure);
            console.error("Error during execution:", err);
        }
    };

    const downloadEditableScript = async (document = null) => {
        const target = document || await saveCurrentScript();
        if (!target?.editable) return;
        downloadJson(target, safeFileName(target.name, "editable"));
        setDownloadOpen(false);
    };

    const downloadCompiledArtifact = async (document = null) => {
        const target = document || await saveCurrentScript();
        const artifact = target?.latestValidArtifact;
        if (!artifact) {
            console.error("No valid compiled artifact is available for this script yet.");
            return;
        }

        downloadJson(artifact, safeFileName(target.name, "compiled"));
        setDownloadOpen(false);
    };

    const importScriptFile = () => {
        importInputRef.current?.click();
    };

    const onImportFile = async (event) => {
        try {
            const file = event.target.files?.[0];
            if (!file) return;

            const parsed = JSON.parse(await file.text());

            if (isEditorDocument(parsed)) {
                let imported = normalizeScriptDocument(parsed);
                const existingIds = new Set(scriptsRef.current.map((document) => document.id));

                if (existingIds.has(imported.id)) {
                    imported = {
                        ...imported,
                        id: createDocumentId(),
                        name: `${imported.name} copy`,
                        createdAt: nowIso(),
                        updatedAt: nowIso()
                    };
                }

                await putScriptDocument(imported);
                setScriptsWithRef((previous) => upsertScript(previous, imported));

                if (imported.editable) {
                    await saveCurrentScript();
                    loadDocumentIntoEditor(imported, { pushCurrent: true });
                }
                return;
            }

            if (isCompiledArtifact(parsed)) {
                ScriptManager.createRunner(parsed);
                const document = createArtifactOnlyDocument(parsed, {
                    name: parsed.name || "Imported Program"
                });
                await putScriptDocument(document);
                setScriptsWithRef((previous) => upsertScript(previous, document));
                addCompiledProgramBlock(document);
                return;
            }

            throw new Error("Unsupported script file.");
        } catch (err) {
            console.error("Error importing script file:", err);
        } finally {
            if (event.target) {
                event.target.value = "";
            }
        }
    };

    const outputNodeElement = (
        <OutputNodeUnit
            key="output-node"
            _uuid={headUUID.current}
            outputs={outputNodeConfig.outputs}
            initialPosition={positions[headUUID.current] || null}
        />
    );
    const visibleUnitChildren = [outputNodeElement, ...unitChildren];

    return (
        <>
            <style jsx global>{`
                .toolbar-btn {
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    background: rgba(255, 255, 255, 0.08);
                    padding: 0.375rem 0.625rem;
                    color: rgb(228, 228, 231);
                    font-size: 0.75rem;
                    line-height: 1rem;
                    transition: transform 150ms ease-out, background-color 150ms ease-out, border-color 150ms ease-out;
                }
                .toolbar-btn:hover {
                    border-color: rgba(255, 255, 255, 0.2);
                    background: rgba(255, 255, 255, 0.12);
                }
                .toolbar-btn:active {
                    transform: scale(0.98);
                }
                .mini-btn {
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 4px;
                    background: rgba(255, 255, 255, 0.05);
                    padding: 0.25rem 0.45rem;
                    color: rgb(212, 212, 216);
                    font-size: 11px;
                    line-height: 1;
                    transition: transform 150ms ease-out, background-color 150ms ease-out, border-color 150ms ease-out;
                }
                .mini-btn:hover {
                    border-color: rgba(255, 255, 255, 0.16);
                    background: rgba(255, 255, 255, 0.1);
                }
                .mini-btn:active {
                    transform: scale(0.98);
                }
                .mini-btn:disabled,
                .toolbar-btn:disabled {
                    pointer-events: none;
                    opacity: 0.4;
                }
            `}</style>

            <EditorToolbar
                currentDocument={currentDocument}
                compileState={compileState}
                valid={valid}
                backStack={backStack}
                onBack={goBack}
                onRename={renameCurrent}
                onNew={createNewScript}
                onToggleScripts={() => setLibraryOpen((value) => !value)}
                onExecute={attemptExecute}
                onDownloadEditable={() => downloadEditableScript()}
                onDownloadCompiled={() => downloadCompiledArtifact()}
                onImport={importScriptFile}
                downloadOpen={downloadOpen}
                onToggleDownload={() => setDownloadOpen((value) => !value)}
            />

            <div className={`fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-md border border-emerald-300/15 bg-[#171717]/95 px-3 py-1.5 text-xs font-medium text-emerald-100 shadow-[0_12px_36px_rgba(0,0,0,0.28)] backdrop-blur transition-[opacity,transform] duration-150 ${saveFeedbackVisible ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"}`}>
                Saved!
            </div>

            <ScriptLibraryDrawer
                open={libraryOpen}
                scripts={scripts}
                currentScriptId={currentScriptId}
                isScriptUsable={getScriptBlockUsability}
                search={librarySearch}
                onSearch={setLibrarySearch}
                onClose={() => setLibraryOpen(false)}
                onCreate={createNewScript}
                onOpen={openScript}
                onUse={addLocalScriptBlock}
                onDuplicate={duplicateScript}
                onRename={renameLibraryScript}
                onDelete={deleteScript}
                onDownloadEditable={downloadEditableScript}
                onDownloadCompiled={downloadCompiledArtifact}
                onImport={importScriptFile}
            />

            {lastRun && (
                <div className="fixed bottom-4 left-4 z-40 max-w-[360px] rounded-md border border-white/10 bg-[#202020]/95 px-3 py-2 text-xs text-zinc-300 shadow-[0_14px_40px_rgba(0,0,0,0.25)]">
                    <div className="mb-1 font-medium text-white">
                        {lastRun.status === "success" ? "Execution output" : "Execution failed"}
                    </div>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-400">
                        {lastRun.status === "success"
                            ? JSON.stringify(lastRun.outputs || {}, null, 2)
                            : compactError(lastRun.e?.message)}
                    </pre>
                </div>
            )}

            <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={onImportFile}
            />

            <OutputNodeSidebar
                config={outputNodeConfig}
                onChange={updateOutputNodeConfig}
                valid={valid}
            />

            <div className="h-[100vh] w-[100vw] bg-[#292929]">
                <Grid />
                <LineManager
                    units={visibleUnitChildren}
                    notifyConnection={onConnectUnits}
                    onDeleteConnection={onDeleteConnection}
                    graphKey={renderGraphId}
                    connectionSnapshot={connectionSnapshot}
                />
                <AddMenu onAddUnit={addUnit} />

                <div key={renderGraphId} className="absolute left-4 top-4 text-white" ref={unitParentRef}>
                    {visibleUnitChildren}
                </div>
            </div>
        </>
    );
}
