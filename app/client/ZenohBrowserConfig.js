export const ZENOH_BROWSER_CONFIG_KIND = "cev-sim.zenoh-browser-host-config";
export const ZENOH_BROWSER_LIMITS = Object.freeze({
    payloadBytes: 16 * 1024 * 1024,
    inboundEntries: 16,
    inboundBytes: 16 * 1024 * 1024,
    connectTimeoutMs: 5000,
    sendTimeoutMs: 5000,
    requestTimeoutMs: 1000,
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 3000,
    closeTimeoutMs: 1000,
});

export function normalizeZenohBrowserConfig(input) {
    const invalid = (message) => { throw Object.assign(new Error(message), { code: "ZENOH_CONFIG_INVALID" }); };
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !["kind", "version", "endpoint", "maxOutboundEntries", "maxOutboundBytes"].includes(key))) invalid("Zenoh browser configuration contains unknown fields or is not an object.");
    if (input.kind !== ZENOH_BROWSER_CONFIG_KIND || input.version !== 1) invalid(`Expected ${ZENOH_BROWSER_CONFIG_KIND}@1.`);
    let endpoint;
    try { endpoint = new URL(input.endpoint); } catch { invalid("Zenoh endpoint must be an explicit ws:// or wss:// URL."); }
    if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) invalid("Zenoh endpoint requires ws/wss, without credentials, query, or fragment.");
    const maxOutboundEntries = input.maxOutboundEntries ?? 256;
    const maxOutboundBytes = input.maxOutboundBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(maxOutboundEntries) || maxOutboundEntries < 1 || maxOutboundEntries > 4096) invalid("maxOutboundEntries must be an integer from 1 to 4096.");
    if (!Number.isSafeInteger(maxOutboundBytes) || maxOutboundBytes < 1024 || maxOutboundBytes > 128 * 1024 * 1024) invalid("maxOutboundBytes must be an integer from 1024 to 134217728.");
    return { kind: ZENOH_BROWSER_CONFIG_KIND, version: 1, endpoint: endpoint.href, maxOutboundEntries, maxOutboundBytes };
}
