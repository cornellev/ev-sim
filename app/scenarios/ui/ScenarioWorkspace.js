'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    IconAlertTriangle,
    IconCheck,
    IconCopy,
    IconDeviceFloppy,
    IconPlus,
    IconRoute,
    IconShieldCheck,
    IconX,
} from "@tabler/icons-react";

import { getEnvironmentManifest, listEnvironments } from "../../3d/environment/EnvironmentCatalogClient.js";
import { listVehicleManifests } from "../../vehicles/VehicleManifestClient.js";
import {
    createScenario,
    getScenario,
    getScenarioCatalog,
    listScenarios,
    saveScenario,
    saveScenarioCatalog,
    validateScenarioOnServer,
    verifyScenarioRoute,
    duplicateScenario,
} from "../ScenarioClient.js";
import {
    createScenarioCatalog,
    normalizeScenario,
    normalizeScenarioCatalog,
    validateScenario,
} from "../ScenarioDocument.js";
import {
    AdvancedSwitch,
    AuthoringModeProvider,
    AsyncState,
    Button,
    Field,
    StatusMessage,
    TabsContent,
    TabsList,
    TabsRoot,
    TabsTrigger,
    Textarea,
    TextInput,
    useWorkspaceGuard,
    WorkspaceFrame,
} from "../../ui";
import ScenarioCatalog from "./ScenarioCatalog.js";
import RouteMapEditor from "./RouteMapEditor.js";
import {
    ActorsSection,
    CompletionSection,
    OutcomesSection,
    OverviewSection,
    RoutesSection,
    TimelineSection,
    ZonesSection,
} from "./ScenarioSections.js";
import {
    SCENARIO_TABS,
    createScenarioDraft,
    folderEntries,
    scenarioDocument,
    scenarioEntries,
    slugify,
    stableDocument,
    withUpdatedPath,
} from "./scenarioUiModel.js";
import styles from "./ScenarioWorkspace.module.css";

function validationResult(value) {
    if (!value) return null;
    if (value.validation) return value.validation;
    if (typeof value.ok === "boolean") return value;
    return null;
}

function tabForIssue(path = "") {
    if (path.startsWith("routes")) return "routes";
    if (path.startsWith("actors")) return "actors";
    if (path.startsWith("zones") || path.startsWith("triggers")) return "zones";
    if (path.startsWith("completion")) return "completion";
    if (path.startsWith("expectedOutcomes")) return "outcomes";
    return "overview";
}

