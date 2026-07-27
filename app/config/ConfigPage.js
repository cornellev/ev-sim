'use client';

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import {
    IconCheck,
    IconCopy,
    IconDeviceFloppy,
    IconDownload,
    IconFileImport,
    IconLayoutGrid,
    IconPlayerPlay,
    IconPlus,
    IconTrash,
} from "@tabler/icons-react";

import { listEnvironments } from "../3d/environment/EnvironmentCatalogClient.js";
import {
    changeRunSensorType,
    createRunSensor,
    getSensorFieldValue,
    getSensorType,
    listSensorTypes,
} from "../3d/devices/SensorTypeRegistry.js";
import {
    createDefaultRunManifest,
    normalizeRunManifest,
    validateRunManifest,
} from "../simulation/RunManifest.js";
import {
    createRunManifest,
    deleteRunManifest,
    duplicateRunManifest,
    exportRunManifest,
    getRunManifest,
    importRunBundle,
    listRunManifests,
    resolveRunManifest,
    saveRunManifest,
    validateRunManifestOnServer,
} from "../simulation/RunManifestClient.js";
import { getRunSessionController } from "../simulation/RunSessionController.js";
import { listVehicleManifests } from "../vehicles/VehicleManifestClient.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    CONFIG_CATALOG_TIMEOUT_MS,
    loadRunManifestCatalog,
    withConfigLoadTimeout,
} from "./ConfigCatalogLoader.js";
import {
    AsyncState,
    Button,
    Field as SharedField,
    IconButton,
    StatusMessage,
    Switch as SharedSwitch,
    TabsContent,
    TabsList,
    TabsRoot,
    TabsTrigger,
    useWorkspaceGuard,
} from "../ui";

const TABS = ["Overview", "Initial State", "Clock", "Sensors", "Scripts", "Topics", "Assertions", "Logging", "JSON"];
const SENSOR_TYPE_DEFINITIONS = listSensorTypes();
const FaPlus = (props) => <IconPlus size={14} stroke={1.75} {...props} />;

