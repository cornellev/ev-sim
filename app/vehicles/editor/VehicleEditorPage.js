'use client';

import { cloneElement, isValidElement, useEffect, useRef, useState } from "react";
import {
    IconArrowsMove,
    IconCheck,
    IconCopy,
    IconCube,
    IconDeviceFloppy,
    IconDownload,
    IconFileImport,
    IconLayoutGrid,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarRightCollapse,
    IconPlus,
    IconRefresh,
    IconTrash,
    IconUpload,
} from "@tabler/icons-react";

import {
    createDefaultVehicleManifest,
    deriveWheelbase,
    normalizeVehicleManifest,
    resolveVehicleModelUrl,
    validateVehicleManifest,
} from "../VehicleManifest.js";
import {
    changeVehicleSensorType,
    createVehicleSensor,
    getSensorFieldValue,
    getSensorType,
    listSensorTypes,
} from "../../3d/devices/SensorTypeRegistry.js";
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
import {
    AsyncState,
    Button,
    Field as SharedField,
    IconButton,
    SegmentedControl,
    StatusMessage,
    Switch as SharedSwitch,
    TabsContent,
    TabsList,
    TabsRoot,
    TabsTrigger,
    useWorkspaceGuard,
} from "../../ui";

const TABS = ["Model", "LiDAR Zone", "Sensors", "Wheels", "Body", "JSON"];
const HISTORY_LIMIT = 100;
const EDIT_COALESCE_MS = 750;
const SENSOR_TYPE_DEFINITIONS = listSensorTypes();
const FaArrowsAlt = (props) => <IconArrowsMove size={14} stroke={1.75} {...props} />;
const FaCube = (props) => <IconCube size={14} stroke={1.75} {...props} />;
const FaPlus = (props) => <IconPlus size={14} stroke={1.75} {...props} />;
const FaSyncAlt = (props) => <IconRefresh size={14} stroke={1.75} {...props} />;
const FaUpload = (props) => <IconUpload size={14} stroke={1.75} {...props} />;

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

