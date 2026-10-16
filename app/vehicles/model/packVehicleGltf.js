/** Deterministic vehicle GLB. Geometry is packed into one BIN chunk; images become sibling files. */

import { sniffImageMediaType } from "../../editor-assets/GltfImportPlan.js";
import { GLB_BIN_CHUNK, readGlb, writeGlb } from "../../simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../../simulation/visual/VisualLayer.js";
import { assertVehicleGltfGraph } from "./validateVehicleModel.js";

const EXTENSIONS = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/ktx2": "ktx2",
});
const DATA_URI_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Import files require Uint8Array or ArrayBuffer bytes.");
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

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
}

function payloadOf(buffer, bytes) {
    const source = bytesOf(bytes);
    const declared = Number(buffer?.byteLength);
    if (Number.isFinite(declared)) {
        if (!Number.isSafeInteger(declared) || declared < 0) throw new Error("GLTF buffer byteLength is invalid.");
        if (source.byteLength < declared) throw new Error("GLTF buffer is shorter than its byteLength.");
        return source.subarray(0, declared);
    }
    return source;
}

function assignOrdinalNames(json) {
    let ordinal = 0;
    for (const node of json.nodes ?? []) {
        if (typeof node.name !== "string" || node.name.trim() === "") {
            node.name = `part-${ordinal}`;
            ordinal += 1;
        }
    }
}

function nodeTable(json) {
    const nodes = json.nodes ?? [];
    const parent = new Array(nodes.length).fill(-1);
    nodes.forEach((node, index) => {
        for (const child of node.children ?? []) {
            if (Number.isInteger(child) && child >= 0 && child < nodes.length && parent[child] < 0) parent[child] = index;
        }
    });
    const pathOf = (index) => {
        const names = [];
        const seen = new Set();
        let cursor = index;
        while (cursor >= 0 && !seen.has(cursor)) {
            seen.add(cursor);
            names.push(String(nodes[cursor].name ?? ""));
            cursor = parent[cursor];
        }
        return names.reverse();
    };
    return nodes.map((node, index) => ({ index, name: String(node.name ?? ""), path: pathOf(index) }));
}

function contentAddressedImage(bytes, declaredMediaType) {
    const copy = bytesOf(bytes);
    const mediaType = sniffImageMediaType(copy);
    if (declaredMediaType && declaredMediaType !== mediaType) {
        throw new Error(`Embedded image media type ${declaredMediaType} does not match observed ${mediaType}.`);
    }
    const sha256 = sha256ExactBytes(copy);
    const extension = EXTENSIONS[mediaType];
    return {
        name: `${sha256}.${extension}`,
        mediaType,
        sha256,
        size: copy.byteLength,
        bytes: copy,
    };
}

function imageSourceBytes(image, index, payloads, originalViews, imageBytes) {
    const hasUri = typeof image?.uri === "string";
    const hasView = Number.isInteger(image?.bufferView);
    if (hasUri && hasView) throw new Error(`GLTF image ${index} cannot declare both uri and bufferView.`);
    if (hasView) {
        const view = originalViews[image.bufferView];
        const payload = view ? payloads[view.buffer] : null;
        if (!view || !payload) throw new Error(`GLTF image ${index} has no source-bound buffer bytes.`);
        const start = Number(view.byteOffset) || 0;
        const end = start + (Number(view.byteLength) || 0);
        if (end > payload.byteLength) throw new Error(`GLTF image ${index} bufferView overflows its buffer.`);
        return { bytes: payload.slice(start, end), declared: image.mimeType };
    }
    if (hasUri && image.uri.startsWith("data:")) {
        const decoded = decodeDataUri(image.uri);
        return { bytes: decoded.bytes, declared: image.mimeType || decoded.mediaType };
    }
    const provided = imageBytes[index];
    if (provided) return { bytes: provided, declared: image.mimeType };
    throw new Error(`GLTF image ${index} was not selected.`);
}