function runIdFromName(name) {
    return String(name || "run")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `run-${Date.now().toString(36)}`;
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

function diffEntries(left, right, path = "") {
    if (Object.is(left, right)) return [];
    if (!left || !right || typeof left !== "object" || typeof right !== "object") {
        return [{ path: path || "manifest", before: left, after: right }];
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => diffEntries(left[key], right[key], path ? `${path}.${key}` : key));
}

function parseInputValue(value) {
    if (value === "") return "";
    try { return JSON.parse(value); } catch { return value; }
}

export default function ConfigPage({ onLaunch, onOpenWorkspace }) {
    const controller = useMemo(() => getRunSessionController(), []);
    const importRef = useRef(null);
    const manifestLoadRequest = useRef(0);
    const environmentLoadRequest = useRef(0);
    const [catalog, setCatalog] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [vehicleCatalog, setVehicleCatalog] = useState([]);
    const [manifestLoadState, setManifestLoadState] = useState("loading");
    const [environmentError, setEnvironmentError] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [raw, setRaw] = useState("");
    const [rawError, setRawError] = useState(null);
    const [tab, setTab] = useState("Overview");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [validation, setValidation] = useState(null);
    const [runState, setRunState] = useState(() => controller.getSnapshot());

    const dirty = Boolean(saved && draft && differenceCount(normalizeRunManifest(saved), normalizeRunManifest(draft)) > 0);
    const changedFields = saved && draft ? differenceCount(normalizeRunManifest(saved), normalizeRunManifest(draft)) : 0;
    const normalizedDiff = useMemo(() => saved && draft
        ? diffEntries(normalizeRunManifest(saved), normalizeRunManifest(draft))
        : [], [draft, saved]);

    const applyManifestDocument = (id, document) => {
        const normalized = normalizeRunManifest(document);
        setSelectedId(id);
        setSaved(document);
        setDraft(normalized);
        setRaw(JSON.stringify(normalized, null, 2));
        setRawError(null);
        setValidation(null);
        controller.selectManifest(id);
    };

    const loadManifestCatalog = async (preferredId = null) => {
        const requestId = ++manifestLoadRequest.current;
        setManifestLoadState("loading");
        setError(null);
        try {
            const result = await loadRunManifestCatalog({
                listManifests: listRunManifests,
                getManifest: getRunManifest,
                preferredId,
            });
            if (requestId !== manifestLoadRequest.current) return;
            setCatalog(result.catalog);
            if (result.status === "empty") {
                setSelectedId(null);
                setSaved(null);
                setDraft(null);
                setRaw("");
                setManifestLoadState("empty");
                return;
            }
            applyManifestDocument(result.selectedId, result.document);
            setManifestLoadState("ready");
        } catch (caught) {
            if (requestId !== manifestLoadRequest.current) return;
            setError(caught.message);
            setManifestLoadState("error");
        }
    };

    const loadEnvironmentCatalog = async () => {
        const requestId = ++environmentLoadRequest.current;
        setEnvironmentError(null);
        try {
            const items = await withConfigLoadTimeout(
                listEnvironments(),
                "Environment catalog loading timed out. Manifest editing is still available.",
                CONFIG_CATALOG_TIMEOUT_MS,
            );
            if (requestId !== environmentLoadRequest.current) return;
            setEnvironments(items || []);
        } catch (caught) {
            if (requestId !== environmentLoadRequest.current) return;
            setEnvironmentError(caught.message);
        }
    };

    const loadVehicleCatalog = async () => {
        try {
            const items = await withConfigLoadTimeout(
                listVehicleManifests(),
                "Vehicle catalog loading timed out. Manifest editing is still available.",
                CONFIG_CATALOG_TIMEOUT_MS,
            );
            setVehicleCatalog(items || []);
        } catch (caught) {
            console.warn("Could not load the vehicle catalog:", caught);
        }
    };

    const refreshCatalog = async (preferredId = null) => {
        await loadManifestCatalog(preferredId || selectedId);
    };

    const select = async (id, { force = false } = {}) => {
        if (!force && dirty && !window.confirm("Discard unsaved manifest changes?")) return;
        setBusy(true);
        setError(null);
        try {
            const document = await getRunManifest(id);
            if (!document) throw new Error(`Manifest "${id}" no longer exists.`);
            applyManifestDocument(id, document);
            setManifestLoadState("ready");
            return true;
        } catch (caught) {
            setError(caught.message);
            if (!draft) setManifestLoadState("error");
            return false;
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        loadManifestCatalog();
        loadEnvironmentCatalog();
        loadVehicleCatalog();
        const unsubscribe = controller.subscribe(setRunState);
        return () => {
            manifestLoadRequest.current += 1;
            environmentLoadRequest.current += 1;
            unsubscribe();
        };
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

    useEffect(() => {
        let cancelled = false;
        return subscribeStorageEvents((event) => {
            if (event.domain !== "run-manifest") return;
            listRunManifests().then(async (items) => {
                if (cancelled) return;
                setCatalog(items || []);
                if (dirty) return;

                const selectedWasDeleted = event.action === "deleted" && event.id === selectedId;
                const nextId = selectedWasDeleted ? items?.[0]?.id : selectedId;
                const selectedChanged = event.id === selectedId && event.action !== "launch";
                if (!nextId || (!selectedWasDeleted && !selectedChanged)) return;

                const document = await getRunManifest(nextId);
                if (cancelled) return;
                const normalized = normalizeRunManifest(document);
                setSelectedId(nextId);
                setSaved(document);
                setDraft(normalized);
                setRaw(JSON.stringify(normalized, null, 2));
                setRawError(null);
                setValidation(null);
                controller.selectManifest(nextId);
            }).catch((caught) => {
                if (!cancelled) setError(caught.message);
            });
        });
    }, [controller, dirty, selectedId]);

    const update = (path, value) => {
        setDraft((current) => {
            const next = structuredClone(current);
            let cursor = next;
            path.slice(0, -1).forEach((part) => { cursor = cursor[part]; });
            cursor[path.at(-1)] = value;
            const normalized = normalizeRunManifest(next);
            // Keep the active string field verbatim while the user is typing.
            // Normalization supplies structural defaults, but its trimming
            // would otherwise remove a space before the next character arrives.
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

    const createNew = async () => {
        const baseName = "Untitled Run";
        let id = runIdFromName(baseName);
        const existing = new Set(catalog.map((entry) => entry.id));
        let suffix = 2;
        while (existing.has(id)) id = `${runIdFromName(baseName)}-${suffix++}`;
        await perform(async () => {
            const created = await createRunManifest(createDefaultRunManifest({ id, name: baseName }));
            await refreshCatalog(created.id);
        });
    };

    const save = async () => perform(async () => {
        const local = validateRunManifest(draft);
        if (!local.ok) {
            setValidation(local);
            throw new Error("Fix validation errors before saving.");
        }
        const stored = await saveRunManifest(selectedId, local.manifest, saved.revision);
        setSaved(stored);
        setDraft(normalizeRunManifest(stored));
        setRaw(JSON.stringify(normalizeRunManifest(stored), null, 2));
        setCatalog((items) => items.map((entry) => entry.id === stored.id
            ? { ...entry, name: stored.name, revision: stored.revision, definitionHash: stored.definitionHash }
            : entry));
        return stored;
    });

    const validate = async () => perform(async () => {
        const result = await validateRunManifestOnServer(selectedId, draft);
        setValidation(result);
        if (!result.ok) throw new Error("Manifest validation found issues.");
        return result;
    });

    const launch = async () => perform(async () => {
        let current = saved;
        if (dirty) current = await save();
        const result = await validateRunManifestOnServer(selectedId, current);
        setValidation(result);
        if (!result.ok) throw new Error("Manifest validation found issues.");
        const resolved = await resolveRunManifest(selectedId);
        await controller.prepare(resolved, { autoplay: true });
        onLaunch?.(resolved);
    }, { nested: true });

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

    const applyRaw = (value) => {
        setRaw(value);
        try {
            const parsed = JSON.parse(value);
            const local = validateRunManifest(parsed);
            if (!local.ok) {
                setRawError(local.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n"));
                return;
            }
            setRawError(null);
            setDraft(local.manifest);
            setValidation(null);
        } catch (caught) {
            setRawError(caught.message);
        }
    };

    const duplicate = () => perform(async () => {
        const id = `${selectedId}-copy-${Date.now().toString(36)}`;
        const created = await duplicateRunManifest(selectedId, { id, name: `${draft.name} Copy` });
        await refreshCatalog(created.id);
    });

    const remove = () => perform(async () => {
        if (!window.confirm(`Delete “${draft.name}”?`)) return;
        await deleteRunManifest(selectedId);
        setSelectedId(null);
        setSaved(null);
        setDraft(null);
        await refreshCatalog();
    });

    const exportBundle = () => perform(async () => {
        if (dirty) await save();
        const bundle = await exportRunManifest(selectedId);
        downloadJson(`${selectedId}.run-bundle.json`, bundle);
    });

    const importBundleFile = (event) => perform(async () => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const created = await importRunBundle(JSON.parse(await file.text()));
        await refreshCatalog(created.id);
    });

    useWorkspaceGuard("run-config", {
        dirty,
        label: "Run configuration",
        save,
        discard: () => saved && applyManifestDocument(selectedId, saved),
    });

    return (
        <main className="fixed inset-0 z-[1] overflow-hidden bg-[var(--slate-bg)] text-[var(--slate-fg)]">
            <header className="flex h-12 items-center justify-between border-b border-[var(--slate-border)] bg-[var(--slate-surface-1)] px-3">
                <button type="button" className="flex min-w-0 items-center gap-2 text-left" onClick={onOpenWorkspace}>
                    <span className="text-[11px] font-medium text-[var(--slate-muted)]">cev-sim</span>
                    <span aria-hidden="true" className="h-3 w-px bg-[var(--slate-border)]" />
                    <IconLayoutGrid size={15} stroke={1.75} aria-hidden="true" />
                    <span className="truncate text-[13px]/[13px] font-semibold">Run Configuration</span>
                </button>
                <div className="flex items-center gap-2">
                    <select
                        aria-label="Select run manifest"
                        className="sf-input hidden max-w-48 max-[1023px]:block"
                        value={selectedId || ""}
                        onChange={(event) => select(event.target.value)}
                        disabled={busy || catalog.length === 0}
                    >
                        {catalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                    </select>
                    <Action icon={<IconCheck size={14} stroke={1.75} />} label="Validate" onClick={validate} disabled={!draft || busy} />
                    <Action icon={<IconDeviceFloppy size={14} stroke={1.75} />} label="Save" onClick={save} disabled={!draft || !dirty || busy} />
                    <Action primary icon={<IconPlayerPlay size={14} stroke={1.75} />} label="Validate and run" onClick={launch} disabled={!draft || busy} />
                </div>
            </header>

            <div className="grid h-[calc(100dvh-2.5rem)] grid-cols-[260px_minmax(0,1fr)] max-[1023px]:grid-cols-[minmax(0,1fr)]">
                <aside className="flex min-h-0 flex-col border-r border-[var(--slate-border)] bg-[var(--slate-surface-1)] max-[1023px]:hidden">
                    <div className="flex items-center gap-2 border-b border-[var(--slate-border)] p-3">
                        <Action icon={<IconPlus size={14} stroke={1.75} />} label="New" onClick={createNew} disabled={busy} compact />
                        <Action icon={<IconFileImport size={14} stroke={1.75} />} label="Import" onClick={() => importRef.current?.click()} disabled={busy} compact />
                        <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={importBundleFile} />
                    </div>
                    <div className="mod-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
                        {catalog.map((entry) => (
                            <button key={entry.id} type="button" onClick={() => select(entry.id)} aria-current={entry.id === selectedId ? "page" : undefined} className={`mb-1 w-full rounded-[var(--radius)] border px-3 py-2.5 text-left transition-[background-color,border-color,color] duration-150 ${entry.id === selectedId ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)] text-[var(--slate-fg)]" : "border-transparent text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-2)]"}`}>
                                <span className="block truncate text-[13px] font-medium">{entry.name}</span>
                                <span className="mt-1 block truncate font-mono text-[11px] text-[var(--slate-muted)]">{entry.id} · r{entry.revision}</span>
                            </button>
                        ))}
                    </div>
                    {draft && (
                        <div className="space-y-2 border-t border-[var(--slate-border)] p-3">
                            <div className="flex gap-2">
                                <Action compact icon={<IconCopy size={14} stroke={1.75} />} label="Duplicate" onClick={duplicate} disabled={busy} />
                                <Action compact icon={<IconDownload size={14} stroke={1.75} />} label="Export" onClick={exportBundle} disabled={busy} />
                                <IconButton label="Delete manifest" onClick={remove} disabled={busy} className="text-[var(--slate-danger)]"><IconTrash size={14} stroke={1.75} /></IconButton>
                            </div>
                            <p className="truncate font-mono text-[11px] text-[var(--slate-muted)]">{saved?.definitionHash || "Unsaved"}</p>
                        </div>
                    )}
                </aside>

                <section className="mod-scrollbar min-w-0 overflow-y-auto">
                    {manifestLoadState === "loading" && <ConfigLoadState title="Loading manifests" detail="Reading the server-backed run catalog and selected manifest." />}
                    {manifestLoadState === "error" && <ConfigLoadState error title="Could not load manifests" detail={error || "The manifest catalog is unavailable."} action={<Action label="Retry" onClick={() => loadManifestCatalog(selectedId)} />} />}
                    {manifestLoadState === "empty" && <ConfigLoadState title="No run manifests" detail="Create the first server-backed manifest to configure a simulation run." action={<Action primary icon={<IconPlus size={14} stroke={1.75} />} label="Create manifest" onClick={createNew} disabled={busy} />} />}
                    {manifestLoadState === "ready" && draft && (
                        <TabsRoot value={tab} onValueChange={setTab} className="mx-auto max-w-6xl p-6 max-[900px]:p-4">
                            <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--slate-border)] pb-5">
                                <div>
                                    <div className="flex items-center gap-3">
                                        <h1 className="text-2xl font-semibold tracking-tight">{draft.name}</h1>
                                        {dirty && <span className="text-[11px] font-medium text-[var(--slate-warning)]">{changedFields} changed</span>}
                                    </div>
                                    <p className="mt-1 text-[13px] text-[var(--slate-muted)]">{draft.id}</p>
                                </div>
                                <div className="border-l border-[var(--slate-border)] pl-3 text-right">
                                    <p className="text-[11px] text-[var(--slate-muted)]">Run session</p>
                                    <p className={`mt-0.5 text-[13px] font-medium ${runState.status === "error" ? "text-[var(--slate-danger)]" : "text-[var(--slate-fg-2)]"}`}>{runState.status}</p>
                                </div>
                            </div>

                            {(error || environmentError || rawError || validation?.issues?.length > 0) && (
                                <StatusMessage className="mb-4" tone="danger" title="Configuration needs attention">
                                    <div className="flex items-start justify-between gap-3">
                                        <pre className="min-w-0 whitespace-pre-wrap font-sans">{error || environmentError || rawError || validation.issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n")}</pre>
                                        {environmentError && !error && <Action compact label="Retry environments" onClick={loadEnvironmentCatalog} />}
                                    </div>
                                </StatusMessage>
                            )}
                            {validation?.ok && <StatusMessage className="mb-4" tone="success" title="Manifest and dependencies are valid." />}

                            <TabsList aria-label="Run manifest sections" className="mb-5 overflow-x-auto">
                                {TABS.map((item) => <TabsTrigger key={item} value={item}>{item}</TabsTrigger>)}
                            </TabsList>

                            <div key={selectedId} className="border-t border-[var(--slate-border)] pt-5">
                                {TABS.map((item) => (
                                    <TabsContent key={item} value={item} forceMount>
                                        {item === "Overview" && <Overview draft={draft} environments={environments} update={update} />}
                                        {item === "Initial State" && <InitialState draft={draft} update={update} vehicleCatalog={vehicleCatalog} />}
                                        {item === "Clock" && <Clock draft={draft} update={update} />}
                                        {item === "Sensors" && <Sensors draft={draft} update={update} />}
                                        {item === "Scripts" && <Scripts draft={draft} update={update} />}
                                        {item === "Topics" && <Topics draft={draft} update={update} />}
                                        {item === "Assertions" && <Assertions draft={draft} update={update} />}
                                        {item === "Logging" && <Logging draft={draft} update={update} />}
                                        {item === "JSON" && (
                                            <div className="space-y-3">
                                                <textarea aria-label="Raw run manifest JSON" spellCheck={false} value={raw} onChange={(event) => applyRaw(event.target.value)} className="sf-input min-h-[520px] resize-y p-4 font-mono text-[12px] leading-relaxed" />
                                                <details className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)] p-3">
                                                    <summary className="cursor-pointer text-[12px] font-medium text-[var(--slate-fg-2)]">Normalized diff preview ({normalizedDiff.length})</summary>
                                                    <div className="mod-scrollbar mt-2 max-h-52 overflow-auto font-mono text-[11px] text-[var(--slate-muted)]">
                                                        {normalizedDiff.length === 0 ? <p>No normalized changes.</p> : normalizedDiff.slice(0, 100).map((entry) => <div key={entry.path} className="grid grid-cols-[minmax(120px,.8fr)_1fr_1fr] gap-2 border-t border-[var(--slate-border-60)] py-1.5"><span className="truncate text-[var(--slate-fg-2)]">{entry.path}</span><span className="truncate text-[var(--slate-danger)]">{JSON.stringify(entry.before)}</span><span className="truncate text-[var(--slate-fg-2)]">{JSON.stringify(entry.after)}</span></div>)}
                                                    </div>
                                                </details>
                                            </div>
                                        )}
                                    </TabsContent>
                                ))}
                            </div>
                        </TabsRoot>
                    )}
                </section>
            </div>
        </main>
    );
}

function ConfigLoadState({ title, detail, action = null, error = false }) {
    return <div className="grid h-full place-items-center p-6"><div><AsyncState status={error ? "error" : action ? "empty" : "loading"} title={title} detail={detail} />{action && <div className="mt-4 flex justify-center">{action}</div>}</div></div>;
}

function Overview({ draft, environments, update }) {
    return <div className="grid gap-4 md:grid-cols-2"><Field label="Name"><input value={draft.name} onChange={(event) => update(["name"], event.target.value)} /></Field><Field label="Stable ID"><input value={draft.id} disabled /></Field><Field wide label="Description"><textarea rows={3} value={draft.description} onChange={(event) => update(["description"], event.target.value)} /></Field><Field label="Environment"><select value={draft.environment.id} onChange={(event) => update(["environment", "id"], event.target.value)}>{environments.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field><Field label="Expected environment hash"><input value={draft.environment.expectedHash || ""} placeholder="Unlocked" onChange={(event) => update(["environment", "expectedHash"], event.target.value || null)} /></Field><Field label="Seed"><input value={draft.seed} onChange={(event) => update(["seed"], event.target.value)} /></Field></div>;
}

const BUILT_IN_VEHICLE_OPTIONS = [
    { id: "big-car", name: "Big Car (built-in)" },
    { id: "igvc-car", name: "IGVC Car (built-in)" },
    { id: "scenario-car", name: "Scenario Car (built-in)" },
];

function InitialState({ draft, update, vehicleCatalog = [] }) {
    const addVehicle = () => update(["initialState", "vehicles"], [...draft.initialState.vehicles, {
        id: `vehicle-${draft.initialState.vehicles.length + 1}`,
        type: "big-car",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        linearVelocity: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
    }]);
    const knownTypes = new Set([
        ...BUILT_IN_VEHICLE_OPTIONS.map((entry) => entry.id),
        ...vehicleCatalog.map((entry) => entry.id),
    ]);
    return (
        <div className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
                <Action icon={<FaPlus />} label="Add vehicle" onClick={addVehicle} />
                </div>{draft.initialState.vehicles.map((vehicle, index) => <div key={`${vehicle.id}-${index}`} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-4">
                    <div className="grid gap-3 md:grid-cols-4">
                        <Field label="Stable ID">
                            <input value={vehicle.id} onChange={(event) => update(["initialState", "vehicles", index, "id"], event.target.value)} />
                        </Field>
                        <Field label="Vehicle type">
                            <select value={vehicle.type} onChange={(event) => update(["initialState", "vehicles", index, "type"], event.target.value)}>
                                {
                                    BUILT_IN_VEHICLE_OPTIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)
                                }
                                {
                                    vehicleCatalog.length > 0 && 
                                        <optgroup label="Custom vehicles">
                                            {vehicleCatalog.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                                        </optgroup>
                                }
                            </select>
                        </Field>
                        <Field label="Steering (rad)">
                            <input type="number" step="0.001" value={vehicle.steeringAngle} onChange={(event) => update(["initialState", "vehicles", index, "steeringAngle"], Number(event.target.value))} />
                        </Field>
                        <button type="button" onClick={() => update(["initialState", "vehicles"], draft.initialState.vehicles.filter((_, candidate) => candidate !== index))} className="self-end pb-2 text-left text-[11px] text-[var(--slate-danger)]">Remove vehicle</button>
                    </div>
                    {!knownTypes.has(vehicle.type) && <p className="mt-2 text-[11px] text-[var(--slate-warning)]">This vehicle type no longer exists in the catalog; the run will fail to spawn it.</p>}
                    <VectorFields label="Position (m)" value={vehicle.pose.position} onChange={(axis, value) => update(["initialState", "vehicles", index, "pose", "position", axis], value)} />
                    <VectorFields label="Rotation (rad)" value={vehicle.pose.rotation} onChange={(axis, value) => update(["initialState", "vehicles", index, "pose", "rotation", axis], value)} />
                    <VectorFields label="Linear velocity (m/s)" value={vehicle.linearVelocity} onChange={(axis, value) => update(["initialState", "vehicles", index, "linearVelocity", axis], value)} />
                </div>
            )}
        </div>
    );
}

function Clock({ draft, update }) {
    const modules = draft.clock.modules;
    return <div className="space-y-5"><div className="grid gap-4 md:grid-cols-3"><Field label="Step (nanoseconds)"><input type="number" min="1" value={draft.clock.stepNs} onChange={(event) => update(["clock", "stepNs"], Number(event.target.value))} /></Field><Field label="Pacing"><select value={draft.clock.pacing} onChange={(event) => update(["clock", "pacing"], event.target.value)}><option value="realtime">Realtime</option><option value="unbounded">Unbounded</option></select></Field><Field label="Speed"><input type="number" min="0" step="0.1" value={draft.clock.speed} onChange={(event) => update(["clock", "speed"], Number(event.target.value))} /></Field><Field label="Maximum steps"><input type="number" min="1" value={draft.clock.maxSteps ?? ""} placeholder="Unlimited" onChange={(event) => update(["clock", "maxSteps"], event.target.value ? Number(event.target.value) : null)} /></Field><Toggle label="Publish /clock" value={draft.clock.publishClock} onChange={(value) => update(["clock", "publishClock"], value)} /></div><div><p className="mb-2 text-[13px] font-medium text-[var(--slate-fg-2)]">Deterministic modules</p><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(modules).map(([name, enabled]) => <Toggle key={name} label={name} value={enabled} onChange={(value) => update(["clock", "modules", name], value)} />)}</div></div></div>;
}

function Sensors({ draft, update }) {
    const add = (type) => {
        const index = draft.sensorRig.sensors.length;
        const id = `sensor-${index + 1}`;
        const sensor = createRunSensor(type, { id, parentId: "ego", frameId: `sensor_${index + 1}_frame` }, index);
        update(["sensorRig", "sensors"], [...draft.sensorRig.sensors, sensor]);
    };
    return <div className="space-y-4"><div className="flex flex-wrap items-end justify-between gap-3"><Field label="Rig root frame"><input value={draft.sensorRig.rootFrameId} onChange={(event) => update(["sensorRig", "rootFrameId"], event.target.value)} /></Field><div className="flex flex-wrap gap-1.5">{SENSOR_TYPE_DEFINITIONS.map((definition) => <Action key={definition.id} compact icon={<FaPlus />} label={definition.addLabel || `Add ${definition.label}`} onClick={() => add(definition.id)} />)}</div></div>{draft.sensorRig.sensors.map((sensor, index) => {
        const sensorPath = ["sensorRig", "sensors", index];
        const change = (parts, value) => update([...sensorPath, ...parts], value);
        const definition = getSensorType(sensor.type);
        return (
            <div key={`${sensor.id}-${index}`} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-4">
                <div className="grid gap-3 md:grid-cols-4">
                    <Field label="Stable ID">
                        <input value={sensor.id} onChange={(event) => change(["id"], event.target.value)} />
                    </Field>
                    <Field label="Type">
                        <select value={sensor.type} onChange={(event) => update(sensorPath, changeRunSensorType(sensor, event.target.value))}>
                            {SENSOR_TYPE_DEFINITIONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                            {!definition && <option value={sensor.type}>{sensor.type} (unsupported)</option>}
                        </select>
                    </Field>
                    <Field label="Parent vehicle">
                        <input value={sensor.parentId} onChange={(event) => change(["parentId"], event.target.value)} />
                    </Field>
                    <Field label="Frame ID">
                        <input value={sensor.frameId} onChange={(event) => change(["frameId"], event.target.value)} />
                    </Field>
                    <Field label="Rate (Hz)">
                        <input type="number" min="0.001" step="0.001" value={sensor.rateHz} onChange={(event) => change(["rateHz"], Number(event.target.value))} />
                    </Field>
                    <Field label="Phase (ns)">
                        <input type="number" min="0" value={sensor.phaseNs} onChange={(event) => change(["phaseNs"], Number(event.target.value))} />
                    </Field>
                    <Field label="Queue limit">
                        <input type="number" min="1" value={sensor.maxQueueFrames} onChange={(event) => change(["maxQueueFrames"], Number(event.target.value))} />
                    </Field>
                    <Toggle label="Enabled" value={sensor.enabled} onChange={(value) => change(["enabled"], value)} />
                </div>
                <VectorFields label="Pose position (m)" value={sensor.pose.position} onChange={(axis, value) => change(["pose", "position", axis], value)} />
                <VectorFields label="Pose rotation (rad)" value={sensor.pose.rotation} onChange={(axis, value) => change(["pose", "rotation", axis], value)} />
                <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <Field label="Fixed latency (ns)">
                    <input type="number" min="0" value={sensor.latency.fixedNs} onChange={(event) => change(["latency", "fixedNs"], Number(event.target.value))} />
                    </Field>
                    <Field label="Latency jitter (ns)">
                        <input type="number" min="0" value={sensor.latency.jitterNs} onChange={(event) => change(["latency", "jitterNs"], Number(event.target.value))} />
                    </Field>
                    <Field label="Noise model">
                        <select value={sensor.noise.model} onChange={(event) => change(["noise", "model"], event.target.value)}>
                            <option value="none">None</option>
                            <option value="gaussian">Gaussian</option>
                        </select>
                    </Field>
                    <Field label="Noise deviation">
                        <input type="number" min="0" step="0.001" value={sensor.noise.standardDeviation} onChange={(event) => change(["noise", "standardDeviation"], Number(event.target.value))} />
                    </Field>
                    <Field label="Noise bias">
                        <input type="number" step="0.001" value={sensor.noise.bias} onChange={(event) => change(["noise", "bias"], Number(event.target.value))} />
                    </Field>
                    <Field label="Dropout probability">
                        <input type="number" min="0" max="1" step="0.001" value={sensor.noise.dropoutProbability} onChange={(event) => change(["noise", "dropoutProbability"], Number(event.target.value))} />
                    </Field>
                    {definition?.run.fields.map((field) => (
                        <SensorDefinitionField key={field.path.join(".")} field={field} sensor={sensor} change={change} />
                    ))}
                </div>
                {!definition && <p className="mt-3 text-[11px] text-[var(--slate-warning)]">This sensor type is not registered. Its data is preserved, but the run cannot launch until a supported type is selected.</p>}
                <button type="button" onClick={() => update(["sensorRig", "sensors"], draft.sensorRig.sensors.filter((_, candidate) => candidate !== index))} className="mt-4 text-[11px] text-[var(--slate-danger)]">Remove sensor</button>
            </div>
        );
    })}</div>;
}

function SensorDefinitionField({ field, sensor, change }) {
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

function Scripts({ draft, update }) {
    const addArtifact = () => update(["scripts", "artifacts"], [...draft.scripts.artifacts, { scriptId: "", expectedHash: null }]);
    return <div className="space-y-4">
<Toggle label="Run deterministic scripts" value={draft.scripts.enabled} onChange={(value) => update(["scripts", "enabled"], value)} /><div className="flex items-center justify-between"><p className="text-xs text-zinc-400">Artifact and binding hashes lock the exact controller dependencies.</p><Action compact icon={<FaPlus />} label="Add artifact" onClick={addArtifact} /></div>{draft.scripts.artifacts.map((artifact, index) => <div key={`${artifact.scriptId}-${index}`} className="grid gap-3 rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-3 md:grid-cols-[1fr_2fr_auto]"><Field label="Script ID"><input value={artifact.scriptId} onChange={(event) => update(["scripts", "artifacts", index, "scriptId"], event.target.value)} /></Field><Field label="Expected SHA-256"><input value={artifact.expectedHash || ""} placeholder="Unlocked" onChange={(event) => update(["scripts", "artifacts", index, "expectedHash"], event.target.value || null)} /></Field><button type="button" onClick={() => update(["scripts", "artifacts"], draft.scripts.artifacts.filter((_, candidate) => candidate !== index))} className="self-end pb-2 text-[11px] text-[var(--slate-danger)]">Remove</button></div>)}<div className="grid gap-4 md:grid-cols-2"><Field label="Binding IDs (comma separated)"><input value={draft.scripts.bindingIds.join(", ")} onChange={(event) => update(["scripts", "bindingIds"], event.target.value.split(",").map((id) => id.trim()).filter(Boolean))} /></Field><Field label="Expected bindings SHA-256"><input value={draft.scripts.expectedBindingsHash || ""} placeholder="Unlocked" onChange={(event) => update(["scripts", "expectedBindingsHash"], event.target.value || null)} /></Field></div><Field label="Embedded portable bindings"><JsonField value={draft.scripts.embeddedBindings} onChange={(value) => update(["scripts", "embeddedBindings"], value)} rows={9} /></Field></div>;
}

function Topics({ draft, update }) {
    const add = () => update(["topics"], [...draft.topics, { id: `topic-${draft.topics.length + 1}`, name: `/topic-${draft.topics.length + 1}`, direction: "output", type: "std_msgs/String", required: false }]);
    return <div className="space-y-3"><div className="flex justify-end"><Action compact icon={<FaPlus />} label="Add topic" onClick={add} /></div>{draft.topics.map((topic, index) => <div key={`${topic.id}-${index}`} className="grid gap-3 rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-3 md:grid-cols-[1fr_1.4fr_1fr_1.5fr_.8fr_auto]"><Field label="ID"><input value={topic.id} onChange={(event) => update(["topics", index, "id"], event.target.value)} /></Field><Field label="Topic"><input value={topic.name} onChange={(event) => update(["topics", index, "name"], event.target.value)} /></Field><Field label="Direction"><select value={topic.direction} onChange={(event) => update(["topics", index, "direction"], event.target.value)}><option value="input">Input</option><option value="output">Output</option></select></Field><Field label="ROS type"><input value={topic.type} onChange={(event) => update(["topics", index, "type"], event.target.value)} /></Field><Toggle label="Required" value={topic.required} onChange={(value) => update(["topics", index, "required"], value)} /><button type="button" onClick={() => update(["topics"], draft.topics.filter((_, candidate) => candidate !== index))} className="self-end pb-2 text-[11px] text-[var(--slate-danger)]">Remove</button></div>)}</div>;
}

function Assertions({ draft, update }) {
    const add = () => update(["assertions"], [...draft.assertions, { id: `assertion-${draft.assertions.length + 1}`, name: "New assertion", source: "signal", path: "simulation.time", operator: "gte", expected: 0, mode: "at-end", window: { startStep: 0, endStep: null }, severity: "error", onFailure: "stop" }]);
    return <div className="space-y-3"><div className="flex justify-end"><Action compact icon={<FaPlus />} label="Add assertion" onClick={add} /></div>{draft.assertions.length === 0 && <p className="py-10 text-center text-xs text-zinc-600">No assertions configured.</p>}{draft.assertions.map((assertion, index) => <div key={`${assertion.id}-${index}`} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-4"><div className="grid gap-3 md:grid-cols-4"><Field label="Stable ID"><input value={assertion.id} onChange={(event) => update(["assertions", index, "id"], event.target.value)} /></Field><Field label="Name"><input value={assertion.name} onChange={(event) => update(["assertions", index, "name"], event.target.value)} /></Field><Field label="Source"><select value={assertion.source} onChange={(event) => update(["assertions", index, "source"], event.target.value)}><option value="signal">Signal</option><option value="event">Event</option></select></Field><Field label="Mode"><select value={assertion.mode} onChange={(event) => update(["assertions", index, "mode"], event.target.value)}><option value="always">Always</option><option value="eventually">Eventually</option><option value="at-end">At end</option></select></Field>{assertion.source === "signal" ? <><Field label="Signal path"><input value={assertion.path || ""} onChange={(event) => update(["assertions", index, "path"], event.target.value)} /></Field><Field label="Selector"><input value={assertion.selector || ""} placeholder="Optional nested.path" onChange={(event) => update(["assertions", index, "selector"], event.target.value)} /></Field></> : <><Field label="Event category"><input value={assertion.category || ""} onChange={(event) => update(["assertions", index, "category"], event.target.value)} /></Field><Field label="Event name"><input value={assertion.event || ""} onChange={(event) => update(["assertions", index, "event"], event.target.value)} /></Field></>}<Field label="Operator"><select value={assertion.operator} onChange={(event) => update(["assertions", index, "operator"], event.target.value)}>{["eq", "neq", "lt", "lte", "gt", "gte", "within", "count"].map((operator) => <option key={operator}>{operator}</option>)}</select></Field><Field label="Expected value"><input value={typeof assertion.expected === "string" ? assertion.expected : JSON.stringify(assertion.expected)} onChange={(event) => update(["assertions", index, "expected"], parseInputValue(event.target.value))} /></Field><Field label="Tolerance"><input type="number" min="0" step="0.0001" value={assertion.tolerance} onChange={(event) => update(["assertions", index, "tolerance"], Number(event.target.value))} /></Field><Field label="Start step"><input type="number" min="0" value={assertion.window.startStep} onChange={(event) => update(["assertions", index, "window", "startStep"], Number(event.target.value))} /></Field><Field label="End step"><input type="number" min="0" value={assertion.window.endStep ?? ""} placeholder="No limit" onChange={(event) => update(["assertions", index, "window", "endStep"], event.target.value ? Number(event.target.value) : null)} /></Field><Field label="Severity"><select value={assertion.severity} onChange={(event) => update(["assertions", index, "severity"], event.target.value)}><option value="error">Error</option><option value="warning">Warning</option></select></Field><Field label="On failure"><select value={assertion.onFailure} onChange={(event) => update(["assertions", index, "onFailure"], event.target.value)}><option value="stop">Stop run</option><option value="continue">Continue</option></select></Field></div><button type="button" onClick={() => update(["assertions"], draft.assertions.filter((_, candidate) => candidate !== index))} className="mt-4 text-left text-[11px] text-[var(--slate-danger)]">Remove assertion</button></div>)}</div>;
}

function Logging({ draft, update }) {
    return <div className="grid gap-4 md:grid-cols-2"><Field label="Run logging policy"><select value={draft.logging.policy} onChange={(event) => update(["logging", "policy"], event.target.value)}><option value="required">Required: reject run if unavailable</option><option value="optional">Optional: continue degraded</option><option value="disabled">Disabled</option></select></Field><Field label="Recording profile"><input value={draft.logging.profileId} onChange={(event) => update(["logging", "profileId"], event.target.value)} /></Field></div>;
}

function VectorFields({ label, value, onChange }) {
    return <div className="mt-4"><p className="mb-2 text-[13px] font-medium text-[var(--slate-fg-2)]">{label}</p><div className="grid gap-3 sm:grid-cols-3">{["x", "y", "z"].map((axis) => <Field key={axis} label={axis.toUpperCase()}><input type="number" step="0.001" value={value?.[axis] ?? 0} onChange={(event) => onChange(axis, Number(event.target.value))} /></Field>)}</div></div>;
}

function JsonField({ value, onChange, rows = 5, className = "", ...props }) {
    const [textValue, setTextValue] = useState(() => JSON.stringify(value, null, 2));
    const [invalid, setInvalid] = useState(false);
    return <div><textarea {...props} spellCheck={false} rows={rows} value={textValue} onChange={(event) => { const next = event.target.value; setTextValue(next); try { onChange(JSON.parse(next)); setInvalid(false); } catch { setInvalid(true); } }} className={[className, invalid && "border-[var(--slate-danger)]"].filter(Boolean).join(" ")} />{invalid && <p className="mt-1 text-[11px] text-[var(--slate-danger)]">Enter valid JSON to apply this field.</p>}</div>;
}

function Field({ label, wide = false, children }) {
    const control = isValidElement(children)
        ? cloneElement(children, { className: [children.props.className, "sf-input"].filter(Boolean).join(" ") })
        : children;
    return <SharedField label={label} className={wide ? "md:col-span-2" : ""}>{control}</SharedField>;
}

function Toggle({ label, value, onChange }) {
    return <SharedSwitch label={label} checked={value} onCheckedChange={onChange} />;
}

function Action({ icon, label, onClick, disabled = false, primary = false, compact = false }) {
    return <Button disabled={disabled} size={compact ? "compact" : "default"} variant={primary ? "primary" : "default"} onClick={() => Promise.resolve(onClick?.()).catch(() => {})}>{icon}{label}</Button>;
}
