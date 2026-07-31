const FALLBACK_CLAIM_TTL_MS = 60_000;

/** Execute one live MCP command in exactly one same-origin browser tab. */
export async function runMcpCommandOnce(requestId, task) {
    const lockName = `fusion-mcp-command:${requestId}`;
    const key = `fusion:mcp-command:${requestId}`;
    const tabId = sessionStorage.getItem("fusion-mcp-tab-id") || crypto.randomUUID();
    sessionStorage.setItem("fusion-mcp-tab-id", tabId);
    const runClaimed = async () => {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, JSON.stringify({ tabId, at: Date.now() }));
        try {
            await task();
        } finally {
            window.setTimeout(() => {
                const current = JSON.parse(localStorage.getItem(key) || "null");
                if (current?.tabId === tabId) localStorage.removeItem(key);
            }, FALLBACK_CLAIM_TTL_MS);
        }
    };

    if (navigator.locks?.request) {
        await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (lock) await runClaimed();
        });
        return;
    }

    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({ tabId, at: Date.now() }));
    await Promise.resolve();
    const claim = JSON.parse(localStorage.getItem(key) || "null");
    if (claim?.tabId === tabId && Date.now() - claim.at < FALLBACK_CLAIM_TTL_MS) await task();
    window.setTimeout(() => {
        const current = JSON.parse(localStorage.getItem(key) || "null");
        if (current?.tabId === tabId) localStorage.removeItem(key);
    }, FALLBACK_CLAIM_TTL_MS);
}
