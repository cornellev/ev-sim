import { SFLogBatchEncoder } from "./SFLogCodec.js";
import {
    DEFAULT_REPLAY_PROFILE,
    normalizeProfile,
    resolveProfileRule,
    shouldSkipHeavyAlias,
} from "./LogProfiles.js";
import { createLogSession, finalizeLogSession, uploadLogBatch } from "./LogClient.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { CEV_SIM_VERSION } from "../version.js";
import { SAFE_LOG_BATCH_BYTES, TARGET_LOG_BATCH_BYTES } from "./LogLimits.js";
import { isHeavyValue } from "../scripting/runtime/SignalStore.js";
import { abortable, abortableDelay, RUN_STOP_TIMEOUT_MS, runStopTimeout } from "../simulation/AsyncCancellation.js";

const FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_INTERVAL_US = 5e6;
const RETRY_DELAYS_MS = [250, 750, 2000];

const HTTP_LOG_TRANSPORT = Object.freeze({
    createSession: createLogSession,
    appendBatch: uploadLogBatch,
    finalize: finalizeLogSession,
});

async function uploadWithRetry(transport, id, sequence, batch, signal) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            signal?.throwIfAborted();
            return await abortable(transport.appendBatch(id, sequence, batch, { signal }), signal);
        } catch (error) {
            lastError = error;
            if (signal?.aborted) throw signal.reason;
            if (attempt === RETRY_DELAYS_MS.length) break;
            await abortableDelay(RETRY_DELAYS_MS[attempt], signal);
        }
    }
    throw lastError;
}

function valuesEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
        return false;
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!(ArrayBuffer.isView(a) && ArrayBuffer.isView(b))) return false;
        if (a.byteLength !== b.byteLength) return false;
        // Identity/length only — never content-stringify heavy byte buffers.
        return a === b;
    }
    if (isHeavyValue(a) || isHeavyValue(b)) {
        return a === b
            || (a?.width === b?.width
                && a?.height === b?.height
                && a?.encoding === b?.encoding
                && a?.data === b?.data);
    }
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Snapshot an entry so a later store overwrite cannot mutate a queued log batch. */
function copyCaptureEntry(entry) {
    if (!entry) return entry;
    const value = entry.value;
    if (value === null || value === undefined || typeof value !== "object") {
        return { ...entry, value };
    }
    if (ArrayBuffer.isView(value)) {
        return { ...entry, value: value.slice() };
    }
    if (ArrayBuffer.isView(value.data)) {
        return { ...entry, value: { ...value, data: value.data.slice() } };
    }
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(entry);
        } catch {
            // Fall through.
        }
    }
    return { ...entry, value: JSON.parse(JSON.stringify(value)) };
}

function lightSnapshot(store) {
    return store.snapshot({ includeHeavy: false });
}

export class RecordingController {
    constructor(store = getTelemetryStore(), {
        transport = HTTP_LOG_TRANSPORT,
        maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
    } = {}) {
        this.store = store;
        this.transport = transport;
        this.listeners = new Set();
        this.encoder = null;
        this.session = null;
        this.profile = normalizeProfile(DEFAULT_REPLAY_PROFILE);
        this.status = "idle";
        this.error = null;
        this.startedAt = null;
        this.bytesWritten = 0;
        this.queuedBytes = 0;
        this.droppedSamples = 0;
        this.sequence = 0;
        this.lastCheckpointUs = 0;
        this.recordingTimeOriginUs = 0;
        this.timeBase = "wall";
        this._unsubscribe = null;
        this._flushTimer = null;
        this._heavyFlushEncoder = null;
        this._uploadChain = Promise.resolve();
        this._ioController = new AbortController();
        this._stopPromise = null;
        this._lastValues = new Map();
        this._lastSamples = new Map();
        this._ruleCache = new Map();
        this._simulation = null;
        this._unsubscribeSim = null;
        this._simClockStopped = false;
        this._flushTotalBytes = 0;
        this.haltSimulationOnError = true;
        this.maxQueueBytes = Math.max(1, Number(maxQueueBytes) || DEFAULT_MAX_QUEUE_BYTES);
    }

