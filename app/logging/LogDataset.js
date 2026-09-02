import { decodeRecordStream } from "./SFLogCodec.js";
import { getLogAttachments, getLogAutonomySnapshot, getLogChunk, getLogEvents, getLogIndex, getLogPoseSeries, getLogSeries, getLogSnapshot } from "./LogClient.js";
import { simplifyTrajectory, poseSampleFromValue } from "../spatial/trajectorySimplify.js";

const datasetCache = new Map();

function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function maybeClone(value, shouldClone) {
    return shouldClone ? clone(value) : value;
}

function captureStamp(sample) {
    return Number(
        sample.value?.captureTimeNs
        ?? sample.value?.estimate?.captureTimeNs
        ?? sample.value?.applyTimeNs
        ?? (sample.timeUs * 1000),
    );
}

function getNested(value, path) {
    if (!path) return value;
    return path.split(".").reduce((current, key) => current?.[key], value);
}

export class LogDataset {
    constructor(id, index, decoded) {
        this.id = id;
        this.metadata = index.metadata;
        this.durationUs = index.durationUs || 0;
        this.schemas = decoded.schemas;
        this.descriptors = [...decoded.schemas.values()].sort((a, b) => a.path.localeCompare(b.path));
        this.updates = decoded.updates.sort((a, b) => a.timeUs - b.timeUs);
        this.events = decoded.events.sort((a, b) => a.timeUs - b.timeUs);
        this.checkpoints = decoded.checkpoints.sort((a, b) => a.timeUs - b.timeUs);
        this.attachments = decoded.attachments;
        this.resolvedRun = this.jsonAttachment("run-manifest.json");
        this.runManifest = this.resolvedRun?.manifest || this.resolvedRun || null;
        this.calibration = this.jsonAttachment("calibration.json") || this.resolvedRun?.calibration || null;
        this.runResults = this.jsonAttachment("run-results.json");
        this.series = new Map();
        for (const update of this.updates) {
            const samples = this.series.get(update.path) || [];
            samples.push({ timeUs: update.timeUs, cycle: update.cycle, value: update.value });
            this.series.set(update.path, samples);
        }
    }

    static async open(id, { eager = true } = {}) {
        const index = await getLogIndex(id);
        const schemaMap = new Map((index.schemas || []).map((schema) => [schema.id, schema]));
        const decoded = { schemas: schemaMap, updates: [], events: [], checkpoints: [], attachments: [] };
        if (eager) {
            for (const chunk of index.chunks || []) {
                const part = decodeRecordStream(await getLogChunk(id, chunk.index), decoded.schemas);
                decoded.schemas = part.schemas;
                decoded.updates.push(...part.updates);
                decoded.events.push(...part.events);
                decoded.checkpoints.push(...part.checkpoints);
                decoded.attachments.push(...part.attachments);
            }
        }
        const dataset = new LogDataset(id, index, decoded);
        dataset.lazy = !eager;
        return dataset;
    }

    static async openCached(id, options = {}) {
        const key = `${id}:${options.eager === false ? "lazy" : "eager"}`;
        if (datasetCache.has(key)) return datasetCache.get(key);
        const opened = await LogDataset.open(id, options);
        datasetCache.set(key, opened);
        return opened;
    }

    static clearCache(id = null) {
        if (!id) {
            datasetCache.clear();
            return;
        }
        for (const key of [...datasetCache.keys()]) {
            if (key.startsWith(`${id}:`)) datasetCache.delete(key);
        }
    }

    async loadSeries(path, field = "", options = {}) {
        this._seriesCache ||= new Map();
        const cacheKey = `${path}\0${field || ""}\0${options.fromUs ?? 0}\0${options.toUs ?? this.durationUs}\0${options.maxPoints ?? 2000}`;
        if (this._seriesCache.has(cacheKey)) return this._seriesCache.get(cacheKey);
        const samples = (await getLogSeries(this.id, { path, field, ...options })).samples;
        this._seriesCache.set(cacheKey, samples);
        return samples;
    }

    async loadSnapshot(timeUs, options = {}) {
        return (await getLogSnapshot(this.id, timeUs, options)).snapshot;
    }

    async loadEvents(options = {}) {
        const result = await getLogEvents(this.id, options);
        this.events = result.events;
        return result;
    }

    async loadAttachment(name) {
        const existing = this.attachment(name);
        if (existing) return existing;
        const result = await getLogAttachments(this.id, { names: [name] });
        for (const attachment of result.attachments) {
            if (!this.attachment(attachment.name)) this.attachments.push(attachment);
        }
        return this.attachment(name);
    }

