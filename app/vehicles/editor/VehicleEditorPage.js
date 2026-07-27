'use client';

import { useEffect, useRef, useState } from "react";
import {
    FaArrowsAlt,
    FaCheck,
    FaClone,
    FaCube,
    FaDownload,
    FaExclamationTriangle,
    FaFileImport,
    FaPlus,
    FaSave,
    FaSyncAlt,
    FaTrash,
    FaUpload,
} from "react-icons/fa";

import {
    createDefaultVehicleManifest,
    deriveWheelbase,
    normalizeVehicleManifest,
    resolveVehicleModelUrl,
    validateVehicleManifest,
} from "../VehicleManifest.js";
import {
    getBuiltInVehicleManifest,
    isBuiltInVehicleManifest,
    listBuiltInVehicleManifests,
} from "../BuiltInVehicleManifests.js";
import {
    createVehicleManifest,
    deleteVehicleManifest,
    duplicateVehicleManifest,
    exportVehicleBundle,
    getVehicleManifest,
    importVehicleBundle,
    listVehicleManifests,
    saveVehicleManifest,
    uploadVehicleAsset,
    validateVehicleManifestOnServer,
} from "../VehicleManifestClient.js";
import { DragNumber } from "./DragNumber.js";
import { VehicleStudio } from "./VehicleStudio.js";

const TABS = ["Model", "LiDAR Zone", "Sensors", "Wheels", "Body", "JSON"];
const HISTORY_LIMIT = 100;
const EDIT_COALESCE_MS = 750;

function vehicleIdFromName(name) {
    return String(name || "vehicle")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `vehicle-${Date.now().toString(36)}`;
}

function downloadJson(name, value) {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
}

function differenceCount(left, right) {
    if (Object.is(left, right)) return 0;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return 1;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].reduce((sum, key) => sum + differenceCount(left[key], right[key]), 0);
}

function round3(value) {
    return Math.round(value * 1000) / 1000;
}

function roundVec(vector) {
    return { x: round3(vector.x), y: round3(vector.y), z: round3(vector.z) };
}

