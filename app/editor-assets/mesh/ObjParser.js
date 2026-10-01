/** Wavefront OBJ + MTL package parser. Geometry is expanded to unique corners. */

import { normalizedSelectedPath, resolveDependency } from "../PackagePaths.js";
import { createMeshDocument } from "./MeshDocument.js";
import { triangulatePolygon } from "./triangulate.js";

const TEXTURE_OPTION_ARITY = Object.freeze({
    "-blendu": 1,
    "-blendv": 1,
    "-bm": 1,
    "-boost": 1,
    "-bs": 1,
    "-cc": 1,
    "-clamp": 1,
    "-imfchan": 1,
    "-mm": 2,
    "-o": 3,
    "-s": 3,
    "-t": 3,
    "-texres": 1,
    "-type": 1,
});

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
    throw new TypeError("Import files require Uint8Array or ArrayBuffer bytes.");
}

function textOf(bytes) {
    return new TextDecoder().decode(bytes).replace(/^\uFEFF/u, "");
}

function linesOf(text) {
    return text.split(/\r?\n/u);
}

function slug(name, fallback) {
    const cleaned = String(name ?? "").trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    return cleaned || fallback;
}

function uniqueId(name, used, fallback) {
    const base = slug(name, fallback);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
    }
    used.add(id);
    return id;
}

function finite(token, label) {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`${label} ${JSON.stringify(token)} is not a finite number.`);
    return Object.is(value, -0) ? 0 : value;
}

function resolveIndex(raw, length, label) {
    if (!/^-?\d+$/u.test(raw)) throw new Error(`OBJ ${label} index ${JSON.stringify(raw)} is invalid.`);
    const index = Number(raw);
    if (index === 0) throw new Error(`OBJ ${label} index cannot be 0.`);
    const resolved = index > 0 ? index - 1 : length + index;
    if (resolved < 0 || resolved >= length) throw new Error(`OBJ ${label} index ${index} is out of range.`);
    return resolved;
}

