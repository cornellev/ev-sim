import * as THREE from "three";
import {
    EffectComposer,
    EffectPass,
    RenderPass,
    ToneMappingEffect,
    ToneMappingMode,
} from "postprocessing";
import {
    AerialPerspectiveEffect,
    getECIToECEFRotationMatrix,
    getMoonDirectionECI,
    getSunDirectionECI,
    PrecomputedTexturesGenerator,
    SkyLightProbe,
    SkyMaterial,
    SunDirectionalLight,
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
import {
    DataTextureLoader,
    DEFAULT_STBN_URL,
    parseUint8Array,
    STBNLoader,
} from "@takram/three-geospatial";
import { DitheringEffect } from "@takram/three-geospatial-effects";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import {
    getSkyDate,
    getSkyRuntimeSource,
    normalizeSkyConfig,
    SKY_MODES,
    skyConfigToManifest,
} from "./EnvironmentSkyConfig.js";

const OBSERVER_ECEF = new THREE.Vector3(3954947, 3354895, 3700264);
const SKY_OBJECT_FLAGS = Object.freeze({
    skipEnvironmentSelection: true,
    bakeIgnore: true,
});
const ECEF_Z_AXIS = new THREE.Vector3(0, 0, 1);

function tagSkyObject(object) {
    Object.assign(object.userData, SKY_OBJECT_FLAGS);
    object.traverse?.((child) => {
        Object.assign(child.userData, SKY_OBJECT_FLAGS);
    });
}

function disposeObject(object) {
    object.traverse?.((child) => {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
            material?.dispose?.();
        }
    });
}

function makeConfigKey(config) {
    const normalized = normalizeSkyConfig(config);
    return JSON.stringify({
        ...skyConfigToManifest(normalized),
        localPreviewUrl: normalized.image.localPreviewUrl,
    });
}

function isExrSource(source) {
    return /\.exr($|\?)/i.test(source);
}

function isHdrSource(source) {
    return /\.hdr($|\?)/i.test(source);
}

function makeLocalToECEFMatrix(positionECEF, result = new THREE.Matrix4()) {
    const up = positionECEF.clone().normalize();
    const east = ECEF_Z_AXIS.clone().cross(up).normalize();
    const north = up.clone().cross(east).normalize();

    // The app's world is Y-up with X/Z as the ground plane. Map that local
    // frame to an east/up/north tangent frame at the observer location.
    result.makeBasis(east, up, north);
    result.setPosition(positionECEF);
    return result;
}

export class EnvironmentSkyManager {
    constructor({ scene, camera, renderer, skyState, invalidate } = {}) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.skyState = skyState;
        this.invalidate = typeof invalidate === "function" ? invalidate : () => {};

        this.activeMode = null;
        this.config = normalizeSkyConfig(skyState?.snapshot?.() ?? {});
        this.lastConfigKey = null;
        this.applyVersion = 0;
        this.unsubscribe = null;

        this.initialRendererState = {
            toneMapping: renderer?.toneMapping,
            toneMappingExposure: renderer?.toneMappingExposure,
        };

        this.group = null;
        this.skyMaterial = null;
        this.skyLight = null;
        this.sunLight = null;
        this.aerialPerspective = null;
        this.cloudsEffect = null;
        this.composer = null;
        this.generator = null;
        this.imageTexture = null;
        this.loadedTextures = [];
        this.handleCloudChange = null;

