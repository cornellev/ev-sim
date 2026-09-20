import { parse } from "acorn";

import {
    canonicalExactStringify,
    parseExactJson,
    sha256ExactBytes,
} from "../simulation/visual/VisualLayer.js";
import { assertPluginDocument, runtimeManifestProjection } from "./PluginDocument.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";

export const PLUGIN_PACKAGE_KIND = "cev-sim.plugin-package";
export const PLUGIN_PACKAGE_VERSION = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function utf8Compare(left, right) {
    const a = textEncoder.encode(left);
    const b = textEncoder.encode(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function sha256(bytes) {
    return sha256ExactBytes(bytes);
}

function hashProjection(domain, value) {
    return sha256(textEncoder.encode(canonicalExactStringify({ domain, version: 1, value })));
}

function toBytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    if (typeof value === "string") return textEncoder.encode(value);
    throw new TypeError("Plugin file content must be text or bytes.");
}

function toBase64(bytes) {
    if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString("base64");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(value) {
    if (globalThis.Buffer) return new Uint8Array(globalThis.Buffer.from(value, "base64"));
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizePath(value) {
    const path = String(value ?? "");
    if (!path || path.includes("\\") || path.startsWith("/") || path.includes("%")
        || path.includes("?") || path.includes("#") || path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Invalid plugin package path "${path}".`, { path });
    }
    return path;
}

function normalizeInputFiles(files) {
    let entries;
    if (files instanceof Map) entries = [...files.entries()].map(([path, bytes]) => ({ path, bytes }));
    else if (Array.isArray(files)) entries = files.map((entry) => ({ path: entry.path, bytes: entry.bytes ?? entry.content }));
    else if (files && typeof files === "object") entries = Object.entries(files).map(([path, bytes]) => ({ path, bytes }));
    else throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin package files are required.");
    const paths = new Set();
    const folded = new Set();
    return entries.map((entry) => {
        const path = normalizePath(entry.path);
        if (paths.has(path) || folded.has(path.toLocaleLowerCase("en-US"))) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Duplicate or case-folding plugin path "${path}".`, { path });
        }
        paths.add(path);
        folded.add(path.toLocaleLowerCase("en-US"));
        return { path, bytes: toBytes(entry.bytes) };
    }).sort((left, right) => utf8Compare(left.path, right.path));
}

function exactRecordKeys(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `${label} must be an object.`);
    }
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `${label} contains unknown field "${unknown}".`);
}

function staticImports(ast, filePath) {
    const imports = [];
    const visit = (node, functionDepth = 0) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ImportExpression") {
            throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Dynamic import is forbidden in "${filePath}".`, { path: filePath });
        }
        if (node.type === "AwaitExpression" && functionDepth === 0) {
            throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Top-level await is forbidden in "${filePath}".`, { path: filePath });
        }
        if (node.type === "ForOfStatement" && node.await && functionDepth === 0) {
            throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Top-level asynchronous iteration is forbidden in "${filePath}".`, { path: filePath });
        }
        if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
            imports.push(node.source.value);
        }
        const isFunction = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
        for (const [key, child] of Object.entries(node)) {
            if (["start", "end", "loc", "source"].includes(key) && node.source === child) continue;
            if (Array.isArray(child)) child.forEach((entry) => visit(entry, functionDepth + (isFunction ? 1 : 0)));
            else if (child && typeof child === "object") visit(child, functionDepth + (isFunction ? 1 : 0));
        }
    };
    visit(ast);
    return imports;
}

function resolveImport(fromPath, specifier, files) {
    if (typeof specifier !== "string" || (!specifier.startsWith("./") && !specifier.startsWith("../"))
        || specifier.includes("\\") || specifier.includes("%") || specifier.includes("?") || specifier.includes("#")
        || !/\.(?:js|mjs)$/.test(specifier)) {
        throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Unsupported import "${specifier}" in "${fromPath}".`, { path: fromPath });
    }
    const parts = fromPath.split("/");
    parts.pop();
    for (const part of specifier.split("/")) {
        if (part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Import "${specifier}" escapes the package.`, { path: fromPath });
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    const target = parts.join("/");
    if (!files.has(target)) throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Import "${specifier}" from "${fromPath}" is missing or has incorrect case.`, { path: fromPath });
    return target;
}

