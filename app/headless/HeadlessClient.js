async function request(path, options = {}) {
    const response = await fetch(`/api/headless${path}`, {
        headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || `Headless API request failed (${response.status}).`);
        error.details = payload.details ?? null;
        throw error;
    }
    return payload;
}

export function getHeadlessCapabilities() {
    return request("/capabilities");
}

export function preflightHeadlessRun(body) {
    return request("/preflight", { method: "POST", body: JSON.stringify(body) });
}

export function listHeadlessRuns() {
    return request("/runs");
}

export function getHeadlessRun(resultId) {
    return request(`/runs/${encodeURIComponent(resultId)}`);
}

export function enqueueHeadlessRun(body) {
    return request("/runs", { method: "POST", body: JSON.stringify(body) });
}

export function cancelHeadlessRun(resultId) {
    return request(`/runs/${encodeURIComponent(resultId)}/cancel`, { method: "POST", body: "{}" });
}

export function headlessArtifactUrl(resultId, caseIndex, artifactName) {
    return `/api/headless/runs/${encodeURIComponent(resultId)}/cases/${caseIndex}/artifacts/${encodeURIComponent(artifactName)}`;
}

export function preflightClip(body) {
    if (body == null) return request("/clips/preflight");
    return request("/clips/preflight", { method: "POST", body: JSON.stringify(body) });
}

export function startClip(body) {
    return request("/clips", { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function getClip() {
    return request("/clips/current");
}

export function cancelClip() {
    return request("/clips/current/cancel", { method: "POST", body: "{}" });
}

export function clipVideoUrl(name) {
    return `/api/headless/clips/current/files/${encodeURIComponent(name)}`;
}

export function getCosmosClipPreflight() {
    return preflightClip();
}

export function getCosmosClip() {
    return getClip();
}

export function startCosmosClip() {
    return startClip();
}

export function cancelCosmosClip() {
    return cancelClip();
}

export function cosmosClipVideoUrl(name) {
    return clipVideoUrl(name);
}
