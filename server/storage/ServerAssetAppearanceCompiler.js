/** Deterministic static GLB compiler for ED-07 published asset appearance. */

import { createHash } from "node:crypto";

import { multiplyAssetMatrices } from "../../app/editor-assets/AssetCompiler.js";
import { simulationSha256 } from "../../app/simulation/kernel/SimulationHashes.js";
import { canonicalExactStringify, hashVisualAssetUse, normalizeVisualAssetUse } from "../../app/simulation/visual/VisualLayer.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const DEFAULT_PARAMETERS = Object.freeze({
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1,
    emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1,
    occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0,
    sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0,
    specularFactor: 1, specularColorFactor: [1, 1, 1],
});

function defaultMaterial() {
    return {
        id: "default", mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5,
        doubleSided: false, parameters: structuredClone(DEFAULT_PARAMETERS), textures: [], extensions: [],
    };
}

function namespaceMaterial(assetId, revision, material) {
    return { ...structuredClone(material), id: `asset:${assetId}:${revision}:material:${material.id}` };
}

function pad4(bytes, value = 0) {
    const padding = (4 - bytes.length % 4) % 4;
    return padding ? Buffer.concat([bytes, Buffer.alloc(padding, value)]) : bytes;
}

function matrixForNode(part, decodedNode) {
    if (part.kind === "asset-reference") return multiplyAssetMatrices(part.matrix, decodedNode.matrix ?? IDENTITY);
    return part.matrix;
}

function materialForPrimitive({ part, primitive, primitiveIndex, source, ownMaterials, childMaterials }) {
    if (part.kind === "asset-reference") {
        if (!primitive.materialName) throw new TypeError(`Child appearance ${part.assetId}@${part.revision} primitive ${primitiveIndex} has no declared material.`);
        const rawId = `${part.id}/${primitive.materialName}`;
        const descriptor = childMaterials.get(rawId);
        if (!descriptor) throw new TypeError(`Child appearance material ${rawId} is missing from the pinned revision.`);
        return descriptor;
    }
    const binding = part.materialBindings?.[primitive.materialName]
        ?? part.materialBindings?.[String(primitive.materialIndex)]
        ?? part.materialBindings?.[`primitive:${primitiveIndex}`]
        ?? part.materialBindings?.default;
    if (binding) {
        const descriptor = ownMaterials.get(binding);
        if (!descriptor) throw new TypeError(`Part ${part.id} binds missing material ${binding}.`);
        return descriptor;
    }
    if (primitive.materialName && ownMaterials.has(primitive.materialName)) return ownMaterials.get(primitive.materialName);
    if (ownMaterials.size === 1) return ownMaterials.values().next().value;
    const imported = source.materials.find((entry) => entry.index === primitive.materialIndex)?.descriptor;
    if (imported) return { ...structuredClone(imported), id: `${part.sourceId}/${imported.id}` };
    if (ownMaterials.size === 0) return defaultMaterial();
    throw new TypeError(`Part ${part.id} primitive ${primitiveIndex} requires an explicit material binding.`);
}

function encodeAttribute(values, semantic) {
    const width = values[0]?.length ?? 0;
    if (values.length === 0 || ![1, 2, 3, 4, 16].includes(width) || values.some((entry) => entry.length !== width || entry.some((value) => !Number.isFinite(value)))) {
        throw new TypeError(`${semantic} contains invalid numeric data.`);
    }
    if (semantic.startsWith("JOINTS_")) {
        const bytes = Buffer.alloc(values.length * width * 2);
        let offset = 0;
        for (const entry of values) for (const value of entry) { if (!Number.isInteger(value) || value < 0 || value > 65535) throw new TypeError(`${semantic} joint index is out of range.`); bytes.writeUInt16LE(value, offset); offset += 2; }
        return { bytes, componentType: 5123 };
    }
    const bytes = Buffer.alloc(values.length * width * 4);
    let offset = 0;
    for (const entry of values) for (const value of entry) { bytes.writeFloatLE(value, offset); offset += 4; }
    return { bytes, componentType: 5126 };
}

function accessorType(width) {
    return width === 1 ? "SCALAR" : width === 2 ? "VEC2" : width === 3 ? "VEC3" : width === 4 ? "VEC4" : "MAT4";
}

function addBufferData(state, bytes, { target, accessor }) {
    while (state.byteLength % 4) { state.buffers.push(Buffer.from([0])); state.byteLength += 1; }
    const byteOffset = state.byteLength;
    state.buffers.push(bytes); state.byteLength += bytes.length;
    const bufferView = state.bufferViews.length;
    state.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    const index = state.accessors.length;
    state.accessors.push({ bufferView, byteOffset: 0, ...accessor });
    return index;
}