    async loadPoseSeries(path, options = {}) {
        this._poseSeriesCache ||= new Map();
        const cacheKey = `${path}:${options.fromUs || 0}:${options.toUs || this.durationUs}:${options.maxPoints || 2000}`;
        if (this._poseSeriesCache.has(cacheKey)) return this._poseSeriesCache.get(cacheKey);

        const eagerSamples = this.series.get(path) || [];
        let samples = [];
        if (!this.lazy && eagerSamples.length) {
            samples = simplifyTrajectory(
                eagerSamples.map((sample) => poseSampleFromValue(sample.timeUs, sample.cycle, sample.value)),
                options.maxPoints || 2000,
            );
        } else {
            const result = await getLogPoseSeries(this.id, {
                path,
                fromUs: options.fromUs ?? 0,
                toUs: options.toUs ?? this.durationUs,
                maxPoints: options.maxPoints ?? 2000,
            });
            samples = result.samples || [];
        }
        this._poseSeriesCache.set(cacheKey, samples);
        return samples;
    }

    async loadAutonomySnapshot(timeUs, options = {}) {
        if (!this.lazy && this.series.size) {
            return this.autonomySnapshotAt(timeUs, options);
        }
        const result = await getLogAutonomySnapshot(this.id, timeUs, options);
        return result.snapshot;
    }

    getSeries(path, field = "") {
        return (this.series.get(path) || []).map((sample) => ({ ...sample, value: getNested(sample.value, field) }));
    }

    paths() {
        return this.descriptors.map((item) => item.path);
    }

    attachment(name) {
        return this.attachments.find((attachment) => attachment.name === name) || null;
    }

    jsonAttachment(name) {
        const attachment = this.attachment(name);
        if (!attachment) return null;
        try {
            return JSON.parse(new TextDecoder().decode(attachment.bytes));
        } catch {
            return null;
        }
    }

