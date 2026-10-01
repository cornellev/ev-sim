/** Lift glTF materials into the asset-definition material list. */

import { VISUAL_MATERIAL_EXTENSIONS } from "../simulation/visual/VisualLayer.js";

const MATERIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function materialId(material, index, used) {
    const name = typeof material?.name === "string" ? material.name.trim() : "";
    const base = MATERIAL_ID.test(name) ? name : `source-material-${index + 1}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
    }
    used.add(id);
    return id;
}

function factor(value, width, fallback) {
    if (!Array.isArray(value) || value.length < width || value.slice(0, width).some((entry) => !Number.isFinite(Number(entry)))) return fallback;
    return value.slice(0, width).map((entry) => Number(entry));
}

function textureUse(json, textureInfo, dependencies) {
    if (!Number.isInteger(textureInfo?.index)) return null;
    const texture = json.textures?.[textureInfo.index];
    const image = json.images?.[texture?.source];
    const uri = typeof image?.uri === "string" ? image.uri : "";
    const digest = uri.startsWith("sha256:") ? uri.slice("sha256:".length) : "";
    const useHash = dependencies?.[uri];
    if (!SHA256.test(digest) || !SHA256.test(useHash ?? "")) return null;
    const transform = textureInfo.extensions?.KHR_texture_transform ?? {};
    return {
        slot: "baseColor",
        assetUri: `sha256:${digest}`,
        useHash,
        texCoord: Number.isInteger(textureInfo.texCoord) ? textureInfo.texCoord : 0,
        transform: {
            offset: factor(transform.offset, 2, [0, 0]),
            rotation: Number.isFinite(Number(transform.rotation)) ? Number(transform.rotation) : 0,
            scale: factor(transform.scale, 2, [1, 1]),
        },
    };
}

export function materialsFromGltf(json, dependencies = {}) {
    const source = json && typeof json === "object" ? json : {};
    const used = new Set();
    const materialIdByIndex = [];
    const materials = (Array.isArray(source.materials) ? source.materials : []).map((material, index) => {
        const pbr = material?.pbrMetallicRoughness ?? {};
        const baseColorFactor = factor(pbr.baseColorFactor, 4, [1, 1, 1, 1]);
        const alpha = baseColorFactor[3];
        const alphaMode = material?.alphaMode === "MASK" || material?.alphaMode === "BLEND" || alpha < 1 ? "MASK" : "OPAQUE";
        const id = materialId(material, index, used);
        materialIdByIndex[index] = id;
        const texture = textureUse(source, pbr.baseColorTexture, dependencies);
        return {
            id,
            mode: material?.extensions?.KHR_materials_unlit ? "unlit-captured-radiance" : "metallic-roughness",
            alphaMode,
            alphaCutoff: Number.isFinite(Number(material?.alphaCutoff)) ? Number(material.alphaCutoff) : 0.5,
            doubleSided: material?.doubleSided === true,
            parameters: {
                baseColorFactor,
                metallicFactor: Number.isFinite(Number(pbr.metallicFactor)) ? Number(pbr.metallicFactor) : 1,
                roughnessFactor: Number.isFinite(Number(pbr.roughnessFactor)) ? Number(pbr.roughnessFactor) : 1,
            },
            textures: texture ? [texture] : [],
            extensions: Object.keys(material?.extensions ?? {}).filter((entry) => VISUAL_MATERIAL_EXTENSIONS.includes(entry)).sort(),
        };
    });
    const materialIdByNode = new Map();
    (Array.isArray(source.nodes) ? source.nodes : []).forEach((node, nodeIndex) => {
        if (!Number.isInteger(node?.mesh)) return;
        const primitive = (source.meshes?.[node.mesh]?.primitives ?? []).find((entry) => Number.isInteger(entry?.material));
        const id = primitive ? materialIdByIndex[primitive.material] : null;
        if (id) materialIdByNode.set(nodeIndex, id);
    });
    return { materials, materialIdByNode };
}
