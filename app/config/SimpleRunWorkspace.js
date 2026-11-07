'use client';

import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState } from "react";

import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    EXECUTION_PROFILE_IDS,
    EXECUTION_PROFILE_LABELS,
    inferExecutionProfile,
    previewProfile,
} from "./executionProfiles.js";
import { applyScenarioSelectionToManifest } from "./ConfigCatalogLoader.js";
import {
    PROFILE_SURFACE_TABS,
    SIMPLE_VEHICLE_OPTIONS,
    applySimpleVehicleSelection,
    longitudinalSpeed,
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
import { resolveInheritedVehicleSelection } from "../simulation/sensors/SensorInheritance.js";
import { getScenario } from "../scenarios/ScenarioClient.js";
import { Button, DialogSurface, Field as SharedField, SegmentedControl, StatusMessage } from "../ui";
import { getBuiltInVehicleManifest } from "../vehicles/BuiltInVehicleManifests.js";
import { getVehicleManifest } from "../vehicles/VehicleManifestClient.js";

const PROFILE_ITEMS = EXECUTION_PROFILE_IDS.map((id) => ({
    value: id,
    label: EXECUTION_PROFILE_LABELS[id],
}));

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
    const [stampIssues, setStampIssues] = useState([]);
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
    const inference = inferExecutionProfile(draft, { scenario });
    const activeIssues = inference.profileId
        ? previewProfile(draft, inference.profileId, { scenario }).issues
        : [];
    const sensors = sensorInheritanceStatus(draft, vehicleManifest);
    const target = simpleVehicleTarget(draft);
    const targetIndex = target
        ? draft.initialState.vehicles.findIndex((vehicle) => vehicle.id === target.id)
        : -1;
    const profileStale = Boolean(preview && (preview.draft !== draft || preview.scenario !== scenario));
    const profileConfirmable = Boolean(
        preview
        && !profileStale
        && preview.result.ready
        && preview.result.changes.length > 0,
    );
    const grantStale = Boolean(grantPreview && grantPreview.draft !== draft);

    useEffect(() => {
        draftVersion.current += 1;
    }, [draft]);

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

    const replaceVehicle = (nextVehicle) => {
        if (targetIndex < 0) return;
        onUpdate(["initialState", "vehicles", targetIndex], nextVehicle);
    };

    const requestProfile = (profileId) => {
        if (blocked) return;
        const result = previewProfile(draft, profileId, { scenario });
        if (result.changes.length === 0 && result.issues.length === 0) return;
        setPreview({ draft, scenario, result });
    };

    const changeVehicle = async (vehicleId) => {
        if (blocked || !vehicleId || vehicleId === vehicleState.selectedId) return;
        const request = ++vehicleChangeRequest.current;
        const source = draft;
        const version = draftVersion.current;
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
            setGrantPreview({ draft: source, stamped: grant.manifest, issues });
            setStampIssues([]);
            return;
        }
        setStampIssues(grant.issues);
        onUpdate([], selected.manifest);
    };

    return (
        <div className="mx-auto max-w-3xl space-y-4 p-6 max-[900px]:p-4">
            {children}
            <section className="rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-1)] p-4">
                <Field label="Name">
                    <input
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
                    value={inference.profileId || ""}
                    items={PROFILE_ITEMS}
                    disabled={blocked}
                    onValueChange={requestProfile}
                />
                {!inference.profileId && (
                    <p className="mt-3 text-[12px] text-[var(--slate-muted)]">{EXECUTION_PROFILE_LABELS.custom}</p>
                )}
                <p className="mt-3 text-[13px] text-[var(--slate-fg-2)]">
                    Control source: {inference.controlSource.kind}
                    {inference.controlSource.scriptId ? ` · ${inference.controlSource.scriptId}` : ""}
                    {inference.controlSource.topicId ? ` · ${inference.controlSource.topicId}` : ""}
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
                            value={draft.clock.pacing}
                            disabled={blocked}
                            onChange={(event) => onUpdate(["clock", "pacing"], event.target.value)}
                        >
                            {RUN_PACING_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                        </select>
                    </Field>
                    <Field label="Speed">
                        <input
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
                                type="number"
                                step="any"
                                value={target.pose.rotation.y}
                                disabled={blocked}
                                onChange={(event) => replaceVehicle(withHeading(target, Number(event.target.value)))}
                            />
                        </Field>
                        <Field label="Longitudinal speed (m/s)">
                            <input
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
                                if (onUpdate([], preview.result.nextManifest) === false) return;
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
        </div>
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
