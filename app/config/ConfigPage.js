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
    RUN_MANIFEST_VERSION,
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
import { getScenario, listScenarios } from "../scenarios/ScenarioClient.js";
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

const TABS = ["Overview", "Scenario", "Initial State", "Clock", "Sensors", "Scripts", "Topics", "Assertions", "Logging", "JSON"];
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
    const scenarioLoadRequest = useRef(0);
    const [catalog, setCatalog] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [vehicleCatalog, setVehicleCatalog] = useState([]);
    const [scenarioCatalog, setScenarioCatalog] = useState([]);
    const [scenarioCatalogState, setScenarioCatalogState] = useState("loading");
    const [scenarioCatalogError, setScenarioCatalogError] = useState(null);
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

    const migrationPending = Boolean(saved && Number(saved.version ?? RUN_MANIFEST_VERSION) !== RUN_MANIFEST_VERSION);
    const dirty = Boolean(saved && draft && (
        migrationPending
        || differenceCount(normalizeRunManifest(saved), normalizeRunManifest(draft)) > 0
    ));
    const changedFields = saved && draft
        ? differenceCount(normalizeRunManifest(saved), normalizeRunManifest(draft)) + (migrationPending ? 1 : 0)
        : 0;
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

    const loadScenarioCatalog = async () => {
        const requestId = ++scenarioLoadRequest.current;
        setScenarioCatalogState("loading");
        setScenarioCatalogError(null);
        try {
            const items = await listScenarios();
            if (requestId !== scenarioLoadRequest.current) return;
            setScenarioCatalog(items || []);
            setScenarioCatalogState("ready");
        } catch (caught) {
            if (requestId !== scenarioLoadRequest.current) return;
            setScenarioCatalogError(caught.message);
            setScenarioCatalogState("error");
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
        loadScenarioCatalog();
        const unsubscribe = controller.subscribe(setRunState);
        return () => {
            manifestLoadRequest.current += 1;
            environmentLoadRequest.current += 1;
            scenarioLoadRequest.current += 1;
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
            if (event.domain === "scenario" || event.domain === "scenario-catalog") {
                loadScenarioCatalog();
                return;
            }
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
                <button type="button" className="flex min-w-0 cursor-pointer items-center gap-2 rounded-[var(--radius)] px-1.5 py-1 text-left outline-none transition-colors duration-150 hover:bg-[var(--slate-surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]" onClick={onOpenWorkspace} aria-label="Open workspace switcher">
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
                            {migrationPending && <StatusMessage className="mb-4" tone="info" title={`Run manifest v${saved.version} is ready to migrate`}>Saving will write the normalized v{RUN_MANIFEST_VERSION} document without changing the configured run.</StatusMessage>}

                            <TabsList aria-label="Run manifest sections" className="mb-5 overflow-x-auto">
                                {TABS.map((item) => <TabsTrigger key={item} value={item}>{item}</TabsTrigger>)}
                            </TabsList>

                            <div key={selectedId} className="border-t border-[var(--slate-border)] pt-5">
                                {TABS.map((item) => (
                                    <TabsContent key={item} value={item} forceMount>
                                        {item === "Overview" && <Overview draft={draft} environments={environments} update={update} />}
                                        {item === "Scenario" && <ScenarioSelection draft={draft} scenarios={scenarioCatalog} scenarioCatalogState={scenarioCatalogState} scenarioCatalogError={scenarioCatalogError} retryScenarios={loadScenarioCatalog} vehicleCatalog={vehicleCatalog} update={update} />}
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
    return <div className="grid gap-4 md:grid-cols-2"><Field label="Name"><input value={draft.name} onChange={(event) => update(["name"], event.target.value)} /></Field><Field label="Stable ID"><input value={draft.id} disabled /></Field><Field wide label="Description"><textarea rows={3} value={draft.description} onChange={(event) => update(["description"], event.target.value)} /></Field><Field label="Environment"><select disabled={Boolean(draft.scenario)} value={draft.environment.id} onChange={(event) => update(["environment", "id"], event.target.value)}>{environments.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></Field><Field label="Expected environment hash"><input disabled={Boolean(draft.scenario)} value={draft.environment.expectedHash || ""} placeholder={draft.scenario ? "Supplied by scenario" : "Unlocked"} onChange={(event) => update(["environment", "expectedHash"], event.target.value || null)} /></Field><Field label="Seed"><input value={draft.seed} onChange={(event) => update(["seed"], event.target.value)} /></Field>{draft.scenario && <p className="md:col-span-2 text-[12px] text-[var(--slate-muted)]">The selected scenario supplies the environment, actors, poses, routes, and events. This run configuration supplies the Ego vehicle, sensors, scripts, assertions, clock, and logging.</p>}</div>;
}

const BUILT_IN_VEHICLE_OPTIONS = [
    { id: "big-car", name: "Big Car (built-in)" },
    { id: "igvc-car", name: "IGVC Car (built-in)" },
    { id: "scenario-car", name: "Scenario Car (built-in)" },
];

function ScenarioSelection({
    draft,
    scenarios,
    scenarioCatalogState,
    scenarioCatalogError,
    retryScenarios,
    vehicleCatalog = [],
    update,
}) {
    const [loaded, setLoaded] = useState({ id: null, scenario: null, error: null });
    const [contractRequest, setContractRequest] = useState(0);
    const selectedId = draft.scenario?.id || "";
    const scenario = loaded.id === selectedId ? loaded.scenario : null;
    const loadError = loaded.id === selectedId ? loaded.error : null;
    const selectedSummary = scenarios.find((entry) => entry.id === selectedId) ?? null;
    const missingScenario = Boolean(selectedId && scenarioCatalogState === "ready" && !selectedSummary);

    useEffect(() => {
        let cancelled = false;
        if (!selectedId) return () => { cancelled = true; };
        getScenario(selectedId).then((document) => {
            if (!document) throw new Error(`Scenario "${selectedId}" does not exist.`);
            if (!cancelled) setLoaded({ id: selectedId, scenario: document, error: null });
        }).catch((caught) => {
            if (!cancelled) setLoaded({ id: selectedId, scenario: null, error: caught.message });
        });
        return () => { cancelled = true; };
    }, [contractRequest, selectedId, selectedSummary?.definitionHash]);

    const selectScenario = (id) => {
        if (!id) {
            update(["scenario"], null);
            return;
        }
        const summary = scenarios.find((entry) => entry.id === id);
        update(["scenario"], {
            id,
            expectedHash: summary?.definitionHash || null,
            egoVehicleId: draft.scenario?.egoVehicleId
                || draft.initialState.vehicles.find((entry) => entry.id === "ego")?.type
                || "big-car",
            sensorBindings: {},
            parameterValues: {},
        });
    };
    const vehicleOptions = [...BUILT_IN_VEHICLE_OPTIONS, ...vehicleCatalog]
        .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index);
    const selectedVehicleId = draft.scenario?.egoVehicleId || "";
    const selectedVehicleMissing = Boolean(
        selectedVehicleId && !vehicleOptions.some((entry) => entry.id === selectedVehicleId),
    );
    const sensorBindings = draft.scenario?.sensorBindings ?? {};
    const parameterValues = draft.scenario?.parameterValues ?? {};
    const sensorAliases = Array.isArray(scenario?.sensorAliases) ? scenario.sensorAliases : [];
    const scenarioParameters = Array.isArray(scenario?.parameters) ? scenario.parameters : [];
    const currentScenarioHash = scenario?.definitionHash ?? selectedSummary?.definitionHash ?? null;
    const scenarioHashDrift = Boolean(
        draft.scenario?.expectedHash
        && currentScenarioHash
        && draft.scenario.expectedHash !== currentScenarioHash,
    );
    const changeParameter = (parameter, rawValue) => {
        let value = rawValue;
        if (parameter.type === "float64") value = Number(rawValue);
        if (parameter.type === "int32") value = Math.trunc(Number(rawValue));
        if (parameter.type === "boolean") value = rawValue === true || rawValue === "true";
        update(["scenario", "parameterValues"], {
            ...parameterValues,
            [parameter.id]: value,
        });
    };
    const resetParameter = (parameterId) => {
        const next = { ...parameterValues };
        delete next[parameterId];
        update(["scenario", "parameterValues"], next);
    };

    return (
        <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
                <Field label="Scenario">
                    <select value={selectedId} onChange={(event) => selectScenario(event.target.value)}>
                        <option value="">No scenario (manifest-only run)</option>
                        {selectedId && !selectedSummary && <option value={selectedId}>{selectedId} ({scenarioCatalogState === "loading" ? "loading" : "missing"})</option>}
                        {scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                    </select>
                </Field>
                {draft.scenario && (
                    <Field label="Ego vehicle">
                        <select aria-invalid={!selectedVehicleId || selectedVehicleMissing || undefined} value={selectedVehicleId} onChange={(event) => update(["scenario", "egoVehicleId"], event.target.value)}>
                            <option value="">Select a vehicle</option>
                            {selectedVehicleMissing && <option value={selectedVehicleId}>{selectedVehicleId} (missing)</option>}
                            {vehicleOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                        </select>
                    </Field>
                )}
                {draft.scenario && (
                    <Field wide label="Expected scenario hash">
                        <div className="flex flex-wrap gap-2">
                            <input className="min-w-0 flex-1" value={draft.scenario.expectedHash || ""} placeholder="Unlocked" onChange={(event) => update(["scenario", "expectedHash"], event.target.value || null)} />
                            {currentScenarioHash && draft.scenario.expectedHash !== currentScenarioHash && <Action compact label="Use current" onClick={() => update(["scenario", "expectedHash"], currentScenarioHash)} />}
                            {draft.scenario.expectedHash && <Action compact label="Unlock" onClick={() => update(["scenario", "expectedHash"], null)} />}
                        </div>
                    </Field>
                )}
            </div>

            {scenarioCatalogState === "loading" && <StatusMessage tone="info" title="Refreshing scenario catalog">The manifest-only workflow remains available while scenarios load.</StatusMessage>}
            {scenarioCatalogError && <StatusMessage tone="warning" title="Scenario catalog is unavailable"><div className="flex items-center justify-between gap-3"><span>{scenarioCatalogError}</span><Action compact label="Retry" onClick={retryScenarios} /></div></StatusMessage>}
            {missingScenario && <StatusMessage tone="danger" title="Selected scenario is missing">The manifest still preserves the reference to “{selectedId}”, but it cannot be resolved until that scenario is restored or replaced.</StatusMessage>}
            {selectedVehicleMissing && <StatusMessage tone="danger" title="Ego vehicle is missing">The saved Ego assignment “{selectedVehicleId}” is preserved. Select an available vehicle before running.</StatusMessage>}
            {scenarioHashDrift && <StatusMessage tone="warning" title="Scenario revision changed">The current scenario hash differs from this manifest’s lock. Review the scenario, then use the current hash or leave the existing lock to reject the run.</StatusMessage>}
            {loadError && <StatusMessage tone="danger" title="Could not load scenario"><div className="flex items-center justify-between gap-3"><span>{loadError}</span><Action compact label="Retry" onClick={() => setContractRequest((value) => value + 1)} /></div></StatusMessage>}
            {draft.scenario && !scenario && !loadError && <AsyncState status="loading" title="Loading scenario contract" detail="Reading roles, sensor aliases, and declared parameters." />}
            {scenario && (
                <>
                    <div className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)] p-4">
                        <p className="text-[13px] font-medium">{scenario.name}</p>
                        <p className="mt-1 text-[12px] text-[var(--slate-muted)]">{scenario.description || `${scenario.actors?.length ?? 0} actors · ${scenario.routes?.length ?? 0} routes`}</p>
                        <p className="mt-2 font-mono text-[11px] text-[var(--slate-muted)]">{scenario.environment?.id || "No environment"} · {currentScenarioHash || "unhashed"}</p>
                    </div>
                    <section>
                        <h2 className="mb-3 text-[13px] font-medium">Scenario sensor bindings</h2>
                        {sensorAliases.length === 0 ? <p className="text-[12px] text-[var(--slate-muted)]">This scenario declares no sensor aliases.</p> : (
                            <div className="grid gap-3 md:grid-cols-2">
                                {sensorAliases.map((alias) => {
                                    const sensorId = sensorBindings[alias.id] || "";
                                    const compatibleSensors = draft.sensorRig.sensors.filter((sensor) => !alias.type || sensor.type === alias.type);
                                    const selectedSensor = draft.sensorRig.sensors.find((sensor) => sensor.id === sensorId);
                                    const bindingInvalid = Boolean(sensorId && (!selectedSensor || (alias.type && selectedSensor.type !== alias.type)));
                                    return (
                                        <Field key={alias.id} label={`${alias.name}${alias.type ? ` (${alias.type})` : ""}`}>
                                            <select aria-invalid={!sensorId || bindingInvalid || undefined} value={sensorId} onChange={(event) => update(["scenario", "sensorBindings"], { ...sensorBindings, [alias.id]: event.target.value })}>
                                                <option value="">Unbound — required</option>
                                                {bindingInvalid && <option value={sensorId}>{sensorId} (missing or incompatible)</option>}
                                                {compatibleSensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.id}{sensor.enabled === false ? " (disabled)" : ""}</option>)}
                                            </select>
                                            <span className={`mt-1 block text-[11px] ${!sensorId || bindingInvalid ? "text-[var(--slate-warning)]" : "text-[var(--slate-muted)]"}`}>{!sensorId ? `Bind this alias to a ${alias.type || "compatible"} run sensor.` : bindingInvalid ? "The saved binding no longer satisfies this alias." : `Bound to run sensor ${sensorId}.`}</span>
                                        </Field>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                    <section>
                        <h2 className="mb-3 text-[13px] font-medium">Scenario parameter overrides</h2>
                        {scenarioParameters.length === 0 ? <p className="text-[12px] text-[var(--slate-muted)]">This scenario declares no parameters.</p> : (
                            <div className="grid gap-3 md:grid-cols-2">
                                {scenarioParameters.map((parameter) => {
                                    const overridden = Object.hasOwn(parameterValues, parameter.id);
                                    const value = overridden ? parameterValues[parameter.id] : parameter.default;
                                    return (
                                        <div key={parameter.id} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-3">
                                            <div className="mb-2 flex items-start justify-between gap-3">
                                                <div><p className="text-[12px] font-medium">{parameter.name}</p><p className="mt-0.5 font-mono text-[11px] text-[var(--slate-muted)]">{parameter.id} · {parameter.type}</p></div>
                                                {overridden && <Action compact label="Use default" onClick={() => resetParameter(parameter.id)} />}
                                            </div>
                                            <ParameterValueControl parameter={parameter} value={value} onChange={(nextValue) => changeParameter(parameter, nextValue)} />
                                            <p className="mt-2 text-[11px] text-[var(--slate-muted)]">{overridden ? `Override; default is ${JSON.stringify(parameter.default)}.` : `Using default ${JSON.stringify(parameter.default)}.`}{parameter.description ? ` ${parameter.description}` : ""}</p>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                </>
            )}

            <RunParameterDeclarations parameters={draft.parameters} update={update} />
        </div>
    );
}

function ParameterValueControl({ parameter, value, onChange }) {
    if (parameter.type === "boolean") {
        return <select aria-label={`${parameter.name} value`} value={String(value)} onChange={(event) => onChange(event.target.value)}><option value="true">True</option><option value="false">False</option></select>;
    }
    return <input aria-label={`${parameter.name} value`} type={["float64", "int32"].includes(parameter.type) ? "number" : "text"} step={parameter.type === "int32" ? 1 : "any"} value={value} onChange={(event) => onChange(event.target.value)} />;
}

function runParameterDefault(type) {
    if (type === "boolean") return false;
    if (type === "string") return "";
    return 0;
}

function RunParameterDeclarations({ parameters, update }) {
    const replace = (index, parameter) => update(["parameters"], parameters.map((entry, candidate) => candidate === index ? parameter : entry));
    const add = () => {
        const ids = new Set(parameters.map((entry) => entry.id));
        let number = parameters.length + 1;
        while (ids.has(`parameter-${number}`)) number += 1;
        update(["parameters"], [...parameters, {
            id: `parameter-${number}`,
            name: `Parameter ${number}`,
            description: "",
            type: "float64",
            default: 0,
            target: { kind: "scalar-field", path: "", scriptId: null, input: "" },
        }]);
    };
    const changeType = (index, parameter, type) => replace(index, {
        ...parameter,
        type,
        default: runParameterDefault(type),
    });
    const changeTargetKind = (index, parameter, kind) => replace(index, {
        ...parameter,
        target: kind === "script-input"
            ? { kind, path: "", scriptId: "", input: "" }
            : { kind, path: "", scriptId: null, input: "" },
    });

    return (
        <section className="border-t border-[var(--slate-border)] pt-5">
            <div className="mb-3 flex items-start justify-between gap-3">
                <div><h2 className="text-[13px] font-medium">Declared run parameters</h2><p className="mt-1 text-[11px] text-[var(--slate-muted)]">Experiment suites may override only these typed, validated targets.</p></div>
                <Action compact icon={<FaPlus />} label="Add parameter" onClick={add} />
            </div>
            {parameters.length === 0 ? <p className="text-[12px] text-[var(--slate-muted)]">This run configuration declares no sweepable parameters.</p> : (
                <div className="space-y-3">
                    {parameters.map((parameter, index) => (
                        <div key={`${parameter.id}-${index}`} className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-4">
                            <div className="grid gap-3 md:grid-cols-4">
                                <Field label="Stable ID"><input value={parameter.id} onChange={(event) => replace(index, { ...parameter, id: event.target.value })} /></Field>
                                <Field label="Name"><input value={parameter.name} onChange={(event) => replace(index, { ...parameter, name: event.target.value })} /></Field>
                                <Field label="Type"><select value={parameter.type} onChange={(event) => changeType(index, parameter, event.target.value)}><option value="float64">float64</option><option value="int32">int32</option><option value="boolean">boolean</option><option value="string">string</option></select></Field>
                                <Field label="Default"><ParameterValueControl parameter={parameter} value={parameter.default} onChange={(rawValue) => {
                                    let value = rawValue;
                                    if (parameter.type === "float64") value = Number(rawValue);
                                    if (parameter.type === "int32") value = Math.trunc(Number(rawValue));
                                    if (parameter.type === "boolean") value = rawValue === true || rawValue === "true";
                                    replace(index, { ...parameter, default: value });
                                }} /></Field>
                                <Field label="Target"><select value={parameter.target.kind || ""} onChange={(event) => changeTargetKind(index, parameter, event.target.value)}><option value="">Select a target</option><option value="scalar-field">Scalar field</option><option value="script-input">Script input</option><option value="scenario-signal">Scenario signal</option></select></Field>
                                {parameter.target.kind === "script-input" ? <><Field label="Script ID"><input value={parameter.target.scriptId || ""} onChange={(event) => replace(index, { ...parameter, target: { ...parameter.target, scriptId: event.target.value } })} /></Field><Field label="Input port"><input value={parameter.target.input || ""} onChange={(event) => replace(index, { ...parameter, target: { ...parameter.target, input: event.target.value } })} /></Field></> : <Field label="Target path"><input value={parameter.target.path || ""} placeholder={parameter.target.kind === "scenario-signal" ? "scenario.custom_flag" : "clock.speed"} onChange={(event) => replace(index, { ...parameter, target: { ...parameter.target, path: event.target.value } })} /></Field>}
                                <Field wide label="Description"><input value={parameter.description || ""} onChange={(event) => replace(index, { ...parameter, description: event.target.value })} /></Field>
                            </div>
                            <button type="button" className="mt-3 text-[11px] text-[var(--slate-danger)]" onClick={() => update(["parameters"], parameters.filter((_, candidate) => candidate !== index))}>Remove parameter</button>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function InitialState({ draft, update, vehicleCatalog = [] }) {
    if (draft.scenario) {
        return <StatusMessage tone="info" title="Initial state comes from the scenario">Actors, poses, routes, and initial speeds are resolved from the selected scenario. Clear the scenario selection to edit manifest-owned vehicles.</StatusMessage>;
    }
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
    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Action compact icon={<FaPlus />} label="Add topic" onClick={add} />
            </div>
            {draft.topics.map((topic, index) => <div key={`${topic.id}-${index}`} className="grid gap-3 rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] p-3 md:grid-cols-[1fr_1.4fr_1fr_1.5fr_.8fr_auto]">
                <Field label="ID">
                    <input value={topic.id} onChange={(event) => update(["topics", index, "id"], event.target.value)} />
                </Field>
                <Field label="Topic">
                    <input value={topic.name} onChange={(event) => update(["topics", index, "name"], event.target.value)} />
                </Field>
                <Field label="Direction">
                    <select value={topic.direction} onChange={(event) => update(["topics", index, "direction"], event.target.value)}>
                        <option value="input">Input</option>
                        <option value="output">Output</option>
                    </select>
                </Field>
                <Field label="ROS type">
                    <input value={topic.type} onChange={(event) => update(["topics", index, "type"], event.target.value)} />
                </Field>
                <div className="h-[100%] flex items-center justify-center flex-col gap-6 border-l border-r border-[var(--slate-border-60)] px-3 text-center text-[11px] text-[var(--slate-fg-2)]">
                    <div></div>
                    <Toggle label="Required" value={topic.required} onChange={(value) => update(["topics", index, "required"], value)} />
                </div>
                <button type="button" onClick={() => update(["topics"], draft.topics.filter((_, candidate) => candidate !== index))} className="self-end pb-2 text-[11px] text-[var(--slate-danger)]">
                    Remove
                </button>
            </div>)}
        </div>
    );
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
