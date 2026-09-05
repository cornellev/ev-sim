'use client';

import { useEffect, useRef, useState } from "react";
import {
    IconAlertTriangle,
    IconChartDots,
    IconCheck,
    IconCircleX,
    IconClock,
    IconDatabase,
    IconFlask2,
    IconPlayerPause,
    IconPlayerPlay,
    IconPlus,
    IconRefresh,
    IconRoute,
    IconSquare,
    IconTerminal2,
    IconTrash,
} from "@tabler/icons-react";

import { AdvancedFields, Button, DialogSurface, Field, NativeSelect, StatusMessage, Switch, Textarea, TextInput } from "../../ui";
import { BUILT_IN_METRIC_IDS, METRIC_DIRECTIONS, METRIC_REDUCER_KINDS, builtInMetricDefaults } from "../MetricReducers.js";
import styles from "./ExperimentWorkspace.module.css";

const RUN_SPEEDS = [1, 2, 4];

function heading(kicker, title, description, action = null) {
    return <header className={styles.sectionHeading}><div><span>{kicker}</span><h2>{title}</h2><p>{description}</p></div>{action}</header>;
}

function toggle(values, value) {
    return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function parseSeedList(value) {
    return String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function parseValues(value) {
    return parseSeedList(value).map((entry) => {
        if (entry === "true") return true;
        if (entry === "false") return false;
        const number = Number(entry);
        return Number.isFinite(number) ? number : entry;
    });
}

function serializeList(values = []) {
    return values.map((entry) => String(entry)).join(", ");
}

/**
 * Freeform comma-separated editors must keep the raw draft while focused.
 * Parsing into the suite model on every keystroke (then joining back) eats
 * commas, spaces, and in-progress decimals like "1.".
 */
function CommaSeparatedInput({
    values,
    parse,
    onCommit,
    ...inputProps
}) {
    const serialized = serializeList(values);
    const [draft, setDraft] = useState(null);
    const text = draft ?? serialized;

    return (
        <TextInput
            {...inputProps}
            value={text}
            onFocus={(event) => {
                setDraft(event.target.value);
                inputProps.onFocus?.(event);
            }}
            onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                onCommit(parse(next));
                inputProps.onChange?.(event);
            }}
            onBlur={(event) => {
                const parsed = parse(event.target.value);
                onCommit(parsed);
                setDraft(null);
                inputProps.onBlur?.(event);
            }}
        />
    );
}

function statusIcon(status) {
    if (["completed", "passed", "improved", "unchanged"].includes(status)) return IconCheck;
    if (["failed", "error", "regressed"].includes(status)) return IconCircleX;
    if (["running"].includes(status)) return IconRefresh;
    return IconClock;
}

function displayName(entries, id) {
    return entries.find((entry) => entry.id === id)?.name || id;
}

function displayRuntimeValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    return value.name || value.id || value.reason || JSON.stringify(value);
}

