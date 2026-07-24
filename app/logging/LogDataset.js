import { decodeRecordStream } from "./SFLogCodec.js";
import { getLogChunks, getLogIndex } from "./LogClient.js";

function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
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
        this.series = new Map();
        for (const update of this.updates) {
            const samples = this.series.get(update.path) || [];
            samples.push({ timeUs: update.timeUs, cycle: update.cycle, value: update.value });
            this.series.set(update.path, samples);
        }
    }

    static async open(id) {
        const index = await getLogIndex(id);
        const schemaMap = new Map((index.schemas || []).map((schema) => [schema.id, schema]));
        const bytes = await getLogChunks(id, { fromUs: 0 });
        const decoded = decodeRecordStream(bytes, schemaMap);
        return new LogDataset(id, index, decoded);
    }

    getSeries(path, field = "") {
        return (this.series.get(path) || []).map((sample) => ({ ...sample, value: getNested(sample.value, field) }));
    }

    valueAt(path, timeUs, { interpolate = false } = {}) {
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
        if (!interpolate || before === after || after.timeUs === before.timeUs) return clone(before.value);
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
        return clone(before.value);
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

export function flattenNumericFields(value, prefix = "") {
    if (typeof value === "number") return [{ field: prefix, value }];
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return [];
    const result = [];
    for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        result.push(...flattenNumericFields(child, path));
    }
    return result;
}
