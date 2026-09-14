import { VISUAL_PREVIEW_ERROR_CODES, VisualPreviewError } from "../../../simulation/visual/VisualLayer.js";
import { createDescriptorMaterial, replaceEmbeddedMaterials } from "../../environment/visual/VisualMaterialFactory.js";

function toArrayBuffer(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function collectMaterialTextures(material) {
    const textures = new Set();
    for (const value of Object.values(material ?? {})) if (value?.isTexture) textures.add(value);
    return textures;
}

/** Decode one published JPEG/PNG/KTX2 appearance texture into a THREE.Texture. */
export async function decodeAppearanceTexture({
    THREE,
    bytes,
    mediaType,
    KTX2Loader = null,
    renderer = null,
} = {}) {
    const type = String(mediaType ?? "").split(";")[0];
    try {
        if (type === "image/ktx2") {
            if (!KTX2Loader) {
                throw new VisualPreviewError(
                    VISUAL_PREVIEW_ERROR_CODES.UNSUPPORTED_RENDERER,
                    "KTX2 textures require a supported GPU transcoder.",
                );
            }
            const ktx2 = new KTX2Loader().setTranscoderPath("/vendor/basis/");
            if (renderer) ktx2.detectSupport(renderer);
            return await new Promise((resolve, reject) => {
                ktx2.parse(toArrayBuffer(bytes), resolve, reject);
            });
        }
        const blob = new Blob([bytes], { type });
        const objectUrl = URL.createObjectURL(blob);
        try {
            return await new THREE.TextureLoader().loadAsync(objectUrl);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    } catch (error) {
        if (error instanceof VisualPreviewError) throw error;
        throw new VisualPreviewError(
            VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
            error.message || `Failed to decode ${type} texture.`,
        );
    }
}

/**
 * Replace compiled-GLB placeholder materials with descriptor materials.
 * `texturesByUseHash` is keyed per published texture use, not by slot, so
 * two materials can share a slot name without sharing a map.
 */
export function applyPublishedAppearance({ root, THREE, appearance, texturesByUseHash } = {}) {
    const materialsById = new Map();
    const createdMaterials = new Set();
    const createdTextures = new Set();
    const dispose = () => {
        createdTextures.forEach((texture) => texture.dispose?.());
        createdMaterials.forEach((material) => material.dispose?.());
        createdTextures.clear();
        createdMaterials.clear();
    };
    try {
        for (const descriptor of appearance ?? []) {
            const texturesBySlot = new Map();
            for (const texture of descriptor.textures ?? []) {
                const source = texturesByUseHash?.get(texture.useHash);
                if (!source) {
                    throw new VisualPreviewError(
                        VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                        `Appearance texture use ${JSON.stringify(texture.useHash)} is missing for material ${JSON.stringify(descriptor.id)}.`,
                    );
                }
                texturesBySlot.set(texture.slot, source);
            }
            const material = createDescriptorMaterial(THREE, descriptor, texturesBySlot);
            createdMaterials.add(material);
            collectMaterialTextures(material).forEach((texture) => createdTextures.add(texture));
            materialsById.set(descriptor.id, material);
        }
        if (materialsById.size > 0) replaceEmbeddedMaterials(root, THREE, materialsById);
        return dispose;
    } catch (error) {
        dispose();
        throw error;
    }
}
