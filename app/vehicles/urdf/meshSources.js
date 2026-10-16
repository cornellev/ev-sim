/** Decode URDF mesh files into triangle parts. Filenames are not part names. */

import { parseObjPackage } from "../../editor-assets/mesh/ObjParser.js";
import { parseStl } from "../../editor-assets/mesh/StlParser.js";
import { GLB_BIN_CHUNK, readGlb } from "../../simulation/visual/GlbContainer.js";
import { vehicleNodeCatalog } from "../model/measurePlacedVehicle.js";
import { listGltfDependencyPaths, resolveVehicleUri } from "../model/vehiclePackagePaths.js";
import { transformNormal, transformPositions } from "./rosCevBasis.js";
import { urdfIssue } from "./issue.js";

const COMPONENT_BYTES = Object.freeze({
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
});

function extensionOf(path) {
    return String(path).toLowerCase().split(".").at(-1);
}

function partsFromDocument(document) {
    const parts = [];
    let ordinal = 0;
    for (const node of document.nodes ?? []) {
        const authored = typeof node.name === "string" && node.name.trim() !== "" && !node.name.startsWith("part");
        const name = authored ? node.name : `part-${ordinal}`;
        if (!authored) ordinal += 1;
        for (const primitive of node.primitives ?? []) {
            parts.push({
                name,
                positions: primitive.positions.map((point) => point.slice(0, 3)),
                normals: primitive.normals ? primitive.normals.map((point) => point.slice(0, 3)) : null,
                indices: primitive.indices.slice(),
            });
        }
    }
    return parts;
}

function decodeDataUri(uri) {
    const match = String(uri).match(/^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/u);
    if (!match) throw new Error("Embedded data URI must be canonical base64.");
    return new Uint8Array(Buffer.from(match[1], "base64"));
}

function readComponent(view, offset, type, normalized) {
    switch (type) {
        case 5120: {
            const value = view.getInt8(offset);
            return normalized ? Math.max(value / 127, -1) : value;
        }
        case 5121: {
            const value = view.getUint8(offset);
            return normalized ? value / 255 : value;
        }
        case 5122: {
            const value = view.getInt16(offset, true);
            return normalized ? Math.max(value / 32767, -1) : value;
        }
        case 5123: {
            const value = view.getUint16(offset, true);
            return normalized ? value / 65535 : value;
        }
        case 5125: {
            const value = view.getUint32(offset, true);
            return normalized ? value / 4294967295 : value;
        }
        case 5126:
            return view.getFloat32(offset, true);
        default:
            throw new Error(`Unsupported accessor component type ${type}.`);
    }
}

function accessorBytes(json, buffers, accessorIndex, expectedType) {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor) throw new Error(`Accessor ${accessorIndex} is missing.`);
    if (accessor.sparse) throw new Error("Sparse accessors are not supported.");
    if (expectedType && accessor.type !== expectedType) throw new Error(`Accessor ${accessorIndex} must be ${expectedType}.`);
    if (!Number.isInteger(accessor.bufferView)) throw new Error(`Accessor ${accessorIndex} has no bufferView.`);
    const bufferView = json.bufferViews?.[accessor.bufferView];
    const payload = buffers[bufferView?.buffer ?? 0];
    if (!bufferView || !payload) throw new Error(`Accessor ${accessorIndex} has no buffer bytes.`);
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    if (!componentBytes) throw new Error(`Unsupported accessor component type ${accessor.componentType}.`);
    const components = accessor.type === "SCALAR" ? 1 : 3;
    const elementBytes = componentBytes * components;
    const stride = bufferView.byteStride || elementBytes;
    const count = accessor.count;
    if (!Number.isInteger(count) || count < 0) throw new Error(`Accessor ${accessorIndex} count is invalid.`);
    const start = (Number(bufferView.byteOffset) || 0) + (Number(accessor.byteOffset) || 0);
    const end = count === 0 ? start : start + (count - 1) * stride + elementBytes;
    if (end > payload.byteLength) throw new Error(`Accessor ${accessorIndex} exceeds its buffer.`);
    return { accessor, payload, componentBytes, stride, count, start, components };
}

function readVec3(json, buffers, accessorIndex) {
    const source = accessorBytes(json, buffers, accessorIndex, "VEC3");
    const view = new DataView(source.payload.buffer, source.payload.byteOffset, source.payload.byteLength);
    const normalized = source.accessor.normalized === true;
    const points = [];
    for (let index = 0; index < source.count; index += 1) {
        const offset = source.start + index * source.stride;
        points.push([
            readComponent(view, offset, source.accessor.componentType, normalized),
            readComponent(view, offset + source.componentBytes, source.accessor.componentType, normalized),
            readComponent(view, offset + source.componentBytes * 2, source.accessor.componentType, normalized),
        ]);
    }
    return points;
}

function readIndices(json, buffers, primitive, vertexCount) {
    if (!Number.isInteger(primitive.indices)) {
        return Array.from({ length: vertexCount }, (_, index) => index);
    }
    const source = accessorBytes(json, buffers, primitive.indices, "SCALAR");
    const view = new DataView(source.payload.buffer, source.payload.byteOffset, source.payload.byteLength);
    const indices = [];
    for (let index = 0; index < source.count; index += 1) {
        const offset = source.start + index * source.stride;
        indices.push(readComponent(view, offset, source.accessor.componentType, false));
    }
    return indices;
}

