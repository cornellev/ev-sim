import { SFLogBatchEncoder } from "./SFLogCodec.js";
import { DEFAULT_REPLAY_PROFILE, normalizeProfile, resolveProfileRule } from "./LogProfiles.js";
import { createLogSession, finalizeLogSession, uploadLogBatch } from "./LogClient.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { SAFE_LOG_BATCH_BYTES, TARGET_LOG_BATCH_BYTES } from "./LogLimits.js";

const FLUSH_INTERVAL_MS = 250;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_INTERVAL_US = 5e6;
const RETRY_DELAYS_MS = [250, 750, 2000];

async function uploadWithRetry(id, sequence, batch) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await uploadLogBatch(id, sequence, batch);
        } catch (error) {
            lastError = error;
            if (attempt === RETRY_DELAYS_MS.length) break;
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
    }
    throw lastError;
}

function valuesEqual(a, b) {
    if (Object.is(a, b)) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/** Snapshot an entry so a later store overwrite cannot mutate a queued log batch. */
function copyCaptureEntry(entry) {
    if (!entry) return entry;
    const value = entry.value;
    if (ArrayBuffer.isView(value)) {
        return { ...entry, value: value.slice() };
    }
    if (value && typeof value === "object" && ArrayBuffer.isView(value.data)) {
        return { ...entry, value: { ...value, data: value.data.slice() } };
    }
    if (typeof structuredClone === "function") {
        try {
            return structuredClone(entry);
        } catch {
            // Fall through.
        }
    }
    return { ...entry };
}

export class RecordingController {
    constructor(store = getTelemetryStore()) {
        this.store = store;
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
        this._uploadChain = Promise.resolve();
        this._lastValues = new Map();
        this._lastSamples = new Map();
        this._simulation = null;
        this.haltSimulationOnError = true;
    }

    attachSimulation(simulation) {
        this._simulation = simulation;
    }

    getSnapshot() {
        return {
            status: this.status,
            active: Boolean(this.session) && ["recording", "stopping", "error"].includes(this.status),
            error: this.error,
            session: this.session,
            profile: this.profile,
            startedAt: this.startedAt,
            bytesWritten: this.bytesWritten,
            queuedBytes: this.queuedBytes,
            droppedSamples: this.droppedSamples,
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
        this.status = "starting";
        this.error = null;
        this.profile = normalizeProfile(options.profile || DEFAULT_REPLAY_PROFILE);
        this.haltSimulationOnError = options.haltSimulationOnError
            ?? (this.profile.mode === "replay-safe");
        this._emit();
        try {
            const created = await createLogSession({
                name: options.name,
                environmentId: options.environmentId,
                simulator: options.simulator,
                profile: this.profile,
                appVersion: options.appVersion || "0.1.0",
                gitHash: options.gitHash || null,
                runId: options.runId || null,
                manifestId: options.manifestId || null,
                manifestRevision: options.manifestRevision || null,
                definitionHash: options.definitionHash || null,
                resolvedHash: options.resolvedHash || null,
                provenance: options.provenance || null,
            });
            this.session = created.metadata;
            this.session.id = created.id;
            this.encoder = new SFLogBatchEncoder();
            this.status = "recording";
            this.startedAt = Date.now();
            this.bytesWritten = 0;
            this.queuedBytes = 0;
            this.droppedSamples = 0;
            this.sequence = 0;
            this._uploadChain = Promise.resolve();
            this.lastCheckpointUs = 0;
            this.recordingTimeOriginUs = this.store.getTimeUs();
            this.timeBase = options.timeBase === "simulation" ? "simulation" : "wall";
            this._lastValues.clear();
            this._lastSamples.clear();
            for (const attachment of options.attachments || []) this.encoder.addAttachment(attachment);
            const initialTimeUs = 0;
            const initialSnapshot = this.store.snapshot();
            const descriptors = this.store.descriptors();
            for (const [path, entry] of Object.entries(initialSnapshot)) {
                const descriptor = descriptors.find((item) => item.path === path) || { path, type: entry.type || "json" };
                if (!resolveProfileRule(this.profile, descriptor).enabled) continue;
                this.encoder.addUpdate({ path, entry, descriptor, timeUs: initialTimeUs, cycle: entry.cycle || 0 });
                this._lastValues.set(path, entry.value);
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
            this.status = "error";
            this.error = error.message;
            this._emit();
            throw error;
        }
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
        const rule = resolveProfileRule(this.profile, descriptor);
        if (!rule.enabled) return;
        const previous = this._lastValues.get(message.path);
        if (rule.sampling === "on-change" && valuesEqual(previous, message.entry.value)) return;
        if (rule.sampling === "fixed-rate" && rule.rateHz) {
            const intervalUs = 1e6 / rule.rateHz;
            const last = this._lastSamples.get(message.path) ?? Number.NEGATIVE_INFINITY;
            if (recordingTimeUs - last < intervalUs) return;
        }
        this._lastValues.set(message.path, message.entry.value);
        this._lastSamples.set(message.path, recordingTimeUs);
        const entry = copyCaptureEntry({ ...message.entry, timeUs: recordingTimeUs });
        this.encoder.addUpdate({
            ...message,
            timeUs: recordingTimeUs,
            entry,
        });
        if (recordingTimeUs - this.lastCheckpointUs >= CHECKPOINT_INTERVAL_US) {
            this.encoder.addCheckpoint(this.store.snapshot(), this.store.descriptors(), recordingTimeUs);
            this.lastCheckpointUs = recordingTimeUs;
        }
        if (this.encoder.byteEstimate >= TARGET_LOG_BATCH_BYTES) this._flush();
    }

    _recordingTimeUs(value) {
        const timeUs = Math.max(0, Number(value || 0));
        return this.timeBase === "simulation" ? timeUs : Math.max(0, timeUs - this.recordingTimeOriginUs);
    }

    _enqueueBatch(batch) {
        if (this.queuedBytes + batch.bytes.byteLength > MAX_QUEUE_BYTES) {
            if (this.haltSimulationOnError) {
                this._simulation?.pause?.();
                this.error = "Recording paused the simulation because the backend queue is full.";
                this.status = "error";
            } else {
                this.droppedSamples += 1;
                this.error = "Optional telemetry was dropped because the backend queue is full.";
            }
            this._emit();
            return false;
        }
        const sequence = this.sequence++;
        this.queuedBytes += batch.bytes.byteLength;
        this._emit();
        this._uploadChain = this._uploadChain
            .then(async () => {
                const result = await uploadWithRetry(this.session.id, sequence, batch);
                this.bytesWritten = result.bytesWritten;
                this.queuedBytes = Math.max(0, this.queuedBytes - batch.bytes.byteLength);
                this._emit();
            })
            .catch((error) => {
                this.error = error.message;
                this.status = "error";
                if (this.haltSimulationOnError) this._simulation?.pause?.();
                this._emit();
                throw error;
            });
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
            if (this.haltSimulationOnError) this._simulation?.pause?.();
            this._emit();
        }
    }

    addAttachment(attachment) {
        if (!this.encoder || !this.session || !attachment) return false;
        this.encoder.addAttachment(attachment);
        return true;
    }

    async stop(finalizePatch = {}) {
        if (!this.session || !["recording", "error"].includes(this.status)) return null;
        this.status = "stopping";
        clearInterval(this._flushTimer);
        this._flushTimer = null;
        this._unsubscribe?.();
        this._unsubscribe = null;
        const finalTimeUs = this.timeBase === "simulation"
            ? Math.round(Number(this._simulation?.timeNs || 0) / 1000)
            : Math.max(0, this.store.getTimeUs() - this.recordingTimeOriginUs);
        this.store.emitTelemetryEvent({ timeUs: finalTimeUs, category: "logging", name: "recording-stopped", payload: { id: this.session.id } });
        this.encoder?.addCheckpoint(
            this.store.snapshot(),
            this.store.descriptors(),
            finalTimeUs,
        );
        this._flush();
        this._emit();
        try {
            let uploadError = null;
            try {
                await this._uploadChain;
            } catch (error) {
                uploadError = error;
            }
            const metadata = await finalizeLogSession(this.session.id, {
                ...finalizePatch,
                incomplete: Boolean(finalizePatch.incomplete || this.error || this.droppedSamples || uploadError),
                loggingError: uploadError?.message || finalizePatch.loggingError || null,
            });
            this.status = "idle";
            this.session = null;
            this.encoder = null;
            this.error = null;
            this.startedAt = null;
            this._emit();
            if (uploadError && this.haltSimulationOnError) throw uploadError;
            return metadata;
        } catch (error) {
            this.status = "error";
            this.error = error.message;
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