    attachSimulation(simulation) {
        if (this._simulation === simulation) return;
        this._unsubscribeSim?.();
        this._unsubscribeSim = null;
        this._simulation = simulation;
        this._simClockStopped = false;
        this._unsubscribeSim = simulation?.subscribe?.((state) => this._handleSimulationSnapshot(state)) || null;
    }

    _pendingBytes() {
        return this.queuedBytes + Math.max(0, Number(this.encoder?.byteEstimate) || 0);
    }

    _flushProgress(pendingBytes = this._pendingBytes()) {
        const total = Math.max(this._flushTotalBytes || 0, pendingBytes);
        if (this.status !== "stopping" && this._flushTotalBytes <= 0) return null;
        if (total <= 0) return this.status === "stopping" ? 1 : 0;
        return Math.max(0, Math.min(1, 1 - pendingBytes / total));
    }

    _markFlushBaseline() {
        this._flushTotalBytes = Math.max(this._flushTotalBytes || 0, this._pendingBytes());
    }

    _handleSimulationSnapshot(state) {
        const stoppedNow = state?.status === "stopped" || state?.lifecycleState === "finalized";
        const wasStopped = this._simClockStopped;
        this._simClockStopped = Boolean(stoppedNow);
        if (stoppedNow && !wasStopped && this.status === "recording") {
            this._markFlushBaseline();
            this._flush();
            this._markFlushBaseline();
            this._emit();
        }
    }

