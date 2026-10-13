/** Vehicle model ingestion. Editor-asset import defaults stay on their own planners. */

import { sniffImageMediaType } from "../../editor-assets/GltfImportPlan.js";
import { encodeMeshDocumentGlb } from "../../editor-assets/mesh/MeshGlbEncoder.js";
import { parseObjPackage } from "../../editor-assets/mesh/ObjParser.js";
import { parseStl } from "../../editor-assets/mesh/StlParser.js";
import { GLB_BIN_CHUNK, readGlb } from "../../simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../../simulation/visual/VisualLayer.js";
import { packVehicleGltf } from "./packVehicleGltf.js";
import { validateVehicleModelClosure } from "./validateVehicleModel.js";
import { normalizeVehicleEntry, resolveVehicleUri } from "./vehiclePackagePaths.js";

const VEHICLE_GENERATOR = "cev-sim.vehicle-glb@1";
const DATA_URI_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Import files require Uint8Array or ArrayBuffer bytes.");
}

function extensionOf(path) {
    return String(path).toLowerCase().split(".").at(-1);
}

function decodeBase64(text) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function decodeDataUri(uri) {
    const match = String(uri).match(DATA_URI_PATTERN);
    if (!match || match[2].length % 4 !== 0) throw new Error("Embedded data URI must be a canonical base64 data URI.");
    return { mediaType: match[1], bytes: decodeBase64(match[2]) };
}

function selectedFiles(files) {
    const selected = new Map();
    for (const file of files ?? []) {
        const path = normalizeVehicleEntry(file?.path);
        if (selected.has(path)) throw new Error(`Selected package contains ambiguous path "${path}".`);
        selected.set(path, bytesOf(file.bytes));
    }
    return selected;
}

function readModel(bytes, mediaType) {
    if (mediaType === "model/gltf-binary") {
        const parsed = readGlb(bytes, {
            requireTotalLength: true,
            requireAligned: true,
            requireLeadingJson: true,
            json: "last",
            jsonPadding: "whitespace",
            copyChunks: true,
            ErrorType: Error,
            headerMessage: "Entry GLB has an invalid version-2 header.",
            chunkMessage: "Entry GLB has an invalid chunk table.",
        });
        const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
        return { json: parsed.json, bin };
    }
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        throw new Error(`Entry model is not valid glTF JSON: ${error.message}`);
    }
    return { json, bin: null };
}

function bufferPayloads(json, bin, selected, entry) {
    const payloads = [];
    for (const [index, buffer] of (json.buffers ?? []).entries()) {
        const uri = buffer?.uri;
        if (uri === undefined || uri === "") {
            if (index !== 0 || !bin) throw new Error(`GLTF buffer ${index} has no URI or GLB binary chunk.`);
            payloads[index] = bin;
            continue;
        }
        if (String(uri).startsWith("data:")) {
            payloads[index] = decodeDataUri(uri).bytes;
            continue;
        }
        const dependencyPath = resolveVehicleUri(entry, uri);
        const bytes = selected.get(dependencyPath);
        if (!bytes) throw new Error(`GLTF dependency "${dependencyPath}" was not selected.`);
        payloads[index] = bytes;
    }
    return payloads;
}

function imagePayloads(json, selected, entry) {
    return (json.images ?? []).map((image) => {
        const uri = image?.uri;
        if (typeof uri !== "string" || uri.startsWith("data:") || Number.isInteger(image?.bufferView)) return null;
        const dependencyPath = resolveVehicleUri(entry, uri);
        if (!dependencyPath) return null;
        const bytes = selected.get(dependencyPath);
        if (!bytes) throw new Error(`GLTF dependency "${dependencyPath}" was not selected.`);
        return bytes;
    });
}

function closureFromPacked(entry, packed) {
    validateVehicleModelClosure({ glbBytes: packed.glbBytes, dependencies: packed.dependencies });
    const sha256 = sha256ExactBytes(packed.glbBytes);
    return {
        kind: "cev-sim.vehicle-model-import",
        version: 1,
        entryPath: entry,
        mediaType: "model/gltf-binary",
        asset: {
            name: `${sha256}.glb`,
            mediaType: "model/gltf-binary",
            sha256,
            size: packed.glbBytes.byteLength,
            bytes: packed.glbBytes,
        },
        dependencies: packed.dependencies,
        nodes: packed.nodes,
    };
}

function packGltfBytes(bytes, mediaType, selected, entry) {
    const parsed = readModel(bytes, mediaType);
    return packVehicleGltf({
        json: parsed.json,
        buffers: bufferPayloads(parsed.json, parsed.bin, selected, entry),
        imageBytes: imagePayloads(parsed.json, selected, entry),
    });
}

function packMeshDocument(document) {
    const encoded = encodeMeshDocumentGlb(document);
    const parsed = readGlb(encoded.glbBytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
        ErrorType: Error,
    });
    const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
    const buffers = (parsed.json.buffers ?? []).map((buffer, index) => (index === 0 ? bin?.subarray(0, Number(buffer.byteLength) || bin.length) : null));
    const imageBytes = (parsed.json.images ?? []).map((image) => {
        const match = encoded.images.find((entry) => entry.path === image.uri);
        if (!match) throw new Error(`Mesh image "${image.uri}" was not declared.`);
        sniffImageMediaType(match.bytes);
        return match.bytes;
    });
    return packVehicleGltf({
        json: parsed.json,
        buffers,
        imageBytes,
        generator: VEHICLE_GENERATOR,
    });
}

/**
 * Plan a canonical vehicle GLB closure.
 * Accepts `.glb`, `.gltf`, `.obj`, and `.stl`. PLY and remote URLs are rejected.
 */
export function createVehicleModelImportPlan(files, { entryPath } = {}) {
    const selected = selectedFiles(files);
    const entry = normalizeVehicleEntry(entryPath);
    const source = selected.get(entry);
    if (!source) throw new Error(`Entry model "${entry}" is not among the selected files.`);
    const extension = extensionOf(entry);
    if (extension === "gltf" || extension === "glb") {
        const mediaType = extension === "glb" ? "model/gltf-binary" : "model/gltf+json";
        return closureFromPacked(entry, packGltfBytes(source, mediaType, selected, entry));
    }
    if (extension === "obj") {
        if (entry.startsWith("/")) throw new Error("Entry model must be .gltf, .glb, .obj, or .stl.");
        const document = parseObjPackage(files, entry, { fallbackName: "part" });
        return closureFromPacked(entry, packMeshDocument(document));
    }
    if (extension === "stl") {
        return closureFromPacked(entry, packMeshDocument(parseStl(source, "part-0")));
    }
    throw new Error("Entry model must be .gltf, .glb, .obj, or .stl.");
}

/** Adapter for `planVehicleMigration`'s `encodeModel` hook. */
export function encodeVehicleModelForMigration({ entry, inputs }) {
    const plan = createVehicleModelImportPlan(
        (inputs ?? []).map((input) => ({ path: input.name, bytes: input.bytes })),
        { entryPath: entry },
    );
    return {
        asset: plan.asset.name,
        dependencies: plan.dependencies.map((file) => file.name),
        files: [plan.asset, ...plan.dependencies],
    };
}