function rewriteImages(json, payloads, originalViews, imageBytes) {
    const saved = new Map();
    for (const [index, image] of (json.images ?? []).entries()) {
        const source = imageSourceBytes(image, index, payloads, originalViews, imageBytes);
        const addressed = contentAddressedImage(source.bytes, source.declared);
        if (!saved.has(addressed.sha256)) saved.set(addressed.sha256, addressed);
        delete image.bufferView;
        image.uri = addressed.name;
        image.mimeType = addressed.mediaType;
    }
    if (!json.images || json.images.length === 0) delete json.images;
    return [...saved.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function retargetAccessor(accessor, remap) {
    if (!accessor || accessor.bufferView === undefined) return;
    const next = remap.get(accessor.bufferView);
    if (next === undefined) throw new Error("GLTF accessor references an image bufferView.");
    accessor.bufferView = next;
}

function appendAligned(pieces, cursor, bytes) {
    const aligned = Math.ceil(cursor / 4) * 4;
    const gap = aligned - cursor;
    if (gap > 0) pieces.push(new Uint8Array(gap));
    pieces.push(bytes);
    return aligned;
}

function repackBuffers(json, payloads, imageViewIndexes) {
    const originalViews = (json.bufferViews ?? []).map((view) => ({ ...view }));
    const kept = [];
    const remap = new Map();
    originalViews.forEach((view, index) => {
        if (imageViewIndexes.has(index)) return;
        remap.set(index, kept.length);
        kept.push(view);
    });
    const pieces = [];
    let cursor = 0;
    const take = (bytes) => {
        const offset = appendAligned(pieces, cursor, bytes);
        cursor = offset + bytes.byteLength;
        return offset;
    };
    if (kept.length > 0) {
        for (const view of kept) {
            const source = payloads[view.buffer];
            if (!source) throw new Error("GLTF bufferView references a missing buffer.");
            const start = Number(view.byteOffset) || 0;
            const length = Number(view.byteLength) || 0;
            if (start + length > source.byteLength) throw new Error("GLTF bufferView overflows its buffer.");
            view.byteOffset = take(source.slice(start, start + length));
            view.buffer = 0;
        }
        json.bufferViews = kept;
    } else if (originalViews.length === 0) {
        for (const source of payloads) {
            if (source?.byteLength) take(source.slice());
        }
        delete json.bufferViews;
    } else {
        delete json.bufferViews;
    }
    for (const accessor of json.accessors ?? []) {
        retargetAccessor(accessor, remap);
        retargetAccessor(accessor?.sparse?.indices, remap);
        retargetAccessor(accessor?.sparse?.values, remap);
    }
    if (cursor === 0) {
        delete json.buffers;
        return null;
    }
    json.buffers = [{ byteLength: cursor }];
    const bin = new Uint8Array(Math.ceil(cursor / 4) * 4);
    let offset = 0;
    for (const piece of pieces) {
        bin.set(piece, offset);
        offset += piece.byteLength;
    }
    return bin;
}

/**
 * Pack resolved glTF buffers into one GLB.
 * `buffers` aligns with `json.buffers`. `imageBytes` aligns with external images.
 */
export function packVehicleGltf({ json, buffers = [], imageBytes = [], generator = null } = {}) {
    const document = structuredClone(json);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("glTF JSON must be an object.");
    assertVehicleGltfGraph(document);
    assignOrdinalNames(document);
    if (generator) document.asset = { ...(document.asset ?? {}), generator };
    const declared = document.buffers ?? [];
    if (buffers.length < declared.length) throw new Error("GLTF buffer is missing.");
    const payloads = declared.map((buffer, index) => payloadOf(buffer, buffers[index]));
    const originalViews = (document.bufferViews ?? []).map((view) => ({ ...view }));
    const imageViewIndexes = new Set();
    for (const image of document.images ?? []) {
        if (Number.isInteger(image?.bufferView)) imageViewIndexes.add(image.bufferView);
    }
    const dependencies = rewriteImages(document, payloads, originalViews, imageBytes);
    const bin = repackBuffers(document, payloads, imageViewIndexes);
    const glbBytes = writeGlb(canonicalize(document), bin);
    return { glbBytes, dependencies, nodes: nodeTable(document) };
}

/** Read a GLB produced by this packer or by the mesh encoder. */
export function readPackedGlb(bytes) {
    return readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
        ErrorType: Error,
    });
}

export { GLB_BIN_CHUNK };
