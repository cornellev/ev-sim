/** Minimal deterministic GLTF geometry decoding for ED-07 server recompilation. */

const COMPONENTS = new Map([
    [5120, { bytes: 1, read: "getInt8" }],
    [5121, { bytes: 1, read: "getUint8" }],
    [5122, { bytes: 2, read: "getInt16" }],
    [5123, { bytes: 2, read: "getUint16" }],
    [5125, { bytes: 4, read: "getUint32" }],
    [5126, { bytes: 4, read: "getFloat32" }],
]);
const WIDTHS = new Map([["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4], ["MAT4", 16]]);

function parseGlb(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new TypeError("Compiled GLB header is invalid.");
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset < bytes.byteLength) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        const chunk = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk).replace(/\0+$/u, ""));
        else if (type === 0x004e4942) binary = chunk;
        offset += 8 + length;
    }
    if (!json) throw new TypeError("Compiled GLB has no JSON chunk.");
    return { json, binary };
}

function parseDocument(bytes, mediaType) {
    if (mediaType === "model/gltf-binary") return parseGlb(bytes);
    if (mediaType === "model/gltf+json") return { json: JSON.parse(new TextDecoder().decode(bytes)), binary: null };
    throw new TypeError(`Unsupported GLTF media type ${mediaType}.`);
}

function readAccessor(gltf, buffers, accessorIndex) {
    const accessor = gltf.accessors?.[accessorIndex];
    if (!accessor || accessor.sparse) throw new TypeError(`GLTF accessor ${accessorIndex} is missing or sparse.`);
    const component = COMPONENTS.get(accessor.componentType);
    const width = WIDTHS.get(accessor.type);
    const bufferView = gltf.bufferViews?.[accessor.bufferView];
    const bytes = buffers[bufferView?.buffer];
    if (!component || !width || !bufferView || !bytes) throw new TypeError(`GLTF accessor ${accessorIndex} has an unsupported layout.`);
    const stride = bufferView.byteStride ?? component.bytes * width;
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maximum = component.bytes === 1 ? (accessor.componentType === 5120 ? 127 : 255) : (component.bytes === 2 ? (accessor.componentType === 5122 ? 32767 : 65535) : 1);
    const minimum = accessor.componentType === 5120 ? -128 : accessor.componentType === 5122 ? -32768 : 0;
    const values = Array.from({ length: accessor.count }, (_, index) => Array.from({ length: width }, (_unused, axis) => {
        const byteOffset = start + index * stride + axis * component.bytes;
        const value = view[component.read](byteOffset, true);
        if (!accessor.normalized || accessor.componentType === 5126 || accessor.componentType === 5125) return value;
        return minimum < 0 ? Math.max(-1, value / maximum) : value / maximum;
    }));
    return { values, type: accessor.type, componentType: accessor.componentType, normalized: accessor.normalized === true };
}

async function loadBuffers(gltf, binary, modelUse, visualAssets) {
    const result = [];
    for (let index = 0; index < (gltf.buffers ?? []).length; index += 1) {
        const buffer = gltf.buffers[index];
        if (!buffer.uri) {
            if (!binary) throw new TypeError(`GLTF buffer ${index} has no URI or GLB binary chunk.`);
            result.push(binary);
            continue;
        }
        const useHash = modelUse.dependencies?.[buffer.uri];
        if (!useHash) throw new TypeError(`GLTF buffer ${index} URI is not bound to a source use.`);
        result.push(await readUseBytes(useHash, visualAssets));
    }
    return result;
}