export default function VehicleEditorPage({ onOpenWorkspace }) {
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
    const [catalogOpen, setCatalogOpen] = useState(false);
    const [inspectorOpen, setInspectorOpen] = useState(false);

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

    useWorkspaceGuard("vehicle-editor", {
        dirty,
        label: "Vehicle editor",
        save,
        discard: () => saved && applyDocument(selectedId, saved),
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
        <main className="fixed inset-0 z-[1] overflow-hidden bg-[var(--slate-bg)] text-[var(--slate-fg)]">
            <header className="flex h-10 items-center justify-between border-b border-[var(--slate-border)] bg-[var(--slate-surface-1)] px-3">
                <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={onOpenWorkspace}>
                    <span className="text-[11px] font-medium text-[var(--slate-muted)]">cev-sim</span>
                    <span aria-hidden="true" className="h-3 w-px bg-[var(--slate-border)]" />
                    <IconLayoutGrid size={15} stroke={1.75} aria-hidden="true" />
                    <span className="truncate text-[13px] font-semibold">Vehicle Editor</span>
                </button>
                <div className="flex items-center gap-2">
                    {readOnly && <span className="text-[11px] font-medium text-[var(--slate-muted)]">Built-in · read only</span>}
                    {dirty && <span className="text-[11px] font-medium text-[var(--slate-warning)]">Unsaved</span>}
                    <span className="hidden max-[899px]:inline-flex"><IconButton label="Open vehicle catalog" onClick={() => setCatalogOpen((open) => !open)}><IconLayoutSidebarLeftCollapse size={15} stroke={1.75} /></IconButton></span>
                    <span className="hidden max-[1199px]:inline-flex"><IconButton label="Open vehicle inspector" onClick={() => setInspectorOpen((open) => !open)}><IconLayoutSidebarRightCollapse size={15} stroke={1.75} /></IconButton></span>
                    <Action icon={<IconCheck size={14} stroke={1.75} />} label="Validate" onClick={validate} disabled={!draft || busy || readOnly} />
                    <Action primary icon={<IconDeviceFloppy size={14} stroke={1.75} />} label="Save" onClick={save} disabled={!draft || !dirty || busy || readOnly} />
                </div>
            </header>

            <div className="grid h-[calc(100dvh-2.5rem)] grid-cols-[260px_minmax(0,1fr)_360px] max-[1199px]:grid-cols-[240px_minmax(0,1fr)] max-[899px]:grid-cols-[minmax(0,1fr)]">
                <aside className={`flex min-h-0 flex-col border-r border-[var(--slate-border)] bg-[var(--slate-surface-1)] max-[899px]:fixed max-[899px]:bottom-3 max-[899px]:left-3 max-[899px]:top-[52px] max-[899px]:z-[var(--layer-drawer)] max-[899px]:w-[min(320px,calc(100vw-24px))] max-[899px]:border max-[899px]:shadow-[var(--slate-shadow-overlay)] ${catalogOpen ? "max-[899px]:flex" : "max-[899px]:hidden"}`}>
                    <div className="flex items-center gap-2 border-b border-[var(--slate-border)] p-3">
                        <Action icon={<FaPlus />} label="New" onClick={createNew} disabled={busy} compact />
                        <Action icon={<IconFileImport size={14} stroke={1.75} />} label="Import" onClick={() => importRef.current?.click()} disabled={busy} compact />
                        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importBundleFile} />
                    </div>
                    <div className="mod-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
                        {catalog.map((entry, index) => (
                            <div key={entry.id}>
                                {(index === 0 || catalog[index - 1]?.builtIn !== entry.builtIn) && (
                                    <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-[var(--slate-muted)]">
                                        {entry.builtIn ? "Built-in vehicles" : "Custom vehicles"}
                                    </p>
                                )}
                                <button type="button" onClick={() => select(entry.id).finally(() => setCatalogOpen(false))} aria-current={entry.id === selectedId ? "page" : undefined} className={`mb-1 w-full rounded-[var(--radius)] border px-3 py-2.5 text-left transition-[background-color,border-color,color] duration-150 ${entry.id === selectedId ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)]" : "border-transparent text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-2)]"}`}>
                                    <span className="flex items-center justify-between gap-2">
                                        <span className="block min-w-0 truncate text-xs font-semibold">{entry.name}</span>
                                        {entry.builtIn && <span className="shrink-0 text-[11px] text-[var(--slate-muted)]">Built-in</span>}
                                    </span>
                                    <span className="mt-1 block truncate font-mono text-[11px] text-[var(--slate-muted)]">
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
                        <div className="space-y-2 border-t border-[var(--slate-border)] p-3">
                            <div className="flex gap-1.5">
                                <Action compact icon={<IconCopy size={14} stroke={1.75} />} label="Duplicate" onClick={duplicate} disabled={busy} />
                                {!readOnly && <Action compact icon={<IconDownload size={14} stroke={1.75} />} label="Export" onClick={exportBundle} disabled={busy} />}
                                {!readOnly && <IconButton label="Delete vehicle" onClick={remove} disabled={busy} className="text-[var(--slate-danger)]"><IconTrash size={14} stroke={1.75} /></IconButton>}
                            </div>
                            <p className="truncate font-mono text-[11px] text-[var(--slate-muted)]">{readOnly ? "Duplicate to create an editable copy" : saved?.definitionHash || "Unsaved"}</p>
                        </div>
                    )}
                </aside>

                <section className="relative min-w-0 overflow-hidden bg-[var(--slate-bg)]">
                    {loadState === "loading" && <CenterState title="Loading vehicles…" detail="Reading the server-backed vehicle catalog." />}
                    {loadState === "error" && (
                        <CenterState error title="Could not load vehicles" detail={error || "The vehicle catalog is unavailable."} action={<Action icon={<IconRefresh size={14} stroke={1.75} />} label="Retry" onClick={() => loadCatalog(selectedId)} />} />
                    )}
                    {loadState === "empty" && (
                        <CenterState title="No vehicles" detail="Create the first vehicle manifest to open the studio." action={<Action primary icon={<IconPlus size={14} stroke={1.75} />} label="Create vehicle" onClick={createNew} disabled={busy} />} />
                    )}
                    {draft && (
                        <>
                            <div ref={viewportRef} className="absolute inset-0" />
                            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
                                {readOnly ? (
                                    <div className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--slate-fg-2)]">Read-only preview</div>
                                ) : (
                                    <div className="pointer-events-auto rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-1">
                                        <SegmentedControl value={gizmoMode} onValueChange={setGizmoMode} label="Gizmo mode" items={[{ value: "translate", label: "Move" }, { value: "rotate", label: "Rotate" }]} />
                                    </div>
                                )}
                                {selection && (
                                    <div className="pointer-events-auto flex items-center gap-2 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] px-2.5 py-1.5">
                                        <span className="text-[14px] font-medium text-[var(--slate-fg-2)]">{selection.kind}{selection.id ? ` · ${selection.id}` : ""}</span>
                                        <button type="button" onClick={() => setSelection(null)} className="text-[12px] text-[var(--slate-muted)] hover:text-[var(--slate-fg)]">Deselect</button>
                                    </div>
                                )}
                            </div>
                            {/* <p className="pointer-events-none absolute bottom-3 left-3 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] px-2 py-1 text-[11px] text-[var(--slate-muted)]">
                                {readOnly ? "Orbit to inspect · duplicate to edit" : "Click a marker to select · drag gizmo to place"}
                            </p> */}
                        </>
                    )}
                </section>

                <aside className={`flex min-h-0 flex-col border-l border-[var(--slate-border)] bg-[var(--slate-surface-1)] max-[1199px]:fixed max-[1199px]:bottom-3 max-[1199px]:right-3 max-[1199px]:top-[52px] max-[1199px]:z-[var(--layer-drawer)] max-[1199px]:w-[min(380px,calc(100vw-24px))] max-[1199px]:border max-[1199px]:shadow-[var(--slate-shadow-overlay)] ${inspectorOpen ? "max-[1199px]:flex" : "max-[1199px]:hidden"}`}>
                    {draft && (
                        <TabsRoot value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
                            <div className="border-b border-[var(--slate-border)] p-3">
                                <input className="sf-input mb-2" aria-label="Vehicle name" value={draft.name} disabled={readOnly} onChange={(event) => update(["name"], event.target.value)} />
                                <p className="truncate font-mono text-[11px] text-[var(--slate-muted)]">{draft.id}</p>
                            </div>
                            {readOnly && (
                                <div className="border-b border-[var(--slate-border)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--slate-muted)]">
                                    This built-in vehicle is defined in code. Inspect its projected values here, or duplicate it to make an editable manifest.
                                </div>
                            )}
                            <TabsList aria-label="Vehicle editor sections" className="overflow-x-auto border-b border-[var(--slate-border)] p-1.5 hide-scrollbar">
                                {TABS.map((item) => <TabsTrigger key={item} value={item} className="whitespace-nowrap">{item}</TabsTrigger>)}
                            </TabsList>

                            {(error || rawError || validation?.issues?.length > 0) && (
                                <StatusMessage className="m-3" tone="danger" title="Vehicle needs attention"><pre className="whitespace-pre-wrap font-sans">{error || rawError || validation.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n")}</pre></StatusMessage>
                            )}
                            {validation?.ok && <StatusMessage className="m-3" tone="success" title="Vehicle manifest is valid." />}

                            <div className="mod-scrollbar min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label="Vehicle editor fields">
                                <fieldset disabled={readOnly}>
                                    {TABS.map((item) => (
                                        <TabsContent key={item} value={item} forceMount className="p-3">
                                            {item === "Model" && (
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
                                            {item === "LiDAR Zone" && (
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
                                            {item === "Sensors" && <SensorsTab draft={draft} update={update} selection={selection} setSelection={setSelection} />}
                                            {item === "Wheels" && <WheelsTab draft={draft} update={update} selection={selection} setSelection={setSelection} derivedWheelbase={derivedWheelbase} />}
                                            {item === "Body" && <BodyTab draft={draft} update={update} selection={selection} setSelection={setSelection} fitBodyToModel={fitBodyToModel} />}
                                            {item === "JSON" && (
                                                <div className="space-y-2">
                                                    <textarea aria-label="Raw vehicle manifest JSON" spellCheck={false} value={raw} onChange={(event) => applyRaw(event.target.value)} className="sf-input min-h-[480px] resize-y font-mono text-[12px] leading-relaxed" />
                                                    <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">Applies on every valid parse. The LiDAR zone arrays are baked data; regenerate them from the LiDAR Zone tab after moving the model.</p>
                                                </div>
                                            )}
                                        </TabsContent>
                                    ))}
                                </fieldset>
                            </div>
                        </TabsRoot>
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
                        <button type="button" onClick={() => update(["model", "asset"], "")} className="text-[11px] text-[var(--slate-danger)]">Detach</button>
                    )}
                </div>
                <p className="mt-2 font-mono text-[11px] text-[var(--slate-muted)]">{draft.model.asset || "No model; a placeholder body is shown."}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--slate-muted)]">Use a self-contained .glb or .gltf. The file uploads immediately and is stored next to the manifest.</p>
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
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--slate-muted)]">Sets the scale so the model footprint matches the target length and width, preserving aspect ratio.</p>
            </Section>
        </div>
    );
}