function encodePrimitive(state, primitive, materialIndex) {
    const attributes = {};
    for (const [semantic, source] of Object.entries(primitive.attributes).sort(([left], [right]) => left.localeCompare(right))) {
        const encoded = encodeAttribute(source.values, semantic);
        const values = source.values;
        const flatAxis = (axis) => values.map((entry) => entry[axis]);
        attributes[semantic] = addBufferData(state, encoded.bytes, {
            target: 34962,
            accessor: {
                componentType: encoded.componentType, count: values.length, type: accessorType(values[0].length),
                ...(semantic === "POSITION" ? {
                    min: values[0].map((_unused, axis) => Math.min(...flatAxis(axis))),
                    max: values[0].map((_unused, axis) => Math.max(...flatAxis(axis))),
                } : {}),
            },
        });
    }
    const indices = Buffer.alloc(primitive.indices.length * 4);
    primitive.indices.forEach((value, index) => {
        if (!Number.isInteger(value) || value < 0 || value >= primitive.attributes.POSITION.values.length) throw new TypeError("Appearance primitive index is out of range.");
        indices.writeUInt32LE(value, index * 4);
    });
    return {
        attributes,
        indices: addBufferData(state, indices, { target: 34963, accessor: { componentType: 5125, count: primitive.indices.length, type: "SCALAR" } }),
        material: materialIndex,
        mode: 4,
    };
}

/** Compile one validated definition and resolved source/child GLTF documents. */
export function compileAssetAppearance({ assetId, revision, compiled, sources, children }) {
    const ownMaterials = new Map(compiled.definition.materials.map((material) => [material.id, material]));
    const childMaterials = new Map(compiled.materials.filter((material) => !ownMaterials.has(material.id)).map((material) => [material.id, material]));
    const usedMaterials = new Map();
    const state = { buffers: [], byteLength: 0, bufferViews: [], accessors: [] };
    const meshes = [];
    const nodes = [];
    for (const part of compiled.appearanceParts) {
        const source = part.kind === "model-node" ? sources[part.sourceId] : children[`${part.assetId}@${part.revision}`];
        if (!source) throw new TypeError(`Appearance source for part ${part.id} is missing.`);
        const sourceNodes = part.kind === "model-node" ? [[part.nodeIndex, source.nodes[part.nodeIndex]]] : Object.entries(source.nodes).sort(([left], [right]) => Number(left) - Number(right));
        for (const [nodeIndex, decodedNode] of sourceNodes) {
            if (!decodedNode) throw new TypeError(`Appearance node ${nodeIndex} for part ${part.id} is missing.`);
            const primitives = decodedNode.primitives.map((primitive, primitiveIndex) => {
                const raw = materialForPrimitive({ part, primitive, primitiveIndex, source, ownMaterials, childMaterials });
                const namespaced = namespaceMaterial(assetId, revision, raw);
                if (!usedMaterials.has(namespaced.id)) usedMaterials.set(namespaced.id, namespaced);
                return { primitive, materialId: namespaced.id };
            });
            const meshIndex = meshes.length;
            meshes.push({ name: `${part.id}:${nodeIndex}`, primitives });
            nodes.push({ name: `${part.id}:${nodeIndex}`, mesh: meshIndex, matrix: matrixForNode(part, decodedNode) });
        }
    }
    const appearance = [...usedMaterials.values()].sort((left, right) => left.id.localeCompare(right.id));
    const materialIndices = new Map(appearance.map((material, index) => [material.id, index]));
    const encodedMeshes = meshes.map((mesh) => ({
        name: mesh.name,
        primitives: mesh.primitives.map(({ primitive, materialId }) => encodePrimitive(state, primitive, materialIndices.get(materialId))),
    }));
    const binary = pad4(Buffer.concat(state.buffers));
    const json = {
        asset: { generator: "cev-sim-asset-compiler@1", version: "2.0" },
        scene: 0, scenes: [{ nodes: nodes.map((_entry, index) => index) }], nodes,
        meshes: encodedMeshes, materials: appearance.map((material) => ({ name: material.id })),
        accessors: state.accessors, bufferViews: state.bufferViews, buffers: [{ byteLength: binary.length }],
    };
    const jsonBytes = pad4(Buffer.from(canonicalExactStringify(json), "utf8"), 0x20);
    const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8);
    const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonBytes.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binaryHeader = Buffer.alloc(8); binaryHeader.writeUInt32LE(binary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
    const bytes = Buffer.concat([header, jsonHeader, jsonBytes, binaryHeader, binary]);
    const geometryHash = simulationSha256(nodes.map((node, index) => ({
        matrix: node.matrix,
        primitives: meshes[index].primitives.map(({ primitive }) => ({
            attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([semantic, attribute]) => [semantic, attribute.values])),
            indices: primitive.indices,
        })),
    })));
    return { bytes, appearance, geometryHash };
}

export function compiledAppearanceUse(bytes, sourceIds) {
    const asset = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mediaType: "model/gltf-binary", sizeBytes: bytes.length, role: "mesh",
    };
    const use = normalizeVisualAssetUse({ asset, sourceIds: [...new Set(sourceIds)].sort(), dependencies: {} });
    return { asset, use, useHash: hashVisualAssetUse(use) };
}
