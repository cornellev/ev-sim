import * as THREE from "three";

import {
    applyProjectionToThreeCamera,
    assertAlignedCapturePassSets,
    assertOwnedCaptureScene,
    assertVisualCapturePassSet,
    normalizeImageRows,
    VISUAL_CAPTURE_PASS_FAMILIES,
    warpCalibratedImage,
} from "./VisualCapturePipeline.js";
import { withPixelPackBufferUnbound } from "../../util/glReadback.js";

const MODE = Object.freeze({
    axialDepth: 1,
    geometricNormal: 2,
    objectId: 3,
    materialId: 4,
    worldPosition: 5,
    confidence: 6,
    validity: 7,
    semanticId: 8,
    instanceId: 9,
});

const VISUAL_RIGHTS = Object.freeze(["display", "machine-interpretation"]);
const BAKE_RIGHTS = Object.freeze(["display", "machine-interpretation", "derivatives"]);

function captureError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function abortIfRequested(signal) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : captureError("VISUAL_CAPTURE_CANCELLED", "Aligned capture was cancelled.");
}

function assertContextAvailable(renderer, { requireFloat = false } = {}) {
    const context = renderer.getContext?.();
    if (!context) return;
    if (context.isContextLost?.()) {
        throw captureError("VISUAL_CAPTURE_CONTEXT_LOST", "WebGL context was lost during aligned capture.");
    }
    if (requireFloat && !context.getExtension?.("EXT_color_buffer_float")) {
        throw captureError(
            "VISUAL_CAPTURE_CAPABILITY_UNAVAILABLE",
            "Float32 aligned products require EXT_color_buffer_float.",
        );
    }
}

function renderableMap(value, name) {
    if (value instanceof Map) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) return new Map(Object.entries(value));
    throw captureError("VISUAL_CAPTURE_BINDING_INVALID", `${name} must be a Map or object.`);
}

function effectiveVisible(object) {
    let current = object;
    while (current) {
        if (current.visible === false) return false;
        current = current.parent;
    }
    return true;
}

function belongsToScene(object, scene) {
    let current = object;
    while (current) {
        if (current === scene) return true;
        current = current.parent;
    }
    return false;
}

function arrayMaterials(object) {
    return Array.isArray(object.material) ? object.material : [object.material];
}

function validateSourceMesh(mesh, material) {
    if (!mesh?.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh) {
        throw captureError(
            "VISUAL_CAPTURE_GEOMETRY_UNSUPPORTED",
            "Corrected capture supports only static, non-instanced triangle meshes.",
        );
    }
    if (!mesh.geometry?.attributes?.position) {
        throw captureError(
            "VISUAL_CAPTURE_GEOMETRY_UNSUPPORTED",
            "Corrected capture requires transformed triangle geometry.",
        );
    }
    if (mesh.geometry.attributes.color || Object.keys(mesh.geometry.morphAttributes || {}).length > 0) {
        throw captureError(
            "VISUAL_CAPTURE_GEOMETRY_UNSUPPORTED",
            "Vertex colors and morph targets are outside visual capture profile v1.",
        );
    }
    if (!material
        || (!material.isMeshBasicMaterial && !material.isMeshStandardMaterial)
        || material.transparent === true
        || material.alphaHash === true
        || Number(material.transmission || 0) > 0
        || Number(material.thickness || 0) > 0
        || material.wireframe === true
        || material.alphaToCoverage === true
        || material.polygonOffset === true
        || material.depthTest === false
        || material.depthWrite === false
        || material.colorWrite === false
        || material.displacementMap
        || material.clippingPlanes?.length > 0
        || material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
        || mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) {
        throw captureError(
            "VISUAL_CAPTURE_MATERIAL_UNSUPPORTED",
            "Corrected capture supports only OPAQUE and MASK materials.",
        );
    }
    if (!Number.isFinite(material.opacity)
        || material.opacity < 0
        || material.opacity > 1
        || !Number.isFinite(material.alphaTest)
        || material.alphaTest < 0
        || material.alphaTest > 1) {
        throw captureError(
            "VISUAL_CAPTURE_MATERIAL_UNSUPPORTED",
            "Capture alpha factors and cutoffs must be finite values in [0, 1].",
        );
    }
    if ((material.map?.channel ?? 0) !== 0 || (material.alphaMap?.channel ?? 0) !== 0) {
        throw captureError(
            "VISUAL_CAPTURE_MATERIAL_UNSUPPORTED",
            "Capture alpha textures must use the primary UV channel.",
        );
    }
    if (Number(material.alphaTest || 0) > 0
        && !mesh.geometry.attributes.uv
        && (material.map || material.alphaMap)) {
        throw captureError(
            "VISUAL_CAPTURE_MATERIAL_UNSUPPORTED",
            "Alpha-tested textures require UV coordinates.",
        );
    }
}

