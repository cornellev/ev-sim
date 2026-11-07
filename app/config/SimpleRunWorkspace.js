'use client';

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";

import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    EXECUTION_PROFILE_IDS,
    EXECUTION_PROFILE_LABELS,
    classifyConfiguration,
    previewOverrideReset,
    previewProfile,
    retainComparisonProfile,
    valueAtOverridePath,
} from "./executionProfiles.js";
import {
    RESOLUTION_DOMAINS,
    createEffectiveResolver,
    summaryRows,
} from "./effectiveResolution.js";
import { applyScenarioSelectionToManifest } from "./ConfigCatalogLoader.js";
import {
    PROFILE_SURFACE_TABS,
    SIMPLE_VEHICLE_OPTIONS,
    applySimpleVehicleSelection,
    longitudinalSpeed,
    overrideEditTarget,
    pluginGrantPreview,
    scenarioSelectionState,
    sensorInheritanceStatus,
    simpleEnvironment,
    simpleVehicleTarget,
    vehicleSelectionState,
    withHeading,
    withLongitudinalSpeed,
    withPositionAxis,
} from "./simpleRunModel.js";
import { RUN_LOGGING_POLICIES, RUN_PACING_MODES } from "../simulation/RunManifest.js";
import { resolveRunManifest } from "../simulation/RunManifestClient.js";
import { resolveInheritedVehicleSelection } from "../simulation/sensors/SensorInheritance.js";
import { getScenario } from "../scenarios/ScenarioClient.js";
import { Button, DialogSurface, Field as SharedField, SegmentedControl, StatusMessage } from "../ui";
import { getBuiltInVehicleManifest } from "../vehicles/BuiltInVehicleManifests.js";
import { getVehicleManifest } from "../vehicles/VehicleManifestClient.js";

const PROFILE_ITEMS = EXECUTION_PROFILE_IDS.map((id) => ({
    value: id,
    label: EXECUTION_PROFILE_LABELS[id],
}));

const OVERRIDE_COLLAPSE_AFTER = 4;

const LOGGING_LABELS = {
    required: "Required: reject run if unavailable",
    optional: "Optional: continue degraded",
    disabled: "Disabled",
};

