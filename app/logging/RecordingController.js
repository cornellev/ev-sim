import { SFLogBatchEncoder } from "./SFLogCodec.js";
import { DEFAULT_REPLAY_PROFILE, normalizeProfile, resolveProfileRule } from "./LogProfiles.js";
import { createLogSession, finalizeLogSession, uploadLogBatch } from "./LogClient.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";

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
        this._unsubscribe = null;
        this._flushTimer = null;
        this._uploadChain = Promise.resolve();
        this._lastValues = new Map();
        this._lastSamples = new Map();
        this._simulation = null;
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
        this._emit();
        try {
            const created = await createLogSession({
                name: options.name,
                environmentId: options.environmentId,
                simulator: options.simulator,
                profile: this.profile,
                appVersion: options.appVersion || "0.1.0",
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
            this.lastCheckpointUs = 0;
            this.recordingTimeOriginUs = this.store.getTimeUs();
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
            this.store.emitTelemetryEvent({ category: "logging", name: "recording-started", payload: { id: created.id, profile: this.profile.id } });
            this._unsubscribe = this.store.subscribeSignals({ includeEvents: true, includeCatalog: false }, (message) => this._capture(message));
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
                timeUs: Math.max(0, Number(message.event?.timeUs || 0) - this.recordingTimeOriginUs),
            });
            return;
        }
        if (message.kind !== "update") return;
        const recordingTimeUs = Math.max(0, Number(message.timeUs || 0) - this.recordingTimeOriginUs);
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
        this.encoder.addUpdate({
            ...message,
            timeUs: recordingTimeUs,
            entry: { ...message.entry, timeUs: recordingTimeUs },
        });
        if (recordingTimeUs - this.lastCheckpointUs >= CHECKPOINT_INTERVAL_US) {
            this.encoder.addCheckpoint(this.store.snapshot(), this.store.descriptors(), recordingTimeUs);
            this.lastCheckpointUs = recordingTimeUs;
        }
        if (this.encoder.byteEstimate >= 256 * 1024) this._flush();
    }

    _flush() {
        if (!this.encoder || !this.session || !["recording", "stopping"].includes(this.status)) return;
        const batch = this.encoder.flush();
        if (!batch) return;
        if (this.queuedBytes + batch.bytes.byteLength > MAX_QUEUE_BYTES) {
            if (this.profile.mode === "replay-safe") {
                this._simulation?.pause?.();
                this.error = "Recording paused the simulation because the backend queue is full.";
                this.status = "error";
            } else {
                this.droppedSamples += 1;
                this.error = "Optional telemetry was dropped because the backend queue is full.";
            }
            this._emit();
            return;
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
                this._simulation?.pause?.();
                this._emit();
                throw error;
            });
    }

    async stop() {
        if (!this.session || !["recording", "error"].includes(this.status)) return null;
        this.status = "stopping";
        clearInterval(this._flushTimer);
        this._flushTimer = null;
        this._unsubscribe?.();
        this._unsubscribe = null;
        this.store.emitTelemetryEvent({ category: "logging", name: "recording-stopped", payload: { id: this.session.id } });
        this.encoder?.addCheckpoint(
            this.store.snapshot(),
            this.store.descriptors(),
            Math.max(0, this.store.getTimeUs() - this.recordingTimeOriginUs),
        );
        this._flush();
        this._emit();
        try {
            await this._uploadChain;
            const metadata = await finalizeLogSession(this.session.id, { incomplete: Boolean(this.error || this.droppedSamples) });
            this.status = "idle";
            this.session = null;
            this.encoder = null;
            this.error = null;
            this.startedAt = null;
            this._emit();
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