function formatJson(value) {
    if (value === null || value === undefined) return "—";
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function inspectableCase(entry, snapshot = null, isActive = false) {
    if (!entry) return null;
    if (!isActive || !snapshot?.run) return entry;
    const run = snapshot.run;
    const liveAssertions = run.assertionResults || run.simulation?.assertions || [];
    const liveOutcomes = run.simulation?.scenario?.outcomes || run.runResult?.outcomes || [];
    const liveMetrics = run.runResult?.metrics || {};
    return {
        ...entry,
        status: entry.status === "running" ? (run.status || entry.status) : entry.status,
        failureReason: entry.failureReason || run.error || run.runResult?.failureReason || null,
        terminationReason: entry.terminationReason || run.runResult?.terminationReason || null,
        terminalEvent: entry.terminalEvent || run.runResult?.terminalEvent || null,
        assertions: (entry.assertions || []).length ? entry.assertions : liveAssertions,
        outcomes: (entry.outcomes || []).length ? entry.outcomes : liveOutcomes,
        metrics: Object.keys(entry.metrics || {}).length ? entry.metrics : liveMetrics,
        dependencyHashes: Object.keys(entry.dependencyHashes || {}).length
            ? entry.dependencyHashes
            : (run.activeResolved?.dependencyHashes || {}),
        resolvedHash: entry.resolvedHash || run.activeResolved?.resolvedHash || null,
        logId: entry.logId || run.runResult?.logId || null,
        runError: run.error || null,
        degraded: Boolean(run.degraded),
    };
}

function CaseDetailDialog({ open, onOpenChange, entry, index = 0, onReplay, onAnalysis }) {
    if (!entry) return null;
    const failedAssertions = (entry.assertions || []).filter((assertion) => assertion.status === "failed");
    const failedOutcomes = (entry.outcomes || []).filter((outcome) => outcome.passed !== true);
    const title = `Case ${String(index + 1).padStart(3, "0")}`;
    const description = `${entry.scenarioId} · ${entry.manifestId} · seed ${String(entry.seed)}`;
    return (
        <DialogSurface
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            description={description}
            className={styles.caseDialog}
            footer={(
                <div className={styles.caseDialogActions}>
                    <Button size="compact" disabled={!entry.logId} onClick={() => onReplay?.(entry.logId)}><IconPlayerPlay size={13} /> Replay</Button>
                    <Button size="compact" disabled={!entry.logId} onClick={() => onAnalysis?.(entry.logId)}><IconChartDots size={13} /> Analysis</Button>
                </div>
            )}
        >
            <dl className={styles.caseDialogMeta}>
                <div><dt>Status</dt><dd data-status={entry.status}>{entry.status || "pending"}</dd></div>
                <div><dt>Passed</dt><dd>{entry.passed == null ? "—" : entry.passed ? "yes" : "no"}</dd></div>
                <div><dt>Resolved hash</dt><dd><code>{entry.resolvedHash || "—"}</code></dd></div>
                <div><dt>Log</dt><dd><code>{entry.logId || "—"}</code></dd></div>
            </dl>
            {(entry.failureReason || entry.runError || entry.degraded) && (
                <section className={styles.caseDialogBlock} data-tone="danger">
                    <h3>Failure / run error</h3>
                    <p>{entry.failureReason || entry.runError || (entry.degraded ? "Recording degraded" : "—")}</p>
                    {entry.runError && entry.failureReason && entry.runError !== entry.failureReason && <p>{entry.runError}</p>}
                </section>
            )}
            <section className={styles.caseDialogBlock}>
                <h3>Termination</h3>
                <p>{entry.terminationReason || "—"}</p>
                <pre>{formatJson(entry.terminalEvent)}</pre>
            </section>
            <div className={styles.caseDialogSplit}>
                <section className={styles.caseDialogBlock}>
                    <h3>Assertions <span>{(entry.assertions || []).length}</span></h3>
                    {(entry.assertions || []).length
                        ? (entry.assertions || []).map((assertion) => (
                            <p key={assertion.id || assertion.name} data-status={assertion.status}>
                                <strong>{assertion.name || assertion.id}</strong>
                                <span>{assertion.status}{assertion.message ? ` · ${assertion.message}` : ""}</span>
                            </p>
                        ))
                        : <em>None recorded</em>}
                    {failedAssertions.length > 0 && <small>{failedAssertions.length} failed</small>}
                </section>
                <section className={styles.caseDialogBlock}>
                    <h3>Outcomes <span>{(entry.outcomes || []).length}</span></h3>
                    {(entry.outcomes || []).length
                        ? (entry.outcomes || []).map((outcome) => (
                            <p key={outcome.id || outcome.name} data-status={outcome.status || (outcome.passed ? "passed" : "failed")}>
                                <strong>{outcome.name || outcome.id}</strong>
                                <span>{displayRuntimeValue(outcome.detail) || outcome.status || (outcome.passed ? "passed" : "failed")}</span>
                            </p>
                        ))
                        : <em>None recorded</em>}
                    {failedOutcomes.length > 0 && <small>{failedOutcomes.length} failed</small>}
                </section>
            </div>
            <section className={styles.caseDialogBlock}>
                <h3>Metrics</h3>
                {Object.keys(entry.metrics || {}).length
                    ? <dl>{Object.entries(entry.metrics || {}).map(([id, value]) => <div key={id}><dt>{id}</dt><dd>{String(value ?? "—")}</dd></div>)}</dl>
                    : <em>None recorded</em>}
            </section>
            <section className={styles.caseDialogBlock}>
                <h3>Dependency hashes</h3>
                <pre>{formatJson(entry.dependencyHashes || {})}</pre>
            </section>
        </DialogSurface>
    );
}

export function SetupSection({ suite, scenarios, manifests, parameters, onUpdate }) {
    const addSweep = () => {
        const parameter = parameters.find((entry) => !suite.sweeps.some((sweep) => sweep.parameterId === entry.id));
        if (!parameter) return;
        onUpdate(["sweeps"], [...suite.sweeps, { parameterId: parameter.id, values: [parameter.default], range: null }]);
    };
    return (
        <div className={styles.sectionStack}>
            {heading("", "Setup", "")}
            <section className={styles.detailsPanel}>
                <div className={styles.formGrid}>
                    <Field label="Suite name" required><TextInput value={suite.name} onChange={(event) => onUpdate(["name"], event.target.value)} /></Field>
                    <Field label="Stable ID"><TextInput value={suite.id} readOnly /></Field>
                    <Field label="Description" className={styles.spanTwo}><Textarea value={suite.description} onChange={(event) => onUpdate(["description"], event.target.value)} placeholder="What change or hypothesis does this suite evaluate?" /></Field>
                </div>
            </section>

            <div className={styles.selectionGrid}>
                <SelectionColumn title="Scenarios" detail="" entries={scenarios} selected={suite.scenarioIds} onToggle={(id) => onUpdate(["scenarioIds"], toggle(suite.scenarioIds, id))} icon={IconRoute} />
                <SelectionColumn title="Run manifests" detail="" entries={manifests} selected={suite.manifestIds} onToggle={(id) => onUpdate(["manifestIds"], toggle(suite.manifestIds, id))} icon={IconDatabase} />
            </div>

            <div className={styles.splitHeading}><div><h3>Seeds and sweeps</h3></div>{parameters.length > suite.sweeps.length && <Button size="compact" onClick={addSweep}><IconPlus size={14} stroke={1.75} /> Add sweep</Button>}</div>
            <section className={styles.sweepPanel}>
                <Field label="Seeds">
                    <CommaSeparatedInput
                        aria-label="Seeds"
                        values={suite.seeds}
                        parse={parseSeedList}
                        onCommit={(seeds) => onUpdate(["seeds"], seeds)}
                    />
                </Field>
                <Switch label="Continue after a failed case" description="Run every compatible case instead of stopping at the first failure." checked={suite.execution.failurePolicy !== "fail-fast"} onCheckedChange={(value) => onUpdate(["execution"], { failurePolicy: value ? "continue" : "fail-fast", continueOnFailure: value })} />
            </section>
            {suite.sweeps.map((sweep, index) => (
                <article className={styles.sweepRow} key={`${sweep.parameterId}-${index}`}>
                    <span>SWEEP {String(index + 1).padStart(2, "0")}</span>
                    <Field label="Declared parameter"><NativeSelect value={sweep.parameterId} onChange={(event) => onUpdate(["sweeps", index, "parameterId"], event.target.value)}>{parameters.map((parameter) => <option key={parameter.id} value={parameter.id}>{parameter.name || parameter.id} · {parameter.type}</option>)}</NativeSelect></Field>
                    <Field label="Values" hint="Comma-separated">
                        <CommaSeparatedInput
                            aria-label={`Sweep ${sweep.parameterId} values`}
                            values={sweep.values}
                            parse={parseValues}
                            onCommit={(values) => onUpdate(["sweeps", index], { ...sweep, values, range: null })}
                        />
                    </Field>
                    <button type="button" aria-label={`Remove sweep ${sweep.parameterId}`} onClick={() => onUpdate(["sweeps"], suite.sweeps.filter((_, candidate) => candidate !== index))}><IconTrash size={14} stroke={1.7} /></button>
                </article>
            ))}
            {parameters.length === 0 && <div className={styles.inlineEmpty}>Selected documents do not declare any sweepable parameters.</div>}
        </div>
    );
}

function SelectionColumn({ title, detail, entries, selected, onToggle, icon: Icon }) {
    return (
        <section className={styles.selectionColumn}>
            <header><Icon size={17} stroke={1.55} /><div><h3>{title}</h3><p>{detail}</p></div><span>{selected.length}/{entries.length}</span></header>
            <div>
                {entries.map((entry) => <label key={entry.id} data-selected={selected.includes(entry.id) || undefined}><input type="checkbox" checked={selected.includes(entry.id)} onChange={() => onToggle(entry.id)} /><span><strong>{entry.name || entry.id}</strong><small>{entry.description || entry.id}</small></span></label>)}
                {entries.length === 0 && <p className={styles.emptySelection}>No documents are available in this catalog.</p>}
            </div>
        </section>
    );
}

export function MatrixSection({ suite, plan, scenarios, manifests, onToggleExclusion }) {
    const pairStatus = (scenarioId, manifestId) => {
        const incompatible = plan.incompatible?.find((entry) => entry.scenarioId === scenarioId && entry.manifestId === manifestId);
        const excluded = plan.excluded?.find((entry) => entry.scenarioId === scenarioId && entry.manifestId === manifestId);
        const count = plan.cases?.filter((entry) => entry.scenarioId === scenarioId && entry.manifestId === manifestId).length || 0;
        if (incompatible) return { kind: "incompatible", label: "Incompatible", detail: incompatible.reason };
        if (excluded) return { kind: "excluded", label: "Excluded", detail: excluded.reason || "Explicitly excluded" };
        return { kind: "enabled", label: `${count} case${count === 1 ? "" : "s"}`, detail: "Included in this run" };
    };
    return (
        <div className={styles.sectionStack}>
            {heading("", "Case matrix", "", <div className={styles.matrixTotal}><strong>{plan.cases?.length || 0}</strong><span>cases&nbsp;&nbsp;&nbsp;</span></div>)}
            {suite.scenarioIds.length === 0 || suite.manifestIds.length === 0 ? <div className={styles.largeEmpty}><IconFlask2 size={24} stroke={1.45} /><strong>Select scenarios and manifests first</strong><p>Add scenarios and manifests to see the case matrix.</p></div> : (
                <div className={styles.matrixScroll}>
                    <table className={styles.matrixTable}>
                        <thead><tr><th>Scenario / manifest</th>{suite.manifestIds.map((id) => <th key={id}>{displayName(manifests, id)}</th>)}</tr></thead>
                        <tbody>{suite.scenarioIds.map((scenarioId) => <tr key={scenarioId}><th>{displayName(scenarios, scenarioId)}</th>{suite.manifestIds.map((manifestId) => { const status = pairStatus(scenarioId, manifestId); return <td key={manifestId}><button type="button" data-status={status.kind} disabled={status.kind === "incompatible"} onClick={() => onToggleExclusion(scenarioId, manifestId)} title={status.detail}><span>{status.kind === "enabled" ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}{status.label}</span><small>{status.detail}</small></button></td>; })}</tr>)}</tbody>
                    </table>
                </div>
            )}
            {plan.issues?.length > 0 && <div className={styles.issuePanel}><IconAlertTriangle size={16} /><div>{plan.issues.map((issue, index) => <p key={`${issue.path}-${index}`}><code>{issue.path}</code>{issue.message}</p>)}</div></div>}
        </div>
    );
}

export function MetricsSection({ suite, onUpdate }) {
    const [metricKind, setMetricKind] = useState("collision-count");
    const addMetric = () => {
        const builtin = BUILT_IN_METRIC_IDS.includes(metricKind);
        const defaults = builtin ? builtInMetricDefaults(metricKind) : null;
        const id = builtin ? metricKind : `custom-metric-${suite.metrics.length + 1}`;
        onUpdate(["metrics"], [...suite.metrics, {
            id,
            name: defaults?.name || (builtin ? metricKind.replaceAll("-", " ") : "Custom metric"),
            source: builtin ? { kind: "builtin", metric: metricKind } : { kind: "signal", path: "" },
            reducer: "last",
            unit: defaults?.unit || "",
            direction: defaults?.direction || "informational",
            target: null,
            tolerance: { absolute: 0, relative: 0 },
            gated: true,
        }]);
    };
    return (
        <div className={styles.sectionStack}>
            {heading("", "Metrics", "")}
            <div className={styles.metricAdd}><NativeSelect aria-label="Metric to add" value={metricKind} onChange={(event) => setMetricKind(event.target.value)}><optgroup label="Built in">{BUILT_IN_METRIC_IDS.map((id) => <option key={id} value={id}>{id.replaceAll("-", " ")}</option>)}</optgroup><option value="custom">Custom signal / event</option></NativeSelect><Button variant="primary" onClick={addMetric}><IconPlus size={14} /> Add metric</Button></div>
            <div className={styles.metricList}>{suite.metrics.map((metric, index) => (
                <article className={styles.metricCard} key={`${metric.id}-${index}`}>
                    <header><span>M{String(index + 1).padStart(2, "0")}</span><div><strong>{metric.name}</strong><small>{metric.source.kind === "builtin" ? metric.source.metric : metric.source.path || metric.source.name || "source required"}</small></div><Switch label="Gate" checked={metric.gated !== false} onCheckedChange={(value) => onUpdate(["metrics", index, "gated"], value)} /><button type="button" aria-label={`Remove ${metric.name}`} onClick={() => onUpdate(["metrics"], suite.metrics.filter((_, candidate) => candidate !== index))}><IconTrash size={14} /></button></header>
                    <div className={styles.metricFields}>
                        <Field label="Name"><TextInput value={metric.name} onChange={(event) => onUpdate(["metrics", index, "name"], event.target.value)} /></Field>
                        <Field label="Direction"><NativeSelect value={metric.direction} onChange={(event) => onUpdate(["metrics", index, "direction"], event.target.value)}>{METRIC_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction}</option>)}</NativeSelect></Field>
                        {metric.source.kind !== "builtin" && <><Field label="Source kind"><NativeSelect value={metric.source.kind} onChange={(event) => onUpdate(["metrics", index, "source"], { kind: event.target.value, path: "", name: "", category: "" })}><option value="signal">Signal</option><option value="event">Event</option></NativeSelect></Field><Field label={metric.source.kind === "signal" ? "Signal path" : "Event name"}><TextInput value={metric.source.kind === "signal" ? metric.source.path || "" : metric.source.name || ""} onChange={(event) => onUpdate(["metrics", index, "source", metric.source.kind === "signal" ? "path" : "name"], event.target.value)} /></Field></>}
                        <AdvancedFields label="Metric comparison settings">
                        {metric.source.kind !== "builtin" && <Field label="Reducer"><NativeSelect value={metric.reducer} onChange={(event) => onUpdate(["metrics", index, "reducer"], event.target.value)}>{METRIC_REDUCER_KINDS.map((reducer) => <option key={reducer}>{reducer}</option>)}</NativeSelect></Field>}
                        <Field label="Unit"><TextInput value={metric.unit || ""} onChange={(event) => onUpdate(["metrics", index, "unit"], event.target.value)} /></Field>
                        <Field label="Absolute tolerance"><TextInput type="number" min="0" step="0.001" value={metric.tolerance.absolute} onChange={(event) => onUpdate(["metrics", index, "tolerance", "absolute"], Number(event.target.value))} /></Field>
                        <Field label="Relative tolerance"><TextInput type="number" min="0" step="0.001" value={metric.tolerance.relative} onChange={(event) => onUpdate(["metrics", index, "tolerance", "relative"], Number(event.target.value))} /></Field>
                        </AdvancedFields>
                    </div>
                </article>
            ))}</div>
        </div>
    );
}

