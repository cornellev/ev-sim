import * as THREE from "three";
import { VISUAL_PREVIEW_USERDATA } from "../../environment/visual/VisualPreviewIsolation.js";
import { EDITOR_LAYERS } from "../EditorState.js";
import { MAP_SATELLITE_MIN_ELEVATION, mapSatelliteFrustum } from "./mapSatelliteFrustum.js";

export const MAP_SATELLITE_CLEAR_COLOR = 0x09090b;
export const MAP_SATELLITE_MAX_SIZE = 2048;

function isRoadRegistryObject(object, registry) {
    if (!registry?.entities) return false;
    const roots = [];
    for (const entity of registry.entities.values()) {
        if (entity.layer === EDITOR_LAYERS.ROADS && entity.object3D) roots.push(entity.object3D);
    }
    if (roots.length === 0) return false;
    let current = object;
    while (current) {
        if (roots.includes(current)) return true;
        current = current.parent;
    }
    return false;
}

/**
 * Editor chrome, 3D roads, and sky stay out of the nadir bitmap. Google tiles
 * (`earthImportLayer`), visual-preview meshes, and chunk occupancy groups
 * (which parent authored buildings/assets) stay in.
 */
export function shouldHideFromMapSatellite(object, { registry } = {}) {
    if (!object) return false;
    const data = object.userData ?? {};
    if (data.earthImportLayer === true) return false;
    if (data[VISUAL_PREVIEW_USERDATA.previewOnly] === true) return false;
    // ChunkManager groups authored meshes under occupancy nodes tagged with
    // both environmentChunkKey and skipEnvironmentSelection. Hiding those
    // groups blanks the snapshot.
    if (data.environmentChunkKey) return false;
    if (data.editorHelper === true) return true;
    if (data.preserveInEarthImportMode === true) return true;
    if (object.isGridHelper === true || object.name === "EditorWorkingGrid") return true;
    if (object.name === "EnvironmentChunkOutlines" || String(object.name ?? "").startsWith("ChunkGrid:")) return true;
    if (object.isTransformControls || object.isTransformControlsRoot || String(object.type ?? "").startsWith("TransformControls")) return true;
    if (object.name === "EditorAssetPlacementGhost") return true;
    if (data.skipEnvironmentSelection === true) return true;
    return isRoadRegistryObject(object, registry);
}

export function collectMapSatelliteHideRoots(scene, registry) {
    const roots = [];
    const seen = new Set();
    const add = (object) => {
        if (!object || seen.has(object)) return;
        seen.add(object);
        roots.push(object);
    };
    if (registry?.entities) {
        for (const entity of registry.entities.values()) {
            if (entity.layer === EDITOR_LAYERS.ROADS && entity.object3D) add(entity.object3D);
        }
    }
    scene?.traverse?.((object) => {
        if (shouldHideFromMapSatellite(object, { registry })) add(object);
    });
    return roots;
}

function satelliteRenderSize(width, height, maxSize) {
    const nextWidth = Math.max(1, Math.floor(Number(width) || 0));
    const nextHeight = Math.max(1, Math.floor(Number(height) || 0));
    const longest = Math.max(nextWidth, nextHeight);
    if (longest <= maxSize) return { width: nextWidth, height: nextHeight };
    const scale = maxSize / longest;
    return {
        width: Math.max(1, Math.round(nextWidth * scale)),
        height: Math.max(1, Math.round(nextHeight * scale)),
    };
}

function sceneCaptureElevation(scene, registry) {
    if (!scene) return MAP_SATELLITE_MIN_ELEVATION;
    const box = new THREE.Box3();
    const child = new THREE.Box3();
    let found = false;
    scene.traverse((object) => {
        if (!object.visible || !object.isMesh) return;
        if (shouldHideFromMapSatellite(object, { registry })) return;
        child.setFromObject(object);
        if (child.isEmpty()) return;
        if (!found) {
            box.copy(child);
            found = true;
        } else {
            box.union(child);
        }
    });
    const maxY = found && Number.isFinite(box.max.y) ? box.max.y : 0;
    return Math.max(MAP_SATELLITE_MIN_ELEVATION, maxY + 10);
}

function applyFrustum(camera, frustum) {
    camera.left = frustum.left;
    camera.right = frustum.right;
    camera.top = frustum.top;
    camera.bottom = frustum.bottom;
    camera.near = frustum.near;
    camera.far = frustum.far;
    camera.position.fromArray(frustum.position);
    camera.up.fromArray(frustum.up);
    camera.lookAt(frustum.lookAt[0], frustum.lookAt[1], frustum.lookAt[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
}

function blitToCanvas(renderer, target, canvas) {
    const width = target.width;
    const height = target.height;
    const source = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, source);
    const context = canvas.getContext?.("2d", { willReadFrequently: true });
    if (!context?.createImageData || !context.putImageData) return false;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const image = context.createImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y += 1) {
        const srcOffset = (height - 1 - y) * row;
        image.data.set(source.subarray(srcOffset, srcOffset + row), y * row);
    }
    context.putImageData(image, 0, 0);
    return true;
}

