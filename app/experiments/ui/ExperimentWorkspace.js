'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    IconCheck,
    IconCopy,
    IconDeviceFloppy,
    IconFlask2,
    IconPlus,
    IconShieldCheck,
} from "@tabler/icons-react";

import { getRunManifest, listRunManifests } from "../../simulation/RunManifestClient.js";
import { getRunSessionController } from "../../simulation/RunSessionController.js";
import { getScenario, listScenarios } from "../../scenarios/ScenarioClient.js";
import { normalizeScenario } from "../../scenarios/ScenarioDocument.js";
import {
    createExperimentBaseline as persistBaseline,
    createExperimentSuite,
    duplicateExperimentSuite,
    getExperimentBaseline,
    getExperimentResult,
    getExperimentSuite,
    listExperimentBaselines,
    listExperimentResults,
    listExperimentSuites,
    saveExperimentSuite,
    validateExperimentSuiteOnServer,
} from "../ExperimentClient.js";
import {
    createDefaultExperimentSuite,
    normalizeExperimentSuite,
    normalizeParameterDeclaration,
    planExperimentCases,
    validateExperimentSuite,
} from "../ExperimentSuite.js";
import { normalizeExperimentResult } from "../ExperimentResult.js";
import {
    getExperimentRunController,
    interruptStaleExperimentResults,
} from "../ExperimentRunController.js";
import {
    compareExperimentToBaseline,
    createExperimentBaseline,
    normalizeExperimentBaseline,
} from "../BaselineComparison.js";
import {
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
import ExperimentCatalog from "./ExperimentCatalog.js";
import {
    CompareSection,
    MatrixSection,
    MetricsSection,
    ReviewSection,
    RunSection,
    SetupSection,
} from "./ExperimentSections.js";
import styles from "./ExperimentWorkspace.module.css";

const TABS = [
    { id: "setup", label: "Setup" },
    { id: "matrix", label: "Matrix" },
    { id: "metrics", label: "Metrics" },
    { id: "run", label: "Run" },
    { id: "compare", label: "Compare" },
    { id: "review", label: "Review" },
];

function slug(value, fallback = "experiment-suite") {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `${fallback}-${Date.now().toString(36)}`;
}

function listFrom(value, key) {
    return Array.isArray(value) ? value : value?.[key] || value?.items || [];
}

function suiteDocument(value) {
    return value?.suite || value?.document || value;
}

function resultDocument(value) {
    return value?.result || value?.document || value;
}

function baselineDocument(value) {
    return value?.baseline || value?.document || value;
}

function updatePath(source, path, value) {
    if (path.length === 0) return value;
    const [key, ...rest] = path;
    const copy = Array.isArray(source) ? [...source] : { ...(source || {}) };
    copy[key] = updatePath(source?.[key], rest, value);
    return copy;
}

function stable(value) {
    const copy = structuredClone(value || {});
    delete copy.revision;
    delete copy.definitionHash;
    delete copy.createdAt;
    delete copy.updatedAt;
    return JSON.stringify(copy);
}

function summaryFromSuite(value) {
    const suite = suiteDocument(value);
    return { id: suite.id, name: suite.name || suite.id, description: suite.description || "", scenarioIds: suite.scenarioIds || [], manifestIds: suite.manifestIds || [], revision: suite.revision };
}

function summaryFromResult(value) {
    const result = resultDocument(value);
    return {
        id: result.id,
        suiteId: result.suiteId,
        status: result.status,
        createdAt: result.createdAt,
        finishedAt: result.finishedAt,
        summary: result.summary,
    };
}

export default function ExperimentWorkspace({ onOpenWorkspace, onOpenReplay, onOpenAnalysis, onDiagnosticsViewportChange }) {
    const runController = useMemo(() => getExperimentRunController(), []);
    const runSession = useMemo(() => getRunSessionController(), []);
    const [suites, setSuites] = useState([]);
    const [scenarios, setScenarios] = useState([]);
    const [scenarioDocuments, setScenarioDocuments] = useState([]);
    const [manifests, setManifests] = useState([]);
    const [manifestDocuments, setManifestDocuments] = useState([]);
    const [results, setResults] = useState([]);
    const [baselines, setBaselines] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [selectedResult, setSelectedResult] = useState(null);
    const [selectedBaseline, setSelectedBaseline] = useState(null);
    const [snapshot, setSnapshot] = useState(() => runController.getSnapshot());
    const [tab, setTab] = useState("setup");
    const [creating, setCreating] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [feedback, setFeedback] = useState(null);
    const [validation, setValidation] = useState(null);
    const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(false);

    const dirty = Boolean(saved && draft && stable(saved) !== stable(draft));

    const applySuite = useCallback((value) => {
        const document = suiteDocument(value);
        const normalized = normalizeExperimentSuite(document);
        setSelectedId(normalized.id);
        setSelectedResult((current) => current?.suiteId === normalized.id ? current : null);
        setSelectedBaseline((current) => current?.suiteId === normalized.id ? current : null);
        setSaved(document);
        setDraft(normalized);
        setCreating(false);
        setValidation(null);
        setError(null);
    }, []);

    const loadAll = useCallback(async (preferredId = null) => {
        const [suiteList, scenarioList, manifestList, resultList, baselineList] = await Promise.all([
            listExperimentSuites(), listScenarios(), listRunManifests(), listExperimentResults(), listExperimentBaselines(),
        ]);
        const suiteEntries = listFrom(suiteList, "suites").map(summaryFromSuite);
        const scenarioEntries = listFrom(scenarioList, "scenarios");
        const manifestEntries = listFrom(manifestList, "manifests");
        let resultEntries = listFrom(resultList, "results");
        const controllerSnapshot = runController.getSnapshot();
        const liveResultId = ["running", "paused"].includes(controllerSnapshot.status)
            ? controllerSnapshot.result?.id ?? null
            : null;
        const interruptedResults = await interruptStaleExperimentResults(resultEntries, {
            excludeResultId: liveResultId,
        });
        if (interruptedResults.length > 0) {
            const replacements = new Map(interruptedResults.map((entry) => [entry.id, summaryFromResult(entry)]));
            resultEntries = resultEntries.map((entry) => replacements.get(entry.id) ?? entry);
        }
        setSuites(suiteEntries);
        setScenarios(scenarioEntries);
        setManifests(manifestEntries);
        setResults(resultEntries);
        setBaselines(listFrom(baselineList, "baselines"));

        const [scenarioDocs, manifestDocs] = await Promise.all([
            Promise.all(scenarioEntries.map((entry) => getScenario(entry.id).then((value) => normalizeScenario(value?.scenario || value)).catch(() => null))),
            Promise.all(manifestEntries.map((entry) => getRunManifest(entry.id).then((value) => value?.manifest || value).catch(() => null))),
        ]);
        setScenarioDocuments(scenarioDocs.filter(Boolean));
        setManifestDocuments(manifestDocs.filter(Boolean));

        const nextId = preferredId || suiteEntries[0]?.id;
        if (nextId) {
            const storedSuite = suiteDocument(await getExperimentSuite(nextId));
            applySuite(storedSuite);
        }
        else {
            setSelectedId(null);
            setSaved(null);
            setDraft(null);
            setCreating(true);
        }
    }, [applySuite, runController]);

    useEffect(() => {
        let cancelled = false;
        loadAll().catch((loadError) => !cancelled && setError(loadError?.message || "Could not load experiment suites."))
            .finally(() => !cancelled && setLoading(false));
        return () => { cancelled = true; };
    }, [loadAll]);

    useEffect(() => runController.subscribe((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        if (!nextSnapshot.result) return;
        const result = normalizeExperimentResult(nextSnapshot.result);
        if (result.suiteId === selectedId) setSelectedResult(result);
        const summary = summaryFromResult(result);
        setResults((current) => {
            const exists = current.some((entry) => entry.id === summary.id);
            return exists
                ? current.map((entry) => entry.id === summary.id ? { ...entry, ...summary } : entry)
                : [summary, ...current];
        });
    }), [runController, selectedId]);

    const changeDiagnostics = useCallback((enabled) => {
        const next = Boolean(enabled);
        setDiagnosticsEnabled(next);
        runSession.setScenarioDiagnosticsEnabled(next);
        if (!next) onDiagnosticsViewportChange?.(null);
    }, [onDiagnosticsViewportChange, runSession]);

    useEffect(() => () => {
        runSession.setScenarioDiagnosticsEnabled(false);
        onDiagnosticsViewportChange?.(null);
    }, [onDiagnosticsViewportChange, runSession]);

    const update = useCallback((path, value) => {
        setDraft((current) => updatePath(current, path, value));
        setValidation(null);
        setFeedback(null);
        setError(null);
    }, []);

    const save = useCallback(async () => {
        if (!draft || !selectedId) return;
        setBusy(true);
        setError(null);
        try {
            const stored = await saveExperimentSuite(selectedId, normalizeExperimentSuite(draft), saved?.revision);
            applySuite(stored);
            setSuites((current) => current.map((entry) => entry.id === selectedId ? summaryFromSuite(suiteDocument(stored)) : entry));
            setFeedback("Suite saved");
            return suiteDocument(stored);
        } catch (saveError) {
            setError(saveError?.message || "Could not save the suite.");
            throw saveError;
        } finally {
            setBusy(false);
        }
    }, [applySuite, draft, saved?.revision, selectedId]);

    const discard = useCallback(() => saved && setDraft(normalizeExperimentSuite(saved)), [saved]);
    useWorkspaceGuard("experiment-suite", { dirty, save, discard, label: draft?.name || "Experiment suite" });

    const selectSuite = async (id) => {
        if (id === selectedId) return;
        if (dirty) { setError("Save or discard the current suite before opening another one."); return; }
        setBusy(true);
        try { applySuite(await getExperimentSuite(id)); }
        catch (loadError) { setError(loadError?.message || "Could not open the suite."); }
        finally { setBusy(false); }
    };

    const createSuite = async ({ name, description }) => {
        setBusy(true);
        setError(null);
        try {
            const suite = createDefaultExperimentSuite({ id: slug(name), name, description });
            const stored = await createExperimentSuite(suite);
            const document = suiteDocument(stored);
            setSuites((current) => [...current, summaryFromSuite(document)]);
            applySuite(stored);
        } catch (createError) { setError(createError?.message || "Could not create the suite."); }
        finally { setBusy(false); }
    };

    const selectedScenarios = useMemo(() => scenarioDocuments.filter((entry) => draft?.scenarioIds?.includes(entry.id)), [draft?.scenarioIds, scenarioDocuments]);
    const selectedManifests = useMemo(() => manifestDocuments.filter((entry) => draft?.manifestIds?.includes(entry.id)), [draft?.manifestIds, manifestDocuments]);
    const parameters = useMemo(() => {
        const declarations = [...selectedScenarios, ...selectedManifests].flatMap((document) => document.parameters || document.experimentParameters || []);
        const unique = new Map();
        declarations.map(normalizeParameterDeclaration).forEach((entry) => entry.id && !unique.has(entry.id) && unique.set(entry.id, entry));
        return [...unique.values()];
    }, [selectedManifests, selectedScenarios]);

    const plan = useMemo(() => draft ? planExperimentCases(draft, { scenarios: scenarioDocuments, manifests: manifestDocuments }) : { ok: false, cases: [], excluded: [], incompatible: [], issues: [] }, [draft, manifestDocuments, scenarioDocuments]);

    const validate = async () => {
        if (!draft) return;
        setBusy(true);
        try {
            const local = validateExperimentSuite(draft, { scenarios: scenarioDocuments, manifests: manifestDocuments });
            const serverResponse = await validateExperimentSuiteOnServer(selectedId, draft);
            const result = serverResponse?.validation || (typeof serverResponse?.ok === "boolean" ? serverResponse : local);
            setValidation(result);
            setFeedback(result.ok ? `${plan.cases.length} cases ready` : `${result.issues?.length || 0} validation issues`);
            if (!result.ok) setTab(result.issues?.some((issue) => issue.path === "matrix") ? "matrix" : "setup");
        } catch (validationError) { setError(validationError?.message || "Suite validation failed."); }
        finally { setBusy(false); }
    };

    const toggleExclusion = (scenarioId, manifestId) => {
        const exists = draft.exclusions.some((entry) => entry.scenarioId === scenarioId && entry.manifestId === manifestId);
        update(["exclusions"], exists ? draft.exclusions.filter((entry) => entry.scenarioId !== scenarioId || entry.manifestId !== manifestId) : [...draft.exclusions, { scenarioId, manifestId, reason: "Excluded in matrix" }]);
    };

    const chooseResult = async (id) => {
        if (!id) { setSelectedResult(null); return; }
        setBusy(true);
        try {
            const activeSnapshot = runController.getSnapshot();
            if (["running", "paused"].includes(activeSnapshot.status)
                && activeSnapshot.result?.id && activeSnapshot.result.id !== id) {
                throw new Error("Pause or finish the active experiment before opening another result.");
            }
            const result = normalizeExperimentResult(resultDocument(await getExperimentResult(id)));
            if (result.suiteId !== selectedId) {
                throw new Error(`Result "${result.id}" belongs to suite "${result.suiteId}", not "${selectedId}".`);
            }
            if (activeSnapshot.result?.id === id && ["running", "paused"].includes(activeSnapshot.status)) {
                setSelectedResult(result);
            } else {
                await runController.load(result, {
                    suite: {
                        ...normalizeExperimentSuite(draft),
                        revision: saved?.revision ?? null,
                        definitionHash: saved?.definitionHash ?? null,
                    },
                    persist: true,
                });
            }
        }
        catch (resultError) { setError(resultError?.message || "Could not load the experiment result."); }
        finally { setBusy(false); }
    };

    const chooseBaseline = async (id) => {
        if (!id) { setSelectedBaseline(null); return; }
        setBusy(true);
        try { setSelectedBaseline(normalizeExperimentBaseline(baselineDocument(await getExperimentBaseline(id)))); }
        catch (baselineError) { setError(baselineError?.message || "Could not load the baseline."); }
        finally { setBusy(false); }
    };

    const startRun = async () => {
        if (!draft || !plan.ok) return;
        setBusy(true);
        setError(null);
        try {
            const storedSuite = dirty ? await save() : saved;
            const executableSuite = {
                ...normalizeExperimentSuite(draft),
                revision: storedSuite?.revision ?? saved?.revision ?? null,
                definitionHash: storedSuite?.definitionHash ?? saved?.definitionHash ?? null,
            };
            const serverResponse = await validateExperimentSuiteOnServer(selectedId, executableSuite);
            const serverValidation = serverResponse?.validation || serverResponse;
            if (serverValidation?.ok === false) {
                setValidation(serverValidation);
                throw new Error(serverValidation.issues?.[0]?.message || "The suite is not valid for execution.");
            }
            const executableCases = serverValidation?.matrix?.cases || plan.cases;
            if (executableCases.length === 0) throw new Error("The suite has no compatible cases to run.");
            const resultId = `${draft.id}-result-${Date.now().toString(36)}`;
            await runController.start({ suite: executableSuite, cases: executableCases, resultId });
            setFeedback(`Running ${executableCases.length} cases sequentially`);
        } catch (runError) { setError(runError?.message || "Could not start the experiment."); }
        finally { setBusy(false); }
    };

    const pauseRun = async () => {
        setError(null);
        try { await runController.pause(); }
        catch (runError) { setError(runError?.message || "Could not pause the experiment."); }
    };

    const resumeRun = async () => {
        setError(null);
        try {
            const activeResult = runController.getSnapshot().result;
            if (activeResult?.suiteId && activeResult.suiteId !== selectedId) {
                throw new Error(`Result "${activeResult.id}" belongs to suite "${activeResult.suiteId}", not "${selectedId}".`);
            }
            const storedSuite = dirty ? await save() : saved;
            await runController.resume({
                suite: {
                    ...normalizeExperimentSuite(draft),
                    revision: storedSuite?.revision ?? saved?.revision ?? null,
                    definitionHash: storedSuite?.definitionHash ?? saved?.definitionHash ?? null,
                },
            });
        } catch (runError) { setError(runError?.message || "Could not resume the experiment."); }
    };

    const cancelRun = async () => {
        setError(null);
        try { await runController.cancel(); }
        catch (runError) { setError(runError?.message || "Could not cancel the experiment."); }
    };

    const saveBaseline = async (name) => {
        if (!selectedResult) return;
        setBusy(true);
        try {
            const baseline = createExperimentBaseline(selectedResult, { name, suite: draft, provenance: { appVersion: "0.1.0" } });
            const stored = normalizeExperimentBaseline(baselineDocument(await persistBaseline(baseline)));
            setSelectedBaseline(stored);
            setBaselines((current) => [...current, { id: stored.id, name: stored.name, suiteId: stored.suiteId, createdAt: stored.createdAt }]);
            setFeedback("Immutable baseline saved");
        } catch (baselineError) { setError(baselineError?.message || "Could not save the baseline."); }
        finally { setBusy(false); }
    };

    const comparison = useMemo(() => selectedResult && selectedBaseline ? compareExperimentToBaseline(selectedResult, selectedBaseline, { metricDefinitions: draft?.metrics }) : null, [draft?.metrics, selectedBaseline, selectedResult]);
    const suiteResults = useMemo(() => results.filter((entry) => entry.suiteId === selectedId), [results, selectedId]);

    const duplicate = async () => {
        if (!selectedId || dirty) { if (dirty) setError("Save the suite before duplicating it."); return; }
        setBusy(true);
        try {
            const stored = await duplicateExperimentSuite(selectedId, {
                id: slug(`${selectedId}-copy-${suites.length + 1}`),
                name: `${draft.name} Copy`,
            });
            await loadAll(suiteDocument(stored).id);
        }
        catch (duplicateError) { setError(duplicateError?.message || "Could not duplicate the suite."); }
        finally { setBusy(false); }
    };

    const actions = draft ? <><span className={styles.caseCount}>{plan.cases.length} cases</span>{feedback && <span className={styles.headerFeedback}>{feedback}</span>}{dirty && <span className={styles.dirty}>Unsaved</span>}<Button size="compact" onClick={duplicate} disabled={dirty || busy}><IconCopy size={14} /> Duplicate</Button><Button size="compact" onClick={validate} loading={busy}><IconShieldCheck size={14} /> Validate</Button><Button size="compact" variant="primary" disabled={!dirty} loading={busy} onClick={() => save().catch(() => {})}><IconDeviceFloppy size={14} /> Save</Button></> : null;

    return (
        <WorkspaceFrame title="Experiment Suite" subtitle={draft?.name} onOpenWorkspace={onOpenWorkspace} actions={actions} className={styles.workspace} contentClassName={styles.workspaceContent} sidebar={<ExperimentCatalog suites={suites} selectedId={selectedId} onSelect={selectSuite} onCreate={() => { if (dirty) setError("Save or discard the current suite before creating another one."); else { setCreating(true); setDraft(null); setSaved(null); setSelectedId(null); } }} />}>
            {loading ? <AsyncState status="loading" title="Loading experiment library" detail="Reading" className={styles.centerState} /> : creating ? <CreateSuite busy={busy} onCreate={createSuite} /> : !draft ? <AsyncState status={error ? "error" : "empty"} title={error ? "Experiment Suite unavailable" : "No suite selected"} detail={error || "Select or create an experiment suite."} className={styles.centerState} /> : (
                <div className={styles.editor}>
                    {(error || validation) && <div className={styles.notice}>{error && <StatusMessage tone="danger" title="Experiment action failed">{error}{dirty && <button type="button" onClick={discard}>Discard current changes</button>}</StatusMessage>}{validation?.ok && <StatusMessage tone="success" title="Suite is valid">{plan.cases.length} deterministic cases are ready.</StatusMessage>}{validation && !validation.ok && <StatusMessage tone="danger" title="Suite needs attention">{validation.issues?.[0]?.message || "Review setup and matrix issues."}</StatusMessage>}</div>}
                    <TabsRoot className={styles.tabs} value={tab} onValueChange={setTab}>
                        <div className={styles.tabBar}><TabsList aria-label="Experiment Suite sections">{TABS.map((entry) => <TabsTrigger key={entry.id} value={entry.id}>{entry.label}{entry.id === "matrix" && <small>{plan.cases.length}</small>}</TabsTrigger>)}</TabsList></div>
                        <div className={styles.viewport} data-experiment-scroll-viewport>
                            <TabsContent value="setup"><SetupSection suite={draft} scenarios={scenarios} manifests={manifests} parameters={parameters} onUpdate={update} /></TabsContent>
                            <TabsContent value="matrix"><MatrixSection suite={draft} plan={plan} scenarios={scenarios} manifests={manifests} onToggleExclusion={toggleExclusion} /></TabsContent>
                            <TabsContent value="metrics"><MetricsSection suite={draft} onUpdate={update} /></TabsContent>
                            <TabsContent value="run"><RunSection plan={plan} result={selectedResult} snapshot={snapshot} results={suiteResults} diagnosticsEnabled={diagnosticsEnabled} onDiagnosticsEnabledChange={changeDiagnostics} onDiagnosticsViewportChange={onDiagnosticsViewportChange} onSelectResult={chooseResult} onStart={startRun} onPause={pauseRun} onResume={resumeRun} onCancel={cancelRun} /></TabsContent>
                            <TabsContent value="compare"><CompareSection results={suiteResults} baselines={baselines.filter((entry) => entry.suiteId === selectedId)} result={selectedResult} baseline={selectedBaseline} comparison={comparison} onResult={chooseResult} onBaseline={chooseBaseline} onSaveBaseline={saveBaseline} /></TabsContent>
                            <TabsContent value="review"><ReviewSection result={selectedResult} results={suiteResults} onResult={chooseResult} onReplay={onOpenReplay} onAnalysis={onOpenAnalysis} /></TabsContent>
                        </div>
                    </TabsRoot>
                </div>
            )}
        </WorkspaceFrame>
    );
}

function CreateSuite({ onCreate, busy }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    return (
        <div className={styles.createStage}>
            <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate({ name, description }); }}>
                <div className={styles.createIcon}><IconFlask2 size={23} stroke={1.45} /></div>
                <h1>New Experiment Suite</h1>
                <Field label="Name" required>
                    <TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Controller tuning regression" />
                </Field>
                <Field label="Description">
                    <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
                </Field>
                <Button type="submit" variant="primary" disabled={!name.trim()} loading={busy}>
                    <IconPlus size={14} /> Create suite
                </Button>
            </form>
            <aside>
                <IconCheck size={17} />
                <p>Make sure that you have defined a scenario before creating a new experiment suite.</p>
            </aside>
        </div>);
}
