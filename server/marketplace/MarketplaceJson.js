import {
    canonicalExactStringify,
    parseExactJson,
    sha256ExactBytes,
} from "../../app/simulation/visual/VisualLayer.js";

import { MARKETPLACE_LIMITS } from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const PROHIBITED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function invalid(message, path = null, cause = null) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message, { path, cause });
}

function bytesOf(input) {
    if (input instanceof Uint8Array) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    invalid("Marketplace JSON input must be exact bytes.");
}

function scanRawJson(source) {
    let index = 0;
    const whitespace = () => {
        while (/\s/u.test(source[index] || "")) index += 1;
    };
    const tokenString = () => {
        const start = index;
        index += 1;
        while (index < source.length) {
            const character = source[index];
            if (character === "\\") {
                index += 2;
                continue;
            }
            index += 1;
            if (character === "\"") return JSON.parse(source.slice(start, index));
        }
        throw new SyntaxError("Unterminated JSON string.");
    };
    const value = (depth, path) => {
        if (depth > MARKETPLACE_LIMITS.jsonDepth) {
            throw new SyntaxError(`JSON nesting exceeds ${MARKETPLACE_LIMITS.jsonDepth}.`);
        }
        whitespace();
        if (source[index] === "{") {
            index += 1;
            whitespace();
            const keys = new Set();
            if (source[index] === "}") { index += 1; return; }
            while (index < source.length) {
                if (source[index] !== "\"") throw new SyntaxError("Expected a JSON object key.");
                const key = tokenString();
                if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key ${JSON.stringify(key)}.`);
                if (PROHIBITED_KEYS.has(key)) throw new SyntaxError(`Prohibited JSON object key ${JSON.stringify(key)}.`);
                keys.add(key);
                whitespace();
                if (source[index] !== ":") throw new SyntaxError("Expected ':' after a JSON object key.");
                index += 1;
                value(depth + 1, `${path}.${key}`);
                whitespace();
                if (source[index] === "}") { index += 1; return; }
                if (source[index] !== ",") throw new SyntaxError("Expected ',' in a JSON object.");
                index += 1;
                whitespace();
            }
            throw new SyntaxError("Unterminated JSON object.");
        }
        if (source[index] === "[") {
            index += 1;
            whitespace();
            if (source[index] === "]") { index += 1; return; }
            let item = 0;
            while (index < source.length) {
                value(depth + 1, `${path}.${item}`);
                item += 1;
                whitespace();
                if (source[index] === "]") { index += 1; return; }
                if (source[index] !== ",") throw new SyntaxError("Expected ',' in a JSON array.");
                index += 1;
            }
            throw new SyntaxError("Unterminated JSON array.");
        }
        if (source[index] === "\"") {
            tokenString();
            return;
        }
        const match = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
        if (!match) throw new SyntaxError(`Invalid JSON value at ${path}.`);
        index += match[0].length;
    };
    whitespace();
    value(0, "$");
    whitespace();
    if (index !== source.length) throw new SyntaxError("Trailing data after JSON value.");
}

export function parseMarketplaceJsonBytes(input) {
    const bytes = bytesOf(input);
    if (bytes.byteLength > MARKETPLACE_LIMITS.catalogBytes) {
        throw marketplaceError(
            MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED,
            `Marketplace JSON exceeds ${MARKETPLACE_LIMITS.catalogBytes} bytes.`,
        );
    }
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        invalid("Marketplace JSON must not contain a byte-order mark.");
    }
    let source;
    try {
        source = textDecoder.decode(bytes);
        scanRawJson(source);
        return { document: parseExactJson(source), byteLength: bytes.byteLength };
    } catch (error) {
        if (error?.code === MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID) throw error;
        invalid(`Invalid marketplace JSON: ${error.message}`, null, error);
    }
}

export function canonicalMarketplaceBytes(value) {
    return textEncoder.encode(canonicalExactStringify(value));
}

export function hashMarketplaceBytes(value) {
    return sha256ExactBytes(value);
}
