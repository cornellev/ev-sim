'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    IconArrowsMove,
    IconBoxMultiple,
    IconChevronLeft,
    IconChevronRight,
    IconDownload,
    IconEye,
    IconFileImport,
    IconMaximize,
    IconNotes,
    IconPlayerPause,
    IconPlayerPlay,
    IconRotate,
    IconRuler2,
    IconScale,
    IconTrash,
    IconZoomIn,
} from "@tabler/icons-react";

import {
    AsyncState,
    Button,
    Field,
    IconButton,
    NativeSelect,
    SegmentedControl,
    StatusMessage,
    Textarea,
    WorkspaceFrame,
} from "../ui";
import {
    VISUAL_LAB_DEFECT_CATEGORIES,
    VISUAL_LAB_DEFECT_SEVERITIES,
    VISUAL_LAB_STAGE_LABELS,
    compareVisualLabTargets,
    defaultVisualLabReview,
    findVisualLabSample,
} from "./VisualLabDocuments.js";
import { VisualLabClient } from "./VisualLabClient.js";
import { VisualLabSceneStudio } from "./VisualLabSceneStudio.js";
import styles from "./VisualLabPage.module.css";

const ICON = { size: 15, stroke: 1.75, "aria-hidden": true };

export default function VisualLabPage({ onOpenWorkspace }) {
    const [cases, setCases] = useState([]);
    const [caseId, setCaseId] = useState("");
    const [caseDocument, setCaseDocument] = useState(null);
    const [candidates, setCandidates] = useState([]);
    const [review, setReview] = useState(null);
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [showDefects, setShowDefects] = useState(true);
    const importRef = useRef(null);

    const loadCases = useCallback(async () => {
        setStatus("loading");
        setError(null);
        try {
            const values = await VisualLabClient.listCases();
            setCases(values);
            setCaseId((current) => current || values[0]?.id || "");
        } catch (nextError) {
            setError(nextError);
            setStatus("error");
        }
    }, []);

    useEffect(() => {
        loadCases();
    }, [loadCases]);

    useEffect(() => {
        if (!caseId) return undefined;
        let cancelled = false;
        setStatus("loading");
        setError(null);
        Promise.all([
            VisualLabClient.getCase(caseId),
            VisualLabClient.listCandidates(caseId),
            VisualLabClient.listReviews(caseId),
        ]).then(([nextCase, nextCandidates, nextReviews]) => {
            if (cancelled) return;
            setCaseDocument(nextCase);
            setCandidates(nextCandidates);
            setReview(nextReviews[0] ?? defaultVisualLabReview(nextCase, nextCandidates));
            setStatus("ready");
        }).catch((nextError) => {
            if (cancelled) return;
            setError(nextError);
            setStatus("error");
        });
        return () => {
            cancelled = true;
        };
    }, [caseId]);

    const saveReview = useCallback(async () => {
        if (!review) return;
        setSaving(true);
        setError(null);
        try {
            const stored = review.revision
                ? await VisualLabClient.saveReview(review)
                : await VisualLabClient.createReview(review);
            setReview(stored);
            return stored;
        } catch (nextError) {
            setError(nextError);
            return null;
        } finally {
            setSaving(false);
        }
    }, [review]);

    const exportReview = useCallback(async () => {
        const stored = review?.revision ? review : await saveReview();
        if (!stored) return;
        const pack = await VisualLabClient.exportReview(stored.id);
        downloadBlob(`${stored.id}-visual-lab-pack.json`, new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }));
    }, [review, saveReview]);

    const importCandidate = useCallback(async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const candidate = JSON.parse(await file.text());
            await VisualLabClient.registerCandidate(candidate);
            setCandidates(await VisualLabClient.listCandidates(caseId));
        } catch (nextError) {
            setError(nextError);
        }
    }, [caseId]);

    const defectCount = review?.defects?.filter((entry) => entry.status === "open").length ?? 0;
    const actions = (
        <>
            <input ref={importRef} className={styles.hiddenInput} type="file" accept="application/json" onChange={importCandidate} />
            <Button size="compact" variant="ghost" onClick={() => importRef.current?.click()}><IconFileImport {...ICON} />Register candidate</Button>
            <Button size="compact" variant="ghost" onClick={() => setShowDefects((value) => !value)} aria-pressed={showDefects}><IconNotes {...ICON} />Defects {defectCount}</Button>
            <Button size="compact" variant="ghost" onClick={exportReview} disabled={!review}><IconDownload {...ICON} />Export</Button>
            <Button size="compact" variant="primary" loading={saving} onClick={saveReview} disabled={!review}>Save review</Button>
        </>
    );

    return (
        <WorkspaceFrame
            title="Visual Lab"
            subtitle="Inspect what survives the bake"
            onOpenWorkspace={onOpenWorkspace}
            actions={actions}
            contentClassName={styles.content}
            inspector={showDefects && review && caseDocument ? (
                <DefectPanel caseDocument={caseDocument} candidates={candidates} review={review} setReview={setReview} />
            ) : null}
        >
            {status === "loading" && <AsyncState status="loading" title="Opening comparison case" detail="Loading frozen inputs and retained media." />}
            {status === "error" && <AsyncState status="error" title="Visual Lab could not open" detail={error?.message} onRetry={loadCases} />}
            {status === "ready" && caseDocument && review && (
                <>
                    {error && <StatusMessage tone="danger" title="The last operation failed">{error.message}</StatusMessage>}
                    <div className={styles.caseBar}>
                        <Field label="Case">
                            <NativeSelect value={caseId} onChange={(event) => setCaseId(event.target.value)}>
                                {cases.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                            </NativeSelect>
                        </Field>
                        <div className={styles.caseFacts}>
                            <span>Room {caseDocument.scene.dimensionsMeters.width} × {caseDocument.scene.dimensionsMeters.depth} × {caseDocument.scene.dimensionsMeters.height} m</span>
                            <span>12 stills</span>
                            <span>3 independent paths</span>
                            <span>{candidates.filter((entry) => entry.status === "complete").length} complete / {candidates.length} registered</span>
                            <span className={caseDocument.measuredCapture.missingObjectIds.length ? styles.blocked : undefined}>{caseDocument.measuredCapture.status.replaceAll("-", " ")}</span>
                        </div>
                    </div>
                    <VisualLabWorkspace
                        caseDocument={caseDocument}
                        candidates={candidates}
                        review={review}
                        setReview={setReview}
                    />
                </>
            )}
        </WorkspaceFrame>
    );
}