    getSnapshot() {
        const pendingBytes = this._pendingBytes();
        return {
            status: this.status,
            active: Boolean(this.session) && ["recording", "stopping", "error"].includes(this.status),
            error: this.error,
            session: this.session,
            profile: this.profile,
            startedAt: this.startedAt,
            bytesWritten: this.bytesWritten,
            queuedBytes: this.queuedBytes,
            pendingBytes,
            encoderBytes: Math.max(0, Number(this.encoder?.byteEstimate) || 0),
            flushTotalBytes: Math.max(this._flushTotalBytes || 0, this.status === "stopping" ? pendingBytes : 0),
            flushProgress: this._flushProgress(pendingBytes),
            droppedSamples: this.droppedSamples,
            maxQueueBytes: this.maxQueueBytes,
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    acknowledgeError() {
        this.error = null;
        this._emit();
    }

    _emit() {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }

    async start(options = {}) {
        if (this.status !== "idle" && this.status !== "error") throw new Error("A log recording is already active.");
        if (this._stopPromise) throw new Error("A log recording is still stopping.");
        this._ioController.abort(new Error("Recording session was replaced."));
        const io = this._ioController = new AbortController();
        this.status = "starting";
        this.error = null;
        this.profile = normalizeProfile(options.profile || DEFAULT_REPLAY_PROFILE);
        this.haltSimulationOnError = options.haltSimulationOnError
            ?? (this.profile.mode === "replay-safe");
        this._emit();
        try {
            const created = await abortable(this.transport.createSession({
                name: options.name,
                environmentId: options.environmentId,
                simulator: options.simulator,
                profile: this.profile,
                appVersion: options.appVersion || CEV_SIM_VERSION,
                gitHash: options.gitHash || null,
                runId: options.runId || null,
                manifestId: options.manifestId || null,
                manifestRevision: options.manifestRevision || null,
                definitionHash: options.definitionHash || null,
                resolvedHash: options.resolvedHash || null,
                provenance: options.provenance || null,
                evidence: options.evidence || null,
            }, { signal: io.signal }), io.signal);
            io.signal.throwIfAborted();
            this.session = created.metadata;
            this.session.id = created.id;
            this.encoder = new SFLogBatchEncoder();
            this.status = "recording";
            this.startedAt = Date.now();
            this.bytesWritten = 0;
            this.queuedBytes = 0;
            this._flushTotalBytes = 0;
            this.droppedSamples = 0;
            this.sequence = 0;
            this._uploadChain = Promise.resolve();
            this.lastCheckpointUs = 0;
            this.recordingTimeOriginUs = this.store.getTimeUs();
            this.timeBase = options.timeBase === "simulation" ? "simulation" : "wall";
            this._lastValues.clear();
            this._lastSamples.clear();
            this._ruleCache.clear();
            for (const attachment of options.attachments || []) this.encoder.addAttachment(attachment);
            const initialTimeUs = 0;
            const initialSnapshot = lightSnapshot(this.store);
            const descriptors = this.store.descriptors();
            for (const [path, entry] of Object.entries(initialSnapshot)) {
                const descriptor = descriptors.find((item) => item.path === path) || { path, type: entry.type || "json" };
                if (!resolveProfileRule(this.profile, descriptor).enabled) continue;
                if (shouldSkipHeavyAlias(this.profile, descriptor, { isHeavy: isHeavyValue(entry.value) })) continue;
                this.encoder.addUpdate({ path, entry, descriptor, timeUs: initialTimeUs, cycle: entry.cycle || 0 });
                this._rememberValue(path, entry.value, descriptor);
                this._lastSamples.set(path, initialTimeUs);
            }
            this.encoder.addCheckpoint(initialSnapshot, descriptors, initialTimeUs);
            this.lastCheckpointUs = initialTimeUs;
            this.store.emitTelemetryEvent({ timeUs: this.timeBase === "simulation" ? 0 : undefined, category: "logging", name: "recording-started", payload: { id: created.id, profile: this.profile.id } });
            this._unsubscribe = this.store.subscribeSignals({ includeEvents: true, includeCatalog: false, includeHeavy: true }, (message) => this._capture(message));
            this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
            this._emit();
            return created;
        } catch (error) {
            if (io !== this._ioController || io.signal.aborted) throw error;
            this.status = "error";
            this.error = error.message;
            this._clearCaptureState();
            this._emit();
            throw error;
        }
    }

    _rememberValue(path, value, descriptor) {
        const heavy = descriptor?.logClass === "heavy" || descriptor?.type === "bytes" || isHeavyValue(value);
        if (heavy) {
            if (ArrayBuffer.isView(value)) {
                this._lastValues.set(path, { heavy: true, byteLength: value.byteLength, identity: value });
                return;
            }
            this._lastValues.set(path, {
                heavy: true,
                width: value?.width ?? null,
                height: value?.height ?? null,
                pixelFormat: value?.pixelFormat ?? null,
                identity: value?.data ?? value,
            });
            return;
        }
        this._lastValues.set(path, value);
    }

    _heavyChanged(previous, value) {
        if (!previous?.heavy) return true;
        if (ArrayBuffer.isView(value)) {
            return previous.identity !== value || previous.byteLength !== value.byteLength;
        }
        return previous.identity !== (value?.data ?? value)
            || previous.width !== (value?.width ?? null)
            || previous.height !== (value?.height ?? null)
            || previous.pixelFormat !== (value?.pixelFormat ?? null);
    }

    _capture(message) {
        if (this.status !== "recording" || !this.encoder) return;
        if (message.kind === "event") {
            this.encoder.addEvent({
                ...message.event,
                timeUs: this._recordingTimeUs(message.event?.timeUs),
            });
            return;
        }
        if (message.kind !== "update") return;
        const recordingTimeUs = this._recordingTimeUs(message.timeUs);
        const descriptor = message.descriptor || { path: message.path, type: message.entry?.type || "json" };
        const heavy = descriptor.logClass === "heavy" || descriptor.type === "bytes" || isHeavyValue(message.entry?.value);
        if (shouldSkipHeavyAlias(this.profile, descriptor, { isHeavy: heavy })) return;
        let rule = this._ruleCache.get(message.path);
        if (!rule) {
            rule = resolveProfileRule(this.profile, descriptor);
            this._ruleCache.set(message.path, rule);
        }
        if (!rule.enabled) return;
        const previous = this._lastValues.get(message.path);
        if (rule.sampling === "on-change") {
            if (heavy) {
                if (previous && !this._heavyChanged(previous, message.entry.value)) return;
            } else if (valuesEqual(previous, message.entry.value)) {
                return;
            }
        }
        if (rule.sampling === "fixed-rate" && rule.rateHz) {
            const intervalUs = 1e6 / rule.rateHz;
            const last = this._lastSamples.get(message.path) ?? Number.NEGATIVE_INFINITY;
            if (recordingTimeUs - last < intervalUs) return;
        }
        this._rememberValue(message.path, message.entry.value, descriptor);
        this._lastSamples.set(message.path, recordingTimeUs);
        const entry = heavy && ArrayBuffer.isView(message.entry.value)
            ? copyCaptureEntry({ ...message.entry, timeUs: recordingTimeUs })
            : (heavy ? { ...message.entry, timeUs: recordingTimeUs, value: message.entry.value } : copyCaptureEntry({ ...message.entry, timeUs: recordingTimeUs }));
        this.encoder.addUpdate({
            ...message,
            timeUs: recordingTimeUs,
            entry,
            descriptor,
        });
        if (recordingTimeUs - this.lastCheckpointUs >= CHECKPOINT_INTERVAL_US) {
            this.encoder.addCheckpoint(lightSnapshot(this.store), this.store.descriptors(), recordingTimeUs);
            this.lastCheckpointUs = recordingTimeUs;
        }
        if (this.encoder.byteEstimate >= TARGET_LOG_BATCH_BYTES) this._flush();
        else if (heavy && this._heavyFlushEncoder !== this.encoder) {
            // A native scan publishes many small packets in one turn. Preserve
            // every record while sharing upload/framing work within that turn.
            const encoder = this.encoder;
            this._heavyFlushEncoder = encoder;
            queueMicrotask(() => {
                if (this._heavyFlushEncoder !== encoder) return;
                this._heavyFlushEncoder = null;
                if (this.encoder === encoder) this._flush();
            });
        }
    }

    _recordingTimeUs(value) {
        const timeUs = Math.max(0, Number(value || 0));
        return this.timeBase === "simulation" ? timeUs : Math.max(0, timeUs - this.recordingTimeOriginUs);
    }

    _clearCaptureState() {
        this._lastValues.clear();
        this._lastSamples.clear();
        this.queuedBytes = 0;
        this._flushTotalBytes = 0;
        if (this.encoder) {
            this.encoder.records = [];
            this.encoder._byteEstimate = 0;
        }
    }

    _pauseOnError() {
        if (this.haltSimulationOnError && this._simulation?.status !== "stopped" && this._simulation?.lifecycleState !== "finalized") this._simulation?.pause?.();
    }

    _enqueueBatch(batch) {
        if (this.queuedBytes + batch.bytes.byteLength > this.maxQueueBytes) {
            if (this.haltSimulationOnError) {
                this._pauseOnError();
                this.error = "Recording paused the simulation because the backend queue is full.";
                this.status = "error";
                this._clearCaptureState();
            } else {
                this.droppedSamples += 1;
                this.error = "Optional telemetry was dropped because the backend queue is full.";
            }
            this._emit();
            return false;
        }
        const sequence = this.sequence++;
        const io = this._ioController;
        const session = this.session;
        this.queuedBytes += batch.bytes.byteLength;
        this._emit();
        this._uploadChain = this._uploadChain
            .then(async () => {
                const result = await uploadWithRetry(this.transport, session.id, sequence, batch, io.signal);
                if (io !== this._ioController || io.signal.aborted) return;
                this.bytesWritten = result.bytesWritten;
                this.queuedBytes = Math.max(0, this.queuedBytes - batch.bytes.byteLength);
                if (this.status === "recording" && this._pendingBytes() === 0) this._flushTotalBytes = 0;
                this._emit();
            })
            .catch((error) => {
                if (io !== this._ioController || io.signal.aborted) throw error;
                this.error = error.message;
                this.status = "error";
                this._clearCaptureState();
                this._pauseOnError();
                this._emit();
                throw error;
            });
        this._uploadChain.catch(() => {});
        return true;
    }

    _flush() {
        if (!this.encoder || !this.session || !["recording", "stopping"].includes(this.status)) return;
        try {
            while (this.encoder.pendingRecordCount > 0) {
                const batch = this.encoder.flushUpTo(SAFE_LOG_BATCH_BYTES);
                if (!batch) break;
                if (!this._enqueueBatch(batch)) {
                    this.encoder.repeatSchemas?.();
                    break;
                }
                if (!["recording", "stopping"].includes(this.status)) break;
            }
        } catch (error) {
            this.error = error.message;
            this.status = "error";
            this._clearCaptureState();
            this._pauseOnError();
            this._emit();
        }
    }

    addAttachment(attachment) {
        if (!this.encoder || !this.session || !attachment) return false;
        this.encoder.addAttachment(attachment);
        return true;
    }

    cancel(error) {
        this._ioController.abort(error);
        clearInterval(this._flushTimer);
        this._flushTimer = null;
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._heavyFlushEncoder = null;
        this._clearCaptureState();
        this.session = null;
        this.encoder = null;
        this.startedAt = null;
        this.status = "error";
        this.error = error.message;
        this._emit();
    }

    stop(finalizePatch = {}, { signal = null } = {}) {
        if (this._stopPromise) return this._stopPromise;
        if (!this.session || !["recording", "error"].includes(this.status)) return Promise.resolve(null);
        const io = this._ioController;
        const cancel = () => { if (io === this._ioController) this.cancel(signal.reason); };
        let timer;
        if (signal) {
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
        } else timer = setTimeout(() => this.cancel(runStopTimeout("log finalization")), RUN_STOP_TIMEOUT_MS);
        const pending = Promise.resolve().then(() => this._stop(finalizePatch, io)).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            if (this._stopPromise === pending) this._stopPromise = null;
        });
        this._stopPromise = pending;
        return pending;
    }