    valueAt(path, timeUs, { interpolate = false, clone: shouldClone = true } = {}) {
        const samples = this.series.get(path) || [];
        if (samples.length === 0) return undefined;
        let low = 0;
        let high = samples.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (samples[middle].timeUs <= timeUs) low = middle + 1;
            else high = middle - 1;
        }
        const before = samples[Math.max(0, high)];
        const after = samples[Math.min(samples.length - 1, high + 1)];
        if (!interpolate || before === after || after.timeUs === before.timeUs) {
            return maybeClone(before.value, shouldClone);
        }
        const amount = Math.min(1, Math.max(0, (timeUs - before.timeUs) / (after.timeUs - before.timeUs)));
        if (typeof before.value === "number" && typeof after.value === "number") {
            return before.value + (after.value - before.value) * amount;
        }
        if (before.value?.position && after.value?.position) {
            const lerp = (a, b) => Number(a || 0) + (Number(b || 0) - Number(a || 0)) * amount;
            return {
                position: {
                    x: lerp(before.value.position.x, after.value.position.x),
                    y: lerp(before.value.position.y, after.value.position.y),
                    z: lerp(before.value.position.z, after.value.position.z),
                },
                rotation: {
                    x: lerp(before.value.rotation?.x, after.value.rotation?.x),
                    y: lerp(before.value.rotation?.y, after.value.rotation?.y),
                    z: lerp(before.value.rotation?.z, after.value.rotation?.z),
                    order: before.value.rotation?.order || "XYZ",
                },
            };
        }
        return maybeClone(before.value, shouldClone);
    }

    /**
     * Look up by captureTimeNs embedded in visualization/status envelopes.
     * Default mode is latest-at-or-before; exactSync requires equal capture stamps.
     */
    _findCaptureLookback(samples, target, { startIndex = 0 } = {}) {
        let best = null;
        let bestIndex = -1;
        for (let index = Math.max(0, startIndex); index < samples.length; index += 1) {
            const stamp = captureStamp(samples[index]);
            if (!Number.isFinite(stamp)) continue;
            if (stamp <= target) {
                best = { sample: samples[index], stamp };
                bestIndex = index;
                continue;
            }
            break;
        }
        if (best) return { best, bestIndex };
        let low = 0;
        let high = samples.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const stamp = captureStamp(samples[middle]);
            if (!Number.isFinite(stamp)) {
                low = middle + 1;
                continue;
            }
            if (stamp <= target) {
                best = { sample: samples[middle], stamp };
                bestIndex = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return { best, bestIndex };
    }

    valueAtCaptureTime(path, captureTimeNs, { exactSync = false, clone: shouldClone = true } = {}) {
        const samples = this.series.get(path) || [];
        if (samples.length === 0) return { value: undefined, ageNs: null, matched: false };
        const target = Number(captureTimeNs);
        if (exactSync) {
            for (const sample of samples) {
                const stamp = captureStamp(sample);
                if (!Number.isFinite(stamp)) continue;
                if (stamp === target) {
                    return {
                        value: maybeClone(sample.value, shouldClone),
                        ageNs: 0,
                        matched: true,
                        sampleTimeUs: sample.timeUs,
                        captureTimeNs: stamp,
                    };
                }
            }
            return { value: undefined, ageNs: null, matched: false };
        }

        this._captureLookbackCache ||= new Map();
        const cached = this._captureLookbackCache.get(path);
        const startIndex = cached && target >= cached.targetNs ? cached.index : 0;
        const { best, bestIndex } = this._findCaptureLookback(samples, target, { startIndex });
        if (!best) {
            return { value: undefined, ageNs: null, matched: false };
        }
        if (bestIndex >= 0) {
            this._captureLookbackCache.set(path, { targetNs: target, index: bestIndex });
        }
        return {
            value: maybeClone(best.sample.value, shouldClone),
            ageNs: Math.max(0, target - best.stamp),
            matched: true,
            sampleTimeUs: best.sample.timeUs,
            captureTimeNs: best.stamp,
        };
    }

    autonomySnapshotAt(timeUs, { exactSync = false, captureTimeNs = null, clone: shouldClone = true } = {}) {
        const cursorNs = Number.isFinite(captureTimeNs) ? captureTimeNs : Math.round(Number(timeUs) * 1000);
        const captureOptions = { exactSync, clone: shouldClone };
        const perception = this.valueAtCaptureTime("visualization.perception.candidate", cursorNs, captureOptions);
        const oracle = this.valueAtCaptureTime("visualization.perception.oracle", cursorNs, captureOptions);
        const localization = this.valueAtCaptureTime("visualization.localization.candidate", cursorNs, captureOptions);
        const localizationError = this.valueAtCaptureTime("visualization.localization.error", cursorNs, captureOptions);
        const status = this.valueAtCaptureTime("visualization.perception.status", cursorNs, captureOptions);
        const controls = this.valueAtCaptureTime("visualization.controls.snapshot", cursorNs, captureOptions);
        return {
            captureTimeNs: cursorNs,
            exactSync,
            perception: {
                ...(perception.value || {}),
                oracle: oracle.value || { detections2d: [], detections3d: [], lanes: [] },
                status: status.value?.status || perception.value?.status || "ok",
                statusCode: status.value?.statusCode || perception.value?.statusCode || null,
                ageNs: perception.ageNs,
            },
            localization: {
                ...(localization.value || {}),
                error: localizationError.value ?? localization.value?.error ?? null,
                ageNs: localization.ageNs,
            },
            controls: controls.value || null,
            ages: {
                perceptionNs: perception.ageNs,
                localizationNs: localization.ageNs,
                controlsNs: controls.ageNs,
            },
        };
    }

    snapshotAt(timeUs) {
        let snapshot = {};
        let startUs = 0;
        let checkpointLow = 0;
        let checkpointHigh = this.checkpoints.length - 1;
        while (checkpointLow <= checkpointHigh) {
            const middle = (checkpointLow + checkpointHigh) >> 1;
            if (this.checkpoints[middle].timeUs <= timeUs) checkpointLow = middle + 1;
            else checkpointHigh = middle - 1;
        }
        if (checkpointHigh >= 0) {
            const checkpoint = this.checkpoints[checkpointHigh];
            snapshot = clone(checkpoint.values);
            startUs = checkpoint.timeUs;
        }
        let updateLow = 0;
        let updateHigh = this.updates.length;
        while (updateLow < updateHigh) {
            const middle = (updateLow + updateHigh) >> 1;
            if (this.updates[middle].timeUs < startUs) updateLow = middle + 1;
            else updateHigh = middle;
        }
        for (let index = updateLow; index < this.updates.length; index += 1) {
            const update = this.updates[index];
            if (update.timeUs > timeUs) break;
            snapshot[update.path] = clone(update.value);
        }
        return snapshot;
    }

    eventsNear(timeUs, windowUs = 1e6) {
        return this.events.filter((event) => Math.abs(event.timeUs - timeUs) <= windowUs);
    }
}

const FLATTEN_NUMERIC_FIELD_CAP = 48;

export function flattenNumericFields(value, prefix = "", { maxFields = FLATTEN_NUMERIC_FIELD_CAP } = {}) {
    if (typeof value === "number") return [{ field: prefix, value }];
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return [];
    if (Array.isArray(value)) {
        if (value.length === 0 || typeof value[0] !== "object" || value[0] === null) return [];
        return [];
    }
    const result = [];
    for (const [key, child] of Object.entries(value)) {
        if (result.length >= maxFields) break;
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof child === "number") {
            result.push({ field: path, value: child });
            continue;
        }
        if (Array.isArray(child)) {
            if (child.length === 0 || typeof child[0] !== "object" || child[0] === null) continue;
            continue;
        }
        result.push(...flattenNumericFields(child, path, { maxFields: maxFields - result.length }));
    }
    return result;
}