export class MapSatelliteCapture {
    constructor({ maxSize = MAP_SATELLITE_MAX_SIZE } = {}) {
        this.maxSize = Math.max(1, Math.trunc(Number(maxSize) || MAP_SATELLITE_MAX_SIZE));
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
        this.target = null;
    }

    _ensureTarget(width, height) {
        if (this.target && this.target.width === width && this.target.height === height) return this.target;
        this.target?.dispose?.();
        this.target = new THREE.WebGLRenderTarget(width, height, {
            depthBuffer: true,
            stencilBuffer: false,
        });
        return this.target;
    }

    capture({ renderer, scene, registry = null, viewport, size, canvas, tilesHost = null } = {}) {
        if (!renderer?.render || !scene || !canvas) return null;
        const cssWidth = Number(size?.width) || 0;
        const cssHeight = Number(size?.height) || 0;
        if (!(cssWidth > 0) || !(cssHeight > 0)) return null;

        const pixels = satelliteRenderSize(cssWidth, cssHeight, this.maxSize);
        const target = this._ensureTarget(pixels.width, pixels.height);
        applyFrustum(this.camera, mapSatelliteFrustum(viewport, size, {
            elevation: sceneCaptureElevation(scene, registry),
        }));

        const hidden = collectMapSatelliteHideRoots(scene, registry).map((object) => ({
            object,
            visible: object.visible !== false,
        }));
        const clearColor = new THREE.Color();
        renderer.getClearColor?.(clearColor);
        const tilesWereVisible = tilesHost ? tilesHost.visible !== false : null;
        const previousTilesCamera = tilesHost?.active?.session?.camera
            ?? tilesHost?.camera
            ?? null;
        const viewportState = new THREE.Vector4();
        renderer.getViewport?.(viewportState);
        const snapshot = {
            target: renderer.getRenderTarget?.() ?? null,
            clearColor: clearColor.clone(),
            clearAlpha: renderer.getClearAlpha?.() ?? 1,
            autoClear: renderer.autoClear,
            shadowEnabled: renderer.shadowMap?.enabled,
            background: scene.background,
            viewport: viewportState,
        };

        try {
            for (const entry of hidden) entry.object.visible = false;
            if (tilesHost && tilesWereVisible === false) tilesHost.setVisible?.(true);
            tilesHost?.update?.(this.camera, { width: pixels.width, height: pixels.height });
            if (renderer.shadowMap) renderer.shadowMap.enabled = false;
            scene.background = new THREE.Color(MAP_SATELLITE_CLEAR_COLOR);
            renderer.autoClear = true;
            renderer.setClearColor?.(MAP_SATELLITE_CLEAR_COLOR, 1);
            renderer.setRenderTarget?.(target);
            // Do not call setViewport here. Three.js multiplies that API by
            // devicePixelRatio, which crops a render-target whose size is already
            // in drawing-buffer pixels. setRenderTarget copies the target viewport.
            renderer.render(scene, this.camera);
            if (!blitToCanvas(renderer, target, canvas)) return null;
            return {
                viewport: {
                    centerX: Number(viewport?.centerX) || 0,
                    centerZ: Number(viewport?.centerZ) || 0,
                    zoom: Number(viewport?.zoom) || 1,
                },
                size: { width: cssWidth, height: cssHeight },
                canvas,
            };
        } finally {
            for (const entry of hidden) entry.object.visible = entry.visible;
            if (tilesHost && previousTilesCamera && previousTilesCamera !== this.camera) {
                tilesHost.update?.(previousTilesCamera);
            }
            if (tilesHost && tilesWereVisible === false) tilesHost.setVisible?.(false);
            scene.background = snapshot.background;
            if (renderer.shadowMap && snapshot.shadowEnabled !== undefined) {
                renderer.shadowMap.enabled = snapshot.shadowEnabled;
            }
            if (snapshot.autoClear !== undefined) renderer.autoClear = snapshot.autoClear;
            renderer.setClearColor?.(snapshot.clearColor, snapshot.clearAlpha);
            renderer.setRenderTarget?.(snapshot.target);
            renderer.setViewport?.(snapshot.viewport);
        }
    }

    dispose() {
        this.target?.dispose?.();
        this.target = null;
    }
}