    async _stop(finalizePatch, io) {
        io.signal.throwIfAborted();
        const session = this.session;
        this.status = "stopping";
        this._flushTotalBytes = this._pendingBytes();
        this._emit();
        clearInterval(this._flushTimer);
        this._flushTimer = null;
        this._unsubscribe?.();
        this._unsubscribe = null;
        const finalTimeUs = this.timeBase === "simulation"
            ? Math.round(Number(this._simulation?.timeNs || 0) / 1000)
            : Math.max(0, this.store.getTimeUs() - this.recordingTimeOriginUs);
        this.store.emitTelemetryEvent({ timeUs: finalTimeUs, category: "logging", name: "recording-stopped", payload: { id: this.session.id } });
        this.encoder?.addCheckpoint(
            lightSnapshot(this.store),
            this.store.descriptors(),
            finalTimeUs,
        );
        this._flushTotalBytes = this._pendingBytes();
        this._flush();
        this._flushTotalBytes = Math.max(this._flushTotalBytes, this._pendingBytes());
        this._emit();
        try {
            let uploadError = null;
            try {
                await abortable(this._uploadChain, io.signal);
            } catch (error) {
                uploadError = error;
            }
            io.signal.throwIfAborted();
            const metadata = await abortable(this.transport.finalize(session.id, {
                ...finalizePatch,
                incomplete: Boolean(finalizePatch.incomplete || this.error || this.droppedSamples || uploadError),
                loggingError: uploadError?.message || finalizePatch.loggingError || null,
            }, { signal: io.signal }), io.signal);
            io.signal.throwIfAborted();
            this.status = "idle";
            this.session = null;
            this.encoder = null;
            this.error = null;
            this.startedAt = null;
            this._clearCaptureState();
            this._emit();
            if (uploadError && this.haltSimulationOnError) throw uploadError;
            return metadata;
        } catch (error) {
            if (io !== this._ioController || io.signal.aborted) throw error;
            this.status = "error";
            this.error = error.message;
            this._clearCaptureState();
            this._emit();
            throw error;
        }
    }
}

let sharedController = null;

export function getRecordingController() {
    if (!sharedController) sharedController = new RecordingController();
    return sharedController;
}