const vertexShader = `
    out vec2 vCaptureUv;
    out vec3 vWorldPosition;
    out float vAxialDepth;
    void main() {
        #ifdef USE_UV
            vCaptureUv = uv;
        #else
            vCaptureUv = vec2(0.0);
        #endif
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        vec4 viewPosition = viewMatrix * world;
        vAxialDepth = -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
    }
`;

const fragmentShader = `
    precision highp float;
    precision highp int;
    in vec2 vCaptureUv;
    in vec3 vWorldPosition;
    in float vAxialDepth;
    uniform int captureMode;
    uniform uint objectId;
    uniform uint materialId;
    uniform uint semanticId;
    uniform uint instanceId;
    uniform float bindingConfidence;
    uniform float alphaFactor;
    uniform float alphaCutoff;
    #ifdef USE_MAP
        uniform sampler2D map;
        uniform mat3 mapTransform;
    #endif
    #ifdef USE_ALPHAMAP
        uniform sampler2D alphaMap;
        uniform mat3 alphaMapTransform;
    #endif
    out vec4 captureOutput;

    vec4 packUint32(uint value) {
        uvec4 bytes = uvec4(
            value & 255u,
            (value >> 8u) & 255u,
            (value >> 16u) & 255u,
            (value >> 24u) & 255u
        );
        return vec4(bytes) / 255.0;
    }

    void main() {
        float alpha = alphaFactor;
        #ifdef USE_MAP
            vec2 transformedMapUv = (mapTransform * vec3(vCaptureUv, 1.0)).xy;
            alpha *= texture(map, transformedMapUv).a;
        #endif
        #ifdef USE_ALPHAMAP
            vec2 transformedAlphaUv = (alphaMapTransform * vec3(vCaptureUv, 1.0)).xy;
            alpha *= texture(alphaMap, transformedAlphaUv).g;
        #endif
        if (alphaCutoff > 0.0 && alpha < alphaCutoff) discard;

        vec3 geometricNormal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (!gl_FrontFacing) geometricNormal = -geometricNormal;
        if (captureMode == ${MODE.axialDepth}) captureOutput = vec4(vAxialDepth, 0.0, 0.0, 1.0);
        else if (captureMode == ${MODE.geometricNormal}) captureOutput = vec4(geometricNormal, 1.0);
        else if (captureMode == ${MODE.objectId}) captureOutput = packUint32(objectId);
        else if (captureMode == ${MODE.materialId}) captureOutput = packUint32(materialId);
        else if (captureMode == ${MODE.worldPosition}) captureOutput = vec4(vWorldPosition, 1.0);
        else if (captureMode == ${MODE.confidence}) captureOutput = vec4(bindingConfidence, 0.0, 0.0, 1.0);
        else if (captureMode == ${MODE.semanticId}) captureOutput = packUint32(semanticId);
        else if (captureMode == ${MODE.instanceId}) captureOutput = packUint32(instanceId);
        else captureOutput = vec4(1.0, 0.0, 0.0, 1.0);
    }
`;

function textureMatrix(texture) {
    if (!texture) return new THREE.Matrix3();
    if (texture.matrixAutoUpdate === false) return texture.matrix.clone();
    return new THREE.Matrix3().setUvTransform(
        texture.offset.x,
        texture.offset.y,
        texture.repeat.x,
        texture.repeat.y,
        texture.rotation,
        texture.center.x,
        texture.center.y,
    );
}

