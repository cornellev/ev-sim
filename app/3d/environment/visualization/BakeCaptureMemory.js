const BYTES_PER_RGBA_PIXEL = 4;

// A capture this large is already well beyond the editor's normal 1920x1080
// output. Reject it explicitly instead of asking the browser to attempt an
// effectively unbounded ArrayBuffer allocation.
export const MAX_CAPTURE_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Validate an RGBA capture size and return its typed-array length.
 * @param {number} width
 * @param {number} height
 * @param {number} [maxBytes]
 * @returns {number}
 */
export function rgbaBufferLength(width, height, maxBytes = MAX_CAPTURE_BUFFER_BYTES) {
    if (!Number.isSafeInteger(width) || width <= 0) {
        throw new RangeError(`Bake camera width must be a positive integer; received ${width}`);
    }
    if (!Number.isSafeInteger(height) || height <= 0) {
        throw new RangeError(`Bake camera height must be a positive integer; received ${height}`);
    }

    const pixelCount = width * height;
    const byteLength = pixelCount * BYTES_PER_RGBA_PIXEL;
    if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
        const requestedMiB = Number.isFinite(byteLength)
            ? (byteLength / (1024 * 1024)).toFixed(1)
            : "an invalid amount of";
        const maximumMiB = (maxBytes / (1024 * 1024)).toFixed(0);
        throw new RangeError(
            `Bake camera resolution ${width}x${height} requires ${requestedMiB} MiB `
            + `per RGBA buffer; the editor limit is ${maximumMiB} MiB`,
        );
    }

    return byteLength;
}