function gltfBuffers(json, bin, pkg, entry) {
    const buffers = [];
    for (const [index, buffer] of (json.buffers ?? []).entries()) {
        const uri = buffer?.uri;
        if (uri == null || uri === "") {
            if (index !== 0 || !bin) throw new Error(`GLTF buffer ${index} has no URI or GLB binary chunk.`);
            const declared = Number(buffer.byteLength);
            buffers[index] = Number.isFinite(declared) ? bin.subarray(0, declared) : bin;
            continue;
        }
        if (String(uri).startsWith("data:")) {
            buffers[index] = decodeDataUri(uri);
            continue;
        }
        const dependencyPath = resolveVehicleUri(entry, uri);
        const bytes = pkg.fileMap.get(dependencyPath);
        if (!bytes) throw new Error(`GLTF dependency "${dependencyPath}" was not selected.`);
        buffers[index] = bytes;
    }
    return buffers;
}

function readGltfDocument(json, buffers) {
    if (json.animations?.length || json.skins?.length) {
        throw new Error("Animated or skinned glTF meshes are not supported.");
    }
    const catalog = vehicleNodeCatalog(json);
    const parts = [];
    let ordinal = 0;
    for (const entry of catalog.nodes) {
        if (!entry.inScene || entry.mesh == null) continue;
        const world = catalog.worlds.get(entry.nodeIndex);
        const mesh = json.meshes?.[entry.mesh];
        const name = entry.name.trim() !== "" ? entry.name : `part-${ordinal}`;
        if (entry.name.trim() === "") ordinal += 1;
        for (const primitive of mesh?.primitives ?? []) {
            const mode = primitive?.mode ?? 4;
            if (mode !== 4) throw new Error("Only triangle meshes are supported.");
            const positions = transformPositions(readVec3(json, buffers, primitive.attributes.POSITION), world);
            const normals = primitive.attributes?.NORMAL == null
                ? null
                : transformPositions(readVec3(json, buffers, primitive.attributes.NORMAL), world).map((normal) => {
                    const transformed = transformNormal(world, normal);
                    return [transformed.x, transformed.y, transformed.z];
                });
            parts.push({
                name,
                nodeIndex: entry.nodeIndex,
                positions,
                normals,
                indices: readIndices(json, buffers, primitive, positions.length),
            });
        }
    }
    if (parts.length === 0) throw new Error("glTF mesh has no triangles.");
    return parts;
}

/** Node parts of one GLB, with each node's world transform baked into its vertices. */
export function readGlbNodeParts(bytes) {
    const parsed = readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
        ErrorType: Error,
    });
    const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
    const buffers = (parsed.json.buffers ?? []).map((buffer, index) => {
        if (index !== 0 || !bin) throw new Error("Vehicle GLB positions must live in the BIN chunk.");
        const declared = Number(buffer.byteLength);
        return Number.isFinite(declared) ? bin.subarray(0, declared) : bin;
    });
    return readGltfDocument(parsed.json, buffers);
}

function requireGltfDependencies(pkg, json, resourcePath) {
    for (const dependency of listGltfDependencyPaths(json, resourcePath)) {
        if (!pkg.fileMap.has(dependency)) throw new Error(`GLTF dependency "${dependency}" was not selected.`);
    }
}

function loadGltf(pkg, resourcePath, bytes) {
    if (extensionOf(resourcePath) === "glb") {
        const parsed = readGlb(bytes, {
            requireTotalLength: true,
            requireAligned: true,
            requireLeadingJson: true,
            json: "last",
            jsonPadding: "whitespace",
            copyChunks: true,
            ErrorType: Error,
        });
        requireGltfDependencies(pkg, parsed.json, resourcePath);
        const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? null;
        return readGltfDocument(parsed.json, gltfBuffers(parsed.json, bin, pkg, resourcePath));
    }
    const json = JSON.parse(new TextDecoder().decode(bytes));
    requireGltfDependencies(pkg, json, resourcePath);
    return readGltfDocument(json, gltfBuffers(json, null, pkg, resourcePath));
}

/**
 * Load one mesh referenced by a URDF geometry element.
 * STL and unnamed OBJ parts use ordinal names, so the filename is not identity.
 */
export function loadMeshPrimitives(pkg, resourcePath) {
    const bytes = pkg.fileMap.get(resourcePath);
    if (!bytes) return { parts: [], issues: [urdfIssue("vehicle.urdf.missing-mesh", resourcePath, `Mesh "${resourcePath}" was not selected.`)] };
    const extension = extensionOf(resourcePath);
    try {
        if (extension === "stl") return { parts: partsFromDocument(parseStl(bytes, "part-0")), issues: [] };
        if (extension === "obj") {
            return {
                parts: partsFromDocument(parseObjPackage(pkg.files, resourcePath, { fallbackName: "part" })),
                issues: [],
            };
        }
        if (extension === "glb" || extension === "gltf") return { parts: loadGltf(pkg, resourcePath, bytes), issues: [] };
        if (extension === "dae") {
            return { parts: [], issues: [urdfIssue("vehicle.urdf.unsupported-mesh", resourcePath, `COLLADA mesh "${resourcePath}" is outside this adapter.`)] };
        }
        return { parts: [], issues: [urdfIssue("vehicle.urdf.unsupported-mesh", resourcePath, `Mesh "${resourcePath}" is not a supported STL, OBJ, or glTF file.`)] };
    } catch (error) {
        return { parts: [], issues: [urdfIssue("vehicle.urdf.unsupported-mesh", resourcePath, error.message)] };
    }
}