function createPassMaterial(source, binding, materialIndex, family) {
    validateSourceMesh(binding.object, source);
    const materialId = family === VISUAL_CAPTURE_PASS_FAMILIES.visual
        ? binding.record?.materialIds?.[materialIndex] ?? 0
        : 0;
    const defines = {};
    if (source.map) defines.USE_MAP = "";
    if (source.alphaMap) defines.USE_ALPHAMAP = "";
    if (source.map || source.alphaMap) defines.USE_UV = "";
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader,
        fragmentShader,
        defines,
        uniforms: {
            captureMode: { value: MODE.validity },
            objectId: { value: binding.record?.objectId ?? 0 },
            materialId: { value: materialId },
            semanticId: { value: binding.record?.semanticId ?? 0 },
            instanceId: { value: binding.record?.instanceId ?? 0 },
            bindingConfidence: { value: binding.record?.confidence ?? 0 },
            alphaFactor: { value: Number(source.opacity ?? 1) },
            alphaCutoff: { value: Math.max(0, Number(source.alphaTest ?? 0)) },
            map: { value: source.map ?? null },
            mapTransform: { value: textureMatrix(source.map) },
            alphaMap: { value: source.alphaMap ?? null },
            alphaMapTransform: { value: textureMatrix(source.alphaMap) },
        },
        side: source.side,
        depthTest: true,
        depthWrite: true,
        transparent: false,
        blending: THREE.NoBlending,
        toneMapped: false,
        fog: false,
    });
}

function prepareProxyScene(sceneHandle, passSet, renderables) {
    const checkedHandle = assertOwnedCaptureScene(sceneHandle);
    if (checkedHandle.scene.overrideMaterial) {
        throw captureError(
            "VISUAL_CAPTURE_MATERIAL_UNSUPPORTED",
            "Owned capture scenes cannot use an override material.",
        );
    }
    if (passSet.captureInput.scene.role !== checkedHandle.role
        || passSet.captureInput.scene.generation !== checkedHandle.generation
        || passSet.captureInput.scene.descriptionHash !== checkedHandle.descriptionHash) {
        throw captureError(
            "VISUAL_CAPTURE_SCENE_STALE",
            "Pass input does not match the supplied capture-scene generation.",
        );
    }
    const resolved = renderableMap(renderables, `${passSet.family} renderables`);
    const bindingByObject = new Map();
    for (const record of passSet.bindings) {
        const object = resolved.get(record.renderableId);
        if (!object || !belongsToScene(object, checkedHandle.scene)) {
            throw captureError(
                "VISUAL_CAPTURE_BINDING_INVALID",
                `Renderable "${record.renderableId}" is missing from the owned scene.`,
            );
        }
        if (bindingByObject.has(object)) {
            throw captureError("VISUAL_CAPTURE_BINDING_INVALID", "One mesh cannot have multiple capture bindings.");
        }
        bindingByObject.set(object, record);
    }

    const proxy = new THREE.Scene();
    const materials = [];
    const entries = [];
    try {
        checkedHandle.scene.traverse((object) => {
            if (!effectiveVisible(object)) return;
            if (object.isLine || object.isPoints || object.isSprite) {
                throw captureError(
                    "VISUAL_CAPTURE_GEOMETRY_UNSUPPORTED",
                    "Lines, points, and sprites are outside visual capture profile v1.",
                );
            }
            if (!object.isMesh) return;
            const sources = arrayMaterials(object);
            const record = bindingByObject.get(object) ?? null;
            if (record?.materialIds?.length > 0 && record.materialIds.length !== sources.length) {
                throw captureError(
                    "VISUAL_CAPTURE_BINDING_INVALID",
                    `Renderable "${record.renderableId}" material binding count does not match its mesh.`,
                );
            }
            const binding = { object, record };
            const proxyMaterials = sources.map((source, materialIndex) => {
                const material = createPassMaterial(source, binding, materialIndex, passSet.family);
                material.visible = source.visible;
                materials.push(material);
                return material;
            });
            const mesh = new THREE.Mesh(
                object.geometry,
                Array.isArray(object.material) ? proxyMaterials : proxyMaterials[0],
            );
            mesh.name = record?.renderableId ?? "unbound-visible-surface";
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(object.matrixWorld);
            mesh.matrixWorld.copy(object.matrixWorld);
            mesh.frustumCulled = object.frustumCulled;
            mesh.layers.mask = object.layers.mask;
            mesh.renderOrder = object.renderOrder;
            mesh.castShadow = false;
            mesh.receiveShadow = false;
            proxy.add(mesh);
            entries.push({ source: object, proxy: mesh });
        });
        proxy.updateMatrixWorld(true);
        return {
            scene: proxy,
            materials,
            entries,
            bindingObjects: new Map(passSet.bindings.map((record) => [
                record.renderableId,
                resolved.get(record.renderableId),
            ])),
        };
    } catch (error) {
        for (const material of materials) material.dispose();
        proxy.clear();
        throw error;
    }
}