async function readUseBytes(useHash, visualAssets) {
    if (typeof visualAssets.getUseContent === "function") {
        const content = await visualAssets.getUseContent(useHash);
        return content.bytes instanceof Uint8Array ? content.bytes : new Uint8Array(content.bytes);
    }
    const use = await visualAssets.getUse(useHash);
    const bytes = await visualAssets.readPublishedBytes(use.asset.sha256, { expectedSize: use.asset.sizeBytes });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export async function decodeAssetSourceGeometry(modelUseHash, visualAssets) {
    const modelUse = await visualAssets.getUse(modelUseHash);
    const bytes = await readUseBytes(modelUseHash, visualAssets);
    const { json, binary } = parseDocument(bytes, modelUse.asset.mediaType);
    const buffers = await loadBuffers(json, binary, modelUse, visualAssets);
    const nodes = {};
    for (let nodeIndex = 0; nodeIndex < (json.nodes ?? []).length; nodeIndex += 1) {
        const node = json.nodes[nodeIndex];
        if (!Number.isInteger(node.mesh)) continue;
        const mesh = json.meshes?.[node.mesh];
        const geometry = { vertices: [], triangles: [] };
        for (const [primitiveIndex, primitive] of (mesh?.primitives ?? []).entries()) {
            if ((primitive.mode ?? 4) !== 4 || !Number.isInteger(primitive.attributes?.POSITION)) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} must contain triangle POSITION data.`);
            const positions = readAccessor(json, buffers, primitive.attributes.POSITION).values;
            if (positions.some((point) => point.length !== 3 || point.some((value) => !Number.isFinite(value)))) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} has invalid positions.`);
            const indices = primitive.indices === undefined
                ? Array.from({ length: positions.length }, (_, index) => index)
                : readAccessor(json, buffers, primitive.indices).values.map((entry) => entry[0]);
            if (indices.length % 3 !== 0) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} has non-triangle indices.`);
            const offset = geometry.vertices.length;
            geometry.vertices.push(...positions);
            for (let index = 0; index < indices.length; index += 3) geometry.triangles.push([indices[index] + offset, indices[index + 1] + offset, indices[index + 2] + offset]);
        }
        nodes[nodeIndex] = geometry;
    }
    return nodes;
}

const SUPPORTED_ATTRIBUTES = new Set([
    "POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "TEXCOORD_1",
    "COLOR_0", "COLOR_1", "JOINTS_0", "JOINTS_1", "WEIGHTS_0", "WEIGHTS_1",
]);

function nodeMatrix(node = {}) {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.map(Number);
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
    return [
        (1-2*(yy+zz))*sx, (2*(xy+wz))*sx, (2*(xz-wy))*sx, 0,
        (2*(xy-wz))*sy, (1-2*(xx+zz))*sy, (2*(yz+wx))*sy, 0,
        (2*(xz+wy))*sz, (2*(yz-wx))*sz, (1-2*(xx+yy))*sz, 0,
        tx, ty, tz, 1,
    ];
}

/** Decode immutable static GLTF primitives for deterministic appearance recompilation. */
export async function decodeAssetAppearanceGeometry(modelUseHash, visualAssets) {
    const modelUse = await visualAssets.getUse(modelUseHash);
    const bytes = await readUseBytes(modelUseHash, visualAssets);
    const { json, binary } = parseDocument(bytes, modelUse.asset.mediaType);
    const buffers = await loadBuffers(json, binary, modelUse, visualAssets);
    const textureDescriptor = async (textureInfo, slot) => {
        if (!Number.isInteger(textureInfo?.index)) return null;
        const texture = json.textures?.[textureInfo.index];
        const image = json.images?.[texture?.source];
        if (!image?.uri) throw new TypeError(`Embedded ${slot} textures must be replaced with a source-bound VIS texture before asset publication.`);
        const useHash = modelUse.dependencies?.[image.uri];
        if (!useHash) throw new TypeError(`Texture ${image.uri} has no source-bound visual asset use.`);
        const use = await visualAssets.getUse(useHash);
        return {
            slot, assetUri: `sha256:${use.asset.sha256}`, useHash,
            texCoord: Number.isInteger(textureInfo.texCoord) ? textureInfo.texCoord : 0,
            transform: {
                offset: textureInfo.extensions?.KHR_texture_transform?.offset ?? [0, 0],
                rotation: textureInfo.extensions?.KHR_texture_transform?.rotation ?? 0,
                scale: textureInfo.extensions?.KHR_texture_transform?.scale ?? [1, 1],
            },
        };
    };
    const materials = [];
    for (let index = 0; index < (json.materials ?? []).length; index += 1) {
        const material = json.materials[index] ?? {};
        const pbr = material.pbrMetallicRoughness ?? {};
        const clearcoat = material.extensions?.KHR_materials_clearcoat ?? {};
        const sheen = material.extensions?.KHR_materials_sheen ?? {};
        const specular = material.extensions?.KHR_materials_specular ?? {};
        const textureInputs = [
            [pbr.baseColorTexture, "baseColor"], [pbr.metallicRoughnessTexture, "metallicRoughness"],
            [material.normalTexture, "normal"], [material.occlusionTexture, "occlusion"], [material.emissiveTexture, "emissive"],
            [clearcoat.clearcoatTexture, "clearcoat"], [clearcoat.clearcoatNormalTexture, "clearcoatNormal"],
            [clearcoat.clearcoatRoughnessTexture, "clearcoatRoughness"], [sheen.sheenColorTexture, "sheenColor"],
            [sheen.sheenRoughnessTexture, "sheenRoughness"], [specular.specularTexture, "specular"],
            [specular.specularColorTexture, "specularColor"],
        ];
        const textures = (await Promise.all(textureInputs.map(([info, slot]) => textureDescriptor(info, slot)))).filter(Boolean);
        const unlit = Boolean(material.extensions?.KHR_materials_unlit);
        materials.push({
            index, name: typeof material.name === "string" && material.name ? material.name : null,
            descriptor: {
                id: `source-material-${index}`,
                mode: unlit ? "unlit-captured-radiance" : "metallic-roughness",
                alphaMode: material.alphaMode ?? "OPAQUE", alphaCutoff: material.alphaCutoff ?? 0.5,
                doubleSided: material.doubleSided === true,
                parameters: {
                    baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1], metallicFactor: pbr.metallicFactor ?? 1,
                    roughnessFactor: pbr.roughnessFactor ?? 1, emissiveFactor: material.emissiveFactor ?? [0, 0, 0],
                    emissiveStrength: material.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1,
                    normalScale: material.normalTexture?.scale ?? 1, occlusionStrength: material.occlusionTexture?.strength ?? 1,
                    clearcoatFactor: clearcoat.clearcoatFactor ?? 0, clearcoatRoughnessFactor: clearcoat.clearcoatRoughnessFactor ?? 0,
                    sheenColorFactor: sheen.sheenColorFactor ?? [0, 0, 0], sheenRoughnessFactor: sheen.sheenRoughnessFactor ?? 0,
                    specularFactor: specular.specularFactor ?? 1, specularColorFactor: specular.specularColorFactor ?? [1, 1, 1],
                },
                textures,
                extensions: Object.keys(material.extensions ?? {}).filter((entry) => [
                    "KHR_materials_unlit", "KHR_materials_clearcoat", "KHR_materials_sheen",
                    "KHR_materials_specular", "KHR_materials_emissive_strength",
                ].includes(entry)).sort(),
            },
        });
    }
    const nodes = {};
    for (let nodeIndex = 0; nodeIndex < (json.nodes ?? []).length; nodeIndex += 1) {
        const node = json.nodes[nodeIndex];
        if (!Number.isInteger(node.mesh)) continue;
        const mesh = json.meshes?.[node.mesh];
        nodes[nodeIndex] = {
            matrix: nodeMatrix(node),
            primitives: (mesh?.primitives ?? []).map((primitive, primitiveIndex) => {
                if ((primitive.mode ?? 4) !== 4 || !Number.isInteger(primitive.attributes?.POSITION)) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} must contain triangle POSITION data.`);
                const attributes = Object.fromEntries(Object.entries(primitive.attributes)
                    .filter(([semantic]) => SUPPORTED_ATTRIBUTES.has(semantic))
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([semantic, accessorIndex]) => [semantic, readAccessor(json, buffers, accessorIndex)]));
                const count = attributes.POSITION.values.length;
                if (Object.values(attributes).some((attribute) => attribute.values.length !== count)) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} attributes have inconsistent counts.`);
                const indices = primitive.indices === undefined
                    ? Array.from({ length: count }, (_, index) => index)
                    : readAccessor(json, buffers, primitive.indices).values.map((entry) => entry[0]);
                if (indices.length % 3 !== 0) throw new TypeError(`GLTF node ${nodeIndex} primitive ${primitiveIndex} has non-triangle indices.`);
                return {
                    attributes, indices,
                    materialIndex: Number.isInteger(primitive.material) ? primitive.material : null,
                    materialName: Number.isInteger(primitive.material) ? (json.materials?.[primitive.material]?.name ?? null) : null,
                };
            }),
        };
    }
    return { modelUse, nodes, materials };
}
