import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for MCP-originated storage changes.
 * Browser clients subscribe via GET /api/storage/events (SSE).
 */
class StorageEventBus extends EventEmitter {
    /**
     * @param {{ domain: "environment" | "script" | "bindings", id?: string | null, action?: string }} event
     */
    publish(event) {
        const payload = {
            domain: event.domain,
            id: event.id ?? null,
            action: event.action ?? "updated",
            at: new Date().toISOString(),
        };
        this.emit("change", payload);
        return payload;
    }
}

export const storageEvents = new StorageEventBus();
// Avoid MaxListeners warnings when many SSE clients connect in dev.
storageEvents.setMaxListeners(50);