export function RunSection({
    plan,
    result,
    snapshot,
    results,
    diagnosticsEnabled,
    onDiagnosticsEnabledChange,
    onDiagnosticsViewportChange,
    onSelectResult,
    runNickname = "",
    runNicknameError = null,
    onRunNicknameChange,
    runSpeed = 1,
    disableLogging = false,
    onRunSpeedChange,
    onDisableLoggingChange,
    onStart,
    onPause,
    onResume,
    onCancel,
    onQueueHeadless,
    onReplay,
    onAnalysis,
}) {
    const diagnosticsViewportRef = useRef(null);
    const [inspectIndex, setInspectIndex] = useState(null);
    const controllerOwnsResult = Boolean(snapshot?.result?.id && snapshot.result.id === result?.id)
        && result?.execution?.backend !== "headless";
    const headlessResult = result?.execution?.backend === "headless";
    const liveResult = controllerOwnsResult ? snapshot.result : result;
    const status = controllerOwnsResult ? snapshot.status : liveResult?.status || "idle";
    const cases = liveResult?.cases || plan.cases || [];
    const complete = cases.filter((entry) => ["completed", "failed", "error", "cancelled", "interrupted"].includes(entry.status)).length;
    const active = (controllerOwnsResult ? snapshot?.currentCase : null) || cases.find((entry) => entry.status === "running");
    const progress = controllerOwnsResult && snapshot?.progress
        ? snapshot.progress.fraction * 100
        : cases.length ? (complete / cases.length) * 100 : 0;
    const simulation = controllerOwnsResult ? snapshot?.run?.simulation : null;
    const scenario = simulation?.scenario;
    const assertions = simulation?.assertions || snapshot?.run?.assertionResults || [];
    const outcomes = scenario?.outcomes || active?.outcomes || [];
    const canResume = cases.some((entry) => entry.status === "pending")
        && ["paused", "interrupted", "error"].includes(status);
    const queueActive = ["running", "paused"].includes(status);
    const effectiveSpeed = snapshot?.realtimeWarning ? 1 : runSpeed;
    const inspectEntry = inspectIndex == null
        ? null
        : inspectableCase(
            cases[inspectIndex],
            controllerOwnsResult ? snapshot : null,
            Boolean(active && cases[inspectIndex] && (cases[inspectIndex].id === active.id || cases[inspectIndex].key === active.key)),
        );

    useEffect(() => {
        const element = diagnosticsViewportRef.current;
        if (!diagnosticsEnabled || !element || !onDiagnosticsViewportChange) {
            onDiagnosticsViewportChange?.(null);
            return undefined;
        }
        let frame = 0;
        const updateViewport = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const rect = element.getBoundingClientRect();
                const scrollViewport = element.closest("[data-experiment-scroll-viewport]")?.getBoundingClientRect();
                const bounds = scrollViewport || { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
                const top = Math.max(rect.top, bounds.top);
                const left = Math.max(rect.left, bounds.left);
                const right = Math.min(rect.right, bounds.right);
                const bottom = Math.min(rect.bottom, bounds.bottom);
                if (right - left < 2 || bottom - top < 2) {
                    onDiagnosticsViewportChange(null);
                    return;
                }
                onDiagnosticsViewportChange({ top, left, width: right - left, height: bottom - top });
            });
        };
        const observer = new ResizeObserver(updateViewport);
        observer.observe(element);
        window.addEventListener("resize", updateViewport);
        window.addEventListener("scroll", updateViewport, true);
        updateViewport();
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener("resize", updateViewport);
            window.removeEventListener("scroll", updateViewport, true);
            onDiagnosticsViewportChange(null);
        };
    }, [diagnosticsEnabled, onDiagnosticsViewportChange]);

    return (
        <div className={styles.sectionStack}>
            {heading("", "Run & monitor", "", <div className={styles.runActions}><Button aria-pressed={diagnosticsEnabled} variant={diagnosticsEnabled ? "primary" : "default"} onClick={() => onDiagnosticsEnabledChange?.(!diagnosticsEnabled)} disabled={headlessResult}><IconRoute size={14} /> 3D diagnostics</Button><Button onClick={() => onQueueHeadless?.()}><IconTerminal2 size={14} /> Queue headless</Button>{status === "running" && !headlessResult ? <Button onClick={onPause}><IconPlayerPause size={14} /> Pause</Button> : canResume && !headlessResult ? <Button variant="primary" onClick={onResume}><IconPlayerPlay size={14} /> Resume</Button> : <Button variant="primary" disabled={headlessResult || !plan.ok || plan.cases.length === 0 || Boolean(runNicknameError)} onClick={onStart}><IconPlayerPlay size={14} /> Run suite</Button>}<Button disabled={headlessResult || !['running', 'paused'].includes(status)} onClick={onCancel}><IconSquare size={13} /> Cancel</Button></div>)}
            {headlessResult && <StatusMessage tone="neutral" title="Headless-owned result">This result is owned by the server headless queue. Open Headless Runs to monitor or cancel it.</StatusMessage>}
            <section className={styles.runOptions} aria-label="Run options">
                <Field
                    label="Run nickname"
                    hint={!runNickname ? "Required" : runNicknameError ? null : "Used as the experiment result ID."}
                    error={runNickname ? runNicknameError : null}
                    className={styles.runNickname}
                >
                    <TextInput
                        value={runNickname}
                        disabled={queueActive}
                        placeholder="corridor-acceptance-01"
                        onChange={(event) => onRunNicknameChange?.(event.target.value)}
                    />
                </Field>
                <div className={styles.speedGroup}>
                    <span>Speed</span>
                    <div className={styles.speedToggle} role="group" aria-label="Simulation speed">
                        {RUN_SPEEDS.map((speed) => (
                            <button
                                key={speed}
                                type="button"
                                aria-pressed={runSpeed === speed}
                                data-active={runSpeed === speed || undefined}
                                onClick={() => onRunSpeedChange?.(speed)}
                            >
                                {speed}×
                            </button>
                        ))}
                    </div>
                    {snapshot?.realtimeWarning && <small>Effective {effectiveSpeed}× while external ROS is active</small>}
                </div>
                <Switch
                    label="Disable logs for this run"
                    description="(Temporary)"
                    checked={disableLogging}
                    disabled={queueActive}
                    onCheckedChange={(value) => onDisableLoggingChange?.(Boolean(value))}
                />
            </section>
            <div className={styles.resultPicker}><Field label="Experiment result"><NativeSelect value={result?.id || ""} onChange={(event) => onSelectResult(event.target.value)}><option value="">Current / new result</option>{results.map((entry) => <option key={entry.id} value={entry.id}>{entry.id} · {entry.status}</option>)}</NativeSelect></Field><span data-status={status}>{status}</span></div>
            {controllerOwnsResult && snapshot?.realtimeWarning && <div className={styles.runtimeWarning}><IconAlertTriangle size={15} /><p>External ROS requires realtime pacing. Effective speed is {effectiveSpeed}×{runSpeed !== effectiveSpeed ? ` (selected ${runSpeed}× ignored)` : ""}. Determinism depends on the timing and contents of external commands.</p></div>}
            {diagnosticsEnabled && <section className={styles.diagnosticsPanel}><header><div><span>OPERATOR VIEW</span><h3>Scenario diagnostics</h3></div><p>Render-only layer 31 · excluded from physics, sensors, and LiDAR</p></header><div ref={diagnosticsViewportRef} className={styles.diagnosticsViewport}><span>Preparing the mounted 3D scene…</span></div></section>}
            <section className={styles.monitorPanel}>
                <div className={styles.progressHeader}><div><span>Queue progress</span><strong>{complete} / {cases.length}</strong></div><p>{Math.round(progress)}%</p></div>
                <div className={styles.progressTrack}><i style={{ transform: `scaleX(${progress / 100})` }} /></div>
                {active ? <><div className={styles.activeCase}><div><span>ACTIVE CASE</span><strong>{active.scenarioId}</strong><p>{active.manifestId} · seed {String(active.seed)}{Object.keys(active.parameters || {}).length ? ` · ${JSON.stringify(active.parameters)}` : ""}</p></div><dl><div><dt>Sim time</dt><dd>{Number(simulation?.time ?? ((scenario?.timeNs || 0) / 1e9)).toFixed(2)}s</dd></div><div><dt>Step</dt><dd>{simulation?.steps ?? scenario?.step ?? 0}</dd></div><div><dt>Latest trigger</dt><dd>{displayRuntimeValue(scenario?.latestTrigger || active.latestTrigger)}</dd></div><div><dt>Next event</dt><dd>{displayRuntimeValue(scenario?.nextTimedEvent)}</dd></div></dl></div><div className={styles.liveChecks}><section><header>Assertions <span>{assertions.length}</span></header>{assertions.length ? assertions.map((assertion) => <p key={assertion.id} data-status={assertion.status}><strong>{assertion.name || assertion.id}</strong><span>{assertion.status}</span></p>) : <em>No assertions configured</em>}</section><section><header>End-only outcomes <span>{outcomes.length}</span></header>{outcomes.length ? outcomes.map((outcome) => <p key={outcome.id} data-status={outcome.status}><strong>{outcome.name || outcome.id}</strong><span>{outcome.status}</span></p>) : <em>No expected outcomes configured</em>}</section></div></> : <div className={styles.monitorIdle}><IconFlask2 size={22} /><strong>{status === "completed" ? "Experiment complete" : "No active case"}</strong><p>{status === "completed" ? "Open Compare or Review to inspect the result." : status === "interrupted" ? "Resume the compatible pending cases when ready." : "Start the suite in order to populate."}</p></div>}
            </section>
            <div className={styles.queueList}>{cases.map((entry, index) => {
                const Icon = statusIcon(entry.status);
                return (
                    <button
                        type="button"
                        key={entry.id || entry.key || index}
                        className={styles.caseRowButton}
                        data-status={entry.status || "pending"}
                        aria-label={`Inspect case ${String(index + 1).padStart(3, "0")}: ${entry.scenarioId}`}
                        onClick={() => setInspectIndex(index)}
                    >
                        <span>{String(index + 1).padStart(3, "0")}</span>
                        <Icon size={15} stroke={1.7} />
                        <div><strong>{entry.scenarioId}</strong><p>{entry.manifestId} · seed {String(entry.seed)}{Object.keys(entry.parameters || {}).length ? ` · ${JSON.stringify(entry.parameters)}` : ""}</p></div>
                        <em>{entry.status || "pending"}</em>
                    </button>
                );
            })}</div>
            <CaseDetailDialog
                open={inspectIndex != null}
                onOpenChange={(open) => { if (!open) setInspectIndex(null); }}
                entry={inspectEntry}
                index={inspectIndex ?? 0}
                onReplay={onReplay}
                onAnalysis={onAnalysis}
            />
        </div>
    );
}

