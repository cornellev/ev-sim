import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer/three";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { ReorientationPlugin } from "3d-tiles-renderer/three/plugins";
import { GoogleEarthTilesService } from "./GoogleEarthTilesService.js";
import { DEFAULT_EARTH_IMPORT_CONFIG } from "./EarthImportConfig.js";

const EARTH_TILE_OBJECT_FLAGS = Object.freeze({
    skipEnvironmentSelection: true,
    bakeIgnore: true,
    earthImportLayer: true,
});

function tagEarthTileObject(object) {
    if (!object) return;
    Object.assign(object.userData, EARTH_TILE_OBJECT_FLAGS);
    object.traverse?.((child) => {
        Object.assign(child.userData, EARTH_TILE_OBJECT_FLAGS);
    });
}

function normalizeAttributionEntry(entry) {
    if (typeof entry === "string") {
        return entry.length > 0 ? { type: "string", value: entry } : null;
    }

    if (entry?.type === "image" && entry.value) {
        return { type: "image", value: entry.value, alt: entry.alt ?? "Google" };
    }

    const value = entry?.value ?? (entry == null ? "" : String(entry));
    return value ? { type: "string", value } : null;
}

function configureTilesCache(tilesRenderer) {
    const maxSize = Math.max(1, DEFAULT_EARTH_IMPORT_CONFIG.cacheSize);
    const minSize = Math.min(
        maxSize,
        Math.max(0, DEFAULT_EARTH_IMPORT_CONFIG.cacheMinSize),
    );

    tilesRenderer.lruCache.minSize = minSize;
    tilesRenderer.lruCache.maxSize = maxSize;
    tilesRenderer.lruCache.minBytesSize = DEFAULT_EARTH_IMPORT_CONFIG.minCacheBytes;
    tilesRenderer.lruCache.maxBytesSize = DEFAULT_EARTH_IMPORT_CONFIG.maxCacheBytes;
}

function createDefaultTilesRenderer(rootUrl) {
    return new TilesRenderer(rootUrl);
}

/**
 * Streams Google Photorealistic 3D Tiles into the scene.
 */
export class EarthTilesManager {
    /**
     * @param {Object} options
     * @param {THREE.Scene} options.scene
     * @param {THREE.Camera} options.camera
     * @param {THREE.WebGLRenderer} options.renderer
     * @param {() => void} [options.invalidate]
     * @param {GoogleEarthTilesService} [options.tileService]
     * @param {(rootUrl: string) => TilesRenderer} [options.createTilesRenderer]
     */
    constructor({
        scene,
        camera,
        renderer,
        invalidate,
        tileService = new GoogleEarthTilesService(),
        createTilesRenderer = createDefaultTilesRenderer,
    }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.invalidate = typeof invalidate === "function" ? invalidate : () => {};
        this.tileService = tileService;
        this.createTilesRenderer = createTilesRenderer;
        this.tilesRenderer = null;
        this.group = null;
        this.anchor = { lat: 0, lng: 0 };
        this.attributions = [];
        this.status = "idle";
        this.error = null;
        this.maxScreenSpaceError = DEFAULT_EARTH_IMPORT_CONFIG.maxScreenSpaceError;
        this.visible = true;
        this.isUpdating = false;
        this.invalidateHandle = null;
        this.pendingRootLoadCleanup = null;
        this.pendingRootLoadReject = null;
    }