function decodeUint32(rgba) {
    const output = new Uint32Array(rgba.length / 4);
    for (let index = 0; index < output.length; index += 1) {
        const offset = index * 4;
        output[index] = (
            rgba[offset]
            | (rgba[offset + 1] << 8)
            | (rgba[offset + 2] << 16)
            | (rgba[offset + 3] << 24)
        ) >>> 0;
    }
    return output;
}

function extractChannels(rgba, channels) {
    const output = new Float32Array((rgba.length / 4) * channels);
    for (let index = 0; index < rgba.length / 4; index += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
            output[index * channels + channel] = rgba[index * 4 + channel];
        }
    }
    return output;
}

function zeroInvalid(data, channels, validity) {
    for (let index = 0; index < validity.length; index += 1) {
        if (validity[index] === 1) continue;
        data.fill(0, index * channels, index * channels + channels);
    }
    return data;
}

function warpNearest(data, calibration, channels) {
    return warpCalibratedImage({ data, calibration, channels, interpolation: "nearest" });
}

function disposePrepared(prepared) {
    for (const material of prepared?.materials ?? []) material.dispose();
    prepared?.scene.clear();
}

function syncPrepared(prepared, sceneHandle, passSet, renderables) {
    if (!prepared || prepared.sceneRole !== sceneHandle.role
        || prepared.sceneGeneration !== sceneHandle.generation
        || prepared.sceneDescriptionHash !== sceneHandle.descriptionHash
        || prepared.bindingSignature !== JSON.stringify(passSet.bindings)) return false;
    const resolved = renderableMap(renderables, `${passSet.family} renderables`);
    for (const [id, object] of prepared.bindingObjects) {
        if (resolved.get(id) !== object) return false;
    }
    const visibleMeshes = [];
    sceneHandle.scene.traverse((object) => {
        if (object.isMesh && effectiveVisible(object)) visibleMeshes.push(object);
    });
    if (visibleMeshes.length !== prepared.entries.length
        || visibleMeshes.some((object, index) => object !== prepared.entries[index].source)) return false;
    for (const entry of prepared.entries) {
        entry.proxy.matrix.copy(entry.source.matrixWorld);
        entry.proxy.matrixWorld.copy(entry.source.matrixWorld);
        entry.proxy.layers.mask = entry.source.layers.mask;
        entry.proxy.renderOrder = entry.source.renderOrder;
    }
    prepared.scene.updateMatrixWorld(true);
    return true;
}

function snapshotRenderer(renderer) {
    const clearColor = new THREE.Color();
    renderer.getClearColor?.(clearColor);
    return {
        target: renderer.getRenderTarget?.() ?? null,
        clearColor,
        clearAlpha: renderer.getClearAlpha?.() ?? 1,
        autoClear: renderer.autoClear,
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
        outputColorSpace: renderer.outputColorSpace,
        xrEnabled: renderer.xr?.enabled,
        shadowEnabled: renderer.shadowMap?.enabled,
    };
}

