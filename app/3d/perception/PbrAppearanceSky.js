import * as THREE from "three";
import { EffectComposer, EffectPass, NormalPass, RenderPass } from "postprocessing";
import {
    AerialPerspectiveEffect,
    getECIToECEFRotationMatrix,
    getMoonDirectionECI,
    getSunDirectionECI,
    PrecomputedTexturesGenerator,
    SkyMaterial,
} from "@takram/three-atmosphere";
import {
    CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
    CLOUD_SHAPE_TEXTURE_SIZE,
    CloudsEffect,
    DEFAULT_LOCAL_WEATHER_URL,
    DEFAULT_SHAPE_DETAIL_URL,
    DEFAULT_SHAPE_URL,
    DEFAULT_TURBULENCE_URL,
} from "@takram/three-clouds";
import { DataTextureLoader, parseUint8Array } from "@takram/three-geospatial";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

import { localEnuToEcefBasis } from "../../autonomy/Geodesy.js";
import { getSkyDate, getSkyRuntimeSource, SKY_MODES, SKY_QUALITY_PRESETS } from "../skybox/EnvironmentSkyConfig.js";
import { assertAllowedBrowserResourceUrl } from "../../security/BrowserResourcePolicy.js";

const OBSERVER_ECEF = new THREE.Vector3(3954947, 3354895, 3700264);
const HEADLESS_PBR_ORIGIN = "http://cev-sim.invalid";
const HEADLESS_CLOUD_ASSET_ROOT = "/runtime/node_modules/@takram/three-clouds/assets";

export function cloudTextureUrl(filename, remoteUrl) {
    if (globalThis.location?.origin !== HEADLESS_PBR_ORIGIN) return remoteUrl;
    return new URL(`${HEADLESS_CLOUD_ASSET_ROOT}/${filename}`, HEADLESS_PBR_ORIGIN).href;
}

function makeLocalToECEFMatrix(positionECEF, result = new THREE.Matrix4()) {
    const { east, up, north } = localEnuToEcefBasis(positionECEF);
    result.makeBasis(
        new THREE.Vector3(east.x, east.y, east.z),
        new THREE.Vector3(up.x, up.y, up.z),
        new THREE.Vector3(north.x, north.y, north.z),
    );
    result.setPosition(positionECEF);
    return result;
}

export function isExrSource(source) {
    return /\.exr($|\?)/i.test(source);
}

export function isHdrSource(source) {
    return /\.hdr($|\?)/i.test(source);
}

export function orientTakramSky(skyMaterial, sky) {
    const date = getSkyDate(sky);
    const sunDirection = new THREE.Vector3();
    const moonDirection = new THREE.Vector3();
    const inertialToECEF = new THREE.Matrix4();
    const worldToECEF = new THREE.Matrix4();
    getECIToECEFRotationMatrix(date, inertialToECEF);
    getSunDirectionECI(date, sunDirection).applyMatrix4(inertialToECEF);
    getMoonDirectionECI(date, moonDirection).applyMatrix4(inertialToECEF);
    makeLocalToECEFMatrix(OBSERVER_ECEF, worldToECEF);
    skyMaterial.sunDirection?.copy(sunDirection);
    skyMaterial.moonDirection?.copy(moonDirection);
    skyMaterial.worldToECEFMatrix?.copy(worldToECEF);
}

export function loadSkyTexture(source) {
    const loader = isExrSource(source)
        ? new EXRLoader()
        : isHdrSource(source)
            ? new RGBELoader()
            : new THREE.TextureLoader();
    return new Promise((resolve, reject) => {
        loader.load(
            source,
            (texture) => {
                if (!isExrSource(source) && !isHdrSource(source)) {
                    texture.colorSpace = THREE.SRGBColorSpace;
                }
                resolve(texture);
            },
            undefined,
            reject,
        );
    });
}

function cloudResolutionScale(quality) {
    switch (quality) {
        case "low":
            return 0.45;
        case "medium":
            return 0.65;
        case "ultra":
            return 1;
        case "high":
        default:
            return 0.85;
    }
}