function VisualLabWorkspace({ caseDocument, candidates, review, setReview }) {
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [loop, setLoop] = useState([0, 24]);
    const [frameState, setFrameState] = useState({ a: "loading", b: "loading" });
    const [wipe, setWipe] = useState(50);
    const [zoom, setZoom] = useState(1);
    const [pixelMode, setPixelMode] = useState(false);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const drag = useRef(null);

    const candidateA = candidates.find((entry) => entry.id === review.comparison.a.candidateId);
    const candidateB = candidates.find((entry) => entry.id === review.comparison.b.candidateId);
    const mediaA = findVisualLabSample(candidateA, review.comparison.a);
    const mediaB = findVisualLabSample(candidateB, review.comparison.b);
    const match = compareVisualLabTargets(caseDocument, candidateA, review.comparison.a, candidateB, review.comparison.b);
    const activePath = review.comparison.a.pathId
        ? caseDocument.paths.find((entry) => entry.id === review.comparison.a.pathId)
        : null;
    const scheduleTarget = review.comparison.mode === "b" ? review.comparison.b : review.comparison.a;
    const schedule = scheduleTarget.viewpointId ? `view:${scheduleTarget.viewpointId}` : `path:${scheduleTarget.pathId}`;

    const updateComparison = useCallback((recipe) => {
        setReview((current) => ({
            ...current,
            comparison: typeof recipe === "function" ? recipe(current.comparison) : { ...current.comparison, ...recipe },
        }));
    }, [setReview]);
    const reportFrameState = useCallback((side, value) => {
        setFrameState((current) => current[side] === value ? current : { ...current, [side]: value });
    }, []);

    const applySchedule = useCallback((nextSchedule, sampleIndex = 0) => {
        const [type, id] = nextSchedule.split(":");
        setPlaying(false);
        updateComparison((current) => {
            const updateTarget = (target) => {
                const candidate = candidates.find((entry) => entry.id === target.candidateId);
                const matchingOutput = candidate?.outputs.find((output) => output.samples.some((sample) => (
                    type === "view" ? sample.viewpointId === id : sample.pathId === id
                )));
                return {
                    ...target,
                    outputId: matchingOutput?.id ?? target.outputId,
                    viewpointId: type === "view" ? id : null,
                    pathId: type === "path" ? id : null,
                    sampleIndex,
                };
            };
            return { ...current, a: updateTarget(current.a), b: updateTarget(current.b) };
        });
        const path = type === "path" ? caseDocument.paths.find((entry) => entry.id === id) : null;
        setLoop([0, Math.max(0, (path?.samples.length ?? 1) - 1)]);
    }, [candidates, caseDocument.paths, updateComparison]);

    const setSample = useCallback((sampleIndex) => {
        if (!activePath) return;
        const clamped = Math.max(loop[0], Math.min(loop[1], sampleIndex));
        updateComparison((current) => ({
            ...current,
            a: { ...current.a, sampleIndex: clamped },
            b: { ...current.b, sampleIndex: clamped },
        }));
    }, [activePath, loop, updateComparison]);

    useEffect(() => {
        if (!playing || !activePath || frameState.a !== "ready" || frameState.b !== "ready") return undefined;
        const timer = setTimeout(() => {
            const current = review.comparison.a.sampleIndex;
            setSample(current >= loop[1] ? loop[0] : current + 1);
        }, 1000 / (activePath.nominalFps * speed));
        return () => clearTimeout(timer);
    }, [activePath, frameState, loop, playing, review.comparison.a.sampleIndex, setSample, speed]);

    const updateTarget = (side, changes) => updateComparison((current) => ({
        ...current,
        [side]: { ...current[side], ...changes },
    }));

    const selectCandidate = (side, candidateId) => {
        const candidate = candidates.find((entry) => entry.id === candidateId);
        const [type, id] = schedule.split(":");
        const output = candidate?.outputs.find((entry) => entry.samples.some((sample) => (
            type === "view" ? sample.viewpointId === id : sample.pathId === id
        )));
        if (output) updateTarget(side, { candidateId, outputId: output.id });
    };

    const frameLabel = activePath
        ? `${review.comparison.a.sampleIndex + 1} / ${activePath.samples.length} · ${(activePath.samples[review.comparison.a.sampleIndex]?.captureTimeNs / 1e9).toFixed(0)} s`
        : "Still";
    const buffering = playing && (frameState.a !== "ready" || frameState.b !== "ready");
    const scheduleItems = [
        ...caseDocument.viewpoints.map((entry) => ({ value: `view:${entry.id}`, label: `${entry.withheld ? "Withheld · " : ""}${entry.name}` })),
        ...caseDocument.paths.map((entry) => ({ value: `path:${entry.id}`, label: `${entry.withheld ? "Withheld · " : ""}${entry.name}` })),
    ];

    const panHandlers = {
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, y: event.clientY, pan };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove: (event) => {
            if (!drag.current) return;
            setPan({
                x: drag.current.pan.x + event.clientX - drag.current.x,
                y: drag.current.pan.y + event.clientY - drag.current.y,
            });
        },
        onPointerUp: () => {
            drag.current = null;
        },
    };

    const addCloseup = () => {
        const id = `closeup-${Date.now().toString(36)}`;
        setReview((current) => ({
            ...current,
            closeups: [...current.closeups, {
                id,
                name: `Close-up ${current.closeups.length + 1}`,
                target: structuredClone(current.comparison.b),
                rectangle: { x: 0.325, y: 0.325, width: 0.35, height: 0.35 },
            }],
        }));
    };

    return (
        <div className={styles.workspace}>
            <div className={styles.selectionBar}>
                <Field label="View or path">
                    <NativeSelect value={schedule} onChange={(event) => applySchedule(event.target.value)}>
                        {scheduleItems.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                    </NativeSelect>
                </Field>
                <TargetSelect label="A" side="a" target={review.comparison.a} candidates={candidates} schedule={schedule} onCandidate={selectCandidate} onOutput={updateTarget} />
                <TargetSelect label="B" side="b" target={review.comparison.b} candidates={candidates} schedule={schedule} onCandidate={selectCandidate} onOutput={updateTarget} />
                <div className={styles.matchBlock} data-matched={match.matched || undefined}>
                    <span>{match.matched ? "Matched" : "Not matched"}</span>
                    <small>{match.matched
                        ? `Camera, sample, and condition agree${match.declaredDifferences.length ? ` · declared: ${match.declaredDifferences.join(", ")}` : ""}`
                        : match.differences.join(", ")}</small>
                </div>
            </div>

            <div className={styles.viewerToolbar}>
                <SegmentedControl
                    value={review.comparison.mode}
                    onValueChange={(mode) => {
                        if (mode === "live") setPlaying(false);
                        updateComparison({ mode });
                    }}
                    label="Comparison mode"
                    items={[
                        { value: "wipe", label: "Wipe" },
                        { value: "side-by-side", label: "A / B" },
                        { value: "a", label: "A" },
                        { value: "b", label: "B" },
                        { value: "live", label: "Live 3D" },
                    ]}
                />
                {review.comparison.mode === "wipe" && <label className={styles.compactRange}>Wipe <input type="range" min="0" max="100" value={wipe} onChange={(event) => setWipe(Number(event.target.value))} /></label>}
                <div className={styles.toolbarSpacer} />
                <IconButton label="Fit images" active={!pixelMode} onClick={() => { setPixelMode(false); setZoom(1); setPan({ x: 0, y: 0 }); }}><IconMaximize {...ICON} /></IconButton>
                <IconButton label="Inspect at one image pixel per screen pixel" active={pixelMode} onClick={() => { setPixelMode(true); setZoom(1); setPan({ x: 0, y: 0 }); }}><IconRuler2 {...ICON} /></IconButton>
                <label className={styles.compactRange}><IconZoomIn {...ICON} /><input aria-label="Shared zoom" type="range" min="1" max="4" step="0.25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
                <Button size="compact" variant="ghost" onClick={addCloseup}>Save close-up</Button>
            </div>

            <div
                className={styles.viewer}
                data-live={review.comparison.mode === "live" || undefined}
                {...(review.comparison.mode === "live" ? {} : panHandlers)}
            >
                {review.comparison.mode === "live" ? (
                    <LiveInspection caseDocument={caseDocument} candidates={candidates} review={review} setReview={setReview} />
                ) : (
                    <ComparisonMedia
                        mode={review.comparison.mode}
                        wipe={wipe}
                        a={{ ...mediaA, candidate: candidateA }}
                        b={{ ...mediaB, candidate: candidateB }}
                        zoom={zoom}
                        pixelMode={pixelMode}
                        pan={pan}
                        closeups={review.closeups}
                        onFrameState={reportFrameState}
                    />
                )}
            </div>

            <div className={styles.playback}>
                <IconButton label={playing ? "Pause" : "Play"} disabled={!activePath || frameState.a === "missing" || frameState.b === "missing"} onClick={() => setPlaying((value) => !value)}>
                    {playing ? <IconPlayerPause {...ICON} /> : <IconPlayerPlay {...ICON} />}
                </IconButton>
                <IconButton label="Previous frame" disabled={!activePath} onClick={() => setSample(review.comparison.a.sampleIndex - 1)}><IconChevronLeft {...ICON} /></IconButton>
                <IconButton label="Next frame" disabled={!activePath} onClick={() => setSample(review.comparison.a.sampleIndex + 1)}><IconChevronRight {...ICON} /></IconButton>
                <span className={styles.frameLabel}>{buffering ? "Waiting for both frames" : frameLabel}</span>
                <input className={styles.scrubber} aria-label="Sample" type="range" min={0} max={Math.max(0, (activePath?.samples.length ?? 1) - 1)} value={review.comparison.a.sampleIndex} disabled={!activePath} onChange={(event) => setSample(Number(event.target.value))} />
                <label className={styles.loopField}>Loop <input type="number" min="0" max={loop[1]} value={loop[0]} onChange={(event) => setLoop(([start, end]) => [Math.min(Number(event.target.value), end), end])} /> to <input type="number" min={loop[0]} max={Math.max(0, (activePath?.samples.length ?? 1) - 1)} value={loop[1]} onChange={(event) => setLoop(([start]) => [start, Math.max(start, Number(event.target.value))])} /></label>
                <NativeSelect className={styles.speedSelect} aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                    {[0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
                </NativeSelect>
            </div>
        </div>
    );
}

function TargetSelect({ label, side, target, candidates, schedule, onCandidate, onOutput }) {
    const candidate = candidates.find((entry) => entry.id === target.candidateId);
    const [type, id] = schedule.split(":");
    const outputs = candidate?.outputs.filter((output) => output.samples.some((sample) => (
        type === "view" ? sample.viewpointId === id : sample.pathId === id
    ))) ?? [];
    return (
        <div className={styles.targetSelect}>
            <span className={styles.targetLetter}>{label}</span>
            <NativeSelect aria-label={`${label} candidate`} value={target.candidateId} onChange={(event) => onCandidate(side, event.target.value)}>
                {candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </NativeSelect>
            <NativeSelect aria-label={`${label} output`} value={target.outputId} onChange={(event) => onOutput(side, { outputId: event.target.value })}>
                {outputs.map((entry) => <option key={entry.id} value={entry.id}>{VISUAL_LAB_STAGE_LABELS[entry.stage]} · {entry.name}</option>)}
            </NativeSelect>
        </div>
    );
}

function ComparisonMedia({ mode, wipe, a, b, zoom, pixelMode, pan, closeups, onFrameState }) {
    if (mode === "side-by-side") {
        return <div className={styles.sideBySide}><MediaPane side="a" data={a} {...{ zoom, pixelMode, pan, closeups, onFrameState }} /><MediaPane side="b" data={b} {...{ zoom, pixelMode, pan, closeups, onFrameState }} /></div>;
    }
    if (mode === "a" || mode === "b") {
        const hiddenSide = mode === "a" ? "b" : "a";
        return <><MediaPane side={mode} data={mode === "a" ? a : b} {...{ zoom, pixelMode, pan, closeups, onFrameState }} /><div className={styles.preload}><MediaPane side={hiddenSide} data={hiddenSide === "a" ? a : b} {...{ zoom, pixelMode, pan, closeups, onFrameState }} /></div></>;
    }
    return (
        <div className={styles.wipe}>
            <MediaPane side="a" data={a} {...{ zoom, pixelMode, pan, closeups, onFrameState }} />
            <div className={styles.wipeTop} style={{ clipPath: `inset(0 ${100 - wipe}% 0 0)` }}>
                <MediaPane side="b" data={b} {...{ zoom, pixelMode, pan, closeups, onFrameState }} />
            </div>
            <div className={styles.wipeLine} style={{ left: `${wipe}%` }} aria-hidden="true" />
            <div className={styles.wipeLegend}>
                <span>A · {a.output ? VISUAL_LAB_STAGE_LABELS[a.output.stage] : "Output missing"}</span>
                <span>B · {b.output ? VISUAL_LAB_STAGE_LABELS[b.output.stage] : "Output missing"}</span>
            </div>
        </div>
    );
}

function MediaPane({ side, data, zoom, pixelMode, pan, closeups, onFrameState }) {
    const [resolved, setResolved] = useState(null);
    const [error, setError] = useState(false);
    const media = data.sample?.media;
    useEffect(() => {
        let active = true;
        let release = () => {};
        Promise.resolve().then(async () => {
            if (!active) return;
            setResolved(null);
            setError(false);
            if (!media) {
                onFrameState(side, "missing");
                return;
            }
            onFrameState(side, "loading");
            try {
                const entry = await VisualLabClient.mediaUrl(media);
                release = entry.revoke;
                if (active) setResolved(entry.url);
                else release();
            } catch {
                if (active) {
                    setError(true);
                    onFrameState(side, "missing");
                }
            }
        });
        return () => {
            active = false;
            release();
        };
    }, [media, onFrameState, side]);

    const relevant = closeups.filter((entry) => sameTarget(entry.target, {
        candidateId: data.candidate?.id,
        outputId: data.output?.id,
        viewpointId: data.sample?.viewpointId,
        pathId: data.sample?.pathId,
        sampleIndex: data.sample?.sampleIndex,
    }));
    const imageStyle = {
        width: pixelMode ? `${media?.width ?? 640}px` : "100%",
        height: pixelMode ? `${media?.height ?? 360}px` : "100%",
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    };
    return (
        <div className={styles.mediaPane} data-side={side}>
            <div className={styles.stageLabel}>{data.output ? VISUAL_LAB_STAGE_LABELS[data.output.stage] : "Output missing"}</div>
            <div className={styles.rendererLabel}>{data.output?.rendererId ?? "No renderer"}</div>
            {resolved && !error ? (
                // Comparison media can be a retained blob URL and must preserve recorded pixels.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={resolved}
                    alt={`${data.candidate?.name ?? "Missing candidate"}, ${data.output?.name ?? "missing output"}`}
                    draggable="false"
                    style={imageStyle}
                    onLoad={() => onFrameState(side, "ready")}
                    onError={() => { setError(true); onFrameState(side, "missing"); }}
                />
            ) : (
                <div className={styles.missingFrame}>{error ? "Frame unavailable" : "Buffering frame"}</div>
            )}
            <div className={styles.annotationPlane} style={imageStyle} aria-hidden="true">
                {relevant.map((entry) => <span key={entry.id} className={styles.closeupRect} style={{ left: `${entry.rectangle.x * 100}%`, top: `${entry.rectangle.y * 100}%`, width: `${entry.rectangle.width * 100}%`, height: `${entry.rectangle.height * 100}%` }} />)}
            </div>
        </div>
    );
}

function LiveInspection({ caseDocument, candidates, review, setReview }) {
    const containerRef = useRef(null);
    const studioRef = useRef(null);
    const [selected, setSelected] = useState(null);
    const [mode, setMode] = useState("translate");
    const [snap, setSnap] = useState(true);
    const [undo, setUndo] = useState([]);
    const [redo, setRedo] = useState([]);
    const [viewMode, setViewMode] = useState("locked");
    const arrangement = useMemo(() => review.arrangement ?? { revision: 0, transforms: [] }, [review.arrangement]);
    const arrangementRef = useRef(arrangement);
    const sceneCandidates = useMemo(() => candidates.filter((entry) => (
        entry.status !== "failed"
        && entry.scene?.fixtureId === caseDocument.scene.fixtureId
        && ["simple", "detailed"].includes(entry.scene?.detail)
        && entry.outputs.some((output) => output.stage !== "reference-renderer-photograph")
    )), [candidates, caseDocument.scene.fixtureId]);
    const [liveCandidateId, setLiveCandidateId] = useState(review.comparison.b.candidateId);
    const liveCandidate = sceneCandidates.find((entry) => entry.id === liveCandidateId)
        ?? sceneCandidates.find((entry) => entry.id === review.comparison.b.candidateId)
        ?? sceneCandidates[0];
    const liveOutput = liveCandidate?.outputs.find((entry) => (
        liveCandidate.id === review.comparison.b.candidateId && entry.id === review.comparison.b.outputId
    )) ?? liveCandidate?.outputs[0];
    const detail = liveCandidate?.scene?.detail ?? "detailed";

    const commit = useCallback((nextArrangement, remember = true) => {
        if (remember) {
            setUndo((entries) => [...entries.slice(-39), structuredClone(arrangementRef.current)]);
            setRedo([]);
        }
        arrangementRef.current = nextArrangement;
        setReview((current) => ({ ...current, arrangement: nextArrangement }));
    }, [setReview]);

    const upsertTransform = useCallback((transform) => {
        const current = arrangementRef.current;
        const index = current.transforms.findIndex((entry) => (entry.instanceId ?? entry.objectId) === transform.objectId);
        const transforms = [...current.transforms];
        const next = { ...transform, instanceId: transform.objectId };
        if (index >= 0) transforms[index] = { ...transforms[index], ...next };
        else transforms.push(next);
        commit({ revision: current.revision + 1, transforms });
    }, [commit]);

    useEffect(() => {
        arrangementRef.current = arrangement;
    }, [arrangement]);

    useEffect(() => {
        if (!containerRef.current || !liveCandidate) return undefined;
        const studio = new VisualLabSceneStudio(containerRef.current, {
            detail,
            caseDocument,
            candidate: liveCandidate,
            output: liveOutput,
            arrangement: arrangementRef.current,
            onSelect: setSelected,
            onTransform: upsertTransform,
            onViewMode: setViewMode,
        });
        studio.setMode("translate");
        studio.setSnap({ translation: 0.1, rotationDegrees: 15, scale: 0.1 });
        studioRef.current = studio;
        return () => {
            studioRef.current = null;
            studio.dispose();
        };
    }, [caseDocument, detail, liveCandidate, liveOutput, upsertTransform]);

    useEffect(() => {
        studioRef.current?.setScene({ detail, candidate: liveCandidate, output: liveOutput, arrangement });
        if (selected?.objectId) studioRef.current?.select(selected.objectId);
    }, [arrangement, detail, liveCandidate, liveOutput, selected?.objectId]);
    useEffect(() => studioRef.current?.setMode(mode), [mode]);
    useEffect(() => studioRef.current?.setSnap(snap ? { translation: 0.1, rotationDegrees: 15, scale: 0.1 } : {}), [snap]);
    const livePose = review.comparison.b.viewpointId
        ? caseDocument.viewpoints.find((entry) => entry.id === review.comparison.b.viewpointId)?.pose
        : caseDocument.paths.find((entry) => entry.id === review.comparison.b.pathId)?.samples[review.comparison.b.sampleIndex]?.pose;
    useEffect(() => studioRef.current?.setView(livePose), [livePose]);
    useEffect(() => {
        const calibration = caseDocument.calibrations.find((entry) => (
            entry.id === liveCandidate?.outputs?.find((output) => output.id === review.comparison.b.outputId)?.calibrationId
        )) ?? caseDocument.calibrations[0];
        studioRef.current?.setViewMode(viewMode, { pose: livePose, calibration });
    }, [caseDocument.calibrations, liveCandidate, livePose, review.comparison.b.outputId, viewMode]);

    const restore = (direction) => {
        const source = direction === "undo" ? undo : redo;
        const target = source.at(-1);
        if (!target) return;
        const current = structuredClone(arrangement);
        if (direction === "undo") {
            setUndo(source.slice(0, -1));
            setRedo((entries) => [...entries, current]);
        } else {
            setRedo(source.slice(0, -1));
            setUndo((entries) => [...entries, current]);
        }
        commit(target, false);
    };

    const addInstance = (sourceObjectId) => {
        const source = caseDocument.scene.objects.find((entry) => entry.id === sourceObjectId);
        if (!source?.editable) return;
        const instanceId = nextInstanceId(sourceObjectId, arrangement.transforms);
        commit({
            revision: arrangement.revision + 1,
            transforms: [...arrangement.transforms, {
                objectId: instanceId,
                instanceId,
                sourceObjectId,
                position: [source.position[0] + 0.4, source.position[1], source.position[2] + 0.4],
                rotationRadians: [...source.rotationRadians],
                uniformScale: 1,
            }],
        });
        setTimeout(() => studioRef.current?.select(instanceId), 0);
    };

    const removeSelected = () => {
        if (!selected?.editable) return;
        const existing = arrangement.transforms.find((entry) => (entry.instanceId ?? entry.objectId) === selected.objectId);
        const transforms = existing?.sourceObjectId && existing.sourceObjectId !== selected.objectId
            ? arrangement.transforms.filter((entry) => (entry.instanceId ?? entry.objectId) !== selected.objectId)
            : [...arrangement.transforms.filter((entry) => (entry.instanceId ?? entry.objectId) !== selected.objectId), { objectId: selected.objectId, instanceId: selected.objectId, deleted: true }];
        commit({ revision: arrangement.revision + 1, transforms });
        setSelected(null);
    };

    const selectedTransform = arrangement.transforms.find((entry) => (entry.instanceId ?? entry.objectId) === selected?.objectId);
    const base = caseDocument.scene.objects.find((entry) => entry.id === (selected?.sourceObjectId ?? selected?.objectId));
    const values = selectedTransform ?? base;
    const changeNumber = (field, index, value) => {
        if (!selected?.editable || !Number.isFinite(Number(value))) return;
        const next = {
            objectId: selected.objectId,
            sourceObjectId: selected.sourceObjectId,
            position: [...(values.position ?? [0, 0, 0])],
            rotationRadians: [...(values.rotationRadians ?? [0, 0, 0])],
            uniformScale: values.uniformScale ?? 1,
        };
        if (field === "uniformScale") next.uniformScale = Math.max(0.1, Number(value));
        else next[field][index] = Number(value);
        upsertTransform(next);
    };

    return (
        <div className={styles.liveInspector}>
            <div
                className={styles.liveCanvas}
                data-testid="visual-lab-live-canvas"
                data-live-scene={liveCandidate?.id}
                data-selected-object={selected?.objectId}
                ref={containerRef}
            />
            <div className={styles.liveBanner} data-view-mode={viewMode}>
                <IconEye {...ICON} />
                {viewMode === "locked"
                    ? `Locked calibrated view · ${arrangement.transforms.length ? "Edited arrangement" : "Frozen candidate"}`
                    : `Exploratory live view · ${arrangement.transforms.length ? "Edited arrangement" : "Frozen candidate"}`}
                <Button size="compact" variant="ghost" onClick={() => setViewMode((value) => value === "locked" ? "exploratory" : "locked")}>
                    {viewMode === "locked" ? "Enable orbit" : "Lock to sample"}
                </Button>
            </div>
            <div className={styles.liveTools}>
                <div className={styles.liveToolRow}>
                    <label className={styles.liveSceneField}>
                        <span>Scene</span>
                        <NativeSelect aria-label="Live 3D scene" value={liveCandidate?.id ?? ""} onChange={(event) => setLiveCandidateId(event.target.value)}>
                            {sceneCandidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                        </NativeSelect>
                    </label>
                    <IconButton label="Move selected asset" active={mode === "translate"} onClick={() => setMode("translate")}><IconArrowsMove {...ICON} /></IconButton>
                    <IconButton label="Rotate selected asset" active={mode === "rotate"} onClick={() => setMode("rotate")}><IconRotate {...ICON} /></IconButton>
                    <IconButton label="Scale selected asset uniformly" active={mode === "scale"} onClick={() => setMode("scale")}><IconScale {...ICON} /></IconButton>
                    <Button size="compact" variant="ghost" aria-pressed={snap} onClick={() => setSnap((value) => !value)}>Grid snap</Button>
                    <Button size="compact" variant="ghost" disabled={!undo.length} onClick={() => restore("undo")}>Undo</Button>
                    <Button size="compact" variant="ghost" disabled={!redo.length} onClick={() => restore("redo")}>Redo</Button>
                </div>
                <div className={styles.liveToolRow}>
                    <NativeSelect aria-label="Asset to add" defaultValue="" onChange={(event) => { if (event.target.value) addInstance(event.target.value); event.target.value = ""; }}>
                        <option value="">Add asset...</option>
                        {caseDocument.scene.objects.filter((entry) => entry.editable).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </NativeSelect>
                    <Button size="compact" variant="ghost" disabled={!selected?.editable} onClick={() => selected?.sourceObjectId && addInstance(selected.sourceObjectId)}><IconBoxMultiple {...ICON} />Duplicate</Button>
                    <IconButton label="Delete selected asset" variant="danger" disabled={!selected?.editable} onClick={removeSelected}><IconTrash {...ICON} /></IconButton>
                    <span className={styles.selectionName}>{selected?.objectId ?? "Select an asset in the room"}</span>
                </div>
                {selected?.editable && values && <div className={styles.numericTransform}>
                    {["X", "Y", "Z"].map((axis, index) => <label key={`p-${axis}`}>P{axis}<input type="number" step="0.1" value={values.position?.[index] ?? 0} onChange={(event) => changeNumber("position", index, event.target.value)} /></label>)}
                    {["X", "Y", "Z"].map((axis, index) => <label key={`r-${axis}`}>R{axis}<input type="number" step="0.1" value={values.rotationRadians?.[index] ?? 0} onChange={(event) => changeNumber("rotationRadians", index, event.target.value)} /></label>)}
                    <label>Scale<input type="number" min="0.1" step="0.1" value={values.uniformScale ?? 1} onChange={(event) => changeNumber("uniformScale", 0, event.target.value)} /></label>
                </div>}
            </div>
        </div>
    );
}

function DefectPanel({ caseDocument, candidates, review, setReview }) {
    const [category, setCategory] = useState(VISUAL_LAB_DEFECT_CATEGORIES[0]);
    const [severity, setSeverity] = useState("major");
    const [text, setText] = useState("");
    const [objectId, setObjectId] = useState("");

    const addDefect = () => {
        if (!text.trim()) return;
        const closeup = review.closeups.findLast((entry) => sameTarget(entry.target, review.comparison.b));
        setReview((current) => ({
            ...current,
            defects: [...current.defects, {
                id: `defect-${Date.now().toString(36)}`,
                target: structuredClone(current.comparison.b),
                objectId: objectId || null,
                rectangle: closeup?.rectangle ?? null,
                category,
                severity,
                status: "open",
                text: text.trim(),
                createdAt: new Date().toISOString(),
                resolvedAt: null,
            }],
        }));
        setText("");
    };

    const restoreDefect = (defect) => {
        const candidate = candidates.find((entry) => entry.id === defect.target.candidateId);
        if (!findVisualLabSample(candidate, defect.target).sample) return;
        setReview((current) => ({
            ...current,
            comparison: { ...current.comparison, b: structuredClone(defect.target), mode: "b" },
        }));
    };

    const toggleResolved = (defectId) => setReview((current) => ({
        ...current,
        defects: current.defects.map((entry) => entry.id === defectId ? {
            ...entry,
            status: entry.status === "open" ? "resolved" : "open",
            resolvedAt: entry.status === "open" ? new Date().toISOString() : null,
        } : entry),
    }));

    return (
        <aside className={styles.defects}>
            <header><div><strong>Defect notes</strong><span>{review.defects.filter((entry) => entry.status === "open").length} open</span></div></header>
            <div className={styles.defectForm}>
                <Field label="Category"><NativeSelect value={category} onChange={(event) => setCategory(event.target.value)}>{VISUAL_LAB_DEFECT_CATEGORIES.map((entry) => <option key={entry} value={entry}>{entry.replaceAll("-", " / ")}</option>)}</NativeSelect></Field>
                <div className={styles.formPair}>
                    <Field label="Severity"><NativeSelect value={severity} onChange={(event) => setSeverity(event.target.value)}>{VISUAL_LAB_DEFECT_SEVERITIES.map((entry) => <option key={entry}>{entry}</option>)}</NativeSelect></Field>
                    <Field label="Object"><NativeSelect value={objectId} onChange={(event) => setObjectId(event.target.value)}><option value="">None</option>{caseDocument.scene.objects.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</NativeSelect></Field>
                </div>
                <Field label="Note"><Textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe the visible defect and expected appearance." /></Field>
                <Button size="compact" variant="primary" onClick={addDefect} disabled={!text.trim()}>Attach to B</Button>
            </div>
            <div className={styles.defectList}>
                {review.defects.length === 0 && <p className={styles.emptyNotes}>No notes yet. Inspect a close-up or path sample, then attach a defect to candidate B.</p>}
                {review.defects.map((defect) => (
                    <article key={defect.id} className={styles.defectCard} data-resolved={defect.status === "resolved" || undefined}>
                        <button type="button" onClick={() => restoreDefect(defect)}>
                            <span className={styles.defectMeta}>{defect.severity} · {defect.category.replaceAll("-", " ")}</span>
                            <span>{defect.text}</span>
                            <small>{defect.target.viewpointId ?? `${defect.target.pathId} / ${defect.target.sampleIndex}`}</small>
                        </button>
                        <Button size="compact" variant="ghost" onClick={() => toggleResolved(defect.id)}>{defect.status === "open" ? "Resolve" : "Reopen"}</Button>
                    </article>
                ))}
            </div>
        </aside>
    );
}

function sameTarget(left, right) {
    return left?.candidateId === right?.candidateId
        && left?.outputId === right?.outputId
        && left?.viewpointId === right?.viewpointId
        && left?.pathId === right?.pathId
        && left?.sampleIndex === right?.sampleIndex;
}

function nextInstanceId(sourceId, transforms) {
    const used = new Set(transforms.map((entry) => entry.instanceId ?? entry.objectId));
    let index = 1;
    while (used.has(`${sourceId}-copy-${index}`)) index += 1;
    return `${sourceId}-copy-${index}`;
}

function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