function restoreRenderer(renderer, state) {
    renderer.setRenderTarget?.(state.target);
    renderer.setClearColor?.(state.clearColor, state.clearAlpha);
    if (state.autoClear !== undefined) renderer.autoClear = state.autoClear;
    if (state.toneMapping !== undefined) renderer.toneMapping = state.toneMapping;
    if (state.toneMappingExposure !== undefined) renderer.toneMappingExposure = state.toneMappingExposure;
    if (state.outputColorSpace !== undefined) renderer.outputColorSpace = state.outputColorSpace;
    if (renderer.xr && state.xrEnabled !== undefined) renderer.xr.enabled = state.xrEnabled;
    if (renderer.shadowMap && state.shadowEnabled !== undefined) renderer.shadowMap.enabled = state.shadowEnabled;
}

function snapshotCamera(camera) {
    return {
        near: camera.near,
        far: camera.far,
        matrixAutoUpdate: camera.matrixAutoUpdate,
        projectionMatrix: camera.projectionMatrix.clone(),
        projectionMatrixInverse: camera.projectionMatrixInverse.clone(),
        matrix: camera.matrix.clone(),
        matrixWorld: camera.matrixWorld.clone(),
        matrixWorldInverse: camera.matrixWorldInverse.clone(),
    };
}

function applyCaptureCamera(camera, captureInput) {
    applyProjectionToThreeCamera(camera, captureInput.calibration);
    camera.matrixAutoUpdate = false;
    camera.matrix.fromArray(captureInput.pose.matrixWorld);
    camera.matrixWorld.fromArray(captureInput.pose.matrixWorld);
    camera.matrixWorldInverse.fromArray(captureInput.pose.viewMatrix);
}

function restoreCamera(camera, state) {
    camera.near = state.near;
    camera.far = state.far;
    camera.matrixAutoUpdate = state.matrixAutoUpdate;
    camera.projectionMatrix.copy(state.projectionMatrix);
    camera.projectionMatrixInverse.copy(state.projectionMatrixInverse);
    camera.matrix.copy(state.matrix);
    camera.matrixWorld.copy(state.matrixWorld);
    camera.matrixWorldInverse.copy(state.matrixWorldInverse);
}

function snapshotSceneState(scene) {
    if (!scene) return null;
    const objects = [];
    scene.traverse((object) => {
        objects.push({
            object,
            visible: object.visible,
            matrixAutoUpdate: object.matrixAutoUpdate,
            matrix: object.matrix?.clone?.() ?? null,
            matrixWorld: object.matrixWorld?.clone?.() ?? null,
            modelViewMatrix: object.modelViewMatrix?.clone?.() ?? null,
            normalMatrix: object.normalMatrix?.clone?.() ?? null,
            material: object.material,
            castShadow: object.castShadow,
            receiveShadow: object.receiveShadow,
            renderOrder: object.renderOrder,
        });
    });
    return {
        scene,
        background: scene.background,
        environment: scene.environment,
        overrideMaterial: scene.overrideMaterial,
        objects,
    };
}

function restoreSceneState(state) {
    if (!state) return;
    state.scene.background = state.background;
    state.scene.environment = state.environment;
    state.scene.overrideMaterial = state.overrideMaterial;
    for (const entry of state.objects) {
        entry.object.visible = entry.visible;
        entry.object.matrixAutoUpdate = entry.matrixAutoUpdate;
        if (entry.matrix && entry.object.matrix) entry.object.matrix.copy(entry.matrix);
        if (entry.matrixWorld && entry.object.matrixWorld) entry.object.matrixWorld.copy(entry.matrixWorld);
        if (entry.modelViewMatrix && entry.object.modelViewMatrix) entry.object.modelViewMatrix.copy(entry.modelViewMatrix);
        if (entry.normalMatrix && entry.object.normalMatrix) entry.object.normalMatrix.copy(entry.normalMatrix);
        if (entry.material !== undefined) entry.object.material = entry.material;
        entry.object.castShadow = entry.castShadow;
        entry.object.receiveShadow = entry.receiveShadow;
        entry.object.renderOrder = entry.renderOrder;
    }
}

