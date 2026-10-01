/** Deterministic glTF 2.0 GLB for a mesh document. Images stay external files. */

import { sniffImageMediaType } from "../GltfImportPlan.js";
import { writeGlb } from "../../simulation/visual/GlbContainer.js";
import { normalizeMeshDocument } from "./MeshDocument.js";

const FLOAT = 5126;
const UNSIGNED_INT = 5125;

function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function roughnessFromNs(ns) {
    return clamp01(1 - ns / 1000);
}

class BinWriter {
    constructor() {
        this.parts = [];
        this.length = 0;
    }

    bytes(chunk) {
        const copy = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
        const offset = this.length;
        this.parts.push(copy);
        this.length += copy.byteLength;
        return offset;
    }

    float32(values) {
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, index) => view.setFloat32(index * 4, value, true));
        return this.bytes(bytes);
    }

    uint32(values) {
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, index) => view.setUint32(index * 4, value, true));
        return this.bytes(bytes);
    }

    toUint8Array() {
        const output = new Uint8Array(this.length);
        let offset = 0;
        for (const part of this.parts) {
            output.set(part, offset);
            offset += part.byteLength;
        }
        return output;
    }
}

function bounds(vectors) {
    const min = vectors[0].slice();
    const max = vectors[0].slice();
    for (const vector of vectors) {
        vector.forEach((value, axis) => {
            if (value < min[axis]) min[axis] = value;
            if (value > max[axis]) max[axis] = value;
        });
    }
    return { min, max };
}

function pushAccessor(accessors, bufferViews, writer, { values, type, componentType, itemSize, min = null, max = null }) {
    const byteOffset = componentType === FLOAT ? writer.float32(values) : writer.uint32(values);
    const bufferView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: values.length * 4 });
    const accessor = { bufferView, componentType, count: values.length / itemSize, type };
    if (min) accessor.min = min;
    if (max) accessor.max = max;
    accessors.push(accessor);
    return accessors.length - 1;
}

export function encodeMeshDocumentGlb(document) {
    const mesh = normalizeMeshDocument(document);
    const materials = [];
    const images = [];
    const textures = [];
    const imageIndex = new Map();
    for (const image of [...mesh.images].sort((left, right) => left.path.localeCompare(right.path))) {
        if (!image.path) throw new Error("Mesh image is missing a package path.");
        if (image.path === "import.glb") throw new Error("Mesh image path import.glb collides with the transcoded model.");
        const mediaType = sniffImageMediaType(image.bytes);
        imageIndex.set(image.path, images.length);
        images.push({ path: image.path, mediaType, bytes: image.bytes.slice() });
    }
    const materialIndex = new Map();
    for (const material of mesh.materials) {
        const pbr = {
            baseColorFactor: [...material.kd, material.d],
            metallicFactor: 0,
            roughnessFactor: roughnessFromNs(material.ns),
        };
        if (material.mapKd) {
            const source = imageIndex.get(material.mapKd);
            if (source === undefined) throw new Error(`Mesh image "${material.mapKd}" was not declared.`);
            if (!textures.some((texture) => texture.source === source)) textures.push({ source });
            pbr.baseColorTexture = { index: textures.findIndex((texture) => texture.source === source) };
        }
        const encoded = {
            name: material.id,
            pbrMetallicRoughness: pbr,
            alphaMode: material.d < 1 ? "MASK" : "OPAQUE",
        };
        if (encoded.alphaMode === "MASK") encoded.alphaCutoff = 0.5;
        materialIndex.set(material.id, materials.length);
        materials.push(encoded);
    }
    const writer = new BinWriter();
    const accessors = [];
    const bufferViews = [];
    const meshes = [];
    const nodes = mesh.nodes.map((node) => {
        const encoded = { name: node.name };
        if (node.primitives.length === 0) return encoded;
        const primitives = node.primitives.map((primitive) => {
            const position = bounds(primitive.positions);
            const attributes = {
                POSITION: pushAccessor(accessors, bufferViews, writer, {
                    values: primitive.positions.flat(),
                    type: "VEC3",
                    componentType: FLOAT,
                    itemSize: 3,
                    min: position.min,
                    max: position.max,
                }),
            };
            if (primitive.normals) {
                attributes.NORMAL = pushAccessor(accessors, bufferViews, writer, {
                    values: primitive.normals.flat(),
                    type: "VEC3",
                    componentType: FLOAT,
                    itemSize: 3,
                });
            }
            if (primitive.uvs) {
                attributes.TEXCOORD_0 = pushAccessor(accessors, bufferViews, writer, {
                    values: primitive.uvs.flat(),
                    type: "VEC2",
                    componentType: FLOAT,
                    itemSize: 2,
                });
            }
            const encodedPrimitive = {
                attributes,
                indices: pushAccessor(accessors, bufferViews, writer, {
                    values: primitive.indices,
                    type: "SCALAR",
                    componentType: UNSIGNED_INT,
                    itemSize: 1,
                }),
            };
            if (primitive.materialId != null) encodedPrimitive.material = materialIndex.get(primitive.materialId);
            return encodedPrimitive;
        });
        encoded.mesh = meshes.length;
        meshes.push({ name: node.name, primitives });
        return encoded;
    });
    if (meshes.length === 0) throw new Error("Mesh document has no triangle primitives.");
    const children = mesh.nodes.map(() => []);
    const indexById = new Map(mesh.nodes.map((node, index) => [node.id, index]));
    mesh.nodes.forEach((node, index) => {
        if (node.parentId != null) children[indexById.get(node.parentId)].push(index);
    });
    children.forEach((list, index) => {
        if (list.length > 0) nodes[index].children = list;
    });
    const data = writer.toUint8Array();
    const paddedLength = Math.ceil(data.length / 4) * 4;
    const bin = new Uint8Array(paddedLength);
    bin.set(data);
    const json = {
        asset: { version: "2.0", generator: "cev-sim.mesh-glb@1" },
        scene: 0,
        scenes: [{ nodes: mesh.nodes.flatMap((node, index) => (node.parentId == null ? [index] : [])) }],
        nodes,
        meshes,
        accessors,
        bufferViews,
        buffers: [{ byteLength: data.length }],
    };
    if (materials.length > 0) json.materials = materials;
    if (textures.length > 0) json.textures = textures;
    if (images.length > 0) json.images = images.map((image) => ({ uri: image.path, mimeType: image.mediaType }));
    return { glbBytes: writeGlb(json, bin), mediaType: "model/gltf-binary", images };
}