export default function SimpleRunWorkspace({
    draft,
    blocked = false,
    environments = [],
    environmentsReady = false,
    scenarios = [],
    scenarioCatalogState = "loading",
    scenarioCatalogError = null,
    onRetryScenarios,
    vehicleCatalog = [],
    sensorCatalog = { sensors: [] },
    sensorRegistry,
    resolutionSuspended = false,
    comparisonLatch = null,
    onComparisonLatch = null,
    children = null,
    onUpdate,
    onOpenAdvanced,
}) {
    const draftVersion = useRef(0);
    const [loaded, setLoaded] = useState({ id: null, scenario: null, error: null });
    const [storedVehicle, setStoredVehicle] = useState({ id: null, manifest: null, error: null });
    const [vehicleRequest, setVehicleRequest] = useState(0);
    const [preview, setPreview] = useState(null);
    const [grantPreview, setGrantPreview] = useState(null);
    const [resetPreview, setResetPreview] = useState(null);
    const [stampIssues, setStampIssues] = useState([]);
    const [dependencyEpoch, setDependencyEpoch] = useState(0);
    const [resolution, setResolution] = useState(null);
    const resolverRef = useRef(null);
    const epochRef = useRef(0);
    const vehicleChangeRequest = useRef(0);

    const scenarioState = scenarioSelectionState(draft, scenarios, scenarioCatalogState);
    const selectedSummary = scenarios.find((entry) => entry.id === scenarioState.selectedId) ?? null;
    const scenario = loaded.id === scenarioState.selectedId ? loaded.scenario : null;
    const loadError = loaded.id === scenarioState.selectedId ? loaded.error : null;
    const selection = resolveInheritedVehicleSelection(draft);
    const builtInManifest = useMemo(
        () => (selection.vehicleId ? getBuiltInVehicleManifest(selection.vehicleId) : null),
        [selection.vehicleId],
    );
    const vehicleManifest = builtInManifest
        || (storedVehicle.id === selection.vehicleId ? storedVehicle.manifest : null);
    const options = vehicleOptions(vehicleCatalog);
    const vehicleState = vehicleSelectionState(draft, options);
    const environment = simpleEnvironment(
        draft,
        environmentsReady ? environments : null,
        scenario,
    );
    const session = retainComparisonProfile(comparisonLatch, draft, { scenario });
    const classification = useMemo(() => classifyConfiguration(draft, {
        scenario,
        vehicleManifest,
        comparisonProfileId: session.inference.comparisonProfileId,
    }), [draft, scenario, vehicleManifest, session.inference.comparisonProfileId]);
    const activeIssues = classification.profileId
        ? previewProfile(draft, classification.profileId, { scenario }).issues
        : [];
    const sensors = sensorInheritanceStatus(draft, vehicleManifest);
    const target = simpleVehicleTarget(draft);
    const targetIndex = target
        ? draft.initialState.vehicles.findIndex((vehicle) => vehicle.id === target.id)
        : -1;
    const profileStale = Boolean(preview && (
        preview.draft !== draft || preview.scenario !== scenario || preview.epoch !== dependencyEpoch
    ));
    const profileConfirmable = Boolean(
        preview
        && !profileStale
        && preview.result.ready
        && preview.result.changes.length > 0,
    );
    const grantStale = Boolean(grantPreview && (
        grantPreview.draft !== draft || grantPreview.epoch !== dependencyEpoch
    ));
    const resetStale = Boolean(resetPreview && (
        resetPreview.draft !== draft || resetPreview.epoch !== dependencyEpoch
    ));
    const resetConfirmable = Boolean(resetPreview && !resetStale && resetPreview.result.changes.length > 0);
    const baselineHeld = Boolean(draft.scenario?.id) && !scenario;
    const baselineKey = baselineResolutionKey(draft, classification, selection, vehicleManifest, dependencyEpoch);
    const currentManifest = resolution?.draft.status === "ready" ? resolution.draft.result?.manifest ?? null : null;
    const baselineManifest = resolution?.baseline.status === "ready" ? resolution.baseline.result?.manifest ?? null : null;
    const rows = summaryRows(currentManifest, baselineManifest);
    const advancedTabs = advancedOverrideTabs(classification.overrides, {
        scenarioOwned: Boolean(draft.scenario?.id),
        actorId: selection.actorId || "ego",
    });

    useEffect(() => {
        draftVersion.current += 1;
    }, [draft]);

    useEffect(() => {
        epochRef.current = dependencyEpoch;
    }, [dependencyEpoch]);

    useEffect(() => {
        let cancelled = false;
        const selectedId = scenarioState.selectedId;
        if (!selectedId) return undefined;
        getScenario(selectedId).then((document) => {
            if (!document) throw new Error(`Scenario "${selectedId}" does not exist.`);
            if (!cancelled) setLoaded({ id: selectedId, scenario: document, error: null });
        }).catch((caught) => {
            if (!cancelled) setLoaded({ id: selectedId, scenario: null, error: caught.message });
        });
        return () => { cancelled = true; };
    }, [scenarioState.selectedId, selectedSummary?.definitionHash]);

    useEffect(() => {
        if (!selection.vehicleId || builtInManifest) return undefined;
        let cancelled = false;
        getVehicleManifest(selection.vehicleId).then((document) => {
            if (cancelled) return;
            if (!document) throw new Error(`Vehicle "${selection.vehicleId}" does not exist.`);
            setStoredVehicle({ id: selection.vehicleId, manifest: document, error: null });
        }).catch((caught) => {
            if (!cancelled) setStoredVehicle({ id: selection.vehicleId, manifest: null, error: caught.message });
        });
        return () => { cancelled = true; };
    }, [builtInManifest, selection.vehicleId, vehicleRequest]);

    useEffect(() => subscribeStorageEvents((event) => {
        if (event.domain === "vehicle" && (!event.id || event.id === selection.vehicleId)) {
            setVehicleRequest((value) => value + 1);
        }
    }), [selection.vehicleId]);

    useEffect(() => subscribeStorageEvents((event) => {
        if (RESOLUTION_DOMAINS.has(event.domain)) setDependencyEpoch((value) => value + 1);
    }), []);

    useEffect(() => {
        onComparisonLatch?.(session.retained);
    }, [onComparisonLatch, session.retained]);

    useEffect(() => {
        const resolver = createEffectiveResolver({
            resolve: (manifest) => resolveRunManifest(manifest.id, manifest),
        });
        resolverRef.current = resolver;
        const unsubscribe = resolver.subscribe(setResolution);
        return () => {
            unsubscribe();
            resolver.dispose();
            resolverRef.current = null;
        };
    }, []);

    useEffect(() => {
        const resolver = resolverRef.current;
        if (!resolver) return;
        if (resolutionSuspended || !draft?.id) {
            resolver.submit({ lane: "draft", key: "suspended", body: null, suspended: true });
            return;
        }
        resolver.submit({
            lane: "draft",
            key: `${dependencyEpoch}:${draft.id}`,
            body: draft,
        });
    }, [dependencyEpoch, draft, resolutionSuspended]);

    useEffect(() => {
        const resolver = resolverRef.current;
        if (!resolver) return;
        if (resolutionSuspended || baselineHeld) {
            resolver.submit({ lane: "baseline", key: "suspended", body: null, suspended: true });
            return;
        }
        resolver.submit({
            lane: "baseline",
            key: baselineKey,
            body: classification.baseline,
        });
    }, [baselineHeld, baselineKey, classification.baseline, resolutionSuspended]);

    const replaceVehicle = (nextVehicle) => {
        if (targetIndex < 0) return;
        onUpdate(["initialState", "vehicles", targetIndex], nextVehicle);
    };

    const requestProfile = (profileId) => {
        if (blocked) return;
        const result = previewProfile(draft, profileId, { scenario });
        if (result.changes.length === 0 && result.issues.length === 0) return;
        setPreview({ draft, scenario, epoch: dependencyEpoch, result });
    };

    const editOverride = (change) => {
        const target = overrideEditTarget(change.path, {
            scenarioOwned: Boolean(draft.scenario?.id),
            actorId: selection.actorId || "ego",
        });
        if (target.surface === "simple") {
            document.getElementById(`simple-field-${target.field}`)?.focus();
            return;
        }
        onOpenAdvanced?.(target.tab);
    };

    const requestReset = (change) => {
        if (blocked) return;
        try {
            const result = previewOverrideReset(draft, change, { sensorRegistry });
            setResetPreview({ draft, epoch: dependencyEpoch, result });
        } catch (caught) {
            setResetPreview({
                draft,
                epoch: dependencyEpoch,
                result: { nextManifest: draft, changes: [], error: caught.message },
            });
        }
    };

    const changeVehicle = async (vehicleId) => {
        if (blocked || !vehicleId || vehicleId === vehicleState.selectedId) return;
        const request = ++vehicleChangeRequest.current;
        const source = draft;
        const version = draftVersion.current;
        const epoch = epochRef.current;
        let manifest = getBuiltInVehicleManifest(vehicleId);
        if (!manifest) {
            try {
                manifest = await getVehicleManifest(vehicleId);
            } catch {
                manifest = null;
            }
        }
        if (request !== vehicleChangeRequest.current || draftVersion.current !== version) return;
        const selected = applySimpleVehicleSelection(source, vehicleId, manifest);
        const grant = pluginGrantPreview(selected.manifest, sensorCatalog, sensorRegistry);
        const issues = [...selected.issues, ...grant.issues];
        if (grant.required) {
            setGrantPreview({ draft: source, epoch, stamped: grant.manifest, issues });
            setStampIssues([]);
            return;
        }
        setStampIssues(grant.issues);
        onUpdate([], selected.manifest);
    };

    const overrideList = classification.overrides.length === 0 ? null : (
        <ul className="mt-3 space-y-3">
            {classification.overrides.map((change) => (
                <li key={change.path} className="text-[13px]">
                    <p className="break-all font-mono text-[12px]">{change.path}</p>
                    <p className="mt-1 break-all font-mono text-[12px]">
                        {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                    </p>
                    <p className="mt-1 text-[12px] text-[var(--slate-muted)]">
                        Effective {formatResolved(resolution?.baseline, change.path)} → {formatResolved(resolution?.draft, change.path)}
                    </p>
                    <div className="mt-1 flex gap-3">
                        <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--slate-fg-2)]"
                            onClick={() => editOverride(change)}
                        >
                            Edit
                        </button>
                        <button
                            type="button"
                            className="text-[12px] font-medium text-[var(--slate-fg-2)] disabled:opacity-40"
                            disabled={blocked}
                            onClick={() => requestReset(change)}
                        >
                            Reset
                        </button>
                    </div>
                </li>
            ))}
        </ul>
    );

    return (
        <div className="mx-auto max-w-3xl space-y-4 p-6 max-[900px]:p-4">
            {children}
            <section className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)] p-4">
                <Field label="Name">
                    <input
                        id="simple-field-name"
                        value={draft.name}
                        disabled={blocked}
                        onChange={(event) => onUpdate(["name"], event.target.value)}
                    />
                </Field>
            </section>

            <Section title="Scenario">
                <div className="grid gap-4 md:grid-cols-2">
                    <Field label="Scenario">
                        <select
                            id="simple-field-scenario"
                            value={scenarioState.selectedId}
                            disabled={blocked}
                            onChange={(event) => {
                                const summary = scenarios.find((entry) => entry.id === event.target.value) ?? null;
                                onUpdate([], applyScenarioSelectionToManifest(draft, summary));
                            }}
                        >
                            <option value="">No scenario (manifest-only run)</option>
                            {scenarioState.preserveSelected && (
                                <option value={scenarioState.selectedId}>
                                    {scenarioState.selectedId} ({scenarioCatalogState === "loading" ? "loading" : "missing"})
                                </option>
                            )}
                            {scenarios.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                        </select>
                    </Field>
                    {environment.editable && (
                        <Field label="Environment">
                            <select
                                id="simple-field-environment"
                                value={environment.id}
                                disabled={blocked}
                                onChange={(event) => onUpdate(["environment", "id"], event.target.value)}
                            >
                                {environment.missing && <option value={environment.id}>{environment.id} (missing)</option>}
                                {environments.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                            </select>
                        </Field>
                    )}
                </div>
                {!environment.editable && (
                    <p className="mt-3 text-[13px] text-[var(--slate-fg-2)]">
                        Environment {environment.name || "not set"} is supplied by the scenario.
                    </p>
                )}
                {scenarioCatalogState === "loading" && <StatusMessage className="mt-3" tone="info" title="Refreshing scenario catalog" />}
                {scenarioCatalogError && (
                    <StatusMessage className="mt-3" tone="warning" title="Scenario catalog is unavailable">
                        <div className="flex items-center justify-between gap-3">
                            <span>{scenarioCatalogError}</span>
                            {onRetryScenarios && <Button size="compact" onClick={onRetryScenarios}>Retry</Button>}
                        </div>
                    </StatusMessage>
                )}
                {scenarioState.missing && (
                    <StatusMessage className="mt-3" tone="danger" title="Selected scenario is missing">
                        The manifest still preserves the reference to “{scenarioState.selectedId}”. Choose another scenario or restore this one.
                    </StatusMessage>
                )}
                {environment.missing && (
                    <StatusMessage className="mt-3" tone="danger" title="Environment is missing">
                        The reference to “{environment.id}” is still on this run.
                    </StatusMessage>
                )}
                {environment.stale && (
                    <StatusMessage className="mt-3" tone="warning" title="Environment revision changed">
                        The locked environment hash differs from the catalog. The lock stays in place.
                    </StatusMessage>
                )}
                {loadError && <StatusMessage className="mt-3" tone="danger" title="Could not load scenario">{loadError}</StatusMessage>}
            </Section>

            <Section title="Vehicle">
                <Field label={draft.scenario ? "Ego vehicle" : "Vehicle"}>
                    <select
                        id="simple-field-vehicle"
                        aria-invalid={vehicleState.missing || undefined}
                        value={vehicleState.selectedId}
                        disabled={blocked}
                        onChange={(event) => { changeVehicle(event.target.value).catch(() => {}); }}
                    >
                        <option value="">Select a vehicle</option>
                        {vehicleState.missing && <option value={vehicleState.selectedId}>{vehicleState.selectedId} (missing)</option>}
                        {options.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                    </select>
                </Field>
                {(draft.initialState?.vehicles?.length ?? 0) > 1 && (
                    <p className="mt-3 text-[12px] text-[var(--slate-muted)]">Other actors stay in Advanced.</p>
                )}
                <p className="mt-3 text-[12px] text-[var(--slate-muted)]">
                    {sensors.inheriting
                        ? `Inheriting ${sensors.inherited} sensor${sensors.inherited === 1 ? "" : "s"} from the vehicle. ${sensors.extras} extra.`
                        : "Sensors are not inherited from the vehicle."}
                </p>
                {vehicleState.missing && (
                    <StatusMessage className="mt-3" tone="danger" title="Vehicle is missing">
                        The saved vehicle “{vehicleState.selectedId}” is preserved. Select an available vehicle before running.
                    </StatusMessage>
                )}
            </Section>

            <Section title="Execution">
                <SegmentedControl
                    label="Execution profile"
                    value={classification.profileId || ""}
                    items={PROFILE_ITEMS}
                    disabled={blocked}
                    onValueChange={requestProfile}
                />
                {classification.label === EXECUTION_PROFILE_LABELS.custom && (
                    <p className="mt-3 text-[12px] text-[var(--slate-muted)]">
                        Custom, compared with {classification.baselineName}
                    </p>
                )}
                <p className="mt-3 text-[13px] text-[var(--slate-fg-2)]">
                    Control source: {classification.controlSource.kind}
                    {classification.controlSource.scriptId ? ` · ${classification.controlSource.scriptId}` : ""}
                    {classification.controlSource.topicId ? ` · ${classification.controlSource.topicId}` : ""}
                </p>
                {activeIssues.length > 0 && (
                    <ul className="mt-3 space-y-2 text-[13px]">
                        {activeIssues.map((issue) => {
                            const tab = PROFILE_SURFACE_TABS[issue.surface];
                            return (
                                <li key={`${issue.code}:${issue.path}`}>
                                    <p>{issue.message}</p>
                                    {tab && (
                                        <button type="button" className="mt-1 text-[12px] font-medium text-[var(--slate-fg-2)]" onClick={() => onOpenAdvanced?.(tab)}>
                                            Edit in {tab}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <Field label="Pacing">
                        <select
                            id="simple-field-pacing"
                            value={draft.clock.pacing}
                            disabled={blocked}
                            onChange={(event) => onUpdate(["clock", "pacing"], event.target.value)}
                        >
                            {RUN_PACING_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                        </select>
                    </Field>
                    <Field label="Speed">
                        <input
                            id="simple-field-speed"
                            type="number"
                            min="0"
                            step="0.1"
                            value={draft.clock.speed}
                            disabled={blocked}
                            onChange={(event) => onUpdate(["clock", "speed"], Number(event.target.value))}
                        />
                    </Field>
                    <Field label="Recording policy">
                        <select
                            id="simple-field-recording"
                            value={draft.logging.policy}
                            disabled={blocked}
                            onChange={(event) => onUpdate(["logging", "policy"], event.target.value)}
                        >
                            {RUN_LOGGING_POLICIES.map((policy) => (
                                <option key={policy} value={policy}>{LOGGING_LABELS[policy] || policy}</option>
                            ))}
                        </select>
                    </Field>
                </div>
            </Section>

            <Section title="Initial state">
                {draft.scenario ? (
                    <p className="text-[13px] text-[var(--slate-fg-2)]">Initial state is supplied by the scenario.</p>
                ) : target && (
                    <div className="grid gap-4 md:grid-cols-3">
                        {["x", "y", "z"].map((axis) => (
                            <Field key={axis} label={`Position ${axis} (m)`}>
                                <input
                                    id={`simple-field-position-${axis}`}
                                    type="number"
                                    step="any"
                                    value={target.pose.position[axis]}
                                    disabled={blocked}
                                    onChange={(event) => replaceVehicle(withPositionAxis(target, axis, Number(event.target.value)))}
                                />
                            </Field>
                        ))}
                        <Field label="Heading (rad)">
                            <input
                                id="simple-field-heading"
                                type="number"
                                step="any"
                                value={target.pose.rotation.y}
                                disabled={blocked}
                                onChange={(event) => replaceVehicle(withHeading(target, Number(event.target.value)))}
                            />
                        </Field>
                        <Field label="Longitudinal speed (m/s)">
                            <input
                                id="simple-field-longitudinal-speed"
                                type="number"
                                step="any"
                                value={longitudinalSpeed(target)}
                                disabled={blocked}
                                onChange={(event) => replaceVehicle(withLongitudinalSpeed(target, Number(event.target.value)))}
                            />
                        </Field>
                    </div>
                )}
            </Section>

            <Section title="Sensors">
                <p className="text-[13px] text-[var(--slate-fg-2)]">
                    {sensors.counts.length === 0
                        ? "No sensors on this run."
                        : sensors.counts.map((entry) => `${entry.count} ${entry.type}`).join(", ")}
                </p>
                {[...sensors.issues, ...stampIssues].length > 0 && (
                    <ul className="mt-3 space-y-1 text-[12px] text-[var(--slate-warning)]">
                        {[...sensors.issues, ...stampIssues].map((issue) => (
                            <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
                        ))}
                    </ul>
                )}
                <div className="mt-3">
                    <Button size="compact" onClick={() => onOpenAdvanced?.("Sensors")}>Customize</Button>
                </div>
            </Section>

            <Section title="Effective summary">
                <ResolutionStatus lane={resolution?.draft} noun="Effective configuration" />
                {resolution?.draft.status === "ready" && (
                    <>
                        {resolution.baseline.status !== "ready" && (
                            <ResolutionStatus className="mt-3" lane={resolution.baseline} noun="Comparison baseline" />
                        )}
                        <dl className="mt-3 grid gap-3 text-[13px]">
                            {rows.map((row) => (
                                <div key={row.id} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3">
                                    <dt className="text-[var(--slate-muted)]">{row.label}</dt>
                                    <dd>
                                        <span>{displaySummary(row.current)}</span>
                                        <span className="mt-1 block text-[12px] text-[var(--slate-muted)]">
                                            Baseline: {baselineSummary(resolution.baseline, row.baseline)}
                                        </span>
                                        {row.id === "sensors" && sensors.inheriting && (
                                            <span className="mt-1 block text-[12px] text-[var(--slate-muted)]">
                                                Inherited mounts: {sensors.inherited}. Extras: {sensors.extras}.
                                            </span>
                                        )}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </>
                )}
                {classification.baselineIssues.length > 0 && (
                    <ul className="mt-3 space-y-1 text-[12px] text-[var(--slate-warning)]">
                        {classification.baselineIssues.map((issue) => (
                            <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title="Custom settings">
                <p className="text-[13px] text-[var(--slate-fg-2)]">
                    {classification.label === EXECUTION_PROFILE_LABELS.custom
                        ? `Compared with ${classification.baselineName}`
                        : classification.label}
                </p>
                {advancedTabs.length > 0 && (
                    <div className="mt-3">
                        <p className="text-[13px] font-medium">Custom advanced settings active</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {advancedTabs.map((tab) => (
                                <Button key={tab} size="compact" onClick={() => onOpenAdvanced?.(tab)}>
                                    {tab}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}
                {classification.overrides.length === 0 ? (
                    <p className="mt-3 text-[12px] text-[var(--slate-muted)]">
                        No differences from {classification.baselineName}.
                    </p>
                ) : classification.overrides.length > OVERRIDE_COLLAPSE_AFTER ? (
                    <details className="mt-3">
                        <summary className="cursor-pointer text-[12px] font-medium text-[var(--slate-fg-2)]">
                            {classification.overrides.length} differences
                        </summary>
                        {overrideList}
                    </details>
                ) : overrideList}
            </Section>

            <DialogSurface
                open={Boolean(preview)}
                onOpenChange={(open) => { if (!open) setPreview(null); }}
                title={preview ? EXECUTION_PROFILE_LABELS[preview.result.profileId] : "Execution profile"}
                description="Review the manifest fields this profile changes. Cancellation leaves the draft unchanged."
                footer={(
                    <>
                        <Button onClick={() => setPreview(null)}>Cancel</Button>
                        <Button
                            variant="primary"
                            disabled={!profileConfirmable || blocked}
                            onClick={() => {
                                if (!profileConfirmable) return;
                                const applied = preview.result.profileId;
                                if (onUpdate([], preview.result.nextManifest) === false) return;
                                onComparisonLatch?.({
                                    manifestId: draft.id,
                                    scenarioId: draft.scenario?.id ?? null,
                                    profileId: applied,
                                });
                                setPreview(null);
                            }}
                        >
                            Apply
                        </Button>
                    </>
                )}
            >
                {preview && (
                    <div className="space-y-3 text-[13px]">
                        {profileStale && (
                            <p className="text-[var(--slate-warning)]">This preview is out of date. Close it and choose the profile again.</p>
                        )}
                        {preview.result.changes.length > 0 && (
                            <ul className="space-y-1.5">
                                {preview.result.changes.map((change) => (
                                    <li key={change.path} className="font-mono text-[12px]">
                                        {change.path}: {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {preview.result.issues.length > 0 && (
                            <ul className="space-y-2">
                                {preview.result.issues.map((issue) => {
                                    const tab = PROFILE_SURFACE_TABS[issue.surface];
                                    return (
                                        <li key={`${issue.code}:${issue.path}`}>
                                            <p>{issue.message}</p>
                                            {tab && (
                                                <button
                                                    type="button"
                                                    className="mt-1 text-[12px] font-medium text-[var(--slate-fg-2)]"
                                                    onClick={() => onOpenAdvanced?.(tab)}
                                                >
                                                    Edit in {tab}
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                )}
            </DialogSurface>

            <DialogSurface
                open={Boolean(grantPreview)}
                onOpenChange={(open) => { if (!open) setGrantPreview(null); }}
                title="Grant plugin capabilities?"
                description="This vehicle change adds plugin locks. Cancellation leaves the draft unchanged."
                footer={(
                    <>
                        <Button onClick={() => setGrantPreview(null)}>Cancel</Button>
                        <Button
                            variant="primary"
                            disabled={grantStale || blocked}
                            onClick={() => {
                                if (grantStale || !grantPreview) return;
                                if (onUpdate([], grantPreview.stamped) === false) return;
                                setStampIssues(grantPreview.issues);
                                setGrantPreview(null);
                            }}
                        >
                            Grant and apply
                        </Button>
                    </>
                )}
            >
                {grantPreview && (
                    <div className="space-y-2 text-[13px]">
                        {grantStale && (
                            <p className="text-[var(--slate-warning)]">This preview is out of date. Close it and choose the vehicle again.</p>
                        )}
                        <ul className="space-y-1 font-mono text-[12px]">
                            {(grantPreview.stamped.plugins?.artifacts ?? []).map((artifact) => (
                                <li key={artifact.pluginId}>{artifact.pluginId}: {artifact.capabilities.join(", ")}</li>
                            ))}
                        </ul>
                        {grantPreview.issues.map((issue) => (
                            <p key={`${issue.path}:${issue.message}`}>{issue.message}</p>
                        ))}
                    </div>
                )}
            </DialogSurface>

            <DialogSurface
                open={Boolean(resetPreview)}
                onOpenChange={(open) => { if (!open) setResetPreview(null); }}
                title="Reset setting"
                description="Review the fields this reset changes. Cancellation leaves the draft unchanged."
                footer={(
                    <>
                        <Button onClick={() => setResetPreview(null)}>Cancel</Button>
                        <Button
                            variant="primary"
                            disabled={!resetConfirmable || blocked}
                            onClick={() => {
                                if (!resetConfirmable) return;
                                if (onUpdate([], resetPreview.result.nextManifest) === false) return;
                                setResetPreview(null);
                            }}
                        >
                            Reset
                        </Button>
                    </>
                )}
            >
                {resetPreview && (
                    <div className="space-y-3 text-[13px]">
                        {resetStale && (
                            <p className="text-[var(--slate-warning)]">This preview is out of date. Close it and choose Reset again.</p>
                        )}
                        {resetPreview.result.error && <p>{resetPreview.result.error}</p>}
                        {resetPreview.result.changes.length > 0 && (
                            <ul className="space-y-1.5">
                                {resetPreview.result.changes.map((change) => (
                                    <li key={change.path} className="break-all font-mono text-[12px]">
                                        {change.path}: {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {resetPreview.result.changes.length === 0 && !resetPreview.result.error && (
                            <p>This reset does not change the draft.</p>
                        )}
                    </div>
                )}
            </DialogSurface>
        </div>
    );
}

function baselineResolutionKey(draft, classification, selection, vehicleManifest, epoch) {
    return JSON.stringify({
        epoch,
        profileId: classification.comparisonProfileId,
        scenarioId: draft.scenario?.id ?? null,
        scenarioHash: draft.scenario?.expectedHash ?? null,
        environmentId: draft.environment?.id ?? null,
        environmentHash: draft.environment?.expectedHash ?? null,
        vehicleId: selection.vehicleId ?? null,
        actorId: selection.actorId ?? null,
        vehicleMark: vehicleManifest?.revision
            ?? vehicleManifest?.definitionHash
            ?? (vehicleManifest ? "loaded" : null),
        loggingPolicy: classification.comparisonProfileId === "external" ? (draft.logging?.policy ?? null) : null,
        controlKind: classification.controlSource?.kind ?? null,
        controlTopic: classification.controlSource?.topicId ?? null,
    });
}

function advancedOverrideTabs(overrides, options) {
    const tabs = [];
    for (const change of overrides ?? []) {
        const target = overrideEditTarget(change.path, options);
        if (target.surface === "advanced" && !tabs.includes(target.tab)) tabs.push(target.tab);
    }
    return tabs;
}

function displaySummary(value) {
    return value == null || value === "" ? "None" : String(value);
}

function laneWord(lane) {
    if (lane?.status === "checking") return "Checking";
    if (lane?.status === "failed") return "Failed";
    return "Unresolved";
}

function baselineSummary(lane, value) {
    if (lane?.status !== "ready") return laneWord(lane);
    return displaySummary(value);
}

function formatResolved(lane, path) {
    if (lane?.status !== "ready") return laneWord(lane);
    const read = valueAtOverridePath(lane.result?.manifest, path);
    return read.ok ? JSON.stringify(read.value) : "unavailable";
}

function ResolutionStatus({ lane, noun, className = "" }) {
    const status = lane?.status ?? "unresolved";
    if (status === "ready") return null;
    const title = status === "failed"
        ? `${noun} is unavailable`
        : status === "checking"
            ? `Checking ${noun.charAt(0).toLowerCase()}${noun.slice(1)}`
            : `${noun} is unresolved`;
    return (
        <StatusMessage className={className || undefined} tone={status === "failed" ? "danger" : "info"} title={title}>
            {status === "failed" ? lane?.error : null}
        </StatusMessage>
    );
}

function vehicleOptions(vehicleCatalog) {
    return [...SIMPLE_VEHICLE_OPTIONS, ...(vehicleCatalog ?? [])]
        .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index);
}

function Section({ title, children }) {
    return (
        <section className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)] p-4">
            <h2 className="mb-3 text-[13px] font-medium">{title}</h2>
            {children}
        </section>
    );
}

function Field({ label, children }) {
    const control = isValidElement(children)
        ? cloneElement(children, {
            className: ["sf-input", children.props.className].filter(Boolean).join(" "),
        })
        : children;
    return <SharedField label={label}>{control}</SharedField>;
}
