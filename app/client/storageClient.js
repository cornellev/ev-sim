/**
 * Thin fetch wrapper around the server storage API (`/api/storage`).
 *
 * This is the ONLY place the browser talks to the persistence backend. Every
 * feature that needs to save state (scripts, bindings, the environment editor)
 * goes through these three helpers, so there is a single spot to adjust error
 * handling, headers, or the base URL.
 */

const BASE_URL = "/api/storage";

/**
 * GET a resource. Returns the parsed JSON body, or `null` when the resource
 * does not exist yet (so callers can treat "missing" as "empty").
 *
 * @param {string} path e.g. "scripts" or "environments/igvc"
 */
export async function storageGet(path) {
    const response = await fetch(url(path), {
        method: "GET",
        headers: { Accept: "application/json" },
    });

    if (response.status === 404) return null;
    await assertOk(response, "load");
    return response.json();
}

/**
 * PUT (create or replace) a resource with a JSON body.
 *
 * @param {string} path
 * @param {unknown} body
 * @param {{ keepalive?: boolean }} [options] Set `keepalive` for saves fired
 *   during page unload so the browser doesn't cancel the request.
 */
export async function storagePut(path, body, { keepalive = false } = {}) {
    return storageWrite("PUT", path, body, { keepalive });
}

/** Create a collection resource or invoke a server-side collection action. */
export async function storagePost(path, body) {
    return storageWrite("POST", path, body);
}

/** Partially update a resource. */
export async function storagePatch(path, body) {
    return storageWrite("PATCH", path, body);
}

/**
 * DELETE a resource.
 * @param {string} path
 */
export async function storageDelete(path) {
    const response = await fetch(url(path), { method: "DELETE" });
    await assertOk(response, "delete");
    return response.json();
}

async function storageWrite(method, path, body, { keepalive = false } = {}) {
    const response = await fetch(url(path), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive,
    });

    await assertOk(response, "save");
    return response.json();
}

function url(path) {
    return `${BASE_URL}/${path}`;
}

/** Throw a readable error when the server responds with a non-2xx status. */
async function assertOk(response, action) {
    if (response.ok) return;

    let detail = "";
    try {
        const payload = await response.json();
        detail = payload?.error ? `: ${payload.error}` : "";
    } catch {
        // Response had no JSON body; the status text is enough.
    }

    throw new Error(`Storage ${action} failed (${response.status} ${response.statusText})${detail}`);
}
