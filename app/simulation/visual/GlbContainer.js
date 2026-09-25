/** Shared glTF 2.0 binary container reader. Callers keep their own error text. */

export const GLB_MAGIC = 0x46546c67;
export const GLB_JSON_CHUNK = 0x4e4f534a;
export const GLB_BIN_CHUNK = 0x004e4942;

function asBytes(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    throw new TypeError("GLB bytes are required.");
}

function stripJson(chunk, padding) {
    if (padding === "nul") return new TextDecoder().decode(chunk).replace(/\0+$/u, "");
    if (padding === "whitespace") {
        let end = chunk.length;
        while (end > 0 && [0, 9, 10, 13, 32].includes(chunk[end - 1])) end -= 1;
        return new TextDecoder().decode(chunk.subarray(0, end));
    }
    return new TextDecoder().decode(chunk);
}

/**
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @param {{
 *   requireTotalLength?: boolean,
 *   requireAligned?: boolean,
 *   requireLeadingJson?: boolean,
 *   json?: "first"|"last",
 *   jsonPadding?: "none"|"nul"|"whitespace",
 *   headerMessage?: string,
 *   lengthMessage?: string,
 *   chunkMessage?: string,
 *   missingJsonMessage?: string,
 *   leadingJsonMessage?: string,
 *   ErrorType?: typeof Error,
 * }} [options]
 */
export function readGlb(bytes, options = {}) {
    const source = asBytes(bytes);
    const ErrorType = options.ErrorType ?? TypeError;
    const fail = (message) => {
        throw new ErrorType(message);
    };
    const headerMessage = options.headerMessage ?? "GLB header is invalid.";
    const lengthMessage = options.lengthMessage ?? headerMessage;
    const chunkMessage = options.chunkMessage ?? "GLB chunk exceeds the file.";
    const missingJsonMessage = options.missingJsonMessage ?? "GLB is missing a JSON chunk.";
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    const minimumLength = options.minimumLength ?? 20;
    if (source.byteLength < Math.max(12, minimumLength)) fail(headerMessage);
    if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) fail(headerMessage);
    const declared = view.getUint32(8, true);
    if (options.requireTotalLength) {
        if (declared !== source.byteLength) fail(headerMessage);
    } else if (declared > source.byteLength) {
        fail(lengthMessage);
    }
    const limit = options.requireTotalLength ? source.byteLength : declared;
    const stopAtFirstJson = options.json !== "last";
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= limit) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const start = offset + 8;
        const end = start + chunkLength;
        if (end > limit || (options.requireAligned && chunkLength % 4 !== 0)) fail(chunkMessage);
        const chunkBytes = options.copyChunks ? source.slice(start, end) : source.subarray(start, end);
        chunks.push({ type: chunkType, bytes: chunkBytes });
        offset = end;
        if (stopAtFirstJson && chunkType === GLB_JSON_CHUNK) break;
    }
    if (options.requireAligned && options.requireTotalLength && offset !== limit) {
        fail(options.trailingMessage ?? chunkMessage);
    }
    if (options.requireLeadingJson && chunks[0]?.type !== GLB_JSON_CHUNK) {
        fail(options.leadingJsonMessage ?? missingJsonMessage);
    }
    const jsonChunk = (options.json === "last"
        ? chunks.findLast((chunk) => chunk.type === GLB_JSON_CHUNK)
        : chunks.find((chunk) => chunk.type === GLB_JSON_CHUNK))?.bytes ?? null;
    if (!jsonChunk) fail(missingJsonMessage);
    const bin = chunks.findLast((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
    return {
        json: JSON.parse(stripJson(jsonChunk, options.jsonPadding ?? "none")),
        jsonChunk,
        bin,
        chunks,
    };
}