export function CompareSection({ results, baselines, result, baseline, comparison, onResult, onBaseline, onSaveBaseline }) {
    const [name, setName] = useState("Reference baseline");
    return (
        <div className={styles.sectionStack}>
            {heading("", "Compare to Baseline", "")}
            <div className={styles.compareControls}><Field label="Current result"><NativeSelect value={result?.id || ""} onChange={(event) => onResult(event.target.value)}><option value="">Select result</option>{results.map((entry) => <option key={entry.id} value={entry.id}>{entry.id} · {entry.status}</option>)}</NativeSelect></Field><Field label="Saved baseline"><NativeSelect value={baseline?.id || ""} onChange={(event) => onBaseline(event.target.value)}><option value="">Select baseline</option>{baselines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>)}</NativeSelect></Field><div className={styles.saveBaseline}><TextInput aria-label="New baseline name" value={name} onChange={(event) => setName(event.target.value)} /><Button disabled={!result || result.status !== "completed" || !name.trim()} onClick={() => onSaveBaseline(name)}><IconDatabase size={14} /> Save baseline</Button></div></div>
            {!comparison ? <div className={styles.largeEmpty}><IconChartDots size={24} /><strong>Choose a result and baseline</strong></div> : <>
                <div className={styles.comparisonSummary} data-status={comparison.status}><div><span>VERDICT</span><strong>{comparison.status}</strong></div><dl><div><dt>Matched</dt><dd>{comparison.matchedCaseCount}</dd></div><div><dt>Current only</dt><dd>{comparison.unmatchedCurrent.length}</dd></div><div><dt>Baseline only</dt><dd>{comparison.unmatchedBaseline.length}</dd></div></dl></div>
                <div className={styles.comparisonList}>{comparison.cases.map((entry) => <article key={entry.key} data-status={entry.classification}><header><div><strong>{entry.scenarioId}</strong><p>{entry.manifestId} · seed {String(entry.seed)}{entry.dependencyChanged ? " · dependencies changed" : ""}</p></div><span>{entry.classification}</span></header><table><thead><tr><th>Metric</th><th>Current</th><th>Baseline</th><th>Delta</th><th>Classification</th></tr></thead><tbody>{entry.metrics.map((metric) => <tr key={metric.id}><th>{metric.name}</th><td>{String(metric.current ?? "—")}</td><td>{String(metric.baseline ?? "—")}</td><td>{metric.delta === null ? "—" : `${metric.delta > 0 ? "+" : ""}${metric.delta.toFixed(4)}`}</td><td data-status={metric.classification}>{metric.classification}</td></tr>)}</tbody></table><details className={styles.dependencyDiff}><summary>Dependency hashes</summary><div><section><span>Current</span><pre>{JSON.stringify(entry.currentDependencyHashes, null, 2)}</pre></section><section><span>Baseline</span><pre>{JSON.stringify(entry.baselineDependencyHashes, null, 2)}</pre></section></div></details></article>)}</div>
                {(comparison.unmatchedCurrent.length > 0 || comparison.unmatchedBaseline.length > 0) && <section className={styles.unmatchedCases}><header><IconAlertTriangle size={15} /><div><strong>Comparison is incomplete</strong><p>Unmatched cases cannot be classified as improvements or regressions.</p></div></header><div>{comparison.unmatchedCurrent.map((entry) => <p key={`current-${entry.key}`}><span>Current only</span>{entry.scenarioId} · {entry.manifestId} · seed {String(entry.seed)}</p>)}{comparison.unmatchedBaseline.map((entry) => <p key={`baseline-${entry.key}`}><span>Baseline only</span>{entry.scenarioId} · {entry.manifestId} · seed {String(entry.seed)}</p>)}</div></section>}
            </>}
        </div>
    );
}