export function analyzePluginModuleGraph(filesInput, document) {
    const entries = Array.isArray(filesInput) && filesInput[0]?.bytes
        ? filesInput : normalizeInputFiles(filesInput);
    const files = new Map(entries.map((entry) => [entry.path, entry]));
    const imports = new Map();
    const unsupportedSource = entries.find((entry) => /\.(?:cjs|jsx|ts|tsx)$/i.test(entry.path));
    if (unsupportedSource) {
        throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Unsupported plugin module format "${unsupportedSource.path}".`, { path: unsupportedSource.path });
    }
    for (const entry of entries.filter((candidate) => /\.(?:js|mjs)$/.test(candidate.path))) {
        let ast;
        try {
            ast = parse(textDecoder.decode(entry.bytes), { ecmaVersion: 2022, sourceType: "module" });
        } catch (error) {
            throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Cannot parse plugin module "${entry.path}": ${error.message}`, { path: entry.path, cause: error });
        }
        imports.set(entry.path, staticImports(ast, entry.path).map((specifier) => resolveImport(entry.path, specifier, files)));
    }
    for (const entry of [document.entry.runtime, document.entry.ui].filter(Boolean)) {
        if (!files.has(entry)) throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Plugin entry "${entry}" is missing.`, { path: entry });
    }
    for (const asset of document.editor?.assets ?? []) {
        if (!files.has(asset)) throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Declared editor asset "${asset}" is missing.`, { path: asset });
    }
    const closure = (root) => {
        if (!root) return [];
        const found = new Set();
        const visit = (path) => {
            if (found.has(path)) return;
            found.add(path);
            for (const dependency of imports.get(path) ?? []) visit(dependency);
        };
        visit(root);
        return [...found].sort(utf8Compare);
    };
    const runtimeFiles = closure(document.entry.runtime);
    const forbiddenRuntime = new Set([document.entry.ui, ...(document.editor?.assets ?? [])].filter(Boolean));
    const violation = runtimeFiles.find((path) => forbiddenRuntime.has(path));
    if (violation) throw pluginError(PLUGIN_ERROR_CODES.IMPORT_INVALID, `Runtime graph reaches UI/editor member "${violation}".`, { path: violation });
    const uiFiles = [...new Set([
        ...closure(document.entry.ui),
        ...(document.editor?.assets ?? []),
    ])].sort(utf8Compare);
    return Object.freeze({ runtimeFiles: Object.freeze(runtimeFiles), uiFiles: Object.freeze(uiFiles) });
}

function buildPackage(entries) {
    const pluginEntry = entries.find((entry) => entry.path === "plugin.json");
    if (!pluginEntry) throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin package is missing plugin.json.");
    let parsed;
    try {
        parsed = parseExactJson(textDecoder.decode(pluginEntry.bytes));
    } catch (error) {
        throw pluginError(PLUGIN_ERROR_CODES.DOCUMENT_INVALID, `Cannot parse plugin.json: ${error.message}`, { path: "plugin.json", cause: error });
    }
    const document = assertPluginDocument(parsed);
    const graph = analyzePluginModuleGraph(entries, document);
    const records = entries.map(({ path, bytes }) => ({
        path,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        encoding: "base64",
        data: toBase64(bytes),
    }));
    const metadata = (paths = records.map((record) => record.path)) => paths.map((path) => {
        const record = records.find((candidate) => candidate.path === path);
        return { path: record.path, sizeBytes: record.sizeBytes, sha256: record.sha256 };
    });
    const packageHash = hashProjection("cev-sim.plugin-package", metadata());
    const runtimeHash = hashProjection("cev-sim.plugin-runtime", {
        manifest: runtimeManifestProjection(document),
        files: metadata(graph.runtimeFiles),
    });
    const hasUi = Boolean(document.entry.ui || document.editor?.assets?.length);
    const uiHash = hasUi ? hashProjection("cev-sim.plugin-ui", {
        entry: document.entry.ui ? { ui: document.entry.ui } : {},
        editor: document.editor ?? null,
        files: metadata(graph.uiFiles),
    }) : null;
    const resource = Object.freeze({
        kind: PLUGIN_PACKAGE_KIND,
        version: PLUGIN_PACKAGE_VERSION,
        packageHash,
        runtimeHash,
        ...(uiHash ? { uiHash } : {}),
        files: Object.freeze(records.map(Object.freeze)),
    });
    return { resource, document, graph, entries };
}

export function createPluginPackage(files) {
    return buildPackage(normalizeInputFiles(files)).resource;
}

export function verifyPluginPackage(resource) {
    exactRecordKeys(resource, ["kind", "version", "packageHash", "runtimeHash", "uiHash", "files"], "Plugin package resource");
    if (resource.kind !== PLUGIN_PACKAGE_KIND || resource.version !== PLUGIN_PACKAGE_VERSION || !Array.isArray(resource.files)) {
        throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Expected ${PLUGIN_PACKAGE_KIND} version ${PLUGIN_PACKAGE_VERSION}.`);
    }
    for (const field of ["packageHash", "runtimeHash", ...(resource.uiHash === undefined ? [] : ["uiHash"])]) {
        if (!/^[a-f0-9]{64}$/.test(resource[field])) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin ${field} must be lowercase SHA-256.`);
        }
    }
    const entries = normalizeInputFiles(resource.files.map((record, index) => {
        exactRecordKeys(record, ["path", "sizeBytes", "sha256", "encoding", "data"], `Plugin package file ${index}`);
        if (record.encoding !== "base64" || typeof record.data !== "string") {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin member "${record.path}" is not base64 encoded.`, { path: record.path });
        }
        if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin member "${record.path}" metadata is invalid.`, { path: record.path });
        }
        const bytes = fromBase64(record.data);
        if (toBase64(bytes) !== record.data || bytes.byteLength !== record.sizeBytes || sha256(bytes) !== record.sha256) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin member "${record.path}" failed byte verification.`, { path: record.path });
        }
        return { path: record.path, bytes };
    }));
    const rebuilt = buildPackage(entries);
    for (const field of ["packageHash", "runtimeHash", "uiHash"]) {
        if ((resource[field] ?? null) !== (rebuilt.resource[field] ?? null)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin ${field} is invalid.`, { pluginId: rebuilt.document.id, packageHash: resource.packageHash });
        }
    }
    return Object.freeze({
        resource: rebuilt.resource,
        document: rebuilt.document,
        runtimeFiles: rebuilt.graph.runtimeFiles,
        uiFiles: rebuilt.graph.uiFiles,
        fileBytes: new Map(rebuilt.entries.map((entry) => [entry.path, new Uint8Array(entry.bytes)])),
    });
}