export default function ScenarioWorkspace({ onOpenWorkspace }) {
    const [entries, setEntries] = useState([]);
    const [catalog, setCatalog] = useState(() => createScenarioCatalog());
    const [environments, setEnvironments] = useState([]);
    const [vehicles, setVehicles] = useState([]);
    const [environment, setEnvironment] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [tab, setTab] = useState("overview");
    const [routeEditorIndex, setRouteEditorIndex] = useState(0);
    const [creating, setCreating] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState(null);
    const [feedback, setFeedback] = useState(null);
    const [validation, setValidation] = useState(null);

    const folders = useMemo(() => folderEntries(catalog), [catalog]);
    const dirty = Boolean(draft && saved && stableDocument(draft) !== stableDocument(saved));

    const applyDocument = useCallback((id, value, nextTab = null) => {
        const document = scenarioDocument(value);
        const normalized = normalizeScenario(document);
        setSelectedId(id || normalized.id);
        setSaved(document);
        setDraft(normalized);
        setCreating(false);
        setValidation(null);
        setError(null);
        setRouteEditorIndex(0);
        if (nextTab) setTab(nextTab);
    }, []);

    const reloadCatalog = useCallback(async (preferredId = null) => {
        const [scenarioList, scenarioCatalog, environmentList, vehicleList] = await Promise.all([
            listScenarios(),
            getScenarioCatalog().catch(() => createScenarioCatalog()),
            listEnvironments(),
            listVehicleManifests().catch(() => []),
        ]);
        const nextEntries = scenarioEntries(scenarioList);
        setEntries(nextEntries);
        setCatalog(normalizeScenarioCatalog(scenarioCatalog || {}));
        setEnvironments(environmentList?.length ? environmentList : [{ id: "igvc", name: "IGVC" }]);
        const builtIns = [
            { id: "big-car", name: "Big Car (built-in)" },
            { id: "igvc-car", name: "IGVC Car (built-in)" },
            { id: "scenario-car", name: "Scenario Car (built-in)" },
        ];
        setVehicles([...builtIns, ...(vehicleList || [])].filter((entry, index, entries) => (
            entries.findIndex((candidate) => candidate.id === entry.id) === index
        )));
        const nextId = preferredId || selectedId || nextEntries[0]?.id;
        if (nextId) applyDocument(nextId, await getScenario(nextId));
        else {
            setSelectedId(null);
            setSaved(null);
            setDraft(null);
            setCreating(true);
        }
    }, [applyDocument, selectedId]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        reloadCatalog().catch((loadError) => {
            if (!cancelled) setError(loadError?.message || "Could not load scenarios.");
        }).finally(() => !cancelled && setLoading(false));
        return () => { cancelled = true; };
        // Initial catalog load is intentionally independent of selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const environmentId = draft?.environment?.id;
        if (!environmentId) {
            setEnvironment(null);
            return undefined;
        }
        let cancelled = false;
        getEnvironmentManifest(environmentId)
            .then((manifest) => !cancelled && setEnvironment(manifest))
            .catch(() => !cancelled && setEnvironment(null));
        return () => { cancelled = true; };
    }, [draft?.environment?.id]);

    const update = useCallback((path, value) => {
        setDraft((current) => withUpdatedPath(current, path, typeof value === "function" ? value(current) : value));
        setValidation(null);
        setFeedback(null);
        setError(null);
    }, []);

    const save = useCallback(async () => {
        if (!draft || !selectedId) return;
        setBusy(true);
        setError(null);
        try {
            const stored = await saveScenario(selectedId, normalizeScenario(draft), saved?.revision);
            applyDocument(selectedId, stored);
            setEntries((current) => current.map((entry) => entry.id === selectedId ? { ...entry, name: draft.name, description: draft.description, folderId: draft.folderId } : entry));
            setFeedback("Scenario saved");
        } catch (saveError) {
            setError(saveError?.message || "Could not save the scenario.");
            throw saveError;
        } finally {
            setBusy(false);
        }
    }, [applyDocument, draft, saved?.revision, selectedId]);

    const discard = useCallback(() => {
        if (saved) setDraft(normalizeScenario(saved));
        setError(null);
        setValidation(null);
    }, [saved]);

    useWorkspaceGuard("scenarios", {
        dirty,
        save,
        discard,
        label: draft?.name || "Scenario",
    });

    const select = async (id) => {
        if (id === selectedId) return;
        if (dirty) {
            setError("Save or discard the current scenario before opening another one.");
            return;
        }
        setBusy(true);
        try {
            applyDocument(id, await getScenario(id), "overview");
        } catch (loadError) {
            setError(loadError?.message || "Could not open the scenario.");
        } finally {
            setBusy(false);
        }
    };

    const startCreating = () => {
        if (dirty) {
            setError("Save or discard the current scenario before creating another one.");
            return;
        }
        setCreating(true);
        setSelectedId(null);
        setSaved(null);
        setDraft(null);
        setValidation(null);
        setError(null);
    };

    const submitCreate = async (input) => {
        setBusy(true);
        setError(null);
        try {
            const scenario = createScenarioDraft(input);
            const stored = await createScenario(scenario);
            const document = scenarioDocument(stored);
            const id = document.id || scenario.id;
            setEntries((current) => [...current, { id, name: document.name, description: document.description, folderId: document.folderId }]);
            applyDocument(id, stored, "routes");
            setFeedback("Scenario created. Edit the Ego route to place its start and finish.");
        } catch (createError) {
            setError(createError?.message || "Could not create the scenario.");
        } finally {
            setBusy(false);
        }
    };

    const addFolder = async (name) => {
        const folder = { id: slugify(name, "folder"), name };
        const next = normalizeScenarioCatalog({ ...catalog, folders: [...folders, folder] });
        setCatalog(next);
        try {
            setCatalog(normalizeScenarioCatalog(await saveScenarioCatalog(next)));
        } catch (catalogError) {
            setCatalog(catalog);
            setError(catalogError?.message || "Could not save the scenario folder.");
        }
    };

    const moveScenarioToFolder = async (scenarioId, folderId) => {
        if (busy) return;
        const nextFolderId = folderId && folders.some((folder) => folder.id === folderId) ? folderId : null;
        const entry = entries.find((candidate) => candidate.id === scenarioId);
        if (!entry || entry.folderId === nextFolderId) return;
        if (selectedId === scenarioId && dirty) {
            setError("Save or discard the current scenario before moving it.");
            return;
        }

        setBusy(true);
        setError(null);
        try {
            const current = selectedId === scenarioId && saved
                ? saved
                : scenarioDocument(await getScenario(scenarioId));
            if (!current) throw new Error(`Scenario "${scenarioId}" does not exist.`);
            const stored = await saveScenario(
                scenarioId,
                normalizeScenario({ ...current, folderId: nextFolderId }),
                current.revision,
            );
            const document = scenarioDocument(stored);
            setEntries((currentEntries) => currentEntries.map((candidate) => (
                candidate.id === scenarioId
                    ? { ...candidate, folderId: document.folderId }
                    : candidate
            )));
            if (selectedId === scenarioId) applyDocument(scenarioId, stored);
            const folderName = folders.find((folder) => folder.id === document.folderId)?.name || "Unfiled";
            setFeedback(`Scenario moved to ${folderName}`);
        } catch (moveError) {
            setError(moveError?.message || "Could not move the scenario.");
        } finally {
            setBusy(false);
        }
    };

    const validate = async () => {
        if (!draft) return;
        setBusy(true);
        setError(null);
        try {
            const local = validateScenario(draft);
            const server = selectedId ? validationResult(await validateScenarioOnServer(selectedId, draft)) : null;
            const result = server || local;
            setValidation(result);
            setFeedback(result.ok ? "Scenario is valid" : `${result.issues?.length || 0} validation issue${result.issues?.length === 1 ? "" : "s"}`);
        } catch (validationError) {
            setError(validationError?.message || "Scenario validation failed.");
        } finally {
            setBusy(false);
        }
    };

    const verifyRoute = async () => {
        const route = draft?.routes?.[routeEditorIndex];
        if (!route || !selectedId) return;
        setVerifying(true);
        setError(null);
        try {
            const result = await verifyScenarioRoute(selectedId, draft, route.id);
            if (result?.ok === false) {
                if (result.route || result.waypoints) update(["routes", routeEditorIndex], {
                    ...route,
                    ...(result.route || {}),
                    waypoints: result.waypoints || result.route?.waypoints || route.waypoints,
                    verification: null,
                });
                throw new Error(result.issues?.[0]?.message || result.error || "The route is not connected.");
            }
            const document = result?.scenario ? scenarioDocument(result.scenario) : null;
            if (document) setDraft(normalizeScenario(document));
            else if (result?.route || result?.waypoints) update(["routes", routeEditorIndex], {
                ...route,
                ...(result.route || {}),
                waypoints: result.waypoints || result.route?.waypoints || route.waypoints,
                verification: result.verification || result.route?.verification || null,
            });
            else if (result?.verification) update(["routes", routeEditorIndex], { ...route, verification: result.verification });
            else throw new Error("Route verification returned no verified route.");
            setFeedback("Route verified against the directed road graph");
        } catch (verifyError) {
            setError(verifyError?.message || "The route could not be connected.");
        } finally {
            setVerifying(false);
        }
    };

    const addActor = () => {
        if (!draft) return;
        const index = draft.actors.length;
        const actorId = `actor-${index}`;
        setDraft((current) => ({
            ...current,
            actors: [...current.actors, { id: actorId, name: `Actor ${index}`, role: "actor", vehicleId: null, enabled: true }],
            routes: [...current.routes, { id: `${actorId}-route`, name: `Actor ${index} route`, actorId, initialSpeedMps: 0, controller: { kind: "route-follower", activation: { kind: "start", flag: null }, scriptId: null, topicId: null, inputs: [], outputs: [] }, waypoints: [], verification: null }],
        }));
        setTab("actors");
    };

    const duplicate = async () => {
        if (!selectedId || dirty) {
            if (dirty) setError("Save the current scenario before duplicating it.");
            return;
        }
        setBusy(true);
        try {
            const result = await duplicateScenario(selectedId, {
                id: slugify(`${selectedId}-copy-${entries.length + 1}`),
                name: `${draft.name} Copy`,
            });
            const document = scenarioDocument(result);
            await reloadCatalog(document.id);
            setFeedback("Scenario duplicated");
        } catch (duplicateError) {
            setError(duplicateError?.message || "Could not duplicate the scenario.");
        } finally {
            setBusy(false);
        }
    };

    const actions = draft ? (
        <>
            <AdvancedSwitch />
            {feedback && <span className={styles.headerFeedback} data-valid={validation?.ok || undefined}>{feedback}</span>}
            {dirty && <span className={styles.dirtyMark}>Unsaved</span>}
            <Button size="compact" onClick={duplicate} disabled={busy || dirty}><IconCopy size={14} stroke={1.75} /> Duplicate</Button>
            <Button size="compact" onClick={validate} loading={busy}><IconShieldCheck size={14} stroke={1.75} /> Validate</Button>
            <Button size="compact" variant="primary" onClick={() => save().catch(() => {})} loading={busy} disabled={!dirty}><IconDeviceFloppy size={14} stroke={1.75} /> Save</Button>
        </>
    ) : null;

    return (
        <AuthoringModeProvider>
        <WorkspaceFrame
            title="Scenarios"
            subtitle={draft?.name}
            onOpenWorkspace={onOpenWorkspace}
            actions={actions}
            className={styles.workspace}
            contentClassName={styles.workspaceContent}
            sidebar={<ScenarioCatalog scenarios={entries} folders={folders} selectedId={selectedId} onSelect={select} onCreate={startCreating} onCreateFolder={addFolder} onMove={moveScenarioToFolder} />}
        >
            {loading ? <AsyncState status="loading" title="Loading scenario library" detail="Reading scenario documents and the folder catalog." className={styles.centerState} /> : creating ? (
                <ScenarioCreateForm environments={environments} folders={folders} onCreate={submitCreate} busy={busy} />
            ) : !draft ? (
                <AsyncState status={error ? "error" : "empty"} title={error ? "Scenarios unavailable" : "No scenario selected"} detail={error || "Select a scenario or create a new one."} onRetry={reloadCatalog} className={styles.centerState} />
            ) : (
                <div className={styles.editorShell}>
                    {(error || validation) && (
                        <div className={styles.noticeRail}>
                            <button
                                type="button"
                                className={styles.noticeClose}
                                aria-label="Dismiss issues"
                                onClick={() => { setError(null); setValidation(null); }}
                            >
                                <IconX size={15} stroke={1.75} />
                            </button>
                            {error && <StatusMessage tone="danger" title="Action required">{error}{dirty && <button type="button" onClick={discard}>Discard current changes</button>}</StatusMessage>}
                            {validation?.ok && <StatusMessage tone="success" title="Ready to run">All scenario references and termination rules are valid.</StatusMessage>}
                            {validation && !validation.ok && <ValidationIssues validation={validation} onSelect={(issue) => { const match = issue.path?.match(/^routes\.(\d+)/); if (match) setRouteEditorIndex(Number(match[1])); setTab(tabForIssue(issue.path)); }} />}
                        </div>
                    )}
                    <TabsRoot className={styles.scenarioTabs} value={tab === "route-editor" ? "routes" : tab} onValueChange={setTab}>
                        <div className={styles.tabBar}><TabsList aria-label="Scenario sections">{SCENARIO_TABS.map((entry) => <TabsTrigger key={entry.id} value={entry.id}>{entry.label}</TabsTrigger>)}</TabsList></div>
                        <div className={styles.tabViewport}>
                            {tab === "route-editor" ? (
                                <RouteMapEditor
                                    route={draft.routes[routeEditorIndex] || draft.routes[0]}
                                    environment={environment}
                                    onChange={(route) => update(["routes", routeEditorIndex], route)}
                                    onVerify={verifyRoute}
                                    verifying={verifying}
                                    onClose={() => setTab("routes")}
                                    onContinue={() => setTab("routes")}
                                />
                            ) : (
                                <>
                                    <TabsContent value="overview"><OverviewSection scenario={draft} environments={environments} folders={folders} onUpdate={update} /></TabsContent>
                                    <TabsContent value="routes"><RoutesSection scenario={draft} onUpdate={update} onAddActor={addActor} onEditRoute={(index) => { setRouteEditorIndex(index); setTab("route-editor"); }} /></TabsContent>
                                    <TabsContent value="actors"><ActorsSection scenario={draft} vehicleCatalog={vehicles} onUpdate={update} onAddActor={addActor} /></TabsContent>
                                    <TabsContent value="zones"><ZonesSection scenario={draft} environment={environment} onUpdate={update} /></TabsContent>
                                    <TabsContent value="timeline"><TimelineSection scenario={draft} /></TabsContent>
                                    <TabsContent value="completion"><CompletionSection scenario={draft} onUpdate={update} /></TabsContent>
                                    <TabsContent value="outcomes"><OutcomesSection scenario={draft} onUpdate={update} /></TabsContent>
                                </>
                            )}
                        </div>
                    </TabsRoot>
                </div>
            )}
        </WorkspaceFrame>
        </AuthoringModeProvider>
    );
}

