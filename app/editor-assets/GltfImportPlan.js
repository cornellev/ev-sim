import { sha256ExactBytes } from "../simulation/visual/VisualLayer.js";
import { GLB_BIN_CHUNK, GLB_JSON_CHUNK, GLB_MAGIC, readGlb } from "../simulation/visual/GlbContainer.js";
const JSON_CHUNK = GLB_JSON_CHUNK;
const BIN_CHUNK = GLB_BIN_CHUNK;
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KTX2_IDENTIFIER = Object.freeze([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const IMAGE_EXTENSIONS = Object.freeze({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/ktx2": "ktx2",
});
const DATA_URI_PATTERN = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
    throw new TypeError("Import files require Uint8Array or ArrayBuffer bytes.");
}

function startsWith(bytes, prefix) {
    return prefix.every((value, index) => bytes[index] === value);
}

function sniffImageMediaType(bytes) {
    if (bytes.length >= 8 && startsWith(bytes, PNG_SIGNATURE)) return "image/png";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length >= 12 && startsWith(bytes, KTX2_IDENTIFIER)) return "image/ktx2";
    throw new Error("Embedded image must be PNG, JPEG, or KTX2.");
}

function decodeBase64(text) {
    if (typeof atob === "function") {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(text, "base64"));
    throw new Error("Base64 decode is unavailable.");
}

function decodeDataUri(uri) {
    const match = String(uri).match(DATA_URI_PATTERN);
    if (!match || match[2].length % 4 !== 0) throw new Error("Embedded data URI must be a canonical base64 data URI.");
    return { mediaType: match[1], bytes: decodeBase64(match[2]) };
}

function normalizedSelectedPath(value) {
    let text = String(value ?? "").replaceAll("\\", "/");
    try { text = decodeURIComponent(text); } catch { throw new Error(`Import path ${JSON.stringify(value)} has invalid URI escapes.`); }
    if (!text || text.startsWith("/") || /^[A-Za-z]:\//.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text)) throw new Error(`Import path ${JSON.stringify(value)} must be package-relative.`);
    const parts = [];
    for (const part of text.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) throw new Error(`Import path ${JSON.stringify(value)} traverses outside the package.`);
            parts.pop();
        } else parts.push(part);
    }
    if (parts.length === 0) throw new Error("Import path cannot resolve to the package root.");
    return parts.join("/");
}

function resolveDependency(entryPath, uri) {
    const raw = String(uri ?? "");
    if (raw.startsWith("data:")) return null;
    if (!raw || raw.startsWith("/") || raw.startsWith("\\") || raw.startsWith("//") || /^[A-Za-z]:[\\/]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        throw new Error(`External GLTF URI ${JSON.stringify(raw)} is not a selected package path.`);
    }
    const base = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/") + 1) : "";
    return normalizedSelectedPath(`${base}${raw}`);
}

function mediaTypeFor(path) {
    const extension = path.toLowerCase().split(".").at(-1);
    return ({
        bin: "application/octet-stream", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        webp: "image/webp", ktx2: "image/ktx2", gltf: "model/gltf+json", glb: "model/gltf-binary",
    })[extension] ?? "application/octet-stream";
}

function parseGlb(bytes) {
    const parsed = readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        ErrorType: Error,
        headerMessage: "Entry GLB has an invalid version-2 header.",
        chunkMessage: "Entry GLB has an invalid chunk table.",
        trailingMessage: "Entry GLB must begin with a JSON chunk.",
        leadingJsonMessage: "Entry GLB must begin with a JSON chunk.",
        copyChunks: true,
        missingJsonMessage: "Entry GLB must begin with a JSON chunk.",
    });
    return { json: parsed.json, chunks: parsed.chunks.slice(1) };
}

function encodeGlb(json, chunks) {
    const encoded = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = Math.ceil(encoded.length / 4) * 4;
    const total = 12 + 8 + jsonLength + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0);
    const output = new Uint8Array(total);
    const view = new DataView(output.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, JSON_CHUNK, true);
    output.fill(0x20, 20, 20 + jsonLength);
    output.set(encoded, 20);
    let offset = 20 + jsonLength;
    for (const chunk of chunks) {
        view.setUint32(offset, chunk.bytes.length, true);
        view.setUint32(offset + 4, chunk.type, true);
        output.set(chunk.bytes, offset + 8);
        offset += 8 + chunk.bytes.length;
    }
    return output;
}

function glbBinBytes(chunks) {
    return chunks.find((chunk) => chunk.type === BIN_CHUNK)?.bytes ?? null;
}

function bufferPayloads(json, chunks, selected, entry) {
    const payloads = [];
    const bin = glbBinBytes(chunks);
    for (const [index, buffer] of (json.buffers ?? []).entries()) {
        const uri = buffer?.uri;
        if (uri === undefined || uri === "") {
            if (index !== 0 || !bin) throw new Error(`GLTF buffer ${index} has no URI or GLB binary chunk.`);
            payloads[index] = bin;
            continue;
        }
        if (uri.startsWith("data:")) {
            payloads[index] = decodeDataUri(uri).bytes;
            continue;
        }
        if (uri.startsWith("sha256:")) {
            payloads[index] = null;
            continue;
        }
        const dependencyPath = resolveDependency(entry, uri);
        const bytes = selected.get(dependencyPath);
        if (!bytes) throw new Error(`GLTF dependency "${dependencyPath}" was not selected.`);
        payloads[index] = bytes;
    }
    return payloads;
}

