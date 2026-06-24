import { fetchBakeResult } from "./bakeUpload";

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
 * Decoded PNG bytes are sRGB (top-left origin); the canvas readback below keeps
 * top-left origin which matches the WebGL bottom-left layout after the model
 * flips during PNG encode/decode, so it lines up with worldToPixel sampling.
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
            return { ...decoded, colorSpace: "srgb", source: "model" };
        }

        if (result.status === "not_found") {
            return null;
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    console.warn(`Bake round-trip timed out for ${sampleId}; using raw beauty render`);
    return null;
}
