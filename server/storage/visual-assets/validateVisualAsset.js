import {
    VISUAL_ASSET_PROFILE,
    canonicalExactStringify,
} from "../../../app/simulation/visual/VisualLayer.js";
import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";
import { inspectVisualAssetBytes, sniffMediaType } from "./mediaInspectors.js";
import { gltfJsonFromChunk, preflightGltf } from "./gltfPreflight.js";
import { runGltfValidator } from "./gltfValidatorHost.js";

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
        const preflight = preflightGltf({
            json,
            binBytes: inspected.binBytes ?? null,
            limits,
            declaredDependencies,
        });
        graph = {
            depth: preflight.depth,
            nodes: preflight.nodeCount,
            triangles: preflight.triangles,
            uris: preflight.uris.map((entry) => entry.uri),
        };
        decodedBytesEstimate += preflight.decodedBytesEstimate;
        const report = await runGltfValidator(bytes, {
            uri: asset.mediaType === "model/gltf-binary" ? "asset.glb" : "asset.gltf",
            resources,
            timeoutMs: timeoutMs ?? limits.validationTimeoutMs,
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
        version: 1,
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

export function canonicalValidationRecord(record, useHash) {
    const value = {
        ...record,
        useHash,
    };
    return JSON.parse(canonicalExactStringify(value));
}