function configureRepeatingCloudTexture(texture) {
    texture.minFilter = THREE.LinearMipMapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

function loadRepeatingTextureWithLoader(url) {
    const loader = new THREE.TextureLoader();
    return new Promise((resolve, reject) => {
        loader.load(url, (texture) => {
            resolve(configureRepeatingCloudTexture(texture));
        }, undefined, reject);
    });
}

async function loadRepeatingTexture(url, loadImageTexture = null) {
    if (typeof loadImageTexture === "function") {
        const texture = await loadImageTexture(url);
        return configureRepeatingCloudTexture(texture);
    }
    // Prefer the DOM-free decoder on both main and worker so cloud texels match.
    if (typeof fetch === "function" && typeof createImageBitmap === "function") {
        return configureRepeatingCloudTexture(await loadImageBitmapTexture(url));
    }
    return loadRepeatingTextureWithLoader(url);
}

function loadCloudShape(url, size) {
    const loader = new DataTextureLoader(THREE.Data3DTexture, parseUint8Array, {
        width: size,
        height: size,
        depth: size,
        format: THREE.RedFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        wrapR: THREE.RepeatWrapping,
        colorSpace: THREE.NoColorSpace,
    });
    return new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
    });
}

async function loadCloudTextures(effect, loadImageTexture = null) {
    const loaded = [];
    const track = (promise) => promise.then((texture) => {
        loaded.push(texture);
        return texture;
    });
    try {
        const [weather, turbulence, shape, shapeDetail] = await Promise.all([
            track(loadRepeatingTexture(
                cloudTextureUrl("local_weather.png", DEFAULT_LOCAL_WEATHER_URL),
                loadImageTexture,
            )),
            track(loadRepeatingTexture(
                cloudTextureUrl("turbulence.png", DEFAULT_TURBULENCE_URL),
                loadImageTexture,
            )),
            track(loadCloudShape(cloudTextureUrl("shape.bin", DEFAULT_SHAPE_URL), CLOUD_SHAPE_TEXTURE_SIZE)),
            track(loadCloudShape(
                cloudTextureUrl("shape_detail.bin", DEFAULT_SHAPE_DETAIL_URL),
                CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
            )),
        ]);
        effect.localWeatherTexture = weather;
        effect.turbulenceTexture = turbulence;
        effect.shapeTexture = shape;
        effect.shapeDetailTexture = shapeDetail;
        return loaded;
    } catch (error) {
        for (const texture of loaded) texture.dispose?.();
        throw error;
    }
}

function assignAtmosphereTextures(skyMaterial, beauty, textures) {
    if (!textures) return;
    Object.assign(skyMaterial ?? {}, textures);
    if (!beauty) return;
    Object.assign(beauty.aerialPerspective ?? {}, textures);
    Object.assign(beauty.cloudsEffect ?? {}, textures);
}

function syncCloudComposition(aerialPerspective, cloudsEffect, event) {
    if (!aerialPerspective || !cloudsEffect) return;
    switch (event?.property) {
        case "atmosphereOverlay":
            aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
            return;
        case "atmosphereShadow":
            aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
            if (cloudsEffect.stbnTexture) aerialPerspective.stbnTexture = cloudsEffect.stbnTexture;
            return;
        case "atmosphereShadowLength":
            aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
            return;
        default:
            break;
    }
    aerialPerspective.overlay = cloudsEffect.atmosphereOverlay;
    aerialPerspective.shadow = cloudsEffect.atmosphereShadow;
    aerialPerspective.shadowLength = cloudsEffect.atmosphereShadowLength;
    if (cloudsEffect.stbnTexture) aerialPerspective.stbnTexture = cloudsEffect.stbnTexture;
}

