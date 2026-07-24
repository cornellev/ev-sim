/**
 * Subscribe to MCP-originated storage changes and live workspace commands via
 * SSE. Browser autosaves do not publish here, so there is no feedback loop
 * with EnvironmentPersistence.
 */

const DEFAULT_URL = "/api/storage/events";

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
    let source = null;
    let closed = false;
    let reconnectTimer = null;
    let attempt = 0;

    const connect = () => {
        if (closed) return;
        source = new EventSource(url);

        source.onmessage = (message) => {
            attempt = 0;
            try {
                const payload = JSON.parse(message.data);
                onEvent?.(payload);
            } catch (error) {
                console.warn("[storage-events] bad payload:", error);
            }
        };

        source.onerror = () => {
            source?.close();
            source = null;
            if (closed) return;
            attempt += 1;
            const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt, 5)));
            reconnectTimer = window.setTimeout(connect, delay);
        };
    };

    connect();

    return () => {
        closed = true;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        source?.close();
        source = null;
    };
}
