const BASE_URL = "/api/logs";

async function assertOk(response, action) {
    if (response.ok) return response;
    let detail = "";
    try {
        detail = (await response.json())?.error || "";
    } catch {
        detail = "";
    }
    throw new Error(`${action} failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`);
}

export async function listLogs() {
    return (await assertOk(await fetch(BASE_URL), "Log catalog load")).json();
}

export async function createLogSession(metadata) {
    const response = await fetch(`${BASE_URL}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
    });
    return (await assertOk(response, "Log session creation")).json();
}

export async function uploadLogBatch(id, sequence, batch) {
    const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}/batches`, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            "X-SFLog-Sequence": String(sequence),
            "X-SFLog-Start-Us": String(batch.startUs),
            "X-SFLog-End-Us": String(batch.endUs),
        },
        body: batch.bytes,
    });
    return (await assertOk(response, "Log batch upload")).json();
}

export async function finalizeLogSession(id, patch = {}) {
    const response = await fetch(`${BASE_URL}/sessions/${encodeURIComponent(id)}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    return (await assertOk(response, "Log finalization")).json();
}

export async function getLogIndex(id) {
    return (await assertOk(await fetch(`${BASE_URL}/${encodeURIComponent(id)}/index`), "Log index load")).json();
}

export async function getLogChunks(id, { fromUs = 0, toUs } = {}) {
    const params = new URLSearchParams({ fromUs: String(Math.max(0, fromUs)) });
    if (toUs !== undefined && Number.isFinite(toUs)) params.set("toUs", String(toUs));
    const response = await fetch(`${BASE_URL}/${encodeURIComponent(id)}/chunks?${params}`);
    return new Uint8Array(await (await assertOk(response, "Log chunk load")).arrayBuffer());
}

export async function importLog(file) {
    const response = await fetch(`${BASE_URL}/import`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-sflog",
            "X-SFLog-Name": file.name.replace(/\.sflog$/i, ""),
        },
        body: file,
    });
    return (await assertOk(response, "Log import")).json();
}

export async function updateLog(id, patch) {
    const response = await fetch(`${BASE_URL}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    return (await assertOk(response, "Log update")).json();
}

export async function deleteLog(id) {
    const response = await fetch(`${BASE_URL}/${encodeURIComponent(id)}`, { method: "DELETE" });
    return (await assertOk(response, "Log deletion")).json();
}

export function getLogDownloadUrl(id) {
    return `${BASE_URL}/${encodeURIComponent(id)}/file`;
}