export class AlignedCaptureProducts {
    constructor({
        renderer,
        camera,
        visualSceneHandle = null,
        analyticSceneHandle = null,
        authorizeSourceUse = null,
        createRenderTarget = null,
        renderPolicy = null,
        readback = null,
    } = {}) {
        if (!renderer || !camera) {
            throw captureError("VISUAL_CAPTURE_RENDERER_INVALID", "Renderer and camera are required.");
        }
        this.renderer = renderer;
        this.camera = camera;
        this.visualSceneHandle = visualSceneHandle;
        this.analyticSceneHandle = analyticSceneHandle;
        this.authorizeSourceUse = authorizeSourceUse;
        this.renderPolicy = renderPolicy;
        this.readback = readback;
        this.createRenderTarget = createRenderTarget ?? ((width, height, options) => (
            new THREE.WebGLRenderTarget(width, height, options)
        ));
        if (typeof this.createRenderTarget !== "function") {
            throw captureError("VISUAL_CAPTURE_RENDERER_INVALID", "createRenderTarget must be a function.");
        }
        this.targets = new Map();
        this.preparedFamilies = new Map();
        this.disposed = false;
    }

    _prepare(passSet, sceneHandle, renderables) {
        const existing = this.preparedFamilies.get(passSet.family);
        if (syncPrepared(existing, sceneHandle, passSet, renderables)) return existing;
        disposePrepared(existing);
        const prepared = prepareProxyScene(sceneHandle, passSet, renderables);
        prepared.sceneRole = sceneHandle.role;
        prepared.sceneGeneration = sceneHandle.generation;
        prepared.sceneDescriptionHash = sceneHandle.descriptionHash;
        prepared.bindingSignature = JSON.stringify(passSet.bindings);
        this.preparedFamilies.set(passSet.family, prepared);
        return prepared;
    }

    async _authorize(passSet, signal) {
        if (passSet.family !== VISUAL_CAPTURE_PASS_FAMILIES.visual || passSet.sourceUseHashes.length === 0) return;
        if (typeof this.authorizeSourceUse !== "function") {
            throw captureError(
                "VISUAL_CAPTURE_RIGHTS_UNAVAILABLE",
                "Source-backed corrected capture requires a trusted rights validator.",
            );
        }
        const operations = passSet.captureInput.scene.role === "bake-snapshot" ? BAKE_RIGHTS : VISUAL_RIGHTS;
        for (const useHash of passSet.sourceUseHashes) {
            abortIfRequested(signal);
            await this.authorizeSourceUse({ useHash, operations: [...operations] });
            abortIfRequested(signal);
        }
    }