export default function VehicleEditorPage() {
    const importRef = useRef(null);
    const modelFileRef = useRef(null);
    const viewportRef = useRef(null);
    const studioRef = useRef(null);
    const studioHandlers = useRef({});
    const loadRequest = useRef(0);
    const undoStack = useRef([]);
    const redoStack = useRef([]);
    const lastEdit = useRef(null);

    const [catalog, setCatalog] = useState([]);
    const [loadState, setLoadState] = useState("loading");
    const [selectedId, setSelectedId] = useState(null);
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [raw, setRaw] = useState("");
    const [rawError, setRawError] = useState(null);
    const [tab, setTab] = useState("Model");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [validation, setValidation] = useState(null);
    const [selection, setSelection] = useState(null);
    const [gizmoMode, setGizmoMode] = useState("translate");
    const [assetVersion, setAssetVersion] = useState(0);
    const [zoneVisible, setZoneVisible] = useState(true);
    const [modelVisible, setModelVisible] = useState(true);
    const [voxelSize, setVoxelSize] = useState(0.2);
    const [fitTarget, setFitTarget] = useState({ length: 2.7, width: 1.25 });

    const dirty = Boolean(saved && draft && differenceCount(normalizeVehicleManifest(saved), normalizeVehicleManifest(draft)) > 0);
    const readOnly = isBuiltInVehicleManifest(selectedId);

    const resetHistory = () => {
        undoStack.current = [];
        redoStack.current = [];
        lastEdit.current = null;
    };

    const applyDocument = (id, document) => {
        const normalized = normalizeVehicleManifest(document);
        resetHistory();
        setSelectedId(id);
        setSaved(document);
        setDraft(normalized);
        setRaw(JSON.stringify(normalized, null, 2));
        setRawError(null);
        setValidation(null);
        setSelection(null);
    };

    const loadCatalog = async (preferredId = null) => {
        const requestId = ++loadRequest.current;
        setLoadState("loading");
        setError(null);
        try {
            const storedItems = (await listVehicleManifests()) || [];
            const builtInItems = listBuiltInVehicleManifests();
            const items = [...builtInItems, ...storedItems];
            if (requestId !== loadRequest.current) return;
            setCatalog(items);
            const nextId = items.some((entry) => entry.id === preferredId)
                ? preferredId
                : storedItems[0]?.id ?? builtInItems[0]?.id;
            if (!nextId) {
                resetHistory();
                setSelectedId(null);
                setSaved(null);
                setDraft(null);
                setRaw("");
                setLoadState("empty");
                return;
            }
            const document = getBuiltInVehicleManifest(nextId) ?? await getVehicleManifest(nextId);
            if (requestId !== loadRequest.current) return;
            if (!document) throw new Error(`Vehicle "${nextId}" no longer exists.`);
            applyDocument(nextId, document);
            setLoadState("ready");
        } catch (caught) {
            if (requestId !== loadRequest.current) return;
            setError(caught.message);
            setLoadState("error");
        }
    };

    useEffect(() => {
        loadCatalog();
        return () => { loadRequest.current += 1; };
        // The initial catalog load intentionally runs once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!dirty) return undefined;
        const protect = (event) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", protect);
        return () => window.removeEventListener("beforeunload", protect);
    }, [dirty]);

    // --- Studio lifecycle ----------------------------------------------------

    const hasDraft = Boolean(draft);
    useEffect(() => {
        if (!hasDraft || !viewportRef.current || studioRef.current) return undefined;
        const studio = new VehicleStudio(viewportRef.current, {
            onTransform: (pick, transform) => studioHandlers.current.onTransform?.(pick, transform),
            onSelect: (pick) => studioHandlers.current.onSelect?.(pick),
        });
        studioRef.current = studio;
        return () => {
            studio.dispose();
            studioRef.current = null;
        };
    }, [hasDraft]);

    useEffect(() => {
        if (!studioRef.current || !draft) return;
        const url = resolveVehicleModelUrl(selectedId, draft.model.asset, { cacheBust: assetVersion });
        studioRef.current.setManifest(draft, url);
    }, [draft, selectedId, assetVersion]);

    useEffect(() => { studioRef.current?.setSelection(readOnly ? null : selection); }, [selection, readOnly]);
    useEffect(() => { studioRef.current?.setGizmoMode(gizmoMode); }, [gizmoMode]);
    useEffect(() => { studioRef.current?.setZoneVisible(zoneVisible); }, [zoneVisible]);
    useEffect(() => { studioRef.current?.setModelVisible(modelVisible); }, [modelVisible]);

    const recordHistory = (current, key, { coalesce = false } = {}) => {
        const now = performance.now();
        const previous = lastEdit.current;
        const joinsPrevious = coalesce
            && previous?.key === key
            && now - previous.at <= EDIT_COALESCE_MS;

        if (!joinsPrevious) {
            undoStack.current.push(structuredClone(current));
            if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
        }
        redoStack.current = [];
        lastEdit.current = coalesce ? { key, at: now } : null;
    };

    const update = (path, value, options = {}) => {
        if (readOnly) return;
        setDraft((current) => {
            if (!current) return current;
            recordHistory(current, path.join("."), {
                coalesce: options.coalesce ?? ["number", "string"].includes(typeof value),
            });
            const next = structuredClone(current);
            let cursor = next;
            path.slice(0, -1).forEach((part) => { cursor = cursor[part]; });
            cursor[path.at(-1)] = value;
            const normalized = normalizeVehicleManifest(next);
            // Keep the active string field verbatim while the user is typing;
            // normalization would trim a trailing space mid-keystroke.
            if (typeof value === "string") {
                let normalizedCursor = normalized;
                path.slice(0, -1).forEach((part) => { normalizedCursor = normalizedCursor[part]; });
                normalizedCursor[path.at(-1)] = value;
            }
            setRaw(JSON.stringify(normalized, null, 2));
            setValidation(null);
            return normalized;
        });
    };

    useEffect(() => {
        const restore = (source, destination) => {
            if (source.current.length === 0) return false;
            const snapshot = source.current.pop();
            setDraft((current) => {
                if (!current) return current;
                destination.current.push(structuredClone(current));
                if (destination.current.length > HISTORY_LIMIT) destination.current.shift();
                const normalized = normalizeVehicleManifest(snapshot);
                setRaw(JSON.stringify(normalized, null, 2));
                setRawError(null);
                setValidation(null);
                return normalized;
            });
            lastEdit.current = null;
            return true;
        };

        const onHistoryShortcut = (event) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
            const key = event.key.toLowerCase();
            const wantsUndo = key === "z" && !event.shiftKey;
            const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey);
            if (!wantsUndo && !wantsRedo) return;

            const changed = wantsUndo
                ? restore(undoStack, redoStack)
                : restore(redoStack, undoStack);
            if (!changed) return;
            event.preventDefault();
        };

        document.addEventListener("keydown", onHistoryShortcut);
        return () => document.removeEventListener("keydown", onHistoryShortcut);
    }, []);

    studioHandlers.current.onTransform = (pick, transform) => {
        const position = roundVec(transform.position);
        const rotation = { ...roundVec(transform.rotation), order: "XYZ" };
        if (pick.kind === "sensor") {
            const index = draft?.sensors.findIndex((entry) => entry.id === pick.id);
            if (index === undefined || index < 0) return;
            update(["sensors", index, "pose"], { position, rotation }, { coalesce: true });
        } else if (pick.kind === "wheel") {
            const index = draft?.wheels.findIndex((entry) => entry.id === pick.id);
            if (index === undefined || index < 0) return;
            update(["wheels", index, "position"], position, { coalesce: true });
        } else if (pick.kind === "body") {
            update(["boundingBox", "center"], position, { coalesce: true });
        } else if (pick.kind === "ego") {
            update(["egoCenter"], position, { coalesce: true });
        } else if (pick.kind === "model") {
            update(["model"], { ...draft.model, offset: position, rotation }, { coalesce: true });
        }
    };

    studioHandlers.current.onSelect = (pick) => {
        if (readOnly) return;
        setSelection(pick);
        if (pick?.kind === "sensor") setTab("Sensors");
        if (pick?.kind === "wheel") setTab("Wheels");
        if (pick?.kind === "ego") setTab("Body");
    };

    // Drop a stale selection when its target leaves the draft.
    useEffect(() => {
        if (!selection || !draft) return;
        if (selection.kind === "sensor" && !draft.sensors.some((entry) => entry.id === selection.id)) setSelection(null);
        if (selection.kind === "wheel" && !draft.wheels.some((entry) => entry.id === selection.id)) setSelection(null);
        if (selection.kind === "model" && !draft.model.asset) setSelection(null);
    }, [draft, selection]);

    // --- Catalog operations ---------------------------------------------------

    const perform = async (operation, { nested = false } = {}) => {
        if (!nested) setBusy(true);
        setError(null);
        try {
            return await operation();
        } catch (caught) {
            setError(caught.message);
            throw caught;
        } finally {
            if (!nested) setBusy(false);
        }
    };

    const select = async (id) => {
        if (dirty && !window.confirm("Discard unsaved vehicle changes?")) return;
        await perform(async () => {
            const document = getBuiltInVehicleManifest(id) ?? await getVehicleManifest(id);
            if (!document) throw new Error(`Vehicle "${id}" no longer exists.`);
            applyDocument(id, document);
            setLoadState("ready");
        });
    };

    const createNew = async () => {
        const baseName = "Untitled Vehicle";
        let id = vehicleIdFromName(baseName);
        const existing = new Set(catalog.map((entry) => entry.id));
        let suffix = 2;
        while (existing.has(id)) id = `${vehicleIdFromName(baseName)}-${suffix++}`;
        await perform(async () => {
            const created = await createVehicleManifest(createDefaultVehicleManifest({ id, name: baseName }));
            await loadCatalog(created.id);
        });
    };

    const save = async () => perform(async () => {
        const local = validateVehicleManifest(draft);
        if (!local.ok) {
            setValidation(local);
            throw new Error("Fix validation errors before saving.");
        }
        const stored = await saveVehicleManifest(selectedId, local.manifest, saved.revision);
        setSaved(stored);
        setDraft(normalizeVehicleManifest(stored));
        setRaw(JSON.stringify(normalizeVehicleManifest(stored), null, 2));
        lastEdit.current = null;
        setCatalog((items) => items.map((entry) => entry.id === stored.id
            ? { ...entry, name: stored.name, revision: stored.revision, definitionHash: stored.definitionHash, modelAsset: stored.model?.asset ?? null }
            : entry));
        return stored;
    });

    const validate = async () => perform(async () => {
        const result = await validateVehicleManifestOnServer(selectedId, draft);
        setValidation(result);
        if (!result.ok) throw new Error("Vehicle validation found issues.");
        return result;
    });

    const duplicate = () => perform(async () => {
        const builtIn = getBuiltInVehicleManifest(selectedId);
        const baseId = builtIn ? `${selectedId}-custom` : `${selectedId}-copy-${Date.now().toString(36)}`;
        let id = baseId;
        const existing = new Set(catalog.map((entry) => entry.id));
        let suffix = 2;
        while (existing.has(id)) id = `${baseId}-${suffix++}`;
        const created = builtIn
            ? await createVehicleManifest({ ...builtIn, id, name: `${builtIn.name} Copy` })
            : await duplicateVehicleManifest(selectedId, { id, name: `${draft.name} Copy` });
        await loadCatalog(created.id);
    });

    const remove = () => perform(async () => {
        if (!window.confirm(`Delete “${draft.name}”?`)) return;
        await deleteVehicleManifest(selectedId);
        setSelectedId(null);
        setSaved(null);
        setDraft(null);
        resetHistory();
        await loadCatalog();
    });

    const exportBundle = () => perform(async () => {
        if (dirty) await save();
        const bundle = await exportVehicleBundle(selectedId);
        downloadJson(`${selectedId}.vehicle-bundle.json`, bundle);
    });

    const importBundleFile = (event) => perform(async () => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const created = await importVehicleBundle(JSON.parse(await file.text()));
        await loadCatalog(created.id);
    });

    // --- Model tab operations -------------------------------------------------

    const uploadModelFile = (event) => perform(async () => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !selectedId) return;
        const extension = file.name.toLowerCase().endsWith(".gltf") ? "gltf" : "glb";
        const fileName = `model.${extension}`;
        await uploadVehicleAsset(selectedId, fileName, file);
        setAssetVersion((version) => version + 1);
        update(["model", "asset"], fileName);
    });

    const fitModelToSize = () => {
        const bounds = studioRef.current?.getModelBounds();
        if (!bounds) {
            setError("Import a model before fitting it to a size.");
            return;
        }
        const currentLength = bounds.size.x / (draft.model.scale || 1);
        const currentWidth = bounds.size.z / (draft.model.scale || 1);
        if (currentLength <= 0 || currentWidth <= 0) return;
        const scale = Math.min(fitTarget.length / currentLength, fitTarget.width / currentWidth);
        update(["model", "scale"], round3(scale) || draft.model.scale);
    };

    const generateZone = () => {
        try {
            const zone = studioRef.current?.generateLidarZone(voxelSize);
            if (zone) update(["lidarZone"], zone);
            setError(null);
        } catch (caught) {
            setError(caught.message);
        }
    };

    const fitBodyToModel = () => {
        const bounds = studioRef.current?.getModelBounds();
        if (!bounds) {
            setError("Import a model before fitting the bounding box.");
            return;
        }
        update(["boundingBox"], {
            size: roundVec(bounds.size),
            center: roundVec(bounds.center),
        });
    };

    // --- JSON tab --------------------------------------------------------------

    const applyRaw = (value) => {
        if (readOnly) return;
        setRaw(value);
        try {
            const parsed = JSON.parse(value);
            const local = validateVehicleManifest(parsed);
            if (!local.ok) {
                setRawError(local.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n"));
                return;
            }
            setRawError(null);
            setDraft((current) => {
                if (current) recordHistory(current, "raw-json", { coalesce: true });
                return local.manifest;
            });
            setValidation(null);
        } catch (caught) {
            setRawError(caught.message);
        }
    };

    const derivedWheelbase = draft ? deriveWheelbase(draft.wheels) : null;

    return (
        <main className="fixed inset-0 overflow-hidden bg-zinc-950 text-zinc-100">
            <header className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-5">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-400">Vehicle authoring</p>
                    <h1 className="mt-0.5 text-lg font-semibold">Vehicle editor</h1>
                </div>
                <div className="flex items-center gap-2">
                    {readOnly && <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-200">Built-in · read only</span>}
                    {dirty && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200">Unsaved</span>}
                    <Action icon={<FaCheck />} label="Validate" onClick={validate} disabled={!draft || busy || readOnly} />
                    <Action primary icon={<FaSave />} label="Save" onClick={save} disabled={!draft || !dirty || busy || readOnly} />
                </div>
            </header>

            <div className="grid h-[calc(100vh-4rem)] grid-cols-[240px_minmax(0,1fr)_360px]">
                <aside className="flex min-h-0 flex-col border-r border-zinc-800 bg-zinc-950">
                    <div className="flex items-center gap-1.5 border-b border-zinc-800 p-3">
                        <Action icon={<FaPlus />} label="New" onClick={createNew} disabled={busy} compact />
                        <Action icon={<FaFileImport />} label="Import" onClick={() => importRef.current?.click()} disabled={busy} compact />
                        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importBundleFile} />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                        {catalog.map((entry, index) => (
                            <div key={entry.id}>
                                {(index === 0 || catalog[index - 1]?.builtIn !== entry.builtIn) && (
                                    <p className="px-2 pb-1 pt-2 text-[8px] font-semibold uppercase tracking-[0.16em] text-zinc-600">
                                        {entry.builtIn ? "Built-in vehicles" : "Custom vehicles"}
                                    </p>
                                )}
                                <button type="button" onClick={() => select(entry.id)} className={`mb-1 w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${entry.id === selectedId ? "border-sky-400/50 bg-sky-500/10" : "border-transparent hover:border-zinc-700 hover:bg-zinc-900"}`}>
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="block min-w-0 truncate text-xs font-semibold">{entry.name}</span>
                                        {entry.builtIn && <span className="shrink-0 rounded border border-violet-400/20 bg-violet-400/10 px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-wide text-violet-300">Built-in</span>}
                                    </span>
                                    <span className="mt-1 block truncate font-mono text-[9px] text-zinc-500">
                                        {entry.builtIn ? `${entry.id} · read only` : `${entry.id} · r${entry.revision}${entry.modelAsset ? "" : " · no model"}`}
                                    </span>
                                </button>
                            </div>
                        ))}
                        {loadState === "empty" && (
                            <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-zinc-600">No vehicles yet. Create one to start authoring.</p>
                        )}
                    </div>
                    {draft && (
                        <div className="space-y-2 border-t border-zinc-800 p-3">
                            <div className="flex gap-1.5">
                                <Action compact icon={<FaClone />} label="Duplicate" onClick={duplicate} disabled={busy} />
                                {!readOnly && <Action compact icon={<FaDownload />} label="Export" onClick={exportBundle} disabled={busy} />}
                                {!readOnly && <button type="button" aria-label="Delete vehicle" onClick={remove} disabled={busy} className="grid h-8 w-8 place-items-center rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-50"><FaTrash className="h-3 w-3" /></button>}
                            </div>
                            <p className="truncate font-mono text-[9px] text-zinc-600">{readOnly ? "Duplicate to create an editable copy" : saved?.definitionHash || "unsaved"}</p>
                        </div>
                    )}
                </aside>

                <section className="relative min-w-0 bg-zinc-950">
                    {loadState === "loading" && <CenterState title="Loading vehicles…" detail="Reading the server-backed vehicle catalog." />}
                    {loadState === "error" && (
                        <CenterState error title="Couldn’t load vehicles" detail={error || "The vehicle catalog is unavailable."} action={<Action icon={<FaSyncAlt />} label="Retry" onClick={() => loadCatalog(selectedId)} />} />
                    )}
                    {loadState === "empty" && (
                        <CenterState title="No vehicles" detail="Create the first vehicle manifest to open the studio." action={<Action primary icon={<FaPlus />} label="Create vehicle" onClick={createNew} disabled={busy} />} />
                    )}
                    {draft && (
                        <>
                            <div ref={viewportRef} className="absolute inset-0" />
                            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
                                {readOnly ? (
                                    <div className="rounded-lg border border-violet-400/20 bg-zinc-950/80 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-violet-300 backdrop-blur">Read-only preview</div>
                                ) : (
                                    <div className="pointer-events-auto flex rounded-lg border border-zinc-700/80 bg-zinc-950/80 p-0.5 backdrop-blur">
                                        {[["translate", "Move"], ["rotate", "Rotate"]].map(([mode, label]) => (
                                            <button key={mode} type="button" onClick={() => setGizmoMode(mode)} className={`rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${gizmoMode === mode ? "bg-sky-500/20 text-sky-100" : "text-zinc-400 hover:text-zinc-200"}`}>{label}</button>
                                        ))}
                                    </div>
                                )}
                                {selection && (
                                    <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-zinc-700/80 bg-zinc-950/80 px-2.5 py-1.5 backdrop-blur">
                                        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-300">{selection.kind}{selection.id ? ` · ${selection.id}` : ""}</span>
                                        <button type="button" onClick={() => setSelection(null)} className="text-[10px] text-zinc-400 hover:text-zinc-100">Deselect</button>
                                    </div>
                                )}
                            </div>
                            <p className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-zinc-800/80 bg-zinc-950/70 px-2 py-1 text-[9px] uppercase tracking-[0.12em] text-zinc-500 backdrop-blur">
                                {readOnly ? "Orbit to inspect · duplicate to edit" : "Click a marker to select · drag gizmo to place"}
                            </p>
                        </>
                    )}
                </section>

                <aside className="flex min-h-0 flex-col border-l border-zinc-800 bg-zinc-950">
                    {draft && (
                        <>
                            <div className="border-b border-zinc-800 p-3">
                                <div className="config-field mb-2">
                                    <input aria-label="Vehicle name" value={draft.name} disabled={readOnly} onChange={(event) => update(["name"], event.target.value)} />
                                </div>
                                <p className="truncate font-mono text-[9px] text-zinc-600">{draft.id}</p>
                            </div>
                            {readOnly && (
                                <div className="border-b border-violet-400/15 bg-violet-400/5 px-3 py-2.5 text-[10px] leading-relaxed text-violet-200">
                                    This built-in vehicle is defined in code. Inspect its projected values here, or duplicate it to make an editable manifest.
                                </div>
                            )}
                            <nav className="flex gap-1 overflow-x-auto border-b border-zinc-800 p-1.5">
                                {TABS.map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${tab === item ? "bg-sky-500/20 text-sky-100" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}>{item}</button>)}
                            </nav>

                            {(error || rawError || validation?.issues?.length > 0) && (
                                <div className="m-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-100">
                                    <div className="flex items-start gap-2"><FaExclamationTriangle className="mt-0.5 shrink-0" /><pre className="whitespace-pre-wrap font-sans">{error || rawError || validation.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n")}</pre></div>
                                </div>
                            )}
                            {validation?.ok && <div className="m-3 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[11px] text-emerald-200"><FaCheck /> Vehicle manifest is valid.</div>}

                            <fieldset disabled={readOnly} className="min-h-0 flex-1 overflow-y-auto p-3">
                                {tab === "Model" && (
                                    <ModelTab
                                        draft={draft}
                                        update={update}
                                        busy={busy}
                                        modelFileRef={modelFileRef}
                                        uploadModelFile={uploadModelFile}
                                        selection={selection}
                                        setSelection={setSelection}
                                        modelVisible={modelVisible}
                                        setModelVisible={setModelVisible}
                                        fitTarget={fitTarget}
                                        setFitTarget={setFitTarget}
                                        fitModelToSize={fitModelToSize}
                                    />
                                )}
                                {tab === "LiDAR Zone" && (
                                    <LidarZoneTab
                                        draft={draft}
                                        update={update}
                                        voxelSize={voxelSize}
                                        setVoxelSize={setVoxelSize}
                                        generateZone={generateZone}
                                        zoneVisible={zoneVisible}
                                        setZoneVisible={setZoneVisible}
                                    />
                                )}
                                {tab === "Sensors" && <SensorsTab draft={draft} update={update} selection={selection} setSelection={setSelection} />}
                                {tab === "Wheels" && <WheelsTab draft={draft} update={update} selection={selection} setSelection={setSelection} derivedWheelbase={derivedWheelbase} />}
                                {tab === "Body" && <BodyTab draft={draft} update={update} selection={selection} setSelection={setSelection} fitBodyToModel={fitBodyToModel} />}
                                {tab === "JSON" && (
                                    <div className="space-y-2">
                                        <textarea aria-label="Raw vehicle manifest JSON" spellCheck={false} value={raw} onChange={(event) => applyRaw(event.target.value)} className="min-h-[480px] w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500" />
                                        <p className="text-[9px] leading-relaxed text-zinc-600">Applies on every valid parse. The LiDAR zone arrays are baked data; regenerate them from the LiDAR Zone tab after moving the model.</p>
                                    </div>
                                )}
                            </fieldset>
                        </>
                    )}
                </aside>
            </div>
        </main>
    );
}

function ModelTab({ draft, update, busy, modelFileRef, uploadModelFile, selection, setSelection, modelVisible, setModelVisible, fitTarget, setFitTarget, fitModelToSize }) {
    return (
        <div className="space-y-4">
            <Section title="Source model">
                <div className="flex items-center gap-2">
                    <Action compact icon={<FaUpload />} label={draft.model.asset ? "Replace model" : "Import GLB / GLTF"} onClick={() => modelFileRef.current?.click()} disabled={busy} />
                    <input ref={modelFileRef} hidden type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" onChange={uploadModelFile} />
                    {draft.model.asset && (
                        <button type="button" onClick={() => update(["model", "asset"], "")} className="text-[10px] text-red-300 hover:text-red-200">Detach</button>
                    )}
                </div>
                <p className="mt-2 font-mono text-[9px] text-zinc-500">{draft.model.asset || "No model — a placeholder body is shown."}</p>
                <p className="mt-1 text-[9px] leading-relaxed text-zinc-600">Use a self-contained .glb or .gltf. The file uploads immediately and is stored next to the manifest.</p>
            </Section>

            <Section title="Placement">
                <div className="mb-2 flex items-center justify-between">
                    <Toggle label="Show model" value={modelVisible} onChange={setModelVisible} />
                    <Action
                        compact
                        icon={<FaArrowsAlt />}
                        label={selection?.kind === "model" ? "Gizmo active" : "Move with gizmo"}
                        onClick={() => setSelection(selection?.kind === "model" ? null : { kind: "model", id: null })}
                        disabled={!draft.model.asset}
                    />
                </div>
                <Field label="Scale">
                    <input type="number" min="0.0001" step="0.0001" value={draft.model.scale} onChange={(event) => update(["model", "scale"], Number(event.target.value))} />
                </Field>
                <VectorFields label="Rotation (rad)" value={draft.model.rotation} onChange={(axis, value) => update(["model", "rotation", axis], value)} />
                <VectorFields label="Offset (m)" value={draft.model.offset} onChange={(axis, value) => update(["model", "offset", axis], value)} scrub />
            </Section>

            <Section title="Fit to real size">
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Target length (m, X)">
                        <DragNumber min={0.01} step={0.01} value={fitTarget.length} onChange={(next) => setFitTarget((current) => ({ ...current, length: next }))} aria-label="Target length (m, X)" />
                    </Field>
                    <Field label="Target width (m, Z)">
                        <DragNumber min={0.01} step={0.01} value={fitTarget.width} onChange={(next) => setFitTarget((current) => ({ ...current, width: next }))} aria-label="Target width (m, Z)" />
                    </Field>
                </div>
                <div className="mt-2"><Action compact icon={<FaCube />} label="Rescale model" onClick={fitModelToSize} disabled={!draft.model.asset} /></div>
                <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">Sets the scale so the model footprint matches the target length and width, preserving aspect ratio.</p>
            </Section>
        </div>
    );
}

function LidarZoneTab({ draft, update, voxelSize, setVoxelSize, generateZone, zoneVisible, setZoneVisible }) {
    const zone = draft.lidarZone;
    return (
        <div className="space-y-4">
            <Section title="Reduced-polygon collision mesh">
                <p className="text-[10px] leading-relaxed text-zinc-500">LiDAR and other GPU sensors raycast against this simplified mesh instead of the full model. Regenerate it after changing the model placement.</p>
                <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Voxel size</span>
                        <span className="font-mono text-[10px] text-sky-300">{voxelSize.toFixed(2)} m</span>
                    </div>
                    <input aria-label="Voxel size" type="range" min="0.05" max="1" step="0.05" value={voxelSize} onChange={(event) => setVoxelSize(Number(event.target.value))} className="timeline-range w-full" />
                    <p className="mt-1 text-[9px] text-zinc-600">Larger voxels merge more vertices and produce fewer triangles.</p>
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <Action compact primary icon={<FaSyncAlt />} label="Generate" onClick={generateZone} disabled={!draft.model.asset} />
                    {zone.triangles.length > 0 && (
                        <button type="button" onClick={() => update(["lidarZone"], { params: { voxelSize }, vertices: [], triangles: [] })} className="text-[10px] text-red-300 hover:text-red-200">Clear</button>
                    )}
                </div>
            </Section>
            <Section title="Baked result">
                <div className="grid grid-cols-2 gap-2">
                    <Stat label="Vertices" value={zone.vertices.length} />
                    <Stat label="Triangles" value={zone.triangles.length} />
                </div>
                <p className="mt-2 font-mono text-[9px] text-zinc-600">baked at voxel {zone.params.voxelSize} m</p>
                <div className="mt-2"><Toggle label="Show wireframe preview" value={zoneVisible} onChange={setZoneVisible} /></div>
            </Section>
        </div>
    );
}

function SensorsTab({ draft, update, selection, setSelection }) {
    const add = (type) => {
        const id = nextId(draft.sensors, type === "camera" ? "camera" : "lidar");
        update(["sensors"], [...draft.sensors, { id, type, pose: { position: { x: 0.3, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } }, config: {} }]);
        setSelection({ kind: "sensor", id });
    };
    return (
        <div className="space-y-3">
            <div className="flex gap-1.5">
                <Action compact icon={<FaPlus />} label="Add LiDAR" onClick={() => add("lidar3d")} />
                <Action compact icon={<FaPlus />} label="Add camera" onClick={() => add("camera")} />
            </div>
            {draft.sensors.length === 0 && <p className="py-8 text-center text-[11px] text-zinc-600">No sensors on this vehicle.</p>}
            {draft.sensors.map((sensor, index) => {
                const selected = selection?.kind === "sensor" && selection.id === sensor.id;
                const change = (parts, value) => update(["sensors", index, ...parts], value);
                return (
                    <div key={`sensor-${index}`} className={`rounded-xl border p-3 transition-colors ${selected ? "border-sky-400/50 bg-sky-500/5" : "border-zinc-800 bg-zinc-950/50"}`}>
                        <button type="button" onClick={() => setSelection(selected ? null : { kind: "sensor", id: sensor.id })} className="mb-2 flex w-full items-center justify-between text-left">
                            <span className="text-[11px] font-semibold">{sensor.id}</span>
                            <span className={`text-[9px] font-semibold uppercase tracking-[0.12em] ${sensor.type === "camera" ? "text-amber-300" : "text-sky-300"}`}>{sensor.type}</span>
                        </button>
                        <div className="grid grid-cols-2 gap-2">
                            <Field label="Stable ID">
                                <input
                                    value={sensor.id}
                                    onChange={(event) => {
                                        const nextId = event.target.value;
                                        change(["id"], nextId);
                                        if (selected) setSelection({ kind: "sensor", id: nextId });
                                    }}
                                />
                            </Field>
                            <Field label="Type"><select value={sensor.type} onChange={(event) => change(["type"], event.target.value)}><option value="lidar3d">3D LiDAR</option><option value="camera">Camera</option></select></Field>
                        </div>
                        <VectorFields label="Position (m)" value={sensor.pose.position} onChange={(axis, value) => change(["pose", "position", axis], value)} scrub />
                        <VectorFields label="Rotation (rad)" value={sensor.pose.rotation} onChange={(axis, value) => change(["pose", "rotation", axis], value)} />
                        <div className="mt-3 grid grid-cols-2 gap-2">
                            <Field label="Range (m)"><input type="number" min="0.1" step="0.1" value={sensor.config.range} onChange={(event) => change(["config", "range"], Number(event.target.value))} /></Field>
                            {sensor.type === "camera" ? (
                                <>
                                    <Field label="Vertical FOV (deg)"><input type="number" min="1" max="179" value={sensor.config.fov} onChange={(event) => change(["config", "fov"], Number(event.target.value))} /></Field>
                                    <Field label="Width (px)"><input type="number" min="1" value={sensor.config.width} onChange={(event) => change(["config", "width"], Number(event.target.value))} /></Field>
                                    <Field label="Height (px)"><input type="number" min="1" value={sensor.config.height} onChange={(event) => change(["config", "height"], Number(event.target.value))} /></Field>
                                    <Field label="Theta step (deg)"><input type="number" min="0.01" step="0.01" value={sensor.config.thetaStep} onChange={(event) => change(["config", "thetaStep"], Number(event.target.value))} /></Field>
                                    <Field label="Phi step (deg)"><input type="number" min="0.01" step="0.01" value={sensor.config.phiStep} onChange={(event) => change(["config", "phiStep"], Number(event.target.value))} /></Field>
                                </>
                            ) : (
                                <>
                                    <Field label="Theta step (deg)"><input type="number" min="0.01" step="0.01" value={sensor.config.thetaStep} onChange={(event) => change(["config", "thetaStep"], Number(event.target.value))} /></Field>
                                    <Field label="Theta start (deg)"><input type="number" value={sensor.config.thetaRange?.[0]} onChange={(event) => change(["config", "thetaRange"], [Number(event.target.value), sensor.config.thetaRange?.[1] ?? 180])} /></Field>
                                    <Field label="Theta end (deg)"><input type="number" value={sensor.config.thetaRange?.[1]} onChange={(event) => change(["config", "thetaRange"], [sensor.config.thetaRange?.[0] ?? -180, Number(event.target.value)])} /></Field>
                                    <Field label="Phi step (deg)"><input type="number" min="0.01" step="0.01" value={sensor.config.phiStep} onChange={(event) => change(["config", "phiStep"], Number(event.target.value))} /></Field>
                                    <Field label="Phi start (deg)"><input type="number" value={sensor.config.phiRange?.[0]} onChange={(event) => change(["config", "phiRange"], [Number(event.target.value), sensor.config.phiRange?.[1] ?? 20])} /></Field>
                                    <Field label="Phi end (deg)"><input type="number" value={sensor.config.phiRange?.[1]} onChange={(event) => change(["config", "phiRange"], [sensor.config.phiRange?.[0] ?? -20, Number(event.target.value)])} /></Field>
                                </>
                            )}
                        </div>
                        <button type="button" onClick={() => update(["sensors"], draft.sensors.filter((_, candidate) => candidate !== index))} className="mt-3 text-[10px] text-red-300 hover:text-red-200">Remove sensor</button>
                    </div>
                );
            })}
        </div>
    );
}

function WheelsTab({ draft, update, selection, setSelection, derivedWheelbase }) {
    const add = (mirrored) => {
        const base = { position: { x: 0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: false };
        const added = mirrored
            ? [
                { ...base, id: nextId(draft.wheels, "wheel"), position: { ...base.position } },
                { ...base, id: nextId(draft.wheels, "wheel", 2), position: { ...base.position, z: -base.position.z } },
            ]
            : [{ ...base, id: nextId(draft.wheels, "wheel") }];
        update(["wheels"], [...draft.wheels, ...added]);
        setSelection({ kind: "wheel", id: added[0].id });
    };
    return (
        <div className="space-y-3">
            <div className="flex gap-1.5">
                <Action compact icon={<FaPlus />} label="Add wheel" onClick={() => add(false)} />
                <Action compact icon={<FaPlus />} label="Add mirrored pair" onClick={() => add(true)} />
            </div>
            {draft.wheels.map((wheel, index) => {
                const selected = selection?.kind === "wheel" && selection.id === wheel.id;
                const change = (parts, value) => update(["wheels", index, ...parts], value);
                return (
                    <div key={`wheel-${index}`} className={`rounded-xl border p-3 transition-colors ${selected ? "border-sky-400/50 bg-sky-500/5" : "border-zinc-800 bg-zinc-950/50"}`}>
                        <button type="button" onClick={() => setSelection(selected ? null : { kind: "wheel", id: wheel.id })} className="mb-2 flex w-full items-center justify-between text-left">
                            <span className="text-[11px] font-semibold">{wheel.id}</span>
                            {wheel.steerable && <span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-sky-300">steerable</span>}
                        </button>
                        <div className="grid grid-cols-2 gap-2">
                            <Field label="Stable ID">
                                <input
                                    value={wheel.id}
                                    onChange={(event) => {
                                        const nextId = event.target.value;
                                        change(["id"], nextId);
                                        if (selected) setSelection({ kind: "wheel", id: nextId });
                                    }}
                                />
                            </Field>
                            <Toggle label="Steerable" value={wheel.steerable} onChange={(value) => change(["steerable"], value)} />
                            <Field label="Radius (m)"><input type="number" min="0.01" step="0.01" value={wheel.radius} onChange={(event) => change(["radius"], Number(event.target.value))} /></Field>
                            <Field label="Width (m)"><input type="number" min="0.01" step="0.01" value={wheel.width} onChange={(event) => change(["width"], Number(event.target.value))} /></Field>
                        </div>
                        <VectorFields label="Position (m)" value={wheel.position} onChange={(axis, value) => change(["position", axis], value)} scrub />
                        <div className="mt-3 flex items-center justify-between">
                            <button type="button" onClick={() => update(["wheels", index, "position", "z"], -wheel.position.z)} className="text-[10px] text-zinc-400 hover:text-zinc-200">Mirror across X</button>
                            <button type="button" onClick={() => update(["wheels"], draft.wheels.filter((_, candidate) => candidate !== index))} className="text-[10px] text-red-300 hover:text-red-200">Remove</button>
                        </div>
                    </div>
                );
            })}
            <Section title="Kinematics">
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Wheelbase (m)"><input type="number" min="0.01" step="0.01" value={draft.kinematics.wheelbase} onChange={(event) => update(["kinematics", "wheelbase"], Number(event.target.value))} /></Field>
                    <Field label="Max steering (rad)"><input type="number" min="0.01" step="0.01" value={draft.kinematics.maxSteeringAngle} onChange={(event) => update(["kinematics", "maxSteeringAngle"], Number(event.target.value))} /></Field>
                </div>
                {derivedWheelbase !== null && (
                    <div className="mt-2 flex items-center justify-between">
                        <p className="text-[9px] text-zinc-600">Derived from wheel placement: <span className="font-mono text-zinc-400">{derivedWheelbase.toFixed(3)} m</span></p>
                        <button type="button" onClick={() => update(["kinematics", "wheelbase"], round3(derivedWheelbase))} className="text-[10px] text-sky-300 hover:text-sky-200">Use derived</button>
                    </div>
                )}
            </Section>
        </div>
    );
}

function BodyTab({ draft, update, selection, setSelection, fitBodyToModel }) {
    const bodySelected = selection?.kind === "body";
    const egoSelected = selection?.kind === "ego";
    return (
        <div className="space-y-4">
            <Section title="Bounding box">
                <p className="text-[10px] leading-relaxed text-zinc-500">Drives the physics AABB. The translucent box in the viewport previews it.</p>
                <div className="mt-2 flex items-center gap-2">
                    <Action compact icon={<FaArrowsAlt />} label={bodySelected ? "Gizmo active" : "Move center with gizmo"} onClick={() => setSelection(bodySelected ? null : { kind: "body", id: null })} />
                    <Action compact icon={<FaCube />} label="Fit to model" onClick={fitBodyToModel} disabled={!draft.model.asset} />
                </div>
                <VectorFields label="Size (m)" value={draft.boundingBox.size} onChange={(axis, value) => update(["boundingBox", "size", axis], value)} scrub min={0.01} />
                <VectorFields label="Center (m)" value={draft.boundingBox.center} onChange={(axis, value) => update(["boundingBox", "center", axis], value)} scrub />
            </Section>
            <Section title="Ego center">
                <p className="text-[10px] leading-relaxed text-zinc-500">The reference point cameras follow and tooling focuses on, marked by the green axes.</p>
                <div className="mt-2">
                    <Action compact icon={<FaArrowsAlt />} label={egoSelected ? "Gizmo active" : "Move with gizmo"} onClick={() => setSelection(egoSelected ? null : { kind: "ego", id: null })} />
                </div>
                <VectorFields label="Position (m)" value={draft.egoCenter} onChange={(axis, value) => update(["egoCenter", axis], value)} scrub />
            </Section>
        </div>
    );
}

function nextId(entries, prefix, offset = 1) {
    const used = new Set(entries.map((entry) => entry.id));
    let index = entries.length + offset;
    while (used.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
}

function CenterState({ title, detail, action = null, error = false }) {
    return <div className="grid h-full place-items-center p-6"><div className={`max-w-md rounded-2xl border p-6 text-center ${error ? "border-red-500/30 bg-red-500/10" : "border-zinc-800 bg-zinc-900/35"}`}><h2 className={`text-sm font-semibold ${error ? "text-red-200" : "text-zinc-200"}`}>{title}</h2><p className="mt-2 text-xs leading-relaxed text-zinc-500">{detail}</p>{action && <div className="mt-4 flex justify-center">{action}</div>}</div></div>;
}

function Section({ title, children }) {
    return <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-3"><p className="mb-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{title}</p>{children}</div>;
}

function Stat({ label, value }) {
    return <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"><p className="text-[9px] uppercase tracking-[0.14em] text-zinc-500">{label}</p><p className="mt-0.5 font-mono text-sm font-semibold text-zinc-100">{value.toLocaleString()}</p></div>;
}

function VectorFields({ label, value, onChange, scrub = false, min, step = 0.01 }) {
    return (
        <div className="mt-3">
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</p>
            <div className="grid grid-cols-3 gap-2">
                {["x", "y", "z"].map((axis) => (
                    <Field key={axis} label={axis.toUpperCase()}>
                        {scrub ? (
                            <DragNumber
                                value={value?.[axis] ?? 0}
                                onChange={(next) => onChange(axis, next)}
                                min={min}
                                step={step}
                                aria-label={`${label} ${axis.toUpperCase()}`}
                            />
                        ) : (
                            <input type="number" step={step} min={min} value={value?.[axis] ?? 0} onChange={(event) => onChange(axis, Number(event.target.value))} />
                        )}
                    </Field>
                ))}
            </div>
        </div>
    );
}

function Field({ label, children }) {
    return <label><span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</span><span className="config-field block">{children}</span></label>;
}

function Toggle({ label, value, onChange }) {
    return <button type="button" onClick={() => onChange(!value)} className="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-[11px] text-zinc-200"><span>{label}</span><span className={`h-4 w-7 rounded-full border p-0.5 ${value ? "border-sky-400 bg-sky-500/40" : "border-zinc-700 bg-zinc-800"}`}><span className={`block h-2.5 w-2.5 rounded-full bg-white transition-transform ${value ? "translate-x-3" : ""}`} /></span></button>;
}

function Action({ icon, label, onClick, disabled = false, primary = false, compact = false }) {
    return <button type="button" disabled={disabled} onClick={() => Promise.resolve(onClick?.()).catch(() => {})} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${compact ? "h-8 px-2.5 text-[9px]" : "h-9 px-3 text-[10px]"} ${primary ? "border-sky-400/60 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30" : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}>{icon}{label}</button>;
}
