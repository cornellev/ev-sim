import {
    fetchBakeResult,
    flipRgbaRows,
} from "./bakeUpload.js";
import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";

export const BAKE_V1_API_BASE = "/bake/v1";
export const BAKE_DIGEST_HEADER = "x-cev-digest";

function adapterError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function resolveUrl(server, path) {
    const host = String(server?.host ?? "").replace(/\/+$/, "");
    return `${host}${path}`;
}

function digestHeaderValue(digest) {
    return `sha256:${digest}`;
}

function parseDigestHeader(value) {
    const text = String(value ?? "");
    const match = /^sha256:([a-f0-9]{64})$/.exec(text.trim());
    if (!match) {
        throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Transfer is missing a declared SHA-256 digest.");
    }
    return match[1];
}

async function readExactBody(response, { expectedDigest = null, expectedLength = null } = {}) {
    const declaredLength = expectedLength
        ?? (response.headers.get("content-length") == null ? null : Number(response.headers.get("content-length")));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (declaredLength != null && (!Number.isSafeInteger(declaredLength) || declaredLength !== bytes.byteLength)) {
        throw adapterError(
            "BAKE_TRANSFER_DIGEST_MISMATCH",
            `Transfer length ${bytes.byteLength} does not match declared length ${declaredLength}.`,
        );
    }
    const digest = expectedDigest ?? (response.headers.get(BAKE_DIGEST_HEADER)
        ? parseDigestHeader(response.headers.get(BAKE_DIGEST_HEADER))
        : null);
    if (digest && sha256ExactBytes(bytes) !== digest) {
        throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Transfer digest does not match the payload.");
    }
    return { bytes, digest: digest ?? sha256ExactBytes(bytes) };
}

async function parseJsonResponse(response, { allowEmpty = false } = {}) {
    const raw = await response.text();
    const declared = response.headers.get("content-length");
    if (declared != null && Number(declared) !== new TextEncoder().encode(raw).byteLength) {
        throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "JSON transfer length does not match Content-Length.");
    }
    if (!raw) {
        if (allowEmpty) return {};
        throw adapterError("BAKE_PROVIDER_CAPABILITY_MISMATCH", "Bake service returned an empty JSON body.");
    }
    return JSON.parse(raw);
}

function errorFromPayload(payload, fallback, code = "BAKE_PROVIDER_UNAVAILABLE") {
    return adapterError(payload?.code ?? code, payload?.error ?? payload?.message ?? fallback);
}

export async function fetchBakeV1Capability(server, {
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== "function") {
        throw adapterError("BAKE_PROVIDER_UNAVAILABLE", "No fetch implementation is available for bake capability probing.");
    }
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/capability`), { method: "GET", signal });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(payload, "Bake capability probe failed.");
    return payload;
}

export async function createBakeV1Job(server, {
    request,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const body = JSON.stringify({ request });
    const encoded = new TextEncoder().encode(body);
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs`), {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": String(encoded.byteLength),
        },
        body,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(payload, "Bake job create failed.");
    return payload;
}

