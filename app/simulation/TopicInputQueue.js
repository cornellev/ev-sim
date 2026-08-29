import { isHeavyValue } from "../scripting/runtime/SignalStore.js";

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function estimatePayloadBytes(value) {
    if (value == null) return 0;
    if (typeof value === "string") return value.length * 2;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (isHeavyValue(value)) {
        const data = value.data;
        if (ArrayBuffer.isView(data)) return data.byteLength + 64;
        if (data instanceof ArrayBuffer) return data.byteLength + 64;
        return 64;
    }
    if (Array.isArray(value)) {
        let total = 24;
        for (const item of value) total += estimatePayloadBytes(item);
        return total;
    }
    if (typeof value === "object") {
        let total = 48;
        for (const child of Object.values(value)) total += estimatePayloadBytes(child);
        return Math.min(total, 1_000_000);
    }
    return 8;
}

function cloneInfo(info) {
    const heavy = isHeavyValue(info?.value);
    if (heavy) {
        // Heavy payloads are treated as immutable under the sensor delivery contract.
        return {
            ...info,
            value: info.value,
        };
    }
    return typeof structuredClone === "function" ? structuredClone(info) : JSON.parse(JSON.stringify(info));
}

export class TopicInputQueue {
    constructor(topics = [], options = {}) {
        this.sequence = 0;
        this.queue = [];
        this.queuedBytes = 0;
        this.maxEntries = Math.max(1, Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
        this.maxBytes = Math.max(1024, Number(options.maxBytes ?? DEFAULT_MAX_BYTES));
        this.droppedEntries = 0;
        this.droppedBytes = 0;
        this.overflowEvents = 0;
        this.declaredInputs = new Set(
            topics.filter((topic) => topic.direction === "input").map((topic) => topic.name)
        );
        this.topicOrder = new Map(
            topics.filter((topic) => topic.direction === "input").map((topic, index) => [topic.name, index])
        );
    }

    getStats() {
        return {
            entries: this.queue.length,
            bytes: this.queuedBytes,
            maxEntries: this.maxEntries,
            maxBytes: this.maxBytes,
            droppedEntries: this.droppedEntries,
            droppedBytes: this.droppedBytes,
            overflowEvents: this.overflowEvents,
        };
    }

    enqueue(info, applyStep, { arrivalTimeNs = null } = {}) {
        if (!info?.name) return null;
        if (this.declaredInputs.size > 0 && !this.declaredInputs.has(info.name)) {
            return { rejected: true, reason: "undeclared-topic", info: cloneInfo(info) };
        }
        const cloned = cloneInfo(info);
        const bytes = estimatePayloadBytes(cloned?.value);
        while (
            this.queue.length > 0
            && (this.queue.length >= this.maxEntries || this.queuedBytes + bytes > this.maxBytes)
        ) {
            const dropped = this.queue.shift();
            const droppedBytes = Number(dropped?.bytes) || estimatePayloadBytes(dropped?.info?.value);
            this.queuedBytes = Math.max(0, this.queuedBytes - droppedBytes);
            this.droppedEntries += 1;
            this.droppedBytes += droppedBytes;
            this.overflowEvents += 1;
        }
        if (bytes > this.maxBytes && this.queue.length === 0) {
            this.droppedEntries += 1;
            this.droppedBytes += bytes;
            this.overflowEvents += 1;
            return {
                rejected: true,
                reason: "payload-too-large",
                info: cloned,
                stats: this.getStats(),
            };
        }
        const entry = {
            info: cloned,
            applyStep: Math.max(0, Math.floor(Number(applyStep) || 0)),
            arrivalTimeNs: Math.max(0, Math.floor(Number(arrivalTimeNs ?? info.arrivalTimeNs ?? 0))),
            sequence: ++this.sequence,
            bytes,
        };
        this.queue.push(entry);
        this.queuedBytes += bytes;
        return {
            ...entry,
            info: cloneInfo(entry.info),
            stats: this.getStats(),
        };
    }

    drain(step, applyTimeNs = 0) {
        const ready = [];
        const pending = [];
        for (const entry of this.queue) {
            (entry.applyStep <= step ? ready : pending).push(entry);
        }
        this.queue = pending;
        this.queuedBytes = pending.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
        ready.sort((left, right) => {
            const leftOrder = this.topicOrder.get(left.info.name) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = this.topicOrder.get(right.info.name) ?? Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder || left.arrivalTimeNs - right.arrivalTimeNs || left.sequence - right.sequence;
        });
        return ready.map((entry) => ({
            info: cloneInfo(entry.info),
            applyStep: entry.applyStep,
            arrivalTimeNs: entry.arrivalTimeNs,
            sequence: entry.sequence,
            bytes: entry.bytes,
            applyTimeNs,
        }));
    }

    reset() {
        this.sequence = 0;
        this.queue = [];
        this.queuedBytes = 0;
        this.droppedEntries = 0;
        this.droppedBytes = 0;
        this.overflowEvents = 0;
    }
}

export { estimatePayloadBytes, DEFAULT_MAX_ENTRIES as TOPIC_INPUT_MAX_ENTRIES, DEFAULT_MAX_BYTES as TOPIC_INPUT_MAX_BYTES };