function ScenarioCreateForm({ environments, folders, onCreate, busy }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [environmentId, setEnvironmentId] = useState(environments[0]?.id || "igvc");
    const [folderId, setFolderId] = useState(null);
    return (
        <div className={styles.createStage}>
            <form className={styles.createForm} onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate({ name, description, environmentId, folderId }); }}>
                <div className={styles.createIcon}><IconRoute size={22} stroke={1.45} aria-hidden="true" /></div>
                <h1>New Reusable Scenario</h1>
                <div className={styles.formStack}>
                    <Field label="Scenario name" required><TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Downtown protected left" /></Field>
                    <Field label="Description"><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What behavior and failure mode does this scenario exercise?" /></Field>
                    <div className={styles.formGrid}>
                        <Field label="Environment" required><select className="sf-input sf-native-select" value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name || environment.id}</option>)}</select></Field>
                        <Field label="Folder"><select className="sf-input sf-native-select" value={folderId || ""} onChange={(event) => setFolderId(event.target.value || null)}><option value="">Unfiled</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
                    </div>
                </div>
                <Button className={styles.createButton} variant="primary" type="submit" disabled={!name.trim()} loading={busy}><IconPlus size={15} stroke={1.75} /> Create scenario</Button>
            </form>
            <aside className={styles.createGuide}>
                <span>Authoring sequence</span>
                <ol><li><strong>Route</strong><p>Define a path and/or behavior for the scenario.</p></li><li><strong>Orchestrate</strong><p>Add events to the scenario.</p></li><li><strong>Define</strong><p>Create conditions for the scenario to pass.</p></li></ol>
                <p className="pt-[30px]">
                    See documentation for more on scenario authoring.
                </p>
            </aside>
        </div>
    );
}

function ValidationIssues({ validation, onSelect }) {
    return (
        <div className={styles.validationPanel} role="status">
            <IconAlertTriangle size={16} stroke={1.75} aria-hidden="true" />
            <div><strong>{validation.issues.length} issue{validation.issues.length === 1 ? "" : "s"} before this scenario can run</strong><div className={styles.issueList}>{validation.issues.slice(0, 5).map((issue, index) => <button type="button" key={`${issue.path}-${index}`} onClick={() => onSelect(issue)}><code>{issue.path || "scenario"}</code><span>{issue.message}</span></button>)}</div></div>
        </div>
    );
}
