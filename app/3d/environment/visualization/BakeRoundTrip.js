import {
    checkBakeServerHealth,
    fetchBakeResult,
    rgbaToPngBlob,
    uploadBakeFrame,
    uploadSampleComplete,
} from "./bakeUpload";

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
 * @param {Object} capture
 * @returns {{ data: Uint8Array, width: number, height: number }|null}
 */
export function getRawBeautyImage(capture) {
    const beauty = capture?.passes?.find((pass) => pass.kind === "render" && pass.passId === "beauty");
    if (!beauty?.data) return null;
    return {
        data: beauty.data,
        width: beauty.width,
        height: beauty.height,
    };
}

/**
 * Poll the bake server for a processed image, falling back to raw beauty.
 * @param {Object} params
 * @returns {Promise<{ data: Uint8ClampedArray|Uint8Array, width: number, height: number, source: string }>}
 */
export async function getBakedImage({
    server,
    roundTrip = {},
    capture,
    view,
    sampleMetadata = {},
    maskPassFrame = null,
}) {
    const raw = getRawBeautyImage(capture);
    if (!raw) {
        throw new Error("Missing beauty pass for bake round-trip");
    }

    const useModel = roundTrip.useModel === true;
    if (!useModel) {
        return { ...raw, source: "raw" };
    }

    const healthy = await checkBakeServerHealth(server);
    if (!healthy) {
        console.warn("Bake server unreachable; using raw beauty render");
        return { ...raw, source: "raw-fallback" };
    }

    const viewSlug = view.name.replace(/\//g, "_");
    const uploads = [];

    const beautyBlob = await rgbaToPngBlob(
        raw.data,
        raw.width,
        raw.height,
        { linearToSrgb: true },
    );
    uploads.push(uploadBakeFrame(server, beautyBlob, {
        ...sampleMetadata,
        filename: `render_beauty_${viewSlug}.png`,
        fileRole: "render",
        passId: "beauty",
    }));

    if (maskPassFrame?.data) {
        const maskBlob = await rgbaToPngBlob(
            maskPassFrame.data,
            maskPassFrame.width,
            maskPassFrame.height,
            { linearToSrgb: false },
        );
        uploads.push(uploadBakeFrame(server, maskBlob, {
            ...sampleMetadata,
            filename: `mask_non_road_${viewSlug}.png`,
            fileRole: "mask",
            passId: "mask_non_road",
            maskTags: "no_road",
            processTag: "no_road_building",
            excludeTags: "road",
        }));
    }

    await Promise.all(uploads);

    const expectedFiles = uploads.length;
    await uploadSampleComplete(server, {
        ...sampleMetadata,
        expectedFiles,
    });

    const pollIntervalMs = roundTrip.pollIntervalMs ?? 1000;
    const timeoutMs = roundTrip.timeoutMs ?? 180000;
    const endpoint = roundTrip.resultEndpoint ?? "/bake/result";
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = await fetchBakeResult(server, {
            sampleId: sampleMetadata.sampleId,
            viewId: view.name,
            endpoint,
        });

        if (result.status === "ready" && result.blob) {
            const decoded = await decodeBlobToRgba(result.blob);
            return { ...decoded, source: "model" };
        }

        if (result.status === "not_found") {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    console.warn("Bake round-trip timed out; using raw beauty render");
    return { ...raw, source: "raw-timeout" };
}