function LidarZoneTab({ draft, update, voxelSize, setVoxelSize, generateZone, zoneVisible, setZoneVisible }) {
    const zone = draft.lidarZone;
    return (
        <div className="space-y-4">
            <Section title="Reduced-polygon collision mesh">
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">LiDAR and other GPU sensors raycast against this simplified mesh instead of the full model. Regenerate it after changing the model placement.</p>
                <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-medium text-[var(--slate-fg-2)]">Voxel size</span>
                        <span className="font-mono text-[11px] text-[var(--slate-fg-2)]">{voxelSize.toFixed(2)} m</span>
                    </div>
                    <input aria-label="Voxel size" type="range" min="0.05" max="1" step="0.05" value={voxelSize} onChange={(event) => setVoxelSize(Number(event.target.value))} className="timeline-range w-full" />
                    <p className="mt-1 text-[11px] text-[var(--slate-muted)]">Larger voxels merge more vertices and produce fewer triangles.</p>
                </div>
                <div className="mt-3 flex items-center gap-2">
                    <Action compact primary icon={<FaSyncAlt />} label="Generate" onClick={generateZone} disabled={!draft.model.asset} />
                    {zone.triangles.length > 0 && (
                        <button type="button" onClick={() => update(["lidarZone"], { params: { voxelSize }, vertices: [], triangles: [] })} className="text-[11px] text-[var(--slate-danger)]">Clear</button>
                    )}
                </div>
            </Section>
            <Section title="Baked result">
                <div className="grid grid-cols-2 gap-2">
                    <Stat label="Vertices" value={zone.vertices.length} />
                    <Stat label="Triangles" value={zone.triangles.length} />
                </div>
                <p className="mt-2 font-mono text-[11px] text-[var(--slate-muted)]">Baked at voxel {zone.params.voxelSize} m</p>
                <div className="mt-2"><Toggle label="Show wireframe preview" value={zoneVisible} onChange={setZoneVisible} /></div>
            </Section>
        </div>
    );
}

