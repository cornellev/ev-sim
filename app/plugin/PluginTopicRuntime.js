import { isHeavyValue } from "../scripting/runtime/SignalStore.js";
import { clonePluginJson } from "./PluginJson.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import { comparePluginText } from "./PluginSelection.js";

export const PLUGIN_TOPIC_QUEUE_LIMIT = 1024;

const HEAVY_TOPIC_TYPE = /PointCloud|Image|CompressedImage|LaserScan/i;

export function isPluginControlTopic(topic) {
    return topic?.stage === "controls" || topic?.contractId === "controls-command";
}

export function isPluginHeavyTopic(topic, value) {
    const type = String(topic?.schema?.type || topic?.type || "");
    if (HEAVY_TOPIC_TYPE.test(type)) return true;
    return value !== undefined && isHeavyValue(value);
}

function subscriptionKey(pluginId, systemId, topicId) {
    return `${pluginId}\0${systemId}\0${topicId}`;
}

function topicIdentity(topic) {
    return [topic?.id, topic?.contractId, topic?.name].filter(Boolean);
}

export class PluginTopicRuntime {
    constructor() {
        this.subscriptions = [];
        this.queues = new Map();
        this.deferredPublishes = [];
        this.delivering = false;
        this.disposed = false;
    }

    subscribe({ pluginId, systemId, topic, onMessage }) {
        if (this.disposed) {
            throw pluginError(PLUGIN_ERROR_CODES.STATE_INVALID, "Plugin topic runtime is closed.", { pluginId });
        }
        if (typeof onMessage !== "function") {
            throw new TypeError("Plugin topic subscriptions require an onMessage callback.");
        }
        if (isPluginControlTopic(topic)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.UNAVAILABLE,
                `Plugin "${pluginId}" cannot subscribe to control topic "${topic?.name ?? topic?.id}".`,
                { pluginId, contributionId: systemId, requiresReset: true },
            );
        }
        if (isPluginHeavyTopic(topic)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.UNAVAILABLE,
                `Plugin "${pluginId}" cannot subscribe to heavy topic "${topic?.name ?? topic?.id}".`,
                { pluginId, contributionId: systemId, requiresReset: true },
            );
        }
        const topicId = String(topic.id || topic.contractId || topic.name);
        const key = subscriptionKey(pluginId, systemId, topicId);
        if (this.subscriptions.some((entry) => entry.key === key)) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                `Plugin system "${systemId}" is already subscribed to "${topicId}".`,
                { pluginId, contributionId: systemId, requiresReset: true },
            );
        }
        const subscription = Object.freeze({
            key,
            pluginId,
            systemId,
            topicId,
            topicName: topic.name,
            identities: Object.freeze(topicIdentity(topic)),
            onMessage,
            index: this.subscriptions.length,
        });
        this.subscriptions.push(subscription);
        this.queues.set(key, []);
        return subscription;
    }

    observe(envelope) {
        if (this.disposed || !envelope) return;
        for (const subscription of this.subscriptions) {
            if (!subscription.identities.includes(envelope.topic)
                && !subscription.identities.includes(envelope.contractId)
                && subscription.topicId !== envelope.topic
                && subscription.topicName !== envelope.topic) {
                continue;
            }
            if (isPluginHeavyTopic(null, envelope.value)) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.RESOURCE,
                    `Plugin topic "${envelope.topic}" payload is too heavy to queue.`,
                    {
                        pluginId: subscription.pluginId,
                        contributionId: subscription.systemId,
                        requiresReset: true,
                    },
                );
            }
            const queue = this.queues.get(subscription.key);
            if (queue.length >= PLUGIN_TOPIC_QUEUE_LIMIT) {
                throw pluginError(
                    PLUGIN_ERROR_CODES.RESOURCE,
                    `Plugin topic queue overflow for "${envelope.topic}".`,
                    {
                        pluginId: subscription.pluginId,
                        contributionId: subscription.systemId,
                        requiresReset: true,
                    },
                );
            }
            queue.push(Object.freeze(clonePluginJson({
                topic: envelope.topic,
                contractId: envelope.contractId,
                producer: envelope.producer,
                sequence: envelope.sequence,
                applyTimeNs: envelope.applyTimeNs,
                applyStep: envelope.applyStep,
                typeStr: envelope.typeStr ?? null,
                value: envelope.value,
            }, "plugin topic envelope")));
        }
    }

    deliver(onMessage) {
        if (this.disposed) return [];
        if (this.delivering) {
            throw pluginError(
                PLUGIN_ERROR_CODES.STATE_INVALID,
                "Plugin topic delivery is not reentrant.",
                { requiresReset: true },
            );
        }
        this.delivering = true;
        const deferred = [];
        try {
            const pending = [];
            for (const subscription of this.subscriptions) {
                const queue = this.queues.get(subscription.key) ?? [];
                this.queues.set(subscription.key, []);
                for (const message of queue) pending.push({ subscription, message });
            }
            pending.sort((left, right) => (left.message.sequence - right.message.sequence)
                || (left.subscription.index - right.subscription.index));
            for (const entry of pending) onMessage(entry.subscription, entry.message);
            deferred.push(...this.deferredPublishes.splice(0));
        } finally {
            this.delivering = false;
        }
        return deferred;
    }

    deferPublish(effect) {
        this.deferredPublishes.push(effect);
    }

    snapshot() {
        return this.subscriptions.map((subscription) => ({
            pluginId: subscription.pluginId,
            systemId: subscription.systemId,
            topicId: subscription.topicId,
            sequence: (this.queues.get(subscription.key) ?? []).at(-1)?.sequence ?? 0,
            messages: [...(this.queues.get(subscription.key) ?? [])],
        })).sort((left, right) => comparePluginText(left.pluginId, right.pluginId)
            || comparePluginText(left.systemId, right.systemId)
            || comparePluginText(left.topicId, right.topicId));
    }

    clearSubscriptions() {
        this.subscriptions = [];
        this.queues.clear();
        this.deferredPublishes = [];
        this.delivering = false;
    }

    reset() {
        for (const key of this.queues.keys()) this.queues.set(key, []);
        this.deferredPublishes = [];
        this.delivering = false;
    }

    dispose() {
        this.subscriptions = [];
        this.queues.clear();
        this.deferredPublishes = [];
        this.delivering = false;
        this.disposed = true;
    }
}
