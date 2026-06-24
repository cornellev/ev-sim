function linearByteToSrgbByte(value) {
    const linear = Math.max(0, Math.min(1, value / 255));
    const srgb = linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
}

/**
 * Prepare WebGL readback pixels for image encoding.
 * WebGL readRenderTargetPixels returns bottom-left-origin rows and, for this
 * offscreen path, linear-ish RGB values. PNG/canvas expects top-left sRGB.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ flipY?: boolean, linearToSrgb?: boolean }} [options]
 * @returns {Uint8ClampedArray}
 */
export function prepareRgbaForPng(rgba, width, height, options = {}) {
    const {
        flipY = true,
        linearToSrgb = true,
    } = options;

    const output = new Uint8ClampedArray(width * height * 4);
    const rowStride = width * 4;

    for (let y = 0; y < height; y++) {
        const sourceY = flipY ? height - 1 - y : y;
        const sourceRow = sourceY * rowStride;
        const targetRow = y * rowStride;

        for (let x = 0; x < rowStride; x += 4) {
            const sourceIndex = sourceRow + x;
            const targetIndex = targetRow + x;

            output[targetIndex + 0] = linearToSrgb ? linearByteToSrgbByte(rgba[sourceIndex + 0]) : rgba[sourceIndex + 0];
            output[targetIndex + 1] = linearToSrgb ? linearByteToSrgbByte(rgba[sourceIndex + 1]) : rgba[sourceIndex + 1];
            output[targetIndex + 2] = linearToSrgb ? linearByteToSrgbByte(rgba[sourceIndex + 2]) : rgba[sourceIndex + 2];
            output[targetIndex + 3] = rgba[sourceIndex + 3];
        }
    }

    return output;
}

/**
 * Convert an RGBA frame buffer into a right-side-up, display-space PNG blob for upload.
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ flipY?: boolean, linearToSrgb?: boolean }} [options]
 * @returns {Promise<Blob>}
 */
export function rgbaToPngBlob(rgba, width, height, options = {}) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        if (!context) {
            reject(new Error("Unable to create canvas context for bake upload"));
            return;
        }

        const imageData = context.createImageData(width, height);
        imageData.data.set(prepareRgbaForPng(rgba, width, height, options));
        context.putImageData(imageData, 0, 0);

        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("Failed to encode bake frame as PNG"));
                return;
            }
            resolve(blob);
        }, "image/png");
    });
}

/**
 * @param {{ host: string, endpoint: string }} server
 * @returns {Promise<boolean>}
 */
export async function checkBakeServerHealth(server) {
    try {
        const response = await fetch(`${server.host}/healthz`);
        if (!response.ok) return false;
        const payload = await response.json();
        return payload?.success === true;
    } catch {
        return false;
    }
}

/**
 * @param {{ host: string, endpoint: string }} server
 * @param {Blob} blob
 * @param {Record<string, string|number|boolean>} metadata
 * @returns {Promise<boolean>}
 */
export async function uploadBakeFrame(server, blob, metadata = {}) {
    const formData = new FormData();
    const filename = metadata.filename || `frame_${metadata.frameIndex ?? Date.now()}.png`;
    formData.append("photo", blob, filename);

    for (const [key, value] of Object.entries(metadata)) {
        if (key === "filename") continue;
        formData.append(key, String(value));
    }

    const response = await fetch(`${server.host}${server.endpoint}`, {
        method: "POST",
        body: formData,
    });

    return response.ok;
}

export async function clearBakeServer(server) {
    try {
        const response = await fetch(`${server.host}/clear`);
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Signal that all files for a sample have been uploaded.
 * @param {{ host: string, endpoint: string }} server
 * @param {Record<string, string|number|boolean>} metadata
 * @returns {Promise<boolean>}
 */
export async function uploadSampleComplete(server, metadata = {}) {
    try {
        const response = await fetch(`${server.host}/bake/complete`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(metadata),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Serial upload queue to avoid flooding the bake server.
 */
export class BakeUploadQueue {
    constructor(server) {
        this.server = server;
        this.queue = [];
        this.processing = false;
    }

    /**
     * @param {Blob} blob
     * @param {Record<string, string|number|boolean>} metadata
     */
    enqueue(blob, metadata = {}) {
        this.queue.push({ blob, metadata });
        this._process();
    }

    async _process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await uploadBakeFrame(this.server, item.blob, item.metadata);
            } catch (error) {
                console.warn("Bake upload failed:", error);
            }
        }

        this.processing = false;
    }
}