function orientBeautyAtmosphere(beauty, skyMaterial, sky) {
    const { aerialPerspective, cloudsEffect } = beauty;
    if (skyMaterial.sunDirection) {
        aerialPerspective.sunDirection.copy(skyMaterial.sunDirection);
        cloudsEffect.sunDirection.copy(skyMaterial.sunDirection);
    }
    if (skyMaterial.moonDirection) aerialPerspective.moonDirection.copy(skyMaterial.moonDirection);
    if (skyMaterial.worldToECEFMatrix) {
        aerialPerspective.worldToECEFMatrix.copy(skyMaterial.worldToECEFMatrix);
        cloudsEffect.worldToECEFMatrix.copy(skyMaterial.worldToECEFMatrix);
    }
    const intensity = Number(sky?.takram?.atmosphereIntensity);
    if (Number.isFinite(intensity)) aerialPerspective.albedoScale = intensity;
    syncCloudComposition(aerialPerspective, cloudsEffect);
}

function disposeBeautyAtmosphere(beauty) {
    if (!beauty) return;
    if (beauty.onCloudChange) {
        beauty.cloudsEffect?.events?.removeEventListener("change", beauty.onCloudChange);
    }
    beauty.cloudsEffect?.dispose?.();
    beauty.aerialPerspective?.dispose?.();
    beauty.normalPass?.dispose?.();
    beauty.composer?.dispose?.();
    for (const texture of beauty.cloudTextures ?? []) texture?.dispose?.();
}

function createBeautyAtmosphere({ scene, renderer, sky }) {
    const camera = new THREE.PerspectiveCamera();
    const beauty = {
        camera,
        cloudsEffect: null,
        aerialPerspective: null,
        normalPass: null,
        composer: null,
        cloudTextures: [],
        onCloudChange: null,
    };
    try {
        const takram = sky.takram;
        const quality = SKY_QUALITY_PRESETS.includes(takram.cloudQuality) ? takram.cloudQuality : "high";
        beauty.cloudsEffect = new CloudsEffect(camera);
        beauty.cloudsEffect.qualityPreset = quality;
        beauty.cloudsEffect.resolutionScale = cloudResolutionScale(quality);
        if (takram.cloudCoverage != null) beauty.cloudsEffect.coverage = takram.cloudCoverage;
        if (takram.haze != null) beauty.cloudsEffect.haze = takram.haze;
        if (takram.lightShafts != null) beauty.cloudsEffect.lightShafts = takram.lightShafts;
        const aerialOptions = { correctGeometricError: true };
        const intensity = Number(takram.atmosphereIntensity);
        if (Number.isFinite(intensity)) aerialOptions.albedoScale = intensity;
        beauty.aerialPerspective = new AerialPerspectiveEffect(camera, aerialOptions);
        beauty.normalPass = new NormalPass(scene, camera);
        beauty.aerialPerspective.normalBuffer = beauty.normalPass.texture;
        beauty.onCloudChange = (event) => {
            syncCloudComposition(beauty.aerialPerspective, beauty.cloudsEffect, event);
        };
        beauty.cloudsEffect.events.addEventListener("change", beauty.onCloudChange);
        beauty.composer = new EffectComposer(renderer, {
            frameBufferType: THREE.UnsignedByteType,
        });
        beauty.composer.autoRenderToScreen = false;
        beauty.composer.addPass(new RenderPass(scene, camera));
        beauty.composer.addPass(beauty.normalPass);
        beauty.composer.addPass(new EffectPass(camera, beauty.cloudsEffect, beauty.aerialPerspective));
        beauty.composer.inputBuffer.texture.colorSpace = THREE.SRGBColorSpace;
        beauty.composer.outputBuffer.texture.colorSpace = THREE.SRGBColorSpace;
        return beauty;
    } catch (error) {
        disposeBeautyAtmosphere(beauty);
        throw error;
    }
}

/** Release a Takram installation, including the color-only cloud composer. */
export function releaseTakramSky(installation) {
    disposeBeautyAtmosphere(installation?.beauty);
    installation?.generator?.dispose?.();
}

/**
 * Load a cloud weather/turbulence PNG as a THREE.Texture without using DOM Image.
 * Decode to RGBA bytes and upload as a DataTexture so browser workers and the
 * main thread share one explicit texel layout (row order flipped in software).
 */