    /**
     * @param {{ lat: number, lng: number, maxScreenSpaceError?: number }} config
     */
    async load(config) {
        this.disposeTiles();
        this.anchor = { lat: config.lat, lng: config.lng };
        this.maxScreenSpaceError = config.maxScreenSpaceError ?? this.maxScreenSpaceError;
        this.status = "loading";
        this.error = null;

        const validation = await this.tileService.validateAccess();
        if (!validation.ok) {
            this.status = "error";
            this.error = validation.error;
            throw new Error(validation.error);
        }

        const { session } = validation;
        const tilesRenderer = this.createTilesRenderer(session.rootUrl);
        tilesRenderer.registerPlugin(new GoogleCloudAuthPlugin({
            apiToken: session.apiKey,
            autoRefreshToken: true,
            logoUrl: DEFAULT_EARTH_IMPORT_CONFIG.googleAttributionLogoUrl,
            useRecommendedSettings: false,
        }));

        const latRad = THREE.MathUtils.degToRad(config.lat);
        const lonRad = THREE.MathUtils.degToRad(config.lng);
        tilesRenderer.registerPlugin(new ReorientationPlugin({
            lat: latRad,
            lon: lonRad,
            height: 0,
            recenter: true,
        }));

        tilesRenderer.errorTarget = this.maxScreenSpaceError;
        tilesRenderer.maxDepth = DEFAULT_EARTH_IMPORT_CONFIG.maxTileDepth;
        configureTilesCache(tilesRenderer);

        tilesRenderer.group.name = "GoogleEarthTiles";
        tagEarthTileObject(tilesRenderer.group);

        const rootReady = new Promise((resolve, reject) => {
            let cleanup = () => {};
            const resolveRootReady = () => {
                cleanup();
                resolve();
            };
            const rejectRootReady = (error) => {
                cleanup();
                reject(error);
            };
            const handleRootReady = () => {
                resolveRootReady();
            };
            const handleLoadError = (event) => {
                if (event.tile) return;
                rejectRootReady(event.error instanceof Error
                    ? event.error
                    : new Error("Google Earth root tileset failed to load."));
            };
            cleanup = () => {
                tilesRenderer.removeEventListener("load-root-tileset", handleRootReady);
                tilesRenderer.removeEventListener("load-error", handleLoadError);
                if (this.pendingRootLoadCleanup === cleanup) {
                    this.pendingRootLoadCleanup = null;
                    this.pendingRootLoadReject = null;
                }
            };

            this.pendingRootLoadCleanup = cleanup;
            this.pendingRootLoadReject = rejectRootReady;
            tilesRenderer.addEventListener("load-root-tileset", handleRootReady);
            tilesRenderer.addEventListener("load-error", handleLoadError);
        });

        tilesRenderer.addEventListener("load-root-tileset", () => {
            this.status = "ready";
            this.requestRender();
        });

        tilesRenderer.addEventListener("load-model", ({ scene }) => {
            tagEarthTileObject(scene);
            this.requestRender();
        });

        tilesRenderer.addEventListener("tile-visibility-change", () => {
            this.collectAttributions();
            this.requestRender();
        });

        tilesRenderer.addEventListener("dispose-tile", () => {
            this.collectAttributions();
        });

        tilesRenderer.addEventListener("load-error", (event) => {
            const message = event.error instanceof Error
                ? event.error.message
                : "Google Earth tile failed to load.";
            this.error = message;
            if (!event.tile) {
                this.status = "error";
            }
            console.warn("Google Earth tile load error:", event.url ?? event.tile?.content?.uri, message);
        });

        this.scene.add(tilesRenderer.group);
        this.tilesRenderer = tilesRenderer;
        this.group = tilesRenderer.group;
        this.group.visible = this.visible;

        this.positionCameraForAnchor(config.lat, config.lng);
        this.update();
        await rootReady;
        return this;
    }

    collectAttributions() {
        if (!this.tilesRenderer) {
            this.attributions = [];
            return;
        }

        const credits = this.tilesRenderer.getAttributions?.() ?? [];
        this.attributions = Array.isArray(credits)
            ? credits.map(normalizeAttributionEntry).filter(Boolean)
            : [];
    }

  /**
   * Position orbit camera above anchor in local tile space.
   * @param {number} lat
   * @param {number} lng
   */
    positionCameraForAnchor(lat, lng) {
        if (!this.camera) return;

        const altitude = 250;
        this.camera.position.set(0, altitude, altitude * 0.6);
        this.camera.lookAt(0, 0, 0);
        this.camera.updateProjectionMatrix();
        this.requestRender();
    }

    setVisible(visible) {
        this.visible = Boolean(visible);
        if (this.group) {
            this.group.visible = this.visible;
        }
        this.requestRender();
    }

    setMaxScreenSpaceError(value) {
        this.maxScreenSpaceError = Math.max(1, Number(value) || DEFAULT_EARTH_IMPORT_CONFIG.maxScreenSpaceError);
        if (this.tilesRenderer) {
            this.tilesRenderer.errorTarget = this.maxScreenSpaceError;
            this.tilesRenderer.resetFailedTiles?.();
        }
        this.requestRender();
    }

    requestRender() {
        if (this.invalidateHandle != null) return;

        const schedule = typeof globalThis.requestAnimationFrame === "function"
            ? globalThis.requestAnimationFrame.bind(globalThis)
            : (callback) => setTimeout(callback, 0);

        this.invalidateHandle = schedule(() => {
            this.invalidateHandle = null;
            this.invalidate();
        });
    }

    update() {
        if (!this.tilesRenderer || !this.camera || !this.renderer) return;
        if (this.isUpdating) return;

        this.isUpdating = true;
        try {
            this.tilesRenderer.setCamera(this.camera);
            this.tilesRenderer.setResolutionFromRenderer(this.camera, this.renderer);
            this.tilesRenderer.update();
        } finally {
            this.isUpdating = false;
        }
    }

    disposeTiles() {
        if (this.invalidateHandle != null) {
            const cancel = typeof globalThis.cancelAnimationFrame === "function"
                ? globalThis.cancelAnimationFrame.bind(globalThis)
                : clearTimeout;
            cancel(this.invalidateHandle);
            this.invalidateHandle = null;
        }

        if (this.pendingRootLoadReject) {
            this.pendingRootLoadReject(new Error("Google Earth tile loading was cancelled."));
        } else {
            this.pendingRootLoadCleanup?.();
        }

        if (this.tilesRenderer) {
            this.scene?.remove?.(this.tilesRenderer.group);
            this.tilesRenderer.dispose();
            this.tilesRenderer = null;
            this.group = null;
        }
        this.attributions = [];
        this.status = "idle";
        this.error = null;
    }

    dispose() {
        this.disposeTiles();
        this.scene = null;
        this.camera = null;
        this.renderer = null;
    }
}

export { EARTH_TILE_OBJECT_FLAGS };
