'use client';

export class MarketplaceApiError extends Error {
    constructor(message, { code = "RECOVERY_REQUIRED", status = 500, currentRevision = null } = {}) {
        super(message);
        this.name = "MarketplaceApiError";
        this.code = code;
        this.status = status;
        this.currentRevision = currentRevision;
    }
}

const ERROR_MESSAGES = Object.freeze({
    CONFLICT: "Marketplace sources changed in another operation. The latest revision was loaded; review it before trying again.",
    SOURCE_UNAVAILABLE: "The Marketplace source is unavailable. Previously verified catalog text may still be browsable.",
    SIGNATURE_INVALID: "Registry metadata failed signature verification. The previous verified snapshot was retained.",
    METADATA_EXPIRED: "Registry metadata is expired. Refresh the source before relying on current catalog data.",
});

export function marketplaceApiErrorMessage(error) {
    if (error instanceof MarketplaceApiError && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
    return error instanceof Error ? error.message : "Marketplace request failed.";
}

async function requestJson(path, { method = "GET", body, signal } = {}) {
    const response = await fetch(path, {
        method,
        signal,
        cache: "no-store",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) payload = await response.json();
    if (!response.ok) {
        const error = payload?.error ?? {};
        throw new MarketplaceApiError(error.message || `Marketplace request failed with HTTP ${response.status}.`, {
            code: error.code,
            status: response.status,
            currentRevision: error.currentRevision,
        });
    }
    return payload;
}

export async function getMarketplaceStatus({ signal } = {}) {
    try {
        return await requestJson("/api/marketplace/status", { signal });
    } catch (error) {
        if (error instanceof MarketplaceApiError && error.status === 404) return null;
        throw error;
    }
}

export function searchMarketplace(query = {}, { signal } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
    }
    const suffix = params.size ? `?${params}` : "";
    return requestJson(`/api/marketplace/discover${suffix}`, { signal });
}

export function getMarketplaceItem(sourceId, itemId, { releaseVersion = null, signal } = {}) {
    const params = new URLSearchParams();
    if (releaseVersion) params.set("releaseVersion", releaseVersion);
    const suffix = params.size ? `?${params}` : "";
    return requestJson(`/api/marketplace/items/${encodeURIComponent(sourceId)}/${encodeURIComponent(itemId)}${suffix}`, { signal });
}

export function listMarketplaceSources({ signal } = {}) {
    return requestJson("/api/marketplace/sources", { signal });
}

export function previewMarketplaceSource(input, { signal } = {}) {
    return requestJson("/api/marketplace/sources/preview", { method: "POST", body: input, signal });
}

export function addMarketplaceSource(input, { signal } = {}) {
    return requestJson("/api/marketplace/sources", { method: "POST", body: input, signal });
}

export function updateMarketplaceSource(sourceId, input, { signal } = {}) {
    return requestJson(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "PATCH", body: input, signal });
}

export function removeMarketplaceSource(sourceId, expectedRevision, { signal } = {}) {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return requestJson(`/api/marketplace/sources/${encodeURIComponent(sourceId)}?${query}`, { method: "DELETE", signal });
}

export function refreshMarketplaceSource(sourceId, expectedRevision, { signal } = {}) {
    return requestJson(`/api/marketplace/sources/${encodeURIComponent(sourceId)}/refresh`, {
        method: "POST",
        body: { expectedRevision },
        signal,
    });
}

export function createMarketplaceInstallPlan(input, { signal } = {}) {
    return requestJson("/api/marketplace/install-plans", { method: "POST", body: input, signal });
}

export function startMarketplaceInstallJob(planHash, { signal } = {}) {
    return requestJson("/api/marketplace/install-jobs", { method: "POST", body: { planHash }, signal });
}

export function getMarketplaceInstallJob(jobId, { signal } = {}) {
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function subscribeMarketplaceInstallJob(jobId, { onJob, onError } = {}) {
    const events = new EventSource(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/events`);
    const receive = (event) => {
        try {
            onJob?.(JSON.parse(event.data));
        } catch (error) {
            onError?.(error);
        }
    };
    events.addEventListener("job", receive);
    events.addEventListener("error", (event) => {
        if (events.readyState !== EventSource.CLOSED) onError?.(event);
    });
    return () => events.close();
}

export function commitMarketplaceInstallJob(jobId, expectedRevision, finalPlanHash, { signal } = {}) {
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/commit`, {
        method: "POST",
        body: { expectedRevision, finalPlanHash },
        signal,
    });
}

export function cancelMarketplaceInstallJob(jobId, expectedRevision, { signal } = {}) {
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        body: { expectedRevision },
        signal,
    });
}

export function resumeMarketplaceInstallJob(jobId, expectedRevision, { signal } = {}) {
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/resume`, {
        method: "POST",
        body: { expectedRevision },
        signal,
    });
}

export function replanMarketplaceInstallJob(jobId, expectedRevision, { signal } = {}) {
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/replan`, {
        method: "POST",
        body: { expectedRevision },
        signal,
    });
}

export function listMarketplaceInstallJobOperations(jobId, { offset = 0, limit = 100, status = null, signal } = {}) {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (status) query.set("status", status);
    return requestJson(`/api/marketplace/install-jobs/${encodeURIComponent(jobId)}/operations?${query}`, { signal });
}

export function listMarketplaceInstalled({ signal } = {}) {
    return requestJson("/api/marketplace/installed", { signal });
}

export function getMarketplaceReceipt(receiptHash, { signal } = {}) {
    return requestJson(`/api/marketplace/receipts/${encodeURIComponent(receiptHash)}`, { signal });
}

export function removeMarketplaceInstalled(release, expectedRevision, { signal } = {}) {
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    const segments = [release.sourceId, release.itemId, release.releaseVersion, release.artifactSha256]
        .map((value) => encodeURIComponent(value));
    return requestJson(`/api/marketplace/installed/${segments.join("/")}?${query}`, { method: "DELETE", signal });
}