export async function loadImageBitmapTexture(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Cloud texture load failed (${response.status} ${response.statusText}): ${url}`);
    }
    const bitmap = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
    });
    try {
        const canvas = typeof OffscreenCanvas === "function"
            ? new OffscreenCanvas(bitmap.width, bitmap.height)
            : Object.assign(document.createElement("canvas"), {
                width: bitmap.width,
                height: bitmap.height,
            });
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        const context = canvas.getContext("2d", {
            alpha: true,
            colorSpace: "srgb",
            willReadFrequently: true,
        });
        context.drawImage(bitmap, 0, 0);
        const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        // Match TextureLoader flipY=true: reverse row order so GL samples match.
        const flipped = new Uint8ClampedArray(data.length);
        const stride = width * 4;
        for (let y = 0; y < height; y += 1) {
            const src = y * stride;
            const dst = (height - 1 - y) * stride;
            flipped.set(data.subarray(src, src + stride), dst);
        }
        const texture = new THREE.DataTexture(flipped, width, height, THREE.RGBAFormat);
        texture.flipY = false;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        return texture;
    } finally {
        bitmap.close?.();
    }
}

/** Fullscreen Takram atmosphere quad. Clouds composite in the color pass only. */
export async function installTakramSky({ scene, renderer, sky, loadImageTexture = null } = {}) {
    const skyMaterial = new SkyMaterial({ ground: true, moon: true });
    skyMaterial.depthWrite = false;
    skyMaterial.depthTest = false;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMaterial);
    quad.name = "TakramSkyQuad";
    quad.frustumCulled = false;
    quad.renderOrder = -1;
    quad.userData.cevSimSky = true;
    quad.userData.cevSimRenderRuntimeOwned = true;
    const group = new THREE.Group();
    group.name = "TakramEnvironmentSky";
    group.userData.cevSimSky = true;
    group.add(quad);

    const generator = new PrecomputedTexturesGenerator(renderer);
    let beauty = null;
    const autoClear = renderer?.autoClear;
    try {
        if (sky?.takram?.cloudsEnabled === true) {
            beauty = createBeautyAtmosphere({ scene, renderer, sky });
        }
        if (generator.textures) assignAtmosphereTextures(skyMaterial, beauty, generator.textures);
        const generatedPromise = generator.update();
        const texturePromise = beauty
            ? loadCloudTextures(beauty.cloudsEffect, loadImageTexture)
            : Promise.resolve([]);
        const [generated, cloudTextures] = await Promise.all([generatedPromise, texturePromise]);
        if (beauty) beauty.cloudTextures = cloudTextures;
        if (generated) assignAtmosphereTextures(skyMaterial, beauty, generated);
        skyMaterial.depthWrite = false;
        skyMaterial.depthTest = false;
        orientTakramSky(skyMaterial, sky);
        if (beauty) orientBeautyAtmosphere(beauty, skyMaterial, sky);
        if (beauty?.composer) scene.userData.cevSimBeautyComposer = beauty.composer;
        scene.add(group);
        return { generator, composer: beauty?.composer ?? null, beauty };
    } catch (error) {
        disposeBeautyAtmosphere(beauty);
        generator.dispose?.();
        quad.geometry.dispose();
        skyMaterial.dispose();
        throw error;
    } finally {
        // EffectComposer claims autoClear. Capture and the viewport clear explicitly.
        if (renderer && typeof autoClear === "boolean") renderer.autoClear = autoClear;
    }
}

/** Equirectangular image sky. The recipe stores the canonical URL, not a local preview. */
export async function installImageSky({ scene, sky }) {
    if (sky?.mode !== SKY_MODES.IMAGE) {
        throw new Error(`Image sky installation requires mode "${SKY_MODES.IMAGE}".`);
    }
    const source = getSkyRuntimeSource(sky);
    const admitted = assertAllowedBrowserResourceUrl(source);
    const texture = await loadSkyTexture(admitted);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.name = "EnvironmentEditorImageSky";
    scene.background = texture;
    scene.environment = texture;
    const exposure = sky.image?.exposure;
    if (exposure != null) {
        scene.backgroundIntensity = exposure;
        scene.environmentIntensity = exposure;
    }
    return texture;
}
