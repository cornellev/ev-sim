import {
    VISUAL_ASSET_PROFILE,
    canonicalExactStringify,
} from "../../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";
import { inspectVisualAssetBytes, sniffMediaType } from "./mediaInspectors.js";
import { gltfJsonFromChunk, preflightGltf } from "./gltfPreflight.js";
import { runGltfValidator } from "./gltfValidatorHost.js";

export const VISUAL_ASSET_VALIDATION_VERSION = 2;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/ktx2"]);

export async function validateVisualAssetBytes(bytes, {
    asset,
    limits,
    declaredDependencies = {},
    resources = {},
    timeoutMs,
    memoryMb,
} = {}) {
    const observed = sniffMediaType(bytes);
    if (asset.mediaType !== "application/octet-stream" && observed !== asset.mediaType) {
        if (!(asset.mediaType === "model/gltf+json" && observed === "model/gltf+json")) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA,
                `Declared media type ${asset.mediaType} does not match observed type ${observed}.`,
            );
        }
    }
    if (bytes.length !== asset.sizeBytes) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
            `Declared size ${asset.sizeBytes} does not match observed ${bytes.length} bytes.`,
        );
    }

    const inspected = inspectVisualAssetBytes(bytes, asset.mediaType, limits);
    let graph = {
        depth: 0,
        nodes: 0,
        triangles: 0,
        uris: [],
    };
    let decodedBytesEstimate = inspected.decodedBytesEstimate;
    let validator = { id: "cev-sim.media-inspector", version: 1 };

    if (asset.mediaType === "model/gltf-binary" || asset.mediaType === "model/gltf+json") {
        const json = asset.mediaType === "model/gltf-binary"
            ? gltfJsonFromChunk(inspected.jsonBytes)
            : gltfJsonFromChunk(bytes);
        const deadline = Date.now() + (timeoutMs ?? limits.validationTimeoutMs);
        const preflight = preflightGltf({
            json,
            binBytes: inspected.binBytes ?? null,
            limits,
            declaredDependencies,
            deadline,
        });
        graph = {
            depth: preflight.depth,
            nodes: preflight.nodeCount,
            triangles: preflight.triangles,
            uris: preflight.uris.map((entry) => entry.uri),
        };
        decodedBytesEstimate += preflight.decodedBytesEstimate;
        const images = inspectGltfImages({
            json,
            binBytes: inspected.binBytes ?? null,
            resources,
            limits,
            deadline,
        });
        decodedBytesEstimate += images.embeddedDecodedBytes;
        graph.images = images.records;
        const remainingValidationMs = Math.max(1, deadline - Date.now());
        const report = await runGltfValidator(bytes, {
            uri: asset.mediaType === "model/gltf-binary" ? "asset.glb" : "asset.gltf",
            resources,
            timeoutMs: remainingValidationMs,
            memoryMb: memoryMb ?? limits.validatorMemoryMb,
        });
        validator = {
            id: "gltf-validator",
            version: report.validatorVersion ?? "2.0.0-dev.3.10",
        };
    } else if (Object.keys(declaredDependencies).length > 0) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
            "Non-glTF assets cannot declare dependency-use mappings.",
        );
    }

    return {
        kind: "cev-sim.visual-asset-validation",
        version: VISUAL_ASSET_VALIDATION_VERSION,
        asset: {
            sha256: asset.sha256,
            mediaType: asset.mediaType,
            sizeBytes: asset.sizeBytes,
            role: asset.role,
        },
        profile: VISUAL_ASSET_PROFILE,
        validator,
        decodedBytesEstimate,
        graph,
        inspected: {
            width: inspected.width,
            height: inspected.height,
            mipLevels: inspected.mipLevels,
        },
    };
}

function inspectGltfImages({ json, binBytes, resources, limits, deadline }) {
    const records = [];
    let embeddedDecodedBytes = 0;
    for (const [index, image] of (json.images ?? []).entries()) {
        if (Date.now() > deadline) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.VALIDATION_TIMEOUT,
                "Embedded image validation exceeded its time limit.",
            );
        }
        const source = imageSourceBytes(index, image, json, binBytes, resources);
        const observed = sniffMediaType(source.bytes);
        const mediaType = image.mimeType ?? source.mediaType ?? observed;
        if (!IMAGE_MEDIA_TYPES.has(mediaType) || observed !== mediaType) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA,
                `glTF image ${index} has unsupported or mismatched media type ${mediaType}.`,
            );
        }
        const result = inspectVisualAssetBytes(source.bytes, mediaType, limits);
        if (source.embedded) embeddedDecodedBytes += result.decodedBytesEstimate;
        records.push({
            index,
            mediaType,
            width: result.width,
            height: result.height,
            mipLevels: result.mipLevels,
            decodedBytesEstimate: result.decodedBytesEstimate,
            embedded: source.embedded,
        });
    }
    return { records, embeddedDecodedBytes };
}

function imageSourceBytes(index, image, json, binBytes, resources) {
    if (image.uri !== undefined) {
        if (String(image.uri).startsWith("data:")) {
            const decoded = decodeDataUri(image.uri, `images.${index}.uri`);
            return { ...decoded, embedded: true };
        }
        const bytes = resources[image.uri];
        if (!bytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
                `glTF image ${index} does not resolve through the declared digest graph.`,
            );
        }
        return { bytes: Buffer.from(bytes), mediaType: null, embedded: false };
    }
    if (!Number.isInteger(image.bufferView)) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, `glTF image ${index} has no source.`);
    }
    const view = json.bufferViews?.[image.bufferView];
    const buffer = json.buffers?.[view?.buffer];
    if (!view || !buffer) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, `glTF image ${index} has an invalid bufferView.`);
    }
    let bytes;
    if (buffer.uri === undefined) {
        bytes = binBytes;
    } else if (String(buffer.uri).startsWith("data:")) {
        bytes = decodeDataUri(buffer.uri, `buffers.${view.buffer}.uri`).bytes;
    } else {
        bytes = resources[buffer.uri];
    }
    if (!bytes) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, `glTF image ${index} buffer bytes are missing.`);
    }
    const start = Number(view.byteOffset) || 0;
    const end = start + (Number(view.byteLength) || 0);
    if (end > bytes.length) {
        throw visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, `glTF image ${index} bufferView overflows its buffer.`);
    }
    return { bytes: Buffer.from(bytes).subarray(start, end), mediaType: image.mimeType ?? null, embedded: true };
}

function decodeDataUri(uri, path) {
    const match = String(uri).match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
    if (!match || match[2].length % 4 !== 0) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA,
            `${path} must be a canonical base64 data URI.`,
        );
    }
    return { mediaType: match[1], bytes: Buffer.from(match[2], "base64") };
}

export function canonicalValidationRecord(record, useHash) {
    const value = {
        ...record,
        useHash,
    };
    return JSON.parse(canonicalExactStringify(value));
}
