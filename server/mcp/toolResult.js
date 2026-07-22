/**
 * Shared helpers for MCP tool handlers.
 */

export function ok(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}

export function fail(error, extras = {}) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...extras }, null, 2) }],
        isError: true,
    };
}

export function maybeFailStrict(strict, conflicts, data) {
    if (strict && conflicts.length > 0) {
        return fail("Rejected due to geometric conflicts (strict=true).", {
            conflicts,
            ...data,
        });
    }
    return ok({ ok: true, conflicts, ...data });
}

/**
 * Self-fetch a Next.js API route on the same Express process.
 * @param {string} pathname e.g. "/api/scripting/compile"
 * @param {object} [options]
 */
export async function selfFetchJson(pathname, { method = "GET", body } = {}) {
    const port = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${port}${pathname}`;
    const response = await fetch(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`Invalid JSON from ${pathname}: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
        throw new Error(parsed?.error || `Request to ${pathname} failed (${response.status})`);
    }
    return parsed;
}
