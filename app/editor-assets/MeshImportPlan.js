/** Catalog import. OBJ, STL, and PLY become one glTF 2.0 GLB before the glTF planner. */

import { createGltfImportPlan } from "./GltfImportPlan.js";
import { normalizedSelectedPath } from "./PackagePaths.js";
import { encodeMeshDocumentGlb } from "./mesh/MeshGlbEncoder.js";
import { parseObjPackage } from "./mesh/ObjParser.js";
import { parsePly } from "./mesh/PlyParser.js";
import { parseStl } from "./mesh/StlParser.js";

function extensionOf(path) {
    return path.toLowerCase().split(".").at(-1);
}

function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
    throw new TypeError("Import files require Uint8Array or ArrayBuffer bytes.");
}

function modelName(entry) {
    const base = entry.split("/").at(-1);
    return base.replace(/\.[^.]+$/u, "") || base;
}

export function createMeshImportPlan(files, { entryPath } = {}) {
    const entry = normalizedSelectedPath(entryPath);
    const extension = extensionOf(entry);
    if (extension === "gltf" || extension === "glb") return createGltfImportPlan(files, { entryPath: entry });
    const selected = new Map();
    for (const file of files ?? []) {
        const path = normalizedSelectedPath(file?.path);
        if (selected.has(path)) throw new Error(`Selected package contains ambiguous path "${path}".`);
        selected.set(path, file);
    }
    const source = selected.get(entry);
    if (!source) throw new Error(`Entry model "${entry}" is not among the selected files.`);
    const document = extension === "obj"
        ? parseObjPackage(files, entry)
        : extension === "stl"
            ? parseStl(bytesOf(source.bytes), modelName(entry))
            : extension === "ply"
                ? parsePly(bytesOf(source.bytes), modelName(entry))
                : null;
    if (!document) throw new Error("Entry model must be .gltf, .glb, .obj, .stl, or .ply.");
    const encoded = encodeMeshDocumentGlb(document);
    const planned = createGltfImportPlan([
        { path: "import.glb", bytes: encoded.glbBytes },
        ...encoded.images.map((image) => ({ path: image.path, bytes: image.bytes })),
    ], { entryPath: "import.glb" });
    // The stored model is the GLB. The source filename stays the catalog name.
    return { ...planned, entryPath: entry };
}
