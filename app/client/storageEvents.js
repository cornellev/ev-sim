/**
 * Subscribe to MCP-originated storage changes and live workspace commands via
 * one shared SSE connection per URL. Keeping a connection per subscriber can
 * exhaust the browser's HTTP/1.1 per-origin connection pool and starve normal
 * storage requests while the simulator is loading assets.
 */

const DEFAULT_URL = "/api/storage/events";
const hubs = new Map();

export class StorageEventHub {
    constructor(url, {
        EventSourceImpl = globalThis.EventSource,
        setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
        clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
    } = {}) {
        this.url = url;
        this.EventSourceImpl = EventSourceImpl;
        this.setTimeoutImpl = setTimeoutImpl;
        this.clearTimeoutImpl = clearTimeoutImpl;
        this.listeners = new Set();
        this.source = null;
        this.reconnectTimer = null;
        this.attempt = 0;
    }

    subscribe(listener) {
        this.listeners.add(listener);
        this.#connect();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) this.close();
        };
    }

    close() {
        if (this.reconnectTimer) this.clearTimeoutImpl?.(this.reconnectTimer);
        this.reconnectTimer = null;
        this.source?.close?.();
        this.source = null;
        this.attempt = 0;
    }

    #connect() {
        if (this.source || this.reconnectTimer || this.listeners.size === 0 || !this.EventSourceImpl) return;
        const source = new this.EventSourceImpl(this.url);
        this.source = source;

        source.onmessage = (message) => {
            if (this.source !== source) return;
            this.attempt = 0;
            let payload;
            try {
                payload = JSON.parse(message.data);
            } catch (error) {
                console.warn("[storage-events] bad payload:", error);
                return;
            }
            for (const listener of [...this.listeners]) {
                try {
                    const result = listener(payload);
                    result?.catch?.((error) => console.warn("[storage-events] listener failed:", error));
                } catch (error) {
                    console.warn("[storage-events] listener failed:", error);
                }
            }
        };

        source.onerror = () => {
            if (this.source !== source) return;
            source.close?.();
            this.source = null;
            if (this.listeners.size === 0) return;
            this.attempt += 1;
            const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.attempt, 5)));
            this.reconnectTimer = this.setTimeoutImpl?.(() => {
                this.reconnectTimer = null;
                this.#connect();
            }, delay) ?? null;
        };
    }
}

/**
 * @param {(event: { domain: string, id: string|null, action: string, requestId?: string|null, data?: object|null, at: string }) => void} onEvent
 * @param {{ url?: string }} [options]
 * @returns {() => void} unsubscribe
 */
export function subscribeStorageEvents(onEvent, options = {}) {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
        return () => {};
    }

    const url = options.url || DEFAULT_URL;
    let hub = hubs.get(url);
    if (!hub) {
        hub = new StorageEventHub(url);
        hubs.set(url, hub);
    }
    const unsubscribe = hub.subscribe(onEvent);

    return () => {
        unsubscribe();
        if (hub.listeners.size === 0 && hubs.get(url) === hub) hubs.delete(url);
    };
}