    _target(kind, width, height) {
        const key = `${kind}:${width}x${height}`;
        let target = this.targets.get(key);
        if (target) return target;
        target = this.createRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: kind === "float" ? THREE.FloatType : THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
        });
        target.texture.colorSpace = kind === "beauty" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        target.userData = { ...(target.userData ?? {}), captureTargetKind: kind };
        this.targets.set(key, target);
        return target;
    }

    async _render(scene, target, ArrayType, signal, { mode = null, materials = [] } = {}) {
        abortIfRequested(signal);
        assertContextAvailable(this.renderer, { requireFloat: target.texture.type === THREE.FloatType });
        for (const material of materials) material.uniforms.captureMode.value = mode;
        this.renderer.setRenderTarget(target);
        const background = mode === null ? this.renderPolicy?.backgroundColorRgba : null;
        this.renderer.setClearColor(
            background ? new THREE.Color(background[0], background[1], background[2]) : 0x000000,
            background ? background[3] : 0,
        );
        this.renderer.clear?.(true, true, true);
        this.renderer.render(scene, this.camera);
        abortIfRequested(signal);
        assertContextAvailable(this.renderer, { requireFloat: target.texture.type === THREE.FloatType });
        const buffer = new ArrayType(target.width * target.height * 4);
        if (this.readback) await this.readback(this.renderer, target, buffer, { signal });
        else {
            withPixelPackBufferUnbound(this.renderer, () => {
                this.renderer.readRenderTargetPixels(
                    target,
                    0,
                    0,
                    target.width,
                    target.height,
                    buffer,
                );
            });
        }
        abortIfRequested(signal);
        return normalizeImageRows(buffer, target.width, target.height, 4, { inputRows: "bottom-left" });
    }

    async _captureFamily(passSet, sceneHandle, prepared, signal) {
        const { width, height } = passSet.captureInput.calibration.image;
        const requested = new Set(passSet.products);
        const floatTarget = () => this._target("float", width, height);
        const idTarget = this._target("id", width, height);
        const renderFloat = async (mode, channels) => extractChannels(await this._render(
            prepared.scene,
            floatTarget(),
            Float32Array,
            signal,
            { mode, materials: prepared.materials },
        ), channels);
        const renderId = async (mode) => decodeUint32(await this._render(
            prepared.scene,
            idTarget,
            Uint8Array,
            signal,
            { mode, materials: prepared.materials },
        ));
        const rawValidity = extractChannels(await this._render(
            prepared.scene,
            idTarget,
            Uint8Array,
            signal,
            { mode: MODE.validity, materials: prepared.materials },
        ), 1);
        const validityWarp = warpNearest(rawValidity, passSet.captureInput.calibration, 1);
        const validity = new Uint8Array(width * height);
        for (let index = 0; index < validity.length; index += 1) {
            validity[index] = validityWarp.validity[index] === 1 && validityWarp.data[index] >= 0.5 ? 1 : 0;
        }
        const products = { validity };
        if (passSet.family === VISUAL_CAPTURE_PASS_FAMILIES.visual && requested.has("beauty")) {
            const beautyTarget = this._target("beauty", width, height);
            const rawBeauty = await this._render(
                sceneHandle.scene,
                beautyTarget,
                Uint8Array,
                signal,
            );
            products.beauty = zeroInvalid(warpCalibratedImage({
                data: rawBeauty,
                calibration: passSet.captureInput.calibration,
                channels: 4,
                interpolation: "linear",
            }).data, 4, validity);
        }
        const numeric = [
            ["axial-depth", "axialDepth", MODE.axialDepth, 1],
            ["geometric-normal", "geometricNormal", MODE.geometricNormal, 3],
            ["world-position", "worldPosition", MODE.worldPosition, 3],
            ["confidence", "confidence", MODE.confidence, 1],
        ];
        for (const [requestName, resultName, mode, channels] of numeric) {
            if (!requested.has(requestName)) continue;
            const warped = warpNearest(
                await renderFloat(mode, channels),
                passSet.captureInput.calibration,
                channels,
            ).data;
            products[resultName] = zeroInvalid(warped, channels, validity);
        }
        const ids = passSet.family === VISUAL_CAPTURE_PASS_FAMILIES.visual
            ? [
                ["object-id", "objectId", MODE.objectId],
                ["material-id", "materialId", MODE.materialId],
            ]
            : [
                ["semantic-id", "semanticId", MODE.semanticId],
                ["instance-id", "instanceId", MODE.instanceId],
            ];
        for (const [requestName, resultName, mode] of ids) {
            if (!requested.has(requestName)) continue;
            const warped = warpNearest(
                await renderId(mode),
                passSet.captureInput.calibration,
                1,
            ).data;
            products[resultName] = zeroInvalid(warped, 1, validity);
        }
        return Object.freeze({
            family: passSet.family,
            captureInput: passSet.captureInput,
            catalogs: passSet.catalogs,
            products: Object.freeze(products),
        });
    }

    async capture({
        visualPassSet = null,
        visualRenderables = new Map(),
        analyticPassSet = null,
        analyticRenderables = new Map(),
        signal = null,
    } = {}) {
        if (this.disposed) throw captureError("VISUAL_CAPTURE_DISPOSED", "Aligned capture renderer is disposed.");
        if (!visualPassSet && !analyticPassSet) {
            throw captureError("VISUAL_CAPTURE_PASS_SET_INVALID", "At least one capture pass set is required.");
        }
        if (!signal || typeof signal.aborted !== "boolean") {
            throw captureError("VISUAL_CAPTURE_SIGNAL_REQUIRED", "Aligned capture requires an AbortSignal.");
        }
        const visual = visualPassSet ? assertVisualCapturePassSet(visualPassSet) : null;
        const analytic = analyticPassSet ? assertVisualCapturePassSet(analyticPassSet) : null;
        if (visual && visual.family !== VISUAL_CAPTURE_PASS_FAMILIES.visual) {
            throw captureError("VISUAL_CAPTURE_PASS_FAMILY_UNSUPPORTED", "visualPassSet must be visual-appearance.");
        }
        if (analytic && analytic.family !== VISUAL_CAPTURE_PASS_FAMILIES.analytic) {
            throw captureError("VISUAL_CAPTURE_PASS_FAMILY_UNSUPPORTED", "analyticPassSet must be analytic-oracle.");
        }
        if (visual && analytic) {
            assertAlignedCapturePassSets(visual, analytic);
            if (this.visualSceneHandle?.scene === this.analyticSceneHandle?.scene) {
                throw captureError(
                    "VISUAL_CAPTURE_SCENE_ROLE_INVALID",
                    "Visual appearance and analytic truth require distinct owned scenes.",
                );
            }
        }
        if (visual) {
            assertOwnedCaptureScene(this.visualSceneHandle, { role: visual.captureInput.scene.role });
            await this._authorize(visual, signal);
        }
        if (analytic) assertOwnedCaptureScene(this.analyticSceneHandle, { role: "analytic-truth" });
        abortIfRequested(signal);

        let visualPrepared = null;
        let analyticPrepared = null;
        const rendererState = snapshotRenderer(this.renderer);
        const cameraState = snapshotCamera(this.camera);
        const visualSceneState = snapshotSceneState(this.visualSceneHandle?.scene);
        const analyticSceneState = snapshotSceneState(this.analyticSceneHandle?.scene);
        let visualResult = null;
        let analyticResult = null;
        try {
            visualPrepared = visual
                ? this._prepare(visual, this.visualSceneHandle, visualRenderables)
                : null;
            analyticPrepared = analytic
                ? this._prepare(analytic, this.analyticSceneHandle, analyticRenderables)
                : null;
            const input = visual?.captureInput ?? analytic.captureInput;
            applyCaptureCamera(this.camera, input);
            if (this.renderer.xr) this.renderer.xr.enabled = false;
            if (this.renderer.shadowMap) this.renderer.shadowMap.enabled = false;
            this.renderer.autoClear = false;
            if (this.renderPolicy) {
                this.renderer.toneMapping = THREE.NoToneMapping;
                this.renderer.toneMappingExposure = Number(this.renderPolicy.exposure ?? 1);
                this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            }
            if (visual) {
                visualResult = await this._captureFamily(
                    visual,
                    this.visualSceneHandle,
                    visualPrepared,
                    signal,
                );
            }
            if (analytic) {
                analyticResult = await this._captureFamily(
                    analytic,
                    this.analyticSceneHandle,
                    analyticPrepared,
                    signal,
                );
            }
            abortIfRequested(signal);
            return Object.freeze({
                captureTimeNs: input.captureTimeNs,
                visual: visualResult,
                analytic: analyticResult,
            });
        } catch (error) {
            this._disposeTargets();
            throw error;
        } finally {
            restoreSceneState(analyticSceneState);
            restoreSceneState(visualSceneState);
            restoreCamera(this.camera, cameraState);
            restoreRenderer(this.renderer, rendererState);
        }
    }

    dispose() {
        if (this.disposed) return;
        this._disposeTargets();
        for (const prepared of this.preparedFamilies.values()) disposePrepared(prepared);
        this.preparedFamilies.clear();
        this.createRenderTarget = null;
        this.readback = null;
        this.disposed = true;
    }

    _disposeTargets() {
        for (const target of this.targets.values()) target.dispose();
        this.targets.clear();
    }
}

export function captureRightsForRole(role) {
    if (role === "bake-snapshot") return [...BAKE_RIGHTS];
    if (role === "measured-appearance") return [...VISUAL_RIGHTS];
    return [];
}
