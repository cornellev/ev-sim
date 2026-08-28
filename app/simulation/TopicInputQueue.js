export class TopicInputQueue {
    constructor(topics = []) {
        this.sequence = 0;
        this.queue = [];
        this.declaredInputs = new Set(
            topics.filter((topic) => topic.direction === "input").map((topic) => topic.name)
        );
        this.topicOrder = new Map(
            topics.filter((topic) => topic.direction === "input").map((topic, index) => [topic.name, index])
        );
    }

    enqueue(info, applyStep, { arrivalTimeNs = null } = {}) {
        if (!info?.name) return null;
        if (this.declaredInputs.size > 0 && !this.declaredInputs.has(info.name)) {
            return { rejected: true, reason: "undeclared-topic", info: structuredClone(info) };
        }
        const entry = {
            info: structuredClone(info),
            applyStep: Math.max(0, Math.floor(Number(applyStep) || 0)),
            arrivalTimeNs: Math.max(0, Math.floor(Number(arrivalTimeNs ?? info.arrivalTimeNs ?? 0))),
            sequence: ++this.sequence,
        };
        this.queue.push(entry);
        return structuredClone(entry);
    }

    drain(step, applyTimeNs = 0) {
        const ready = [];
        const pending = [];
        for (const entry of this.queue) {
            (entry.applyStep <= step ? ready : pending).push(entry);
        }
        this.queue = pending;
        ready.sort((left, right) => {
            const leftOrder = this.topicOrder.get(left.info.name) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = this.topicOrder.get(right.info.name) ?? Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder || left.arrivalTimeNs - right.arrivalTimeNs || left.sequence - right.sequence;
        });
        return ready.map((entry) => ({
            ...structuredClone(entry),
            applyTimeNs,
        }));
    }

    reset() {
        this.sequence = 0;
        this.queue = [];
    }
}
