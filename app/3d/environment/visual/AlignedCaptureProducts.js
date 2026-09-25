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
import {
    getWebGL2Context,
    PixelPackSlot,
    waitForPixelPack,
    withPixelPackBufferUnbound,
    yieldForGpuReadback,
} from "../../util/glReadback.js";

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
    axialDepthValidity: 10,
    idAttachments: 11,
});

const ANALYTIC_COMBINED_PRODUCTS = new Set([
    "axial-depth",
    "semantic-id",
    "instance-id",
    "validity",
]);

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

function isCaptureSky(object) {
    let current = object;
    while (current && !current.isScene) {
        if (current.userData?.cevSimSky === true) return true;
        current = current.parent;
    }
    return false;
}

function createSkyValidityMaterial() {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: `
            void main() {
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform int captureMode;
            out vec4 captureOutput;
            void main() {
                if (captureMode == ${MODE.validity}) captureOutput = vec4(1.0, 0.0, 0.0, 1.0);
                else captureOutput = vec4(0.0);
            }
        `,
        uniforms: {
            captureMode: { value: MODE.validity },
        },
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
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
        else if (captureMode == ${MODE.axialDepthValidity}) captureOutput = vec4(vAxialDepth, 1.0, 0.0, 1.0);
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

const fragmentShaderIdAttachments = `
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
    layout(location = 0) out vec4 semanticOutput;
    layout(location = 1) out vec4 instanceOutput;

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
        semanticOutput = packUint32(semanticId);
        instanceOutput = packUint32(instanceId);
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
    let coverBackground = checkedHandle.scene.background?.isTexture === true;
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
            if (isCaptureSky(object)) {
                coverBackground = true;
                return;
            }
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
            let cursor = object;
            let dynamic = false;
            while (cursor && cursor !== checkedHandle.scene) {
                if (cursor.userData?.cevSimCaptureDynamic === true) {
                    dynamic = true;
                    break;
                }
                cursor = cursor.parent;
            }
            entries.push({ source: object, proxy: mesh, dynamic });
        });
        if (coverBackground) {
            // SkyMaterial cannot feed the capture proxy. This mask is drawn
            // first so measured sky and equirectangular background pixels stay
            // valid, then real surfaces overwrite the pixels they cover.
            const material = createSkyValidityMaterial();
            materials.push(material);
            const skyMask = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
            skyMask.name = "cev-sim.sky-validity";
            skyMask.frustumCulled = false;
            skyMask.renderOrder = -1;
            skyMask.matrixAutoUpdate = false;
            skyMask.userData.cevSimOwnedProxyGeometry = true;
            proxy.add(skyMask);
        }
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

function decodeUint32Into(rgba, output) {
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

function extractChannelsInto(rgba, channels, output) {
    const pixels = rgba.length / 4;
    for (let index = 0; index < pixels; index += 1) {
        for (let channel = 0; channel < channels; channel += 1) {
            output[index * channels + channel] = rgba[index * 4 + channel];
        }
    }
    return output;
}

function extractChannelInto(rgba, channel, output) {
    const pixels = rgba.length / 4;
    for (let index = 0; index < pixels; index += 1) {
        output[index] = rgba[index * 4 + channel];
    }
    return output;
}

function zeroInvalid(data, channels, validity) {
    for (let index = 0; index < validity.length; index += 1) {
        if (validity[index] === 1) continue;
        const offset = index * channels;
        for (let channel = 0; channel < channels; channel += 1) data[offset + channel] = 0;
    }
    return data;
}

function warpNearest(data, calibration, channels, output, validity) {
    return warpCalibratedImage({
        data,
        calibration,
        channels,
        interpolation: "nearest",
        output,
        validity,
    });
}

function matrixElementsEqual(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function disposePrepared(prepared) {
    prepared?.scene.traverse?.((object) => {
        if (object.userData?.cevSimOwnedProxyGeometry) object.geometry?.dispose?.();
    });
    for (const material of prepared?.materials ?? []) {
        material.userData?.cevSimIdAttachment?.dispose?.();
        material.dispose();
    }
    prepared?.scene.clear();
}

function syncPrepared(prepared, sceneHandle, passSet, renderables) {
    const topologyRevision = Number(sceneHandle.scene?.userData?.cevSimCaptureTopologyRevision) || null;
    if (!prepared || prepared.sceneRole !== sceneHandle.role
        || prepared.sceneGeneration !== sceneHandle.generation
        || prepared.sceneDescriptionHash !== sceneHandle.descriptionHash
        || prepared.topologyRevision !== topologyRevision) return false;
    const previousBindings = prepared.bindings ?? [];
    const sameBindings = previousBindings === passSet.bindings
        || (previousBindings.length === passSet.bindings.length
            && previousBindings.every((binding, index) => binding === passSet.bindings[index]));
    if (!sameBindings) return false;
    const resolved = renderableMap(renderables, `${passSet.family} renderables`);
    for (const [id, object] of prepared.bindingObjects) {
        if (resolved.get(id) !== object) return false;
    }
    if (topologyRevision === null) {
        const visibleMeshes = [];
        sceneHandle.scene.traverse((object) => {
            if (object.isMesh && effectiveVisible(object) && !isCaptureSky(object)) visibleMeshes.push(object);
        });
        if (visibleMeshes.length !== prepared.entries.length
            || visibleMeshes.some((object, index) => object !== prepared.entries[index].source)) return false;
    }
    const transformRevision = Number(sceneHandle.scene?.userData?.cevSimCaptureTransformRevision) || null;
    if (topologyRevision !== null && prepared.transformRevision === transformRevision) return true;
    const entries = topologyRevision === null
        ? prepared.entries
        : prepared.entries.filter((entry) => entry.dynamic);
    for (const entry of entries) {
        if (!matrixElementsEqual(entry.proxy.matrix.elements, entry.source.matrixWorld.elements)) {
            entry.proxy.matrix.copy(entry.source.matrixWorld);
            entry.proxy.matrixWorld.copy(entry.source.matrixWorld);
        }
        entry.proxy.layers.mask = entry.source.layers.mask;
        entry.proxy.renderOrder = entry.source.renderOrder;
    }
    prepared.transformRevision = transformRevision;
    return true;
}

function presentBeautyComposer(composer, camera, width, height) {
    composer.setMainCamera?.(camera);
    const input = composer.inputBuffer;
    const output = composer.outputBuffer;
    const sized = input?.width === width && input?.height === height
        && output?.width === width && output?.height === height;
    if (!sized
        && typeof input?.setSize === "function"
        && typeof output?.setSize === "function") {
        input.setSize(width, height);
        output.setSize(width, height);
        composer.depthRenderTarget?.setSize?.(width, height);
        for (const pass of composer.passes ?? []) pass.setSize?.(width, height);
    }
    composer.render(0);
    return composer.outputBuffer;
}

function assertCaptureTargetSize(target, width, height, label) {
    const actualWidth = Number(target?.width);
    const actualHeight = Number(target?.height);
    if (actualWidth !== width || actualHeight !== height) {
        const actual = Number.isFinite(actualWidth) && Number.isFinite(actualHeight)
            ? `${actualWidth}x${actualHeight}`
            : "unavailable";
        throw captureError(
            "VISUAL_CAPTURE_TARGET_SIZE_INVALID",
            `${label} render target must be ${width}x${height} after draw; got ${actual}.`,
        );
    }
    return target;
}

function snapshotRenderer(renderer) {
    const clearColor = new THREE.Color();
    renderer.getClearColor?.(clearColor);
    const gl = renderer.getContext?.() ?? null;
    const webgl2 = gl && typeof WebGL2RenderingContext !== "undefined"
        && gl instanceof WebGL2RenderingContext;
    return {
        target: renderer.getRenderTarget?.() ?? null,
        activeCubeFace: renderer.getActiveCubeFace?.() ?? 0,
        activeMipmapLevel: renderer.getActiveMipmapLevel?.() ?? 0,
        clearColor,
        clearAlpha: renderer.getClearAlpha?.() ?? 1,
        clearDepth: renderer.getClearDepth?.(),
        clearStencil: renderer.getClearStencil?.(),
        autoClear: renderer.autoClear,
        autoClearColor: renderer.autoClearColor,
        autoClearDepth: renderer.autoClearDepth,
        autoClearStencil: renderer.autoClearStencil,
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
        outputColorSpace: renderer.outputColorSpace,
        xrEnabled: renderer.xr?.enabled,
        shadowEnabled: renderer.shadowMap?.enabled,
        gl: webgl2 ? {
            context: gl,
            drawFramebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
            readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
            readBuffer: gl.getParameter(gl.READ_BUFFER),
            pixelPackBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
            packAlignment: gl.getParameter(gl.PACK_ALIGNMENT),
        } : null,
    };
}

function restoreRenderer(renderer, state) {
    renderer.setRenderTarget?.(state.target, state.activeCubeFace, state.activeMipmapLevel);
    renderer.setClearColor?.(state.clearColor, state.clearAlpha);
    if (state.clearDepth !== undefined) renderer.setClearDepth?.(state.clearDepth);
    if (state.clearStencil !== undefined) renderer.setClearStencil?.(state.clearStencil);
    if (state.autoClear !== undefined) renderer.autoClear = state.autoClear;
    if (state.autoClearColor !== undefined) renderer.autoClearColor = state.autoClearColor;
    if (state.autoClearDepth !== undefined) renderer.autoClearDepth = state.autoClearDepth;
    if (state.autoClearStencil !== undefined) renderer.autoClearStencil = state.autoClearStencil;
    if (state.toneMapping !== undefined) renderer.toneMapping = state.toneMapping;
    if (state.toneMappingExposure !== undefined) renderer.toneMappingExposure = state.toneMappingExposure;
    if (state.outputColorSpace !== undefined) renderer.outputColorSpace = state.outputColorSpace;
    if (renderer.xr && state.xrEnabled !== undefined) renderer.xr.enabled = state.xrEnabled;
    if (renderer.shadowMap && state.shadowEnabled !== undefined) renderer.shadowMap.enabled = state.shadowEnabled;
    if (state.gl?.context && !state.gl.context.isContextLost?.()) {
        const gl = state.gl.context;
        gl.bindFramebuffer?.(gl.DRAW_FRAMEBUFFER, state.gl.drawFramebuffer);
        gl.bindFramebuffer?.(gl.READ_FRAMEBUFFER, state.gl.readFramebuffer);
        gl.readBuffer?.(state.gl.readBuffer);
        gl.bindBuffer?.(gl.PIXEL_PACK_BUFFER, state.gl.pixelPackBuffer);
        gl.pixelStorei?.(gl.PACK_ALIGNMENT, state.gl.packAlignment);
    }
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
    return {
        scene,
        background: scene.background,
        environment: scene.environment,
        overrideMaterial: scene.overrideMaterial,
    };
}

function restoreSceneState(state) {
    if (!state) return;
    state.scene.background = state.background;
    state.scene.environment = state.environment;
    state.scene.overrideMaterial = state.overrideMaterial;
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
        rendererLease = null,
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
        this.rendererLease = rendererLease;
        this.createRenderTarget = createRenderTarget ?? ((width, height, options) => (
            new THREE.WebGLRenderTarget(width, height, options)
        ));
        if (typeof this.createRenderTarget !== "function") {
            throw captureError("VISUAL_CAPTURE_RENDERER_INVALID", "createRenderTarget must be a function.");
        }
        this.targets = new Map();
        this.preparedFamilies = new Map();
        this._packSlots = [];
        this._freePackSlots = new Map();
        this._bufferPools = new Map();
        this.bufferAllocations = 0;
        this._packGl = null;
        this.disposed = false;
        this.lastCaptureTimings = Object.freeze({ captureMs: 0, readbackMs: 0, warpMs: 0 });
    }

    _runRendererSync(operation) {
        if (typeof this.rendererLease?.runSync === "function") {
            return this.rendererLease.runSync(operation);
        }
        return operation();
    }

    async _runRendererAsync(operation) {
        if (typeof this.rendererLease?.runAsync === "function") {
            return this.rendererLease.runAsync(operation);
        }
        return operation();
    }

    _configureRendererForCapture() {
        if (this.renderer.xr) this.renderer.xr.enabled = false;
        if (this.renderer.shadowMap) this.renderer.shadowMap.enabled = false;
        this.renderer.autoClear = false;
        if (this.renderPolicy) {
            this.renderer.toneMapping = THREE.NoToneMapping;
            this.renderer.toneMappingExposure = Number(this.renderPolicy.exposure ?? 1);
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
    }

    _withCaptureRendererSync(operation) {
        return this._runRendererSync(() => {
            const state = snapshotRenderer(this.renderer);
            try {
                this._configureRendererForCapture();
                return operation();
            } finally {
                restoreRenderer(this.renderer, state);
            }
        });
    }

    async _withCaptureRendererAsync(operation) {
        return this._runRendererAsync(async () => {
            const state = snapshotRenderer(this.renderer);
            try {
                this._configureRendererForCapture();
                return await operation();
            } finally {
                restoreRenderer(this.renderer, state);
            }
        });
    }

    _prepare(passSet, sceneHandle, renderables) {
        const existing = this.preparedFamilies.get(passSet.family);
        if (syncPrepared(existing, sceneHandle, passSet, renderables)) return existing;
        disposePrepared(existing);
        const prepared = prepareProxyScene(sceneHandle, passSet, renderables);
        prepared.sceneRole = sceneHandle.role;
        prepared.sceneGeneration = sceneHandle.generation;
        prepared.sceneDescriptionHash = sceneHandle.descriptionHash;
        prepared.bindings = passSet.bindings;
        prepared.topologyRevision = Number(sceneHandle.scene?.userData?.cevSimCaptureTopologyRevision) || null;
        prepared.transformRevision = Number(sceneHandle.scene?.userData?.cevSimCaptureTransformRevision) || null;
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
        abortIfRequested(signal);
        const operations = passSet.captureInput.scene.role === "bake-snapshot" ? BAKE_RIGHTS : VISUAL_RIGHTS;
        await Promise.all(passSet.sourceUseHashes.map(async (useHash) => {
            abortIfRequested(signal);
            await this.authorizeSourceUse({ useHash, operations: [...operations] });
            abortIfRequested(signal);
        }));
    }

    _target(kind, width, height, count = 1) {
        const key = `${kind}:${width}x${height}:${count}`;
        let target = this.targets.get(key);
        if (target) return target;
        target = this.createRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            type: kind === "float" ? THREE.FloatType : THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
            count,
        });
        target.texture.colorSpace = kind === "beauty" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        target.userData = { ...(target.userData ?? {}), captureTargetKind: kind };
        this.targets.set(key, target);
        return target;
    }

    _acquireBuffer(ArrayType, length) {
        const key = `${ArrayType.name}:${length}`;
        const pooled = this._bufferPools.get(key);
        const buffer = pooled?.pop();
        if (buffer) return buffer;
        this.bufferAllocations += 1;
        return new ArrayType(length);
    }

    _releaseBuffer(buffer) {
        if (!buffer) return;
        const key = `${buffer.constructor.name}:${buffer.length}`;
        const pooled = this._bufferPools.get(key) ?? [];
        pooled.push(buffer);
        this._bufferPools.set(key, pooled);
    }

    _pipelinesReads() {
        return !this.readback && Boolean(getWebGL2Context(this.renderer));
    }

    _draw(scene, target, { mode = null, materials = [] } = {}) {
        assertContextAvailable(this.renderer, { requireFloat: target.texture?.type === THREE.FloatType });
        for (const material of materials) material.uniforms.captureMode.value = mode;
        this.renderer.setRenderTarget(target);
        const background = mode === null ? this.renderPolicy?.backgroundColorRgba : null;
        this.renderer.setClearColor(
            background ? new THREE.Color(background[0], background[1], background[2]) : 0x000000,
            background ? background[3] : 0,
        );
        this.renderer.clear?.(true, true, true);
        this.renderer.render(scene, this.camera);
    }

    _idAttachmentMaterial(source) {
        if (!source?.isShaderMaterial) return source;
        if (source.userData?.cevSimIdAttachment) return source.userData.cevSimIdAttachment;
        const material = source.clone();
        material.fragmentShader = fragmentShaderIdAttachments;
        material.uniforms.captureMode.value = MODE.idAttachments;
        if (!source.userData) source.userData = {};
        source.userData.cevSimIdAttachment = material;
        return material;
    }

    _drawIdAttachments(scene, target) {
        const restores = [];
        scene.traverse((object) => {
            if (!object.isMesh || !object.material) return;
            restores.push([object, object.material]);
            object.material = Array.isArray(object.material)
                ? object.material.map((material) => this._idAttachmentMaterial(material))
                : this._idAttachmentMaterial(object.material);
        });
        try {
            this._draw(scene, target, { mode: null, materials: [] });
        } finally {
            for (const [object, material] of restores) object.material = material;
        }
    }

    _normalizeRead(buffer, width, height) {
        const flipped = this._acquireBuffer(buffer.constructor, buffer.length);
        const normalized = normalizeImageRows(buffer, width, height, 4, {
            inputRows: "bottom-left",
            output: flipped,
        });
        if (normalized !== buffer) this._releaseBuffer(buffer);
        return normalized;
    }

    async _readRenderTarget(target, ArrayType, signal, attachmentIndex = 0) {
        const readbackStart = performance.now();
        abortIfRequested(signal);
        assertContextAvailable(this.renderer, { requireFloat: target.texture?.type === THREE.FloatType });
        const buffer = this._acquireBuffer(ArrayType, target.width * target.height * 4);
        try {
            if (this.readback) {
                await this.readback(this.renderer, target, buffer, { signal, textureIndex: attachmentIndex });
            } else if (getWebGL2Context(this.renderer)) {
                const slot = this._beginPackedRead(target, buffer, attachmentIndex);
                await this._finishPackedRead(slot, buffer, signal);
            } else {
                withPixelPackBufferUnbound(this.renderer, () => {
                    this.renderer.readRenderTargetPixels(
                        target,
                        0,
                        0,
                        target.width,
                        target.height,
                        buffer,
                        undefined,
                        attachmentIndex,
                    );
                });
            }
        } catch (error) {
            this._releaseBuffer(buffer);
            throw error;
        }
        abortIfRequested(signal);
        const result = this._normalizeRead(buffer, target.width, target.height);
        this._captureTimings.readbackMs += performance.now() - readbackStart;
        return result;
    }

    _binaryValidity(raw, calibration, width, height) {
        const warpStart = performance.now();
        const warpData = this._acquireBuffer(Float32Array, width * height);
        const warpMask = this._acquireBuffer(Uint8Array, width * height);
        const warped = warpNearest(raw, calibration, 1, warpData, warpMask);
        const validity = new Uint8Array(width * height);
        for (let index = 0; index < validity.length; index += 1) {
            validity[index] = warped.validity[index] === 1 && warped.data[index] >= 0.5 ? 1 : 0;
        }
        this._releaseBuffer(raw);
        this._releaseBuffer(warpData);
        this._releaseBuffer(warpMask);
        this._captureTimings.warpMs += performance.now() - warpStart;
        return validity;
    }

    _warpProduct(raw, calibration, channels, validity) {
        const warpStart = performance.now();
        const product = new raw.constructor(raw.length);
        const mask = this._acquireBuffer(Uint8Array, raw.length / channels);
        const warped = warpNearest(raw, calibration, channels, product, mask);
        this._releaseBuffer(mask);
        this._releaseBuffer(raw);
        const result = zeroInvalid(warped.data, channels, validity);
        this._captureTimings.warpMs += performance.now() - warpStart;
        return result;
    }

    async _captureFamily(passSet, sceneHandle, prepared, signal) {
        const { width, height } = passSet.captureInput.calibration.image;
        const calibration = passSet.captureInput.calibration;
        const requested = new Set(passSet.products);
        const pipeline = this._pipelinesReads();
        const pending = [];
        const products = {};
        let validity = null;
        const pixels = width * height;

        const pump = () => {
            let waiting = false;
            for (const job of pending) {
                if (job.settled) continue;
                if (!job.filled) {
                    if (job.slot?.gl?.isContextLost?.()) {
                        throw new Error("WebGL2 context was lost during asynchronous readback.");
                    }
                    if (!job.slot?.pending) {
                        this._abandonPackSlot(job.slot);
                        throw new Error("Asynchronous PBR readback lost its fence before readback.");
                    }
                    if (!this._runRendererSync(() => this._tryFinishPackedRead(job.slot, job.buffer))) {
                        if (job.slot?.gl?.isContextLost?.()) {
                            throw new Error("WebGL2 context was lost during asynchronous readback.");
                        }
                        if (!job.slot?.pending) {
                            this._abandonPackSlot(job.slot);
                            throw new Error("Asynchronous PBR readback lost its fence before readback.");
                        }
                        waiting = true;
                        continue;
                    }
                    job.filled = true;
                    job.rgba = this._normalizeRead(job.buffer, job.readWidth, job.readHeight);
                }
                if (job.needsValidity && !validity) continue;
                job.settle(job.rgba);
                this._releaseBuffer(job.rgba);
                job.settled = true;
            }
            return waiting;
        };

        const issue = async (job) => {
            abortIfRequested(signal);
            const drawAndResolveTarget = () => assertCaptureTargetSize(
                job.draw() ?? (typeof job.target === "function" ? job.target() : job.target),
                width,
                height,
                job.label ?? `${passSet.family} capture`,
            );
            if (!pipeline) {
                const rgba = await this._withCaptureRendererAsync(async () => {
                    const target = drawAndResolveTarget();
                    return this._readRenderTarget(
                        target,
                        job.ArrayType,
                        signal,
                        job.attachmentIndex ?? 0,
                    );
                });
                job.settle(rgba);
                this._releaseBuffer(rgba);
                return;
            }
            const issued = this._withCaptureRendererSync(() => {
                const target = drawAndResolveTarget();
                const readWidth = target.width;
                const readHeight = target.height;
                const buffer = this._acquireBuffer(job.ArrayType, readWidth * readHeight * 4);
                try {
                    return {
                        target,
                        readWidth,
                        readHeight,
                        buffer,
                        slot: this._beginPackedRead(target, buffer, job.attachmentIndex ?? 0),
                    };
                } catch (error) {
                    this._releaseBuffer(buffer);
                    throw error;
                }
            });
            pending.push({
                ...job,
                ...issued,
                filled: false,
                settled: false,
                rgba: null,
            });
            pump();
        };

        const queueValidity = () => issue({
            needsValidity: false,
            ArrayType: Uint8Array,
            target: this._target("id", width, height),
            draw: () => this._draw(prepared.scene, this._target("id", width, height), {
                mode: MODE.validity,
                materials: prepared.materials,
            }),
            settle: (rgba) => {
                const raw = this._acquireBuffer(Float32Array, pixels);
                extractChannelInto(rgba, 0, raw);
                validity = this._binaryValidity(raw, calibration, width, height);
                products.validity = validity;
            },
        });

        const queueBeauty = () => {
            const composer = sceneHandle.scene?.userData?.cevSimBeautyComposer ?? null;
            return issue({
                needsValidity: true,
                ArrayType: Uint8Array,
                label: "Beauty",
                target: () => composer?.outputBuffer ?? this._target("beauty", width, height),
                draw: () => {
                    const background = this.renderPolicy?.backgroundColorRgba;
                    this.renderer.setClearColor?.(
                        background ? new THREE.Color(background[0], background[1], background[2]) : 0x000000,
                        background ? background[3] : 0,
                    );
                    if (composer) return presentBeautyComposer(composer, this.camera, width, height);
                    const target = this._target("beauty", width, height);
                    this._draw(sceneHandle.scene, target, { mode: null, materials: [] });
                    return target;
                },
                settle: (rgba) => {
                    const warpStart = performance.now();
                    const product = new Uint8Array(rgba.length);
                    const mask = this._acquireBuffer(Uint8Array, pixels);
                    const warped = warpCalibratedImage({
                        data: rgba,
                        calibration,
                        channels: 4,
                        interpolation: "linear",
                        output: product,
                        validity: mask,
                    });
                    this._releaseBuffer(mask);
                    products.beauty = zeroInvalid(warped.data, 4, validity);
                    this._captureTimings.warpMs += performance.now() - warpStart;
                },
            });
        };

        const queueFloat = (mode, resultName, channels) => issue({
            needsValidity: true,
            ArrayType: Float32Array,
            target: this._target("float", width, height),
            draw: () => this._draw(prepared.scene, this._target("float", width, height), {
                mode,
                materials: prepared.materials,
            }),
            settle: (rgba) => {
                const raw = this._acquireBuffer(Float32Array, pixels * channels);
                extractChannelsInto(rgba, channels, raw);
                products[resultName] = this._warpProduct(raw, calibration, channels, validity);
            },
        });

        const queueId = (mode, resultName) => issue({
            needsValidity: true,
            ArrayType: Uint8Array,
            target: this._target("id", width, height),
            draw: () => this._draw(prepared.scene, this._target("id", width, height), {
                mode,
                materials: prepared.materials,
            }),
            settle: (rgba) => {
                const raw = this._acquireBuffer(Uint32Array, pixels);
                decodeUint32Into(rgba, raw);
                products[resultName] = this._warpProduct(raw, calibration, 1, validity);
            },
        });

        const combineAnalytic = !this.readback
            && passSet.family === VISUAL_CAPTURE_PASS_FAMILIES.analytic
            && [...requested].every((name) => ANALYTIC_COMBINED_PRODUCTS.has(name));

        if (combineAnalytic) {
            const floatTarget = this._target("float", width, height);
            await issue({
                needsValidity: false,
                ArrayType: Float32Array,
                target: floatTarget,
                draw: () => this._draw(prepared.scene, floatTarget, {
                    mode: MODE.axialDepthValidity,
                    materials: prepared.materials,
                }),
                settle: (rgba) => {
                    const rawValidity = this._acquireBuffer(Float32Array, pixels);
                    extractChannelInto(rgba, 1, rawValidity);
                    validity = this._binaryValidity(rawValidity, calibration, width, height);
                    products.validity = validity;
                    if (!requested.has("axial-depth")) return;
                    const rawDepth = this._acquireBuffer(Float32Array, pixels);
                    extractChannelInto(rgba, 0, rawDepth);
                    products.axialDepth = this._warpProduct(rawDepth, calibration, 1, validity);
                },
            });
            const wantSemantic = requested.has("semantic-id");
            const wantInstance = requested.has("instance-id");
            if (wantSemantic && wantInstance) {
                const idTarget = this._target("id", width, height, 2);
                const settleId = (channelName) => (rgba) => {
                    const raw = this._acquireBuffer(Uint32Array, pixels);
                    decodeUint32Into(rgba, raw);
                    products[channelName] = this._warpProduct(raw, calibration, 1, validity);
                };
                if (!pipeline) {
                    const [semantic, instance] = await this._withCaptureRendererAsync(async () => {
                        this._drawIdAttachments(prepared.scene, idTarget);
                        const semantic = await this._readRenderTarget(idTarget, Uint8Array, signal, 0);
                        const instance = await this._readRenderTarget(idTarget, Uint8Array, signal, 1);
                        return [semantic, instance];
                    });
                    if (!validity) throw new Error("Analytic validity was not produced.");
                    settleId("semanticId")(semantic);
                    settleId("instanceId")(instance);
                    this._releaseBuffer(semantic);
                    this._releaseBuffer(instance);
                } else {
                    const issued = this._withCaptureRendererSync(() => {
                        this._drawIdAttachments(prepared.scene, idTarget);
                        return [[0, "semanticId"], [1, "instanceId"]].map(([attachmentIndex, resultName]) => {
                            const buffer = this._acquireBuffer(Uint8Array, idTarget.width * idTarget.height * 4);
                            const slot = this._beginPackedRead(idTarget, buffer, attachmentIndex);
                            return {
                                needsValidity: true,
                                target: idTarget,
                                readWidth: idTarget.width,
                                readHeight: idTarget.height,
                                buffer,
                                slot,
                                filled: false,
                                settled: false,
                                rgba: null,
                                settle: settleId(resultName),
                            };
                        });
                    });
                    pending.push(...issued);
                    pump();
                }
            } else if (wantSemantic) {
                await queueId(MODE.semanticId, "semanticId");
            } else if (wantInstance) {
                await queueId(MODE.instanceId, "instanceId");
            }
        } else {
            await queueValidity();
            if (passSet.family === VISUAL_CAPTURE_PASS_FAMILIES.visual && requested.has("beauty")) {
                await queueBeauty();
            }
            const numeric = [
                ["axial-depth", "axialDepth", MODE.axialDepth, 1],
                ["geometric-normal", "geometricNormal", MODE.geometricNormal, 3],
                ["world-position", "worldPosition", MODE.worldPosition, 3],
                ["confidence", "confidence", MODE.confidence, 1],
            ];
            for (const [requestName, resultName, mode, channels] of numeric) {
                if (requested.has(requestName)) await queueFloat(mode, resultName, channels);
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
                if (requested.has(requestName)) await queueId(mode, resultName);
            }
        }

        if (pipeline) {
            const readbackStart = performance.now();
            const deadline = Date.now() + 2000;
            while (pump()) {
                abortIfRequested(signal);
                if (Date.now() >= deadline) {
                    for (const job of pending) {
                        if (!job.filled) this._abandonPackSlot(job.slot);
                    }
                    throw new Error("Asynchronous PBR readback exceeded 2000 ms.");
                }
                await yieldForGpuReadback();
            }
            this._captureTimings.readbackMs += performance.now() - readbackStart;
        }
        if (!products.validity) {
            throw captureError("VISUAL_CAPTURE_PRODUCT_INVALID", "Aligned capture did not produce validity.");
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
        const captureStart = performance.now();
        this._captureTimings = { captureMs: 0, readbackMs: 0, warpMs: 0 };
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
            this._captureTimings.captureMs = performance.now() - captureStart;
            this.lastCaptureTimings = Object.freeze({ ...this._captureTimings });
            restoreSceneState(analyticSceneState);
            restoreSceneState(visualSceneState);
            restoreCamera(this.camera, cameraState);
        }
    }

    _acquirePackSlot(byteLength) {
        const gl = getWebGL2Context(this.renderer);
        if (this._packGl !== gl) {
            this._disposePackSlots();
            this._packGl = gl;
        }
        const free = this._freePackSlots.get(byteLength);
        const slot = free?.pop() ?? new PixelPackSlot(gl, byteLength);
        if (!this._packSlots.includes(slot)) this._packSlots.push(slot);
        return slot;
    }

    _releasePackSlot(slot) {
        if (!slot || slot.pending) return;
        const free = this._freePackSlots.get(slot.byteLength) ?? [];
        free.push(slot);
        this._freePackSlots.set(slot.byteLength, free);
    }

    _abandonPackSlot(slot) {
        if (!slot) return;
        slot.dispose();
        this._packSlots = this._packSlots.filter((candidate) => candidate !== slot);
        const free = this._freePackSlots.get(slot.byteLength);
        if (free) this._freePackSlots.set(slot.byteLength, free.filter((candidate) => candidate !== slot));
    }

    _beginPackedRead(target, buffer, attachmentIndex = 0) {
        const gl = getWebGL2Context(this.renderer);
        const slot = this._acquirePackSlot(buffer.byteLength);
        const type = buffer instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE;
        if (slot.begin(0, 0, target.width, target.height, gl.RGBA, type, attachmentIndex) === false) {
            this._abandonPackSlot(slot);
            throw new Error("Asynchronous PBR readback buffer is still awaiting readback.");
        }
        return slot;
    }

    _tryFinishPackedRead(slot, buffer) {
        if (!slot.poll(buffer)) return false;
        this._releasePackSlot(slot);
        return true;
    }

    async _finishPackedRead(slot, buffer, signal) {
        abortIfRequested(signal);
        const gl = slot.gl;
        if (gl?.isContextLost?.()) {
            this._abandonPackSlot(slot);
            throw new Error("WebGL2 context was lost during asynchronous readback.");
        }
        const remainingMs = Math.max(0, 2000 - (Date.now() - slot.begunAtMs));
        const ready = await waitForPixelPack(slot, buffer, { timeoutMs: remainingMs, signal });
        if (!ready) {
            const lost = slot.gl?.isContextLost?.();
            this._abandonPackSlot(slot);
            throw new Error(lost
                ? "WebGL2 context was lost during asynchronous readback."
                : "Asynchronous PBR readback exceeded 2000 ms.");
        }
        this._releasePackSlot(slot);
        return buffer;
    }

    _disposePackSlots() {
        for (const slot of this._packSlots) slot.dispose();
        this._packSlots = [];
        this._freePackSlots.clear();
        this._packGl = null;
    }

    dispose() {
        if (this.disposed) return;
        this._disposeTargets();
        this._disposePackSlots();
        this._bufferPools.clear();
        for (const prepared of this.preparedFamilies.values()) disposePrepared(prepared);
        this.preparedFamilies.clear();
        this.createRenderTarget = null;
        this.readback = null;
        this.rendererLease = null;
        this.disposed = true;
    }

    _disposeTargets() {
        for (const target of this.targets.values()) target.dispose();
        this.targets.clear();
        this._disposePackSlots();
    }
}

export function captureRightsForRole(role) {
    if (role === "bake-snapshot") return [...BAKE_RIGHTS];
    if (role === "measured-appearance") return [...VISUAL_RIGHTS];
    return [];
}