function addDependency(dependencies, bytes, mediaType) {
    const copy = bytes instanceof Uint8Array ? bytes.slice() : Uint8Array.from(bytes);
    const sha256 = sha256ExactBytes(copy);
    for (const existing of dependencies.values()) {
        if (existing.sha256 === sha256) return sha256;
    }
    const extension = IMAGE_EXTENSIONS[mediaType];
    if (!extension) throw new Error("Embedded image must be PNG, JPEG, or KTX2.");
    const path = `embedded/${sha256}.${extension}`;
    dependencies.set(path, { path, mediaType, sha256, bytes: copy });
    return sha256;
}

function bindImageBytes(image, bytes, declaredMediaType, dependencies) {
    const mediaType = sniffImageMediaType(bytes);
    if (declaredMediaType && declaredMediaType !== mediaType) {
        throw new Error(`Embedded image media type ${declaredMediaType} does not match observed ${mediaType}.`);
    }
    image.uri = `sha256:${addDependency(dependencies, bytes, mediaType)}`;
}

function extractEmbeddedImages(json, payloads, dependencies) {
    for (const [index, image] of (json.images ?? []).entries()) {
        const hasUri = typeof image?.uri === "string";
        const hasBufferView = Number.isInteger(image?.bufferView);
        if (hasUri && hasBufferView) throw new Error(`GLTF image ${index} cannot declare both uri and bufferView.`);
        if (hasUri && image.uri.startsWith("data:")) {
            const decoded = decodeDataUri(image.uri);
            bindImageBytes(image, decoded.bytes, decoded.mediaType, dependencies);
            continue;
        }
        if (!hasBufferView) continue;
        const view = json.bufferViews?.[image.bufferView];
        const payload = payloads[view?.buffer];
        if (!view || !payload) throw new Error(`GLTF image ${index} has no source-bound buffer bytes.`);
        const start = Number(view.byteOffset) || 0;
        const end = start + (Number(view.byteLength) || 0);
        if (end > payload.length) throw new Error(`GLTF image ${index} bufferView overflows its buffer.`);
        bindImageBytes(image, payload.subarray(start, end), image.mimeType, dependencies);
        delete image.bufferView;
    }
}

export function createGltfImportPlan(files, { entryPath } = {}) {
    const selected = new Map();
    for (const file of files ?? []) {
        const normalized = normalizedSelectedPath(file?.path);
        if (selected.has(normalized)) throw new Error(`Selected package contains ambiguous path "${normalized}".`);
        selected.set(normalized, bytesOf(file.bytes));
    }
    const entry = normalizedSelectedPath(entryPath);
    const sourceBytes = selected.get(entry);
    if (!sourceBytes) throw new Error(`Entry model "${entry}" is not among the selected files.`);
    const mediaType = mediaTypeFor(entry);
    if (!new Set(["model/gltf+json", "model/gltf-binary"]).has(mediaType)) throw new Error("Entry model must be .gltf or .glb.");
    const parsed = mediaType === "model/gltf-binary"
        ? parseGlb(sourceBytes)
        : { json: JSON.parse(new TextDecoder().decode(sourceBytes)), chunks: [] };
    if (parsed.json?.asset?.version !== "2.0") throw new Error("Only GLTF 2.0 models can be imported.");
    const dependencies = new Map();
    const payloads = bufferPayloads(parsed.json, parsed.chunks, selected, entry);
    const rewrite = (records) => {
        for (const record of records ?? []) {
            if (typeof record?.uri !== "string") continue;
            if (record.uri.startsWith("sha256:") || record.uri.startsWith("data:")) continue;
            const dependencyPath = resolveDependency(entry, record.uri);
            if (!dependencyPath) continue;
            const bytes = selected.get(dependencyPath);
            if (!bytes) throw new Error(`GLTF dependency "${dependencyPath}" was not selected.`);
            const sha256 = sha256ExactBytes(bytes);
            record.uri = `sha256:${sha256}`;
            dependencies.set(dependencyPath, { path: dependencyPath, mediaType: mediaTypeFor(dependencyPath), sha256, bytes });
        }
    };
    rewrite(parsed.json.buffers);
    rewrite(parsed.json.images);
    extractEmbeddedImages(parsed.json, payloads, dependencies);
    const modelBytes = mediaType === "model/gltf-binary"
        ? encodeGlb(parsed.json, parsed.chunks)
        : new TextEncoder().encode(JSON.stringify(parsed.json));
    return {
        entryPath: entry,
        mediaType,
        dependencies: [...dependencies.values()].sort((left, right) => left.path.localeCompare(right.path)),
        modelBytes,
        modelSha256: sha256ExactBytes(modelBytes),
    };
}