function SensorsTab({ draft, update, selection, setSelection }) {
    const add = (type) => {
        const definition = getSensorType(type);
        const id = nextId(draft.sensors, definition?.idPrefix || "sensor");
        const sensor = createVehicleSensor(type, {
            id,
            pose: { position: { x: 0.3, y: 0.8, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        }, draft.sensors.length);
        update(["sensors"], [...draft.sensors, sensor]);
        setSelection({ kind: "sensor", id });
    };
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
                {SENSOR_TYPE_DEFINITIONS.map((definition) => (
                    <Action key={definition.id} compact icon={<FaPlus />} label={definition.addLabel || `Add ${definition.label}`} onClick={() => add(definition.id)} />
                ))}
            </div>
            {draft.sensors.length === 0 && <p className="py-8 text-center text-[11px] text-zinc-600">No sensors on this vehicle.</p>}
            {draft.sensors.map((sensor, index) => {
                const selected = selection?.kind === "sensor" && selection.id === sensor.id;
                const change = (parts, value) => update(["sensors", index, ...parts], value);
                const definition = getSensorType(sensor.type);
                return (
                    <div key={`sensor-${index}`} className={`rounded-[var(--radius)] border p-3 transition-[background-color,border-color] ${selected ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)]" : "border-[var(--slate-border-60)] bg-[var(--slate-surface-1)]"}`}>
                        <button type="button" onClick={() => setSelection(selected ? null : { kind: "sensor", id: sensor.id })} className="mb-2 flex w-full items-center justify-between text-left">
                            <span className="text-[11px] font-semibold">{sensor.id}</span>
                            <span className="text-[11px] font-medium text-[var(--slate-muted)]">{definition?.label || sensor.type}</span>
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
                            <Field label="Type">
                                <select value={sensor.type} onChange={(event) => update(["sensors", index], changeVehicleSensorType(sensor, event.target.value))}>
                                    {SENSOR_TYPE_DEFINITIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                                    {!definition && <option value={sensor.type}>{sensor.type} (unsupported)</option>}
                                </select>
                            </Field>
                        </div>
                        <VectorFields label="Position (m)" value={sensor.pose.position} onChange={(axis, value) => change(["pose", "position", axis], value)} scrub />
                        <VectorFields label="Rotation (rad)" value={sensor.pose.rotation} onChange={(axis, value) => change(["pose", "rotation", axis], value)} />
                        <div className="mt-3 grid grid-cols-2 gap-2">
                            {definition?.vehicle.fields.map((field) => (
                                <VehicleSensorDefinitionField key={field.path.join(".")} field={field} sensor={sensor} change={change} />
                            ))}
                        </div>
                        {!definition && <p className="mt-3 text-[11px] text-[var(--slate-warning)]">This sensor type is not registered. Its data is preserved, but this vehicle cannot run until a supported type is selected.</p>}
                        <button type="button" onClick={() => update(["sensors"], draft.sensors.filter((_, candidate) => candidate !== index))} className="mt-3 text-[11px] text-[var(--slate-danger)]">Remove sensor</button>
                    </div>
                );
            })}
        </div>
    );
}

function VehicleSensorDefinitionField({ field, sensor, change }) {
    const value = getSensorFieldValue(sensor, field.path);
    return (
        <Field label={field.label}>
            <input
                type={field.control === "number" ? "number" : "text"}
                min={field.min}
                max={field.max}
                step={field.step}
                value={value ?? ""}
                disabled={field.readOnly}
                onChange={(event) => change(field.path, field.control === "number" ? Number(event.target.value) : event.target.value)}
            />
        </Field>
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
                    <div key={`wheel-${index}`} className={`rounded-[var(--radius)] border p-3 transition-[background-color,border-color] ${selected ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)]" : "border-[var(--slate-border-60)] bg-[var(--slate-surface-1)]"}`}>
                        <button type="button" onClick={() => setSelection(selected ? null : { kind: "wheel", id: wheel.id })} className="mb-2 flex w-full items-center justify-between text-left">
                            <span className="text-[11px] font-semibold">{wheel.id}</span>
                            {wheel.steerable && <span className="text-[11px] font-medium text-[var(--slate-muted)]">Steerable</span>}
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
                            <button type="button" onClick={() => update(["wheels", index, "position", "z"], -wheel.position.z)} className="text-[11px] text-[var(--slate-fg-2)]">Mirror across X</button>
                            <button type="button" onClick={() => update(["wheels"], draft.wheels.filter((_, candidate) => candidate !== index))} className="text-[11px] text-[var(--slate-danger)]">Remove</button>
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
                        <p className="text-[11px] text-[var(--slate-muted)]">Derived from wheel placement: <span className="font-mono text-[var(--slate-fg-2)]">{derivedWheelbase.toFixed(3)} m</span></p>
                        <button type="button" onClick={() => update(["kinematics", "wheelbase"], round3(derivedWheelbase))} className="text-[11px] text-[var(--slate-fg-2)]">Use derived</button>
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
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">Drives the physics AABB. The translucent box in the viewport previews it.</p>
                <div className="mt-2 flex items-center gap-2">
                    <Action compact icon={<FaArrowsAlt />} label={bodySelected ? "Gizmo active" : "Move center with gizmo"} onClick={() => setSelection(bodySelected ? null : { kind: "body", id: null })} />
                    <Action compact icon={<FaCube />} label="Fit to model" onClick={fitBodyToModel} disabled={!draft.model.asset} />
                </div>
                <VectorFields label="Size (m)" value={draft.boundingBox.size} onChange={(axis, value) => update(["boundingBox", "size", axis], value)} scrub min={0.01} />
                <VectorFields label="Center (m)" value={draft.boundingBox.center} onChange={(axis, value) => update(["boundingBox", "center", axis], value)} scrub />
            </Section>
            <Section title="Ego center">
                <p className="text-[11px] leading-relaxed text-[var(--slate-muted)]">The reference point cameras follow and tooling focuses on, marked by the green axes.</p>
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
    return <div className="grid h-full place-items-center p-6"><div><AsyncState status={error ? "error" : action ? "empty" : "loading"} title={title} detail={detail} />{action && <div className="mt-4 flex justify-center">{action}</div>}</div></div>;
}

function Section({ title, children }) {
    return <section className="border-t border-[var(--slate-border)] pt-3 first:border-t-0 first:pt-0"><h3 className="mb-3 text-[13px] font-semibold text-[var(--slate-fg-2)]">{title}</h3>{children}</section>;
}

function Stat({ label, value }) {
    return <div className="border-l border-[var(--slate-border)] px-3 py-2 first:border-l-0"><p className="text-[11px] text-[var(--slate-muted)]">{label}</p><p className="mt-0.5 font-mono text-sm font-semibold text-[var(--slate-fg)]">{value.toLocaleString()}</p></div>;
}

function VectorFields({ label, value, onChange, scrub = false, min, step = 0.01 }) {
    return (
        <div className="mt-3">
            <p className="mb-1.5 text-[13px] font-medium text-[var(--slate-fg-2)]">{label}</p>
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
    const control = isValidElement(children)
        ? cloneElement(children, { className: [children.props.className, "sf-input"].filter(Boolean).join(" ") })
        : children;
    return <SharedField label={label}>{control}</SharedField>;
}

function Toggle({ label, value, onChange }) {
    return <SharedSwitch label={label} checked={value} onCheckedChange={onChange} />;
}

function Action({ icon, label, onClick, disabled = false, primary = false, compact = false }) {
    return <Button disabled={disabled} size={compact ? "compact" : "default"} variant={primary ? "primary" : "default"} onClick={() => Promise.resolve(onClick?.()).catch(() => {})}>{icon}{label}</Button>;
}