        this.sunDirection = new THREE.Vector3();
        this.moonDirection = new THREE.Vector3();
        this.worldToECEFMatrix = new THREE.Matrix4();
        this.inertialToECEFMatrix = new THREE.Matrix4();
        this.rendererSize = new THREE.Vector2();
    }

    async setup() {
        await this.applyConfig(this.config);
        this.unsubscribe = this.skyState?.subscribe?.((snapshot) => {
            this.applyConfig(snapshot);
        });
    }

    async applyConfig(config) {
        const normalized = normalizeSkyConfig(config);
        const nextKey = makeConfigKey(normalized);
        if (this.lastConfigKey === nextKey) return;

        if (this.activeMode === SKY_MODES.TAKRAM && normalized.mode === SKY_MODES.TAKRAM) {
            const needsRebuild = this.config.takram.cloudsEnabled !== normalized.takram.cloudsEnabled;
            this.config = normalized;
            this.lastConfigKey = nextKey;
            if (!needsRebuild) {
                this.patchTakramSky(normalized);
                return;
            }
        }

        if (this.activeMode === SKY_MODES.IMAGE && normalized.mode === SKY_MODES.IMAGE) {
            const currentSource = getSkyRuntimeSource(this.config);
            const nextSource = getSkyRuntimeSource(normalized);
            this.config = normalized;
            this.lastConfigKey = nextKey;
            if (currentSource === nextSource && this.imageTexture) {
                this.renderer.toneMappingExposure = normalized.image.exposure;
                this.skyState?.setRuntimeStatus?.("ready", null);
                this.invalidate();
                return;
            }
        }

        this.config = normalized;
        this.lastConfigKey = nextKey;
        const version = ++this.applyVersion;

        if (normalized.mode === SKY_MODES.IMAGE) {
            await this.setupImageSky(normalized, version);
            return;
        }

        this.setupTakramSky(normalized, version);
    }

    patchTakramSky(config) {
        if (this.cloudsEffect) {
            this.cloudsEffect.qualityPreset = config.takram.cloudQuality;
            this.cloudsEffect.resolutionScale = this.getCloudResolutionScale(config.takram.cloudQuality);
            this.cloudsEffect.coverage = config.takram.cloudCoverage;
            this.cloudsEffect.haze = config.takram.haze;
            this.cloudsEffect.lightShafts = config.takram.lightShafts;
        }
        if (this.aerialPerspective) {
            this.aerialPerspective.albedoScale = config.takram.atmosphereIntensity;
        }
        this.updateCelestial();
        this.skyState?.setRuntimeStatus?.("ready", null);
        this.invalidate();
    }

    setupTakramSky(config, version) {
        this.disposeActiveMode();
        this.skyState?.setRuntimeStatus?.("loading", null);
        this.activeMode = SKY_MODES.TAKRAM;

        this.scene.background = null;
        this.scene.environment = null;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1;

        this.group = new THREE.Group();
        this.group.name = "TakramEnvironmentSky";
        tagSkyObject(this.group);

        this.skyMaterial = new SkyMaterial({
            ground: true,
            moon: true,
        });
        const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
        sky.name = "TakramSkyQuad";
        sky.frustumCulled = false;
        tagSkyObject(sky);
        this.group.add(sky);

        this.skyLight = new SkyLightProbe();
        tagSkyObject(this.skyLight);
        this.group.add(this.skyLight);

        this.sunLight = new SunDirectionalLight({ distance: 300 });
        tagSkyObject(this.sunLight);
        tagSkyObject(this.sunLight.target);
        this.group.add(this.sunLight);
        this.group.add(this.sunLight.target);

        this.aerialPerspective = new AerialPerspectiveEffect(this.camera, {
            correctGeometricError: true,
            albedoScale: config.takram.atmosphereIntensity,
        });

        const effects = [];
        if (config.takram.cloudsEnabled) {
            this.cloudsEffect = new CloudsEffect(this.camera, {
                resolutionScale: this.getCloudResolutionScale(config.takram.cloudQuality),
            });
            this.cloudsEffect.qualityPreset = config.takram.cloudQuality;
            this.cloudsEffect.coverage = config.takram.cloudCoverage;
            this.cloudsEffect.haze = config.takram.haze;
            this.cloudsEffect.lightShafts = config.takram.lightShafts;
            this.loadCloudTextures(this.cloudsEffect);
            this.syncCloudComposition();
            this.handleCloudChange = () => this.syncCloudComposition();
            this.cloudsEffect.events.addEventListener("change", this.handleCloudChange);
            effects.push(this.cloudsEffect);
        }

        effects.push(
            this.aerialPerspective,
            new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
            new DitheringEffect(),
        );

        this.composer = new EffectComposer(this.renderer, {
            frameBufferType: THREE.HalfFloatType,
        });
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.composer.addPass(new EffectPass(this.camera, ...effects));
        this.resize();

        this.generator = new PrecomputedTexturesGenerator(this.renderer);
        this.assignAtmosphereTextures(this.generator.textures);
        this.generator.update()
            .then((textures) => {
                if (version !== this.applyVersion || this.activeMode !== SKY_MODES.TAKRAM) return;
                this.assignAtmosphereTextures(textures);
                this.invalidate();
            })
            .catch((error) => {
                if (version !== this.applyVersion) return;
                console.warn("Takram atmosphere texture generation failed", error);
                this.skyState?.setRuntimeStatus?.("error", "Atmosphere texture generation failed.");
            });

        this.updateCelestial();
        this.scene.add(this.group);
        this.skyState?.setRuntimeStatus?.("ready", null);
        this.invalidate();
    }

    async setupImageSky(config, version) {
        const source = getSkyRuntimeSource(config);
        this.disposeActiveMode();
        this.activeMode = SKY_MODES.IMAGE;
        this.skyState?.setRuntimeStatus?.("loading", null);

        if (!source) {
            this.scene.background = new THREE.Color(0x202020);
            this.scene.environment = null;
            this.skyState?.setRuntimeStatus?.("error", "Enter an image URL or asset path.");
            this.invalidate();
            return;
        }

        try {
            const texture = await this.loadEnvironmentTexture(source);
            if (version !== this.applyVersion || this.activeMode !== SKY_MODES.IMAGE) {
                texture.dispose();
                return;
            }

            texture.mapping = THREE.EquirectangularReflectionMapping;
            texture.name = "EnvironmentEditorImageSky";
            this.imageTexture = texture;
            this.scene.background = texture;
            this.scene.environment = texture;
            this.renderer.toneMapping = this.initialRendererState.toneMapping;
            this.renderer.toneMappingExposure = config.image.exposure;
            this.skyState?.setRuntimeStatus?.("ready", null);
            this.invalidate();
        } catch (error) {
            if (version !== this.applyVersion) return;
            console.warn("Image skybox failed to load", error);
            this.scene.background = new THREE.Color(0x202020);
            this.scene.environment = null;
            this.skyState?.setRuntimeStatus?.("error", "Image skybox failed to load.");
            this.invalidate();
        }
    }

    loadEnvironmentTexture(source) {
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

    loadCloudTextures(effect) {
        const textureLoader = new THREE.TextureLoader();
        const configureRepeatingTexture = (texture) => {
            texture.minFilter = THREE.LinearMipMapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.colorSpace = THREE.NoColorSpace;
            texture.needsUpdate = true;
            this.loadedTextures.push(texture);
            this.invalidate();
        };

        effect.localWeatherTexture = textureLoader.load(DEFAULT_LOCAL_WEATHER_URL, configureRepeatingTexture);
        effect.turbulenceTexture = textureLoader.load(DEFAULT_TURBULENCE_URL, configureRepeatingTexture);

        const shapeLoader = new DataTextureLoader(THREE.Data3DTexture, parseUint8Array, {
            width: CLOUD_SHAPE_TEXTURE_SIZE,
            height: CLOUD_SHAPE_TEXTURE_SIZE,
            depth: CLOUD_SHAPE_TEXTURE_SIZE,
            format: THREE.RedFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.RepeatWrapping,
            wrapT: THREE.RepeatWrapping,
            wrapR: THREE.RepeatWrapping,
            colorSpace: THREE.NoColorSpace,
        });
        effect.shapeTexture = shapeLoader.load(DEFAULT_SHAPE_URL, (texture) => {
            this.loadedTextures.push(texture);
            this.invalidate();
        });

        const shapeDetailLoader = new DataTextureLoader(THREE.Data3DTexture, parseUint8Array, {
            width: CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
            height: CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
            depth: CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
            format: THREE.RedFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.RepeatWrapping,
            wrapT: THREE.RepeatWrapping,
            wrapR: THREE.RepeatWrapping,
            colorSpace: THREE.NoColorSpace,
        });
        effect.shapeDetailTexture = shapeDetailLoader.load(DEFAULT_SHAPE_DETAIL_URL, (texture) => {
            this.loadedTextures.push(texture);
            this.invalidate();
        });

        effect.stbnTexture = new STBNLoader().load(DEFAULT_STBN_URL, (texture) => {
            this.loadedTextures.push(texture);
            this.invalidate();
        });
    }

    assignAtmosphereTextures(textures = {}) {
        if (!textures) return;

        Object.assign(this.skyMaterial ?? {}, textures);
        Object.assign(this.aerialPerspective ?? {}, textures);

        if (this.sunLight) {
            this.sunLight.transmittanceTexture = textures.transmittanceTexture ?? null;
        }
        if (this.skyLight) {
            this.skyLight.irradianceTexture = textures.irradianceTexture ?? null;
        }
        if (this.cloudsEffect) {
            Object.assign(this.cloudsEffect, textures);
        }
    }

    syncCloudComposition() {
        if (!this.aerialPerspective || !this.cloudsEffect) return;
        this.aerialPerspective.overlay = this.cloudsEffect.atmosphereOverlay;
        this.aerialPerspective.shadow = this.cloudsEffect.atmosphereShadow;
        this.aerialPerspective.shadowLength = this.cloudsEffect.atmosphereShadowLength;
    }

    updateCelestial() {
        if (this.activeMode !== SKY_MODES.TAKRAM) return;

        const date = getSkyDate(this.config);
        getECIToECEFRotationMatrix(date, this.inertialToECEFMatrix);
        getSunDirectionECI(date, this.sunDirection).applyMatrix4(this.inertialToECEFMatrix);
        getMoonDirectionECI(date, this.moonDirection).applyMatrix4(this.inertialToECEFMatrix);

        // The simulator uses a small local coordinate system near the origin.
        // Takram's atmosphere expects world positions in ECEF meters, so map
        // local Y-up world space to a tangent east/up/north frame on Earth.
        makeLocalToECEFMatrix(OBSERVER_ECEF, this.worldToECEFMatrix);

        this.skyMaterial?.sunDirection?.copy(this.sunDirection);
        this.skyMaterial?.moonDirection?.copy(this.moonDirection);
        this.skyMaterial?.worldToECEFMatrix?.copy(this.worldToECEFMatrix);

        this.sunLight?.sunDirection?.copy(this.sunDirection);
        this.skyLight?.sunDirection?.copy(this.sunDirection);
        this.sunLight?.worldToECEFMatrix?.copy(this.worldToECEFMatrix);
        this.skyLight?.worldToECEFMatrix?.copy(this.worldToECEFMatrix);
        this.sunLight?.update?.();
        this.skyLight?.update?.();

        this.aerialPerspective?.sunDirection?.copy(this.sunDirection);
        this.aerialPerspective?.moonDirection?.copy(this.moonDirection);
        this.aerialPerspective?.worldToECEFMatrix?.copy(this.worldToECEFMatrix);
        if (this.aerialPerspective) {
            this.aerialPerspective.albedoScale = this.config.takram.atmosphereIntensity;
        }

        if (this.cloudsEffect) {
            this.cloudsEffect.sunDirection.copy(this.sunDirection);
            this.cloudsEffect.worldToECEFMatrix.copy(this.worldToECEFMatrix);
            this.syncCloudComposition();
        }
    }

    getCloudResolutionScale(quality) {
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

    resize(width, height) {
        if (!this.renderer) return;
        const size = this.renderer.getSize(this.rendererSize);
        const nextWidth = width ?? size.x;
        const nextHeight = height ?? size.y;
        this.composer?.setSize?.(nextWidth, nextHeight);
        this.cloudsEffect?.setSize?.(nextWidth, nextHeight);
    }

    render(deltaTime = 0) {
        if (this.activeMode !== SKY_MODES.TAKRAM || !this.composer) return false;
        this.updateCelestial();
        this.composer.render(deltaTime);
        return true;
    }

    disposeActiveMode() {
        if (this.cloudsEffect && this.handleCloudChange) {
            this.cloudsEffect.events.removeEventListener("change", this.handleCloudChange);
        }
        this.handleCloudChange = null;

        if (this.group) {
            this.scene.remove(this.group);
            disposeObject(this.group);
        }

        this.group = null;
        this.skyMaterial = null;
        this.skyLight = null;
        this.sunLight = null;

        this.cloudsEffect?.dispose?.();
        this.aerialPerspective?.dispose?.();
        this.composer?.dispose?.();
        this.generator?.dispose?.({ textures: true });
        this.imageTexture?.dispose?.();

        for (const texture of this.loadedTextures) {
            texture?.dispose?.();
        }

        this.cloudsEffect = null;
        this.aerialPerspective = null;
        this.composer = null;
        this.generator = null;
        this.imageTexture = null;
        this.loadedTextures = [];

        if (this.renderer) {
            this.renderer.toneMapping = this.initialRendererState.toneMapping;
            this.renderer.toneMappingExposure = this.initialRendererState.toneMappingExposure;
        }
    }

    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.applyVersion += 1;
        this.disposeActiveMode();
        this.skyState?.setRuntimeStatus?.("idle", null);
    }
}
