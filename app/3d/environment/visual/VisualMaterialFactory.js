import { VISUAL_PREVIEW_ERROR_CODES, VisualPreviewError } from "../../../simulation/visual/VisualLayer.js";

const SRGB_SLOTS = new Set(["baseColor", "emissive", "sheenColor", "specularColor"]);
const MATERIAL_PROPERTY = {
    baseColor: "map",
    metallicRoughness: "metalnessMap",
    normal: "normalMap",
    occlusion: "aoMap",
    emissive: "emissiveMap",
    clearcoat: "clearcoatMap",
    clearcoatNormal: "clearcoatNormalMap",
    clearcoatRoughness: "clearcoatRoughnessMap",
    sheenColor: "sheenColorMap",
    sheenRoughness: "sheenRoughnessMap",
    specular: "specularIntensityMap",
    specularColor: "specularColorMap",
};

export function assertGltfMaterialBijection(gltfJson, materialIds) {
    const declared = [...materialIds];
    const jsonMaterials = gltfJson?.materials ?? [];
    const names = jsonMaterials.map((material, index) => {
        const name = material?.name;
        if (typeof name !== "string" || !name || name !== name.normalize("NFC")) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
                `glTF material ${index} must have a unique NFC name matching a declared materialId.`,
            );
        }
        return name;
    });
    if (new Set(names).size !== names.length) {
        throw new VisualPreviewError(
            VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
            "glTF material names must be unique.",
        );
    }
    const declaredSet = new Set(declared);
    const namedSet = new Set(names);
    for (const name of names) {
        if (!declaredSet.has(name)) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
                `glTF material ${JSON.stringify(name)} is not declared on the instance.`,
            );
        }
    }
    for (const id of declared) {
        if (!namedSet.has(id)) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
                `Declared material ${JSON.stringify(id)} is not used by the glTF asset.`,
            );
        }
    }
    for (const [meshIndex, mesh] of (gltfJson?.meshes ?? []).entries()) {
        for (const [primitiveIndex, primitive] of (mesh?.primitives ?? []).entries()) {
            if (primitive?.material === undefined) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
                    `meshes.${meshIndex}.primitives.${primitiveIndex} has an unnamed material.`,
                );
            }
        }
    }
}

export function createDescriptorMaterial(THREE, descriptorMaterial, texturesBySlot = new Map()) {
    const unlit = descriptorMaterial.mode === "unlit-captured-radiance";
    const material = unlit ? new THREE.MeshBasicMaterial() : new THREE.MeshPhysicalMaterial();
    const parameters = descriptorMaterial.parameters;
    const [red, green, blue, alpha] = parameters.baseColorFactor;
    material.name = descriptorMaterial.id;
    material.color.setRGB(red, green, blue);
    material.opacity = alpha;
    material.transparent = false;
    material.depthWrite = true;
    material.toneMapped = !unlit;
    material.side = descriptorMaterial.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    if (descriptorMaterial.alphaMode === "MASK") {
        material.alphaTest = descriptorMaterial.alphaCutoff;
    }
    if (!unlit) {
        material.metalness = parameters.metallicFactor;
        material.roughness = parameters.roughnessFactor;
        material.emissive.setRGB(...parameters.emissiveFactor);
        material.emissiveIntensity = parameters.emissiveStrength;
        material.normalScale?.set?.(parameters.normalScale, parameters.normalScale);
        material.aoMapIntensity = parameters.occlusionStrength;
        material.clearcoat = parameters.clearcoatFactor;
        material.clearcoatRoughness = parameters.clearcoatRoughnessFactor;
        material.sheen = Math.max(parameters.sheenColorFactor[0], parameters.sheenColorFactor[1], parameters.sheenColorFactor[2], parameters.sheenRoughnessFactor);
        material.sheenColor?.setRGB?.(...parameters.sheenColorFactor);
        material.sheenRoughness = parameters.sheenRoughnessFactor;
        material.specularIntensity = parameters.specularFactor;
        material.specularColor?.setRGB?.(...parameters.specularColorFactor);
    }
    for (const texture of descriptorMaterial.textures) {
        const source = texturesBySlot.get(texture.slot);
        if (!source) continue;
        const applied = source.clone();
        applied.colorSpace = SRGB_SLOTS.has(texture.slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (unlit) applied.flipY = false;
        if ("channel" in applied) applied.channel = texture.texCoord;
        applied.offset.set(texture.transform.offset[0], texture.transform.offset[1]);
        applied.rotation = texture.transform.rotation;
        applied.repeat.set(texture.transform.scale[0], texture.transform.scale[1]);
        applied.matrixAutoUpdate = true;
        applied.needsUpdate = true;
        const property = MATERIAL_PROPERTY[texture.slot];
        if (property) material[property] = applied;
        if (texture.slot === "metallicRoughness" && !unlit) {
            material.roughnessMap = applied;
        }
    }
    material.needsUpdate = true;
    return material;
}

export function replaceEmbeddedMaterials(root, THREE, materialsById) {
    root.traverse((object) => {
        if (!object.isMesh) return;
        const current = Array.isArray(object.material) ? object.material : [object.material];
        const next = current.map((material) => {
            const replacement = materialsById.get(material?.name);
            if (!replacement) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.MATERIAL_MISMATCH,
                    `Embedded material ${JSON.stringify(material?.name)} has no descriptor replacement.`,
                );
            }
            return replacement;
        });
        object.material = Array.isArray(object.material) ? next : next[0];
    });
}
