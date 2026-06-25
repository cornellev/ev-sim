function clampByte(value) {
    return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

function linearByteToSrgbByte(value) {
    const linear = Math.max(0, Math.min(1, value / 255));
    const srgb = linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    return clampByte(srgb);
}

function sourceByteForColorSpace(image, index, targetColorSpace) {
    if ((targetColorSpace ?? image?.colorSpace) === "srgb" && image?.colorSpace === "linear") {
        return linearByteToSrgbByte(image.data[index]);
    }
    return image.data[index];
}

/**
 * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }|null} maskImage
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
export function maskAllowsPixel(maskImage, px, py) {
    if (!maskImage?.data) return true;
    if (px < 0 || py < 0 || px >= maskImage.width || py >= maskImage.height) return false;

    const idx = (py * maskImage.width + px) * 4;
    return maskImage.data[idx + 3] > 0 && maskImage.data[idx] > 0;
}

/**
 * @param {number} imageWidth
 * @param {{ enabled?: boolean, widthPx?: number, widthRatio?: number }|number|undefined} config
 * @returns {{ enabled: boolean, xMin: number, xMax: number, width: number }}
 */
export function buildCenterSliverBounds(imageWidth, config = {}) {
    const normalized = typeof config === "number" ? { widthPx: config } : (config ?? {});
    if (normalized.enabled === false || imageWidth <= 0) {
        return { enabled: false, xMin: 0, xMax: imageWidth, width: imageWidth };
    }

    const requestedWidth = normalized.widthPx
        ?? (normalized.widthRatio ? imageWidth * normalized.widthRatio : imageWidth);
    const width = Math.max(1, Math.min(imageWidth, Math.round(requestedWidth)));
    const xMin = Math.max(0, Math.floor((imageWidth - width) / 2));
    const xMax = Math.min(imageWidth, xMin + width);

    return { enabled: true, xMin, xMax, width: xMax - xMin };
}

/**
 * @param {number} px
 * @param {{ enabled?: boolean, xMin: number, xMax: number }|null} bounds
 * @returns {boolean}
 */
export function pixelInSliver(px, bounds) {
    if (!bounds?.enabled) return true;
    return px >= bounds.xMin && px < bounds.xMax;
}

/**
 * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }|null} maskImage
 * @param {{ enabled?: boolean, xMin: number, xMax: number }|null} bounds
 * @returns {number}
 */
export function countMaskPixelsInSliver(maskImage, bounds) {
    if (!maskImage?.data) return 0;

    const xMin = bounds?.enabled ? bounds.xMin : 0;
    const xMax = bounds?.enabled ? bounds.xMax : maskImage.width;
    let count = 0;

    for (let y = 0; y < maskImage.height; y += 1) {
        for (let x = xMin; x < xMax; x += 1) {
            if (maskAllowsPixel(maskImage, x, y)) count += 1;
        }
    }

    return count;
}

/**
 * Keep model changes inside the process mask. Pixels outside the mask are copied
 * from the original capture in the returned image's color space.
 *
 * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number, colorSpace?: string, source?: string }} baseImage
 * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number, colorSpace?: string, source?: string }} processedImage
 * @param {{ data: Uint8Array|Uint8ClampedArray, width: number, height: number }|null} maskImage
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, colorSpace?: string, source?: string }}
 */
export function composeImageThroughMask(baseImage, processedImage, maskImage) {
    if (!baseImage?.data || !processedImage?.data) return processedImage;
    if (
        baseImage.width !== processedImage.width
        || baseImage.height !== processedImage.height
        || maskImage?.width !== processedImage.width
        || maskImage?.height !== processedImage.height
    ) {
        return processedImage;
    }

    const output = new Uint8ClampedArray(processedImage.data.length);
    const targetColorSpace = processedImage.colorSpace ?? baseImage.colorSpace;

    for (let i = 0; i < output.length; i += 4) {
        const pixelIndex = i / 4;
        const x = pixelIndex % processedImage.width;
        const y = Math.floor(pixelIndex / processedImage.width);
        const useProcessed = maskAllowsPixel(maskImage, x, y);
        const source = useProcessed ? processedImage : baseImage;

        output[i + 0] = useProcessed
            ? source.data[i + 0]
            : sourceByteForColorSpace(source, i + 0, targetColorSpace);
        output[i + 1] = useProcessed
            ? source.data[i + 1]
            : sourceByteForColorSpace(source, i + 1, targetColorSpace);
        output[i + 2] = useProcessed
            ? source.data[i + 2]
            : sourceByteForColorSpace(source, i + 2, targetColorSpace);
        output[i + 3] = useProcessed ? source.data[i + 3] : source.data[i + 3];
    }

    return {
        ...processedImage,
        data: output,
        colorSpace: targetColorSpace,
        source: processedImage.source,
    };
}
