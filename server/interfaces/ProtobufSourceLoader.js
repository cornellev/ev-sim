import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { assertProtoPath, loadDescriptorSet, protobufFingerprint, PROTOBUF_LIMITS } from "../../app/interfaces/ProtobufSchema.js";

export const PROTOBUF_SOURCE_LIMITS = Object.freeze({ fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
const WELL_KNOWN = new Set(["any", "duration", "empty", "field_mask", "struct", "timestamp", "wrappers"].map((name) => `google/protobuf/${name}.proto`));
const decoder = new TextDecoder("utf-8", { fatal: true });

function inside(directory, file) {
    const relative = path.relative(directory, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function readProtobufFile(file, limit) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error("Protobuf input must be a bounded regular file.");
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        if (length !== stat.size) throw new Error("Protobuf input changed while reading.");
        return bytes.subarray(0, length);
    } finally { await handle.close(); }
}

function sourceImports(source) {
    const tokens = protobuf.tokenize(source);
    const string = () => {
        let result = "";
        do {
            const quote = tokens.next();
            if (quote !== '"' && quote !== "'") throw new Error("Expected a protobuf string.");
            result += tokens.next();
            tokens.skip(quote);
        } while (["'", '"'].includes(tokens.peek()));
        return result;
    };
    if (tokens.next() !== "syntax") throw new Error("An explicit proto3 syntax declaration is required.");
    tokens.skip("=");
    if (string() !== "proto3") throw new Error("Only proto3 source files are supported.");
    tokens.skip(";");
    const dependency = [];
    const publicDependency = [];
    let depth = 0;
    let token;
    while ((token = tokens.next()) !== null) {
        if (token === "{") depth++;
        else if (token === "}") depth--;
        else if (token === '"' || token === "'") { tokens.next(); tokens.skip(token); }
        else if (depth === 0 && ["syntax", "edition", "extend"].includes(token)) throw new Error("Duplicate syntax, editions, and extensions are unsupported.");
        else if (depth === 0 && token === "import") {
            if (tokens.peek() === "weak") throw new Error("Weak protobuf imports are unsupported.");
            if (tokens.peek() === "public") { tokens.next(); publicDependency.push(dependency.length); }
            dependency.push(assertProtoPath(string()));
            tokens.skip(";");
        }
    }
    return { dependency, publicDependency };
}

function messageDescriptor(type) {
    const message = type.toDescriptor("proto3");
    const fixOptional = (entry) => {
        for (const field of entry.field) {
            if (field.proto3_optional) { field.proto3Optional = true; delete field.proto3_optional; }
        }
        entry.nestedType.forEach(fixOptional);
    };
    fixOptional(message);
    return message;
}

export async function loadDescriptorFile(file) {
    return loadDescriptorSet(await readProtobufFile(file, PROTOBUF_LIMITS.descriptorBytes));
}

export async function loadProtoFiles(entryFiles, { includeDirs = [] } = {}) {
    if (!Array.isArray(entryFiles) || !entryFiles.length || entryFiles.length > PROTOBUF_LIMITS.files) {
        throw new Error("Select 1..128 protobuf entry files.");
    }
    if (!Array.isArray(includeDirs) || includeDirs.length > PROTOBUF_LIMITS.files) throw new Error("Select at most 128 protobuf include directories.");
    const roots = [...new Set(await Promise.all((includeDirs.length ? includeDirs : entryFiles.map((file) => path.dirname(path.resolve(file)))).map((directory) => realpath(directory))))];
    const names = await Promise.all(entryFiles.map(async (file) => {
        const absolute = path.join(await realpath(path.dirname(path.resolve(file))), path.basename(file));
        const root = roots.find((directory) => inside(directory, absolute));
        if (!root) throw new Error("Protobuf entry is outside the include directories.");
        return assertProtoPath(path.relative(root, absolute).split(path.sep).join("/"));
    }));
    const find = async (name) => {
        const candidates = new Set();
        for (const directory of roots) {
            try {
                const file = await realpath(path.join(directory, name));
                if (!inside(directory, file)) throw new Error("Protobuf import escapes its include directory.");
                candidates.add(file);
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (candidates.size !== 1) throw new Error(`${candidates.size ? "Ambiguous" : "Unresolved"} protobuf import "${name}".`);
        return candidates.values().next().value;
    };
    return loadProtoSources(names, { readSource: async (name) => {
        const file = await find(name);
        return { path: file, bytes: await readProtobufFile(file, PROTOBUF_SOURCE_LIMITS.fileBytes) };
    } });
}

// Uploaded files and pinned repositories use the same logical include roots.
export function resolveProtoSelection(entryFiles, includeDirs = []) {
    if (!Array.isArray(entryFiles) || !entryFiles.length || entryFiles.length > PROTOBUF_LIMITS.files
        || Object.keys(entryFiles).length !== entryFiles.length) throw new Error("Select 1..128 protobuf entry files.");
    entryFiles.forEach(assertProtoPath);
    if (!Array.isArray(includeDirs) || includeDirs.length > PROTOBUF_LIMITS.files
        || Object.keys(includeDirs).length !== includeDirs.length) throw new Error("Invalid protobuf include directories.");
    const roots = [...new Set((includeDirs.length ? includeDirs : entryFiles.map((file) => path.posix.dirname(file))).map((directory) => {
        if (directory === "" || directory === ".") return "";
        assertProtoPath(`${directory}/include.proto`);
        return directory;
    }))];
    const names = entryFiles.map((file) => {
        const root = roots.find((directory) => !directory || file.startsWith(`${directory}/`));
        if (root === undefined) throw new Error("Protobuf entry is outside the include directories.");
        return root ? file.slice(root.length + 1) : file;
    });
    return { roots, names };
}

export function decodeProtobufBase64(value, limit) {
    if (typeof value !== "string" || !value.length || value.length > Math.ceil(limit / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid bounded protobuf base64.");
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > limit || bytes.toString("base64") !== value) throw new Error("Invalid bounded protobuf base64.");
    return bytes;
}

export async function loadUploadedProtoFiles({ entryFiles, includeDirs = [], files }) {
    const selection = resolveProtoSelection(entryFiles, includeDirs);
    if (!Array.isArray(files) || !files.length || files.length > PROTOBUF_LIMITS.files
        || Object.keys(files).length !== files.length) throw new Error("Select 1..128 uploaded protobuf files.");
    const uploaded = new Map();
    let total = 0;
    for (const file of files) {
        const name = assertProtoPath(file.path);
        if (uploaded.has(name) || Object.keys(file).some((key) => !["path", "bytesBase64"].includes(key))) throw new Error("Invalid or duplicate uploaded protobuf file.");
        const bytes = decodeProtobufBase64(file.bytesBase64, PROTOBUF_SOURCE_LIMITS.fileBytes);
        total += bytes.length;
        if (total > PROTOBUF_SOURCE_LIMITS.totalBytes) throw new Error("Protobuf source bundle is too large.");
        uploaded.set(name, bytes);
    }
    return loadProtoSources(selection.names, { readSource: async (name) => {
        const matches = selection.roots.map((root) => root ? `${root}/${name}` : name).filter((file) => uploaded.has(file));
        if (matches.length !== 1) throw new Error(`${matches.length ? "Ambiguous" : "Unresolved"} protobuf import "${name}".`);
        return { path: matches[0], bytes: uploaded.get(matches[0]) };
    } });
}

export async function loadProtoSources(entryFiles, { readSource }) {
    if (!Array.isArray(entryFiles) || !entryFiles.length || entryFiles.length > PROTOBUF_LIMITS.files
        || Object.keys(entryFiles).length !== entryFiles.length) throw new Error("Select 1..128 protobuf entry files.");
    const names = entryFiles.map((name) => assertProtoPath(name));
    const root = new protobuf.Root();
    const files = new Map();
    const acquired = [];
    const visiting = new Set();
    let totalBytes = 0;
    const load = async (name) => {
        if (visiting.has(name)) throw new Error("Protobuf imports contain a cycle.");
        if (files.has(name)) return;
        if (files.size >= PROTOBUF_LIMITS.files) throw new Error("Too many protobuf source files.");
        visiting.add(name);
        let info;
        let symbols;
        if (WELL_KNOWN.has(name)) {
            const json = protobuf.common[name];
            root.addJSON(json.nested);
            info = { package: "google.protobuf", dependency: [], publicDependency: [] };
            symbols = Object.keys(json.nested.google.nested.protobuf.nested).map((symbol) => root.lookup(`google.protobuf.${symbol}`));
        } else {
            const sourceFile = await readSource(name);
            const bytes = sourceFile.bytes;
            if (!(bytes instanceof Uint8Array) || bytes.length > PROTOBUF_SOURCE_LIMITS.fileBytes) throw new Error("Protobuf input must be bounded bytes.");
            totalBytes += bytes.length;
            if (totalBytes > PROTOBUF_SOURCE_LIMITS.totalBytes) throw new Error("Protobuf source bundle is too large.");
            const source = decoder.decode(bytes);
            acquired.push({ path: sourceFile.path ?? name, importPath: name, sha256: protobufFingerprint(bytes), size: bytes.length });
            info = sourceImports(source);
            protobuf.parse.filename = name;
            const parsed = protobuf.parse(source, root, { keepCase: true });
            info.package = parsed.package || "";
            symbols = (info.package ? root.lookup(info.package) : root).nestedArray.filter((symbol) => symbol.filename === name);
            if (symbols.some((symbol) => symbol instanceof protobuf.Field)) throw new Error("Protobuf extensions are unsupported.");
        }
        files.set(name, { ...info, symbols });
        for (const dependency of info.dependency) await load(dependency);
        visiting.delete(name);
    };
    for (const name of names.sort(compareUtf8)) await load(name);
    root.resolveAll();
    const file = [...files].sort(([left], [right]) => compareUtf8(left, right)).map(([name, info]) => descriptor.FileDescriptorProto.create({
        name, package: info.package, syntax: "proto3", dependency: info.dependency, publicDependency: info.publicDependency,
        messageType: info.symbols.filter((symbol) => symbol instanceof protobuf.Type).map(messageDescriptor),
        enumType: info.symbols.filter((symbol) => symbol instanceof protobuf.Enum).map((symbol) => symbol.toDescriptor()),
        service: info.symbols.filter((symbol) => symbol instanceof protobuf.Service).map((symbol) => symbol.toDescriptor()),
    }));
    return { ...loadDescriptorSet(descriptor.FileDescriptorSet.encode({ file }).finish()), files: acquired.sort((left, right) => compareUtf8(left.importPath, right.importPath)) };
}
