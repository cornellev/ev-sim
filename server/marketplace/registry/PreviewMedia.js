import { promises as fs } from "node:fs";

import sharp from "sharp";

import { MARKETPLACE_LIMITS, MARKETPLACE_PREVIEW_MEDIA_TYPES } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import { readRegularBytes } from "./RegistryFs.js";

export const PREVIEW_MAX_PIXELS = 64 * 1024 * 1024;

const formatByMediaType = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
});

function invalid(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message);
}

function assertExactContainer(bytes, format) {
    if (format === "png") {
        if (bytes.length < 20 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            invalid("Preview is not a PNG container.");
        }
        let offset = 8;
        let ended = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset);
            const end = offset + 12 + length;
            if (!Number.isSafeInteger(end) || end > bytes.length) invalid("PNG preview is truncated.");
            const type = bytes.toString("ascii", offset + 4, offset + 8);
            offset = end;
            if (type === "IEND") {
                ended = true;
                break;
            }
        }
        if (!ended || offset !== bytes.length) invalid("PNG preview has trailing or malformed data.");
        return;
    }
    if (format === "jpeg") {
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
            || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
            invalid("JPEG preview is truncated or has trailing data.");
        }
        return;
    }
    if (format === "webp") {
        if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF"
            || bytes.toString("ascii", 8, 12) !== "WEBP"
            || bytes.readUInt32LE(4) + 8 !== bytes.length) {
            invalid("WebP preview is truncated or has trailing data.");
        }
    }
}

export function assertPreviewMediaType(mediaType) {
    if (!MARKETPLACE_PREVIEW_MEDIA_TYPES.includes(mediaType)) {
        invalid("Preview media type must be image/png, image/jpeg, or image/webp.");
    }
    return mediaType;
}

export async function inspectPreviewBytes(rawBytes, { mediaType }) {
    assertPreviewMediaType(mediaType);
    const bytes = Buffer.from(rawBytes);
    if (bytes.byteLength > MARKETPLACE_LIMITS.previewBytes) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `Preview exceeds ${MARKETPLACE_LIMITS.previewBytes} bytes.`);
    }
    const declaredFormat = formatByMediaType[mediaType];
    assertExactContainer(bytes, declaredFormat);
    let metadata;
    try {
        const image = sharp(bytes, {
            animated: true,
            failOn: "error",
            limitInputPixels: PREVIEW_MAX_PIXELS,
            sequentialRead: true,
        });
        metadata = await image.metadata();
        if (metadata.format !== declaredFormat) invalid(`Preview bytes are ${metadata.format ?? "unknown"}, not ${declaredFormat}.`);
        if (!Number.isSafeInteger(metadata.width) || metadata.width < 1
            || !Number.isSafeInteger(metadata.height) || metadata.height < 1) invalid("Preview dimensions must be positive integers.");
        if (metadata.width * metadata.height > PREVIEW_MAX_PIXELS) invalid(`Preview exceeds ${PREVIEW_MAX_PIXELS} decoded pixels.`);
        if ((metadata.pages ?? 1) !== 1) invalid("Animated or multi-page previews are not allowed.");
        await image.clone().raw().toBuffer();
    } catch (error) {
        if (error?.code && Object.values(MARKETPLACE_ERROR_CODES).includes(error.code)) throw error;
        invalid(`Preview image validation failed: ${error.message}`);
    }
    return Object.freeze({
        mediaType,
        sha256: hashMarketplaceBytes(bytes),
        sizeBytes: bytes.byteLength,
        format: declaredFormat,
        width: metadata.width,
        height: metadata.height,
        pages: 1,
    });
}

export async function inspectPreviewFile(filePath, options) {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) invalid("Preview input must be a regular non-symlink file.");
    return inspectPreviewBytes(await readRegularBytes(filePath, { maxBytes: MARKETPLACE_LIMITS.previewBytes }), options);
}