function statement(line) {
    const comment = line.search(/\s+#/u);
    const cleaned = (comment >= 0 ? line.slice(0, comment) : line).trim();
    if (!cleaned || cleaned.startsWith("#")) return null;
    const space = cleaned.search(/\s/u);
    if (space < 0) return { keyword: cleaned, args: "" };
    return { keyword: cleaned.slice(0, space), args: cleaned.slice(space).trim() };
}

function texturePath(args) {
    const tokens = args.split(/\s+/u).filter(Boolean);
    let index = 0;
    while (index < tokens.length && tokens[index].startsWith("-")) {
        const arity = TEXTURE_OPTION_ARITY[tokens[index]];
        if (arity === undefined) throw new Error(`MTL texture option ${tokens[index]} is unsupported.`);
        index += 1 + arity;
    }
    if (index >= tokens.length) throw new Error("MTL map_Kd is missing a file path.");
    return tokens.slice(index).join(" ");
}

function selectedFile(selected, path) {
    const bytes = selected.get(path);
    if (!bytes) throw new Error(`GLTF dependency "${path}" was not selected.`);
    return bytes;
}

function parseMtl(text, mtlPath, selected, usedIds, materialNames) {
    const materials = [];
    const images = [];
    const imagePaths = new Set();
    let current = null;
    const finish = () => {
        if (!current) return;
        materials.push(current);
        current = null;
    };
    for (const line of linesOf(text)) {
        const parsed = statement(line);
        if (!parsed) continue;
        const keyword = parsed.keyword.toLowerCase();
        if (keyword === "newmtl") {
            finish();
            const name = parsed.args.trim();
            if (!name) throw new Error("MTL newmtl is missing a name.");
            if (materialNames.has(name)) throw new Error(`MTL material "${name}" is declared more than once.`);
            const id = uniqueId(name, usedIds, "material");
            materialNames.set(name, id);
            current = { id, kd: [1, 1, 1], d: 1, ns: 0, mapKd: null };
            continue;
        }
        if (!current) continue;
        if (keyword === "kd") {
            const channels = parsed.args.split(/\s+/u);
            if (channels.length < 3) throw new Error(`MTL Kd for "${current.id}" requires three channels.`);
            current.kd = [0, 1, 2].map((index) => finite(channels[index], "MTL Kd"));
        } else if (keyword === "d") {
            current.d = finite(parsed.args.split(/\s+/u)[0], "MTL d");
        } else if (keyword === "tr") {
            current.d = 1 - finite(parsed.args.split(/\s+/u)[0], "MTL Tr");
        } else if (keyword === "ns") {
            current.ns = finite(parsed.args.split(/\s+/u)[0], "MTL Ns");
        } else if (keyword === "map_kd") {
            const path = resolveDependency(mtlPath, texturePath(parsed.args));
            current.mapKd = path;
            if (!imagePaths.has(path)) {
                imagePaths.add(path);
                images.push({ path, bytes: selectedFile(selected, path).slice() });
            }
        }
    }
    finish();
    return { materials, images };
}

function parseCorner(token, counts) {
    const parts = token.split("/");
    if (parts.length > 3 || !parts[0]) throw new Error(`OBJ face vertex ${JSON.stringify(token)} is invalid.`);
    return {
        position: resolveIndex(parts[0], counts.positions, "position"),
        uv: parts.length > 1 && parts[1] !== "" ? resolveIndex(parts[1], counts.uvs, "texcoord") : null,
        normal: parts.length > 2 && parts[2] !== "" ? resolveIndex(parts[2], counts.normals, "normal") : null,
    };
}

function addTriangle(node, materialId, corners, geometry) {
    let run = node.runs.get(materialId ?? "");
    if (!run) {
        run = {
            materialId,
            lookup: new Map(),
            positions: [],
            normals: [],
            uvs: [],
            indices: [],
            hasNormal: true,
            hasUv: true,
        };
        node.runs.set(materialId ?? "", run);
    }
    for (const corner of corners) {
        const uv = corner.uv == null ? null : geometry.uvs[corner.uv];
        const normal = corner.normal == null ? null : geometry.normals[corner.normal];
        if (!uv) run.hasUv = false;
        if (!normal) run.hasNormal = false;
        const key = `${corner.position}/${corner.uv ?? ""}/${corner.normal ?? ""}`;
        let index = run.lookup.get(key);
        if (index === undefined) {
            index = run.positions.length;
            run.lookup.set(key, index);
            run.positions.push(geometry.positions[corner.position].slice());
            run.uvs.push(uv ? uv.slice() : [0, 0]);
            run.normals.push(normal ? normal.slice() : [0, 0, 1]);
        }
        run.indices.push(index);
    }
}

function nodeFromRuns(node) {
    return {
        id: node.id,
        name: node.name,
        parentId: null,
        primitives: [...node.runs.values()].map((run) => ({
            positions: run.positions,
            normals: run.hasNormal ? run.normals : null,
            uvs: run.hasUv ? run.uvs : null,
            indices: run.indices,
            materialId: run.materialId,
        })),
    };
}

function loadLibraries(statements, entry, selected) {
    const usedIds = new Set();
    const materialNames = new Map();
    const materials = [];
    const images = [];
    const seenImages = new Set();
    for (const parsed of statements) {
        if (parsed.keyword.toLowerCase() !== "mtllib") continue;
        for (const name of parsed.args.split(/\s+/u).filter(Boolean)) {
            const path = resolveDependency(entry, name);
            const parsedMtl = parseMtl(textOf(selectedFile(selected, path)), path, selected, usedIds, materialNames);
            materials.push(...parsedMtl.materials);
            for (const image of parsedMtl.images) {
                if (seenImages.has(image.path)) continue;
                seenImages.add(image.path);
                images.push(image);
            }
        }
    }
    return { materials, images, materialNames };
}

export function parseObjPackage(files, entryPath) {
    const selected = new Map();
    for (const file of files ?? []) {
        const path = normalizedSelectedPath(file?.path);
        if (selected.has(path)) throw new Error(`Selected package contains ambiguous path "${path}".`);
        selected.set(path, bytesOf(file.bytes));
    }
    const entry = normalizedSelectedPath(entryPath);
    const source = selected.get(entry);
    if (!source) throw new Error(`Entry model "${entry}" is not among the selected files.`);
    const stem = entry.split("/").at(-1).replace(/\.[^.]+$/u, "") || "object";
    const statements = linesOf(textOf(source)).map(statement).filter(Boolean);
    const { materials, images, materialNames } = loadLibraries(statements, entry, selected);
    const geometry = { positions: [], uvs: [], normals: [] };
    const usedNodeIds = new Set();
    const nodes = [];
    let current = null;
    let activeMaterial = null;

    const startNode = (name) => {
        current = { id: uniqueId(name, usedNodeIds, "object"), name: String(name ?? "").trim() || stem, runs: new Map() };
        nodes.push(current);
    };

    for (const parsed of statements) {
        const keyword = parsed.keyword.toLowerCase();
        if (keyword === "l" || keyword === "p") throw new Error("OBJ line and point primitives are not imported.");
        if (keyword === "v") {
            const channels = parsed.args.split(/\s+/u);
            geometry.positions.push([0, 1, 2].map((index) => finite(channels[index], "OBJ position")));
        } else if (keyword === "vt") {
            const channels = parsed.args.split(/\s+/u);
            geometry.uvs.push([finite(channels[0], "OBJ texcoord"), finite(channels[1] ?? "0", "OBJ texcoord")]);
        } else if (keyword === "vn") {
            const channels = parsed.args.split(/\s+/u);
            geometry.normals.push([0, 1, 2].map((index) => finite(channels[index], "OBJ normal")));
        } else if (keyword === "o" || keyword === "g") {
            startNode(parsed.args || stem);
        } else if (keyword === "usemtl") {
            const name = parsed.args.trim();
            if (!materialNames.has(name)) throw new Error(`MTL material "${name}" was not declared.`);
            activeMaterial = materialNames.get(name);
        } else if (keyword === "f") {
            if (!current) startNode(stem);
            const counts = { positions: geometry.positions.length, uvs: geometry.uvs.length, normals: geometry.normals.length };
            const corners = parsed.args.split(/\s+/u).filter(Boolean).map((token) => parseCorner(token, counts));
            for (const triangle of triangulatePolygon(corners)) addTriangle(current, activeMaterial, triangle, geometry);
        }
    }

    const published = nodes.map(nodeFromRuns);
    if (!published.some((node) => node.primitives.length > 0)) throw new Error("OBJ file has no triangle faces.");
    return createMeshDocument({ nodes: published, materials, images });
}