export async function uploadBakeV1Input(server, {
    jobId,
    sampleId,
    viewId,
    role,
    bytes,
    sha256,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = sha256 ?? sha256ExactBytes(payload);
    const key = encodeURIComponent(`${sampleId}:${viewId}:${role}`);
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/inputs/${key}`), {
        method: "PUT",
        signal,
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(payload.byteLength),
            "X-Cev-Digest": digestHeaderValue(digest),
            "X-Cev-Sample-Id": sampleId,
            "X-Cev-View-Id": viewId,
            "X-Cev-Role": role,
        },
        body: payload,
    });
    const json = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(json, "Bake input upload failed.", "BAKE_TRANSFER_DIGEST_MISMATCH");
    if (json.sha256 !== digest || json.byteSize !== payload.byteLength) {
        throw adapterError("BAKE_TRANSFER_DIGEST_MISMATCH", "Bake service did not acknowledge the uploaded digest.");
    }
    return json;
}

export async function submitBakeV1Job(server, {
    jobId,
    requestHash,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const body = JSON.stringify({ requestHash });
    const encoded = new TextEncoder().encode(body);
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/submit`), {
        method: "POST",
        signal,
        headers: {
            "Content-Type": "application/json",
            "Content-Length": String(encoded.byteLength),
        },
        body,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(payload, "Bake job submit failed.");
    return payload;
}

export async function fetchBakeV1Status(server, {
    jobId,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/status`), {
        method: "GET",
        signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(payload, "Bake job status failed.");
    return payload;
}

export async function fetchBakeV1Result(server, {
    jobId,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/result`), {
        method: "GET",
        signal,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) throw errorFromPayload(payload, "Bake job result failed.", "BAKE_MODEL_INCOMPLETE");
    return payload;
}

export async function fetchBakeV1Buffer(server, {
    jobId,
    sha256,
    expectedLength = null,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const response = await fetchImpl(
        resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/buffers/${encodeURIComponent(sha256)}`),
        { method: "GET", signal },
    );
    if (!response.ok) {
        const payload = await parseJsonResponse(response, { allowEmpty: true });
        throw errorFromPayload(payload, "Bake result buffer download failed.", "BAKE_MODEL_INCOMPLETE");
    }
    return readExactBody(response, { expectedDigest: sha256, expectedLength });
}

export async function cancelBakeV1Job(server, {
    jobId,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const response = await fetchImpl(resolveUrl(server, `${apiBase}/jobs/${encodeURIComponent(jobId)}/cancel`), {
        method: "POST",
        signal,
        headers: { "Content-Length": "0" },
    });
    const payload = await parseJsonResponse(response, { allowEmpty: true });
    if (!response.ok) throw errorFromPayload(payload, "Bake job cancel failed.", "BAKE_MODEL_CANCELLED");
    return payload;
}

export async function pollBakeV1Job(server, {
    jobId,
    timeoutMs = 300000,
    pollIntervalMs = 1000,
    apiBase = BAKE_V1_API_BASE,
    signal = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : adapterError("BAKE_MODEL_CANCELLED", "Bake model job cancelled.");
        }
        const status = await fetchBakeV1Status(server, { jobId, apiBase, signal, fetchImpl });
        if (status.state === "completed") return status;
        if (status.state === "cancelled") {
            throw adapterError("BAKE_MODEL_CANCELLED", status.error ?? "Bake model job cancelled.");
        }
        if (status.state === "failed") {
            throw adapterError(status.code ?? "BAKE_MODEL_INCOMPLETE", status.error ?? "Bake model job failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw adapterError("BAKE_MODEL_TIMEOUT", `Bake model job ${jobId} timed out.`);
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number }>}
 */
async function decodeBlobToRgba(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("Unable to decode baked image");
    }
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
        data: imageData.data,
        width: bitmap.width,
        height: bitmap.height,
    };
}

/**
 * Extract raw beauty RGBA in bottom-left origin (WebGL readback layout).
 * The framebuffer read is already in linear space.
 * @param {Object} capture
 * @returns {{ data: Uint8Array, width: number, height: number, colorSpace: string, source: string }|null}
 */
export function getRawBeautyImage(capture) {
    const beauty = capture?.passes?.find(
        (pass) => pass.kind === "render" && pass.passId === "beauty",
    );
    if (!beauty?.data) return null;
    return {
        data: beauty.data,
        width: beauty.width,
        height: beauty.height,
        colorSpace: "linear",
        source: "raw",
    };
}

/**
 * Poll the bake server for a model-processed image. Returns null on timeout or
 * if the sample is not found so callers can fall back to the raw render.
 * Decoded PNG bytes are sRGB top-left origin. Convert them back to the
 * bottom-left-origin layout used by WebGL readback, masks, worldToPixel, and
 * polygon UV generation.
 * @param {string} server
 * @param {Object} roundTrip
 * @param {{ sampleId: string, viewId: string }} params
 * @returns {Promise<{ data: Uint8ClampedArray, width: number, height: number, colorSpace: string, source: string }|null>}
 */
export async function pollBakedImage(server, roundTrip = {}, { sampleId, viewId } = {}) {
    const pollIntervalMs = roundTrip.pollIntervalMs ?? 1000;
    const timeoutMs = roundTrip.timeoutMs ?? 180000;
    const endpoint = roundTrip.resultEndpoint ?? "/bake/result";
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = await fetchBakeResult(server, { sampleId, viewId, endpoint });

        if (result.status === "ready" && result.blob) {
            const decoded = await decodeBlobToRgba(result.blob);
            return {
                ...decoded,
                data: flipRgbaRows(decoded.data, decoded.width, decoded.height),
                colorSpace: "srgb",
                source: "model",
            };
        }

        if (result.status === "not_found") {
            return null;
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    console.warn(`Bake round-trip timed out for ${sampleId}; using raw beauty render`);
    return null;
}