export function ReviewSection({ result, results, onResult, onReplay, onAnalysis, initialCaseId = null, onInitialCaseConsumed }) {
    const [inspectIndex, setInspectIndex] = useState(null);
    const consumedInitialCase = useRef(false);
    useEffect(() => {
        if (consumedInitialCase.current || !initialCaseId || !result?.cases?.length) return;
        const index = result.cases.findIndex((entry) => entry.id === initialCaseId);
        if (index < 0) return;
        consumedInitialCase.current = true;
        queueMicrotask(() => {
            setInspectIndex(index);
            onInitialCaseConsumed?.();
        });
    }, [initialCaseId, onInitialCaseConsumed, result]);
    const inspectEntry = inspectIndex == null ? null : inspectableCase(result?.cases?.[inspectIndex]);
    return (
        <div className={styles.sectionStack}>
            {heading("", "Review", "")}
            <Field label="Experiment result"><NativeSelect value={result?.id || ""} onChange={(event) => onResult(event.target.value)}><option value="">Select result</option>{results.map((entry) => <option key={entry.id} value={entry.id}>{entry.id} · {entry.status}</option>)}</NativeSelect></Field>
            {!result ? <div className={styles.largeEmpty}><IconClock size={24} /><strong>No result selected</strong></div> : <>
                <div className={styles.reviewSummary}><div><span>STATUS</span><strong>{result.status}</strong></div>{Object.entries(result.summary || {}).filter(([key]) => ["total", "passed", "failed", "error", "interrupted"].includes(key)).map(([key, value]) => <dl key={key}><dt>{key}</dt><dd>{value}</dd></dl>)}</div>
                <div className={styles.reviewList}>{result.cases.map((entry, index) => {
                    const Icon = statusIcon(entry.status);
                    const failedAssertions = (entry.assertions || []).filter((assertion) => assertion.status === "failed");
                    const failedOutcomes = (entry.outcomes || []).filter((outcome) => outcome.passed !== true);
                    const hasEvidence = failedAssertions.length > 0 || failedOutcomes.length > 0 || Object.keys(entry.metrics || {}).length > 0;
                    return (
                        <article key={entry.id} className={styles.reviewCase}>
                            <button
                                type="button"
                                className={styles.reviewCaseButton}
                                aria-label={`Inspect case ${String(index + 1).padStart(3, "0")}: ${entry.scenarioId}`}
                                onClick={() => setInspectIndex(index)}
                            >
                                <Icon size={17} stroke={1.65} />
                                <div className={styles.reviewIdentity}><span>CASE {String(index + 1).padStart(3, "0")}</span><strong>{entry.scenarioId}</strong><p>{entry.manifestId} · seed {String(entry.seed)}</p></div>
                                <div className={styles.reviewReason}><span>{entry.passed ? "passed" : entry.status}</span><p>{entry.failureReason || entry.terminationReason || displayRuntimeValue(entry.terminalEvent) || "No terminal reason recorded"}</p></div>
                            </button>
                            <div className={styles.reviewActions}>
                                <Button size="compact" disabled={!entry.logId} onClick={() => onReplay?.(entry.logId)}><IconPlayerPlay size={13} /> Replay</Button>
                                <Button size="compact" disabled={!entry.logId} onClick={() => onAnalysis?.(entry.logId)}><IconChartDots size={13} /> Analysis</Button>
                            </div>
                            {hasEvidence && <details className={styles.reviewEvidence}><summary>Terminal evidence · {failedAssertions.length} assertion failures · {failedOutcomes.length} outcome failures</summary><div>{failedAssertions.map((assertion) => <p key={assertion.id}><strong>{assertion.name || assertion.id}</strong><span>{assertion.message || "Failed"}</span></p>)}{failedOutcomes.map((outcome) => <p key={outcome.id}><strong>{outcome.name || outcome.id}</strong><span>{displayRuntimeValue(outcome.detail) || outcome.status}</span></p>)}<dl>{Object.entries(entry.metrics || {}).map(([id, value]) => <div key={id}><dt>{id}</dt><dd>{String(value ?? "—")}</dd></div>)}</dl></div></details>}
                        </article>
                    );
                })}</div>
                <CaseDetailDialog
                    open={inspectIndex != null}
                    onOpenChange={(open) => { if (!open) setInspectIndex(null); }}
                    entry={inspectEntry}
                    index={inspectIndex ?? 0}
                    onReplay={onReplay}
                    onAnalysis={onAnalysis}
                />
            </>}
        </div>
    );
}
