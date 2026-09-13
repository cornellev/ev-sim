import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer/three";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { ReorientationPlugin } from "3d-tiles-renderer/three/plugins";
import { GoogleEarthTilesService } from "./GoogleEarthTilesService.js";
import { DEFAULT_EARTH_IMPORT_CONFIG } from "./EarthImportConfig.js";
import { ecefToLocalMatrix } from "./GeoFrame.js";
import { TileAoiPlugin } from "./TileAoiPlugin.js";

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

function configureTilesCache(tilesRenderer, quality = {}) {
    const maxSize = Math.max(1, Math.trunc(Number(quality.maxCachedTiles) || DEFAULT_EARTH_IMPORT_CONFIG.cacheSize));
    const minSize = Math.min(
        maxSize,
        Math.max(0, DEFAULT_EARTH_IMPORT_CONFIG.cacheMinSize),
    );

    tilesRenderer.lruCache.minSize = minSize;
    tilesRenderer.lruCache.maxSize = maxSize;
    const maxBytes = Math.max(1, Math.trunc(Number(quality.maxCacheBytes) || DEFAULT_EARTH_IMPORT_CONFIG.maxCacheBytes));
    tilesRenderer.lruCache.minBytesSize = Math.min(maxBytes, DEFAULT_EARTH_IMPORT_CONFIG.minCacheBytes);
    tilesRenderer.lruCache.maxBytesSize = maxBytes;
    return { maxSize, maxBytes };
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
        this.currentSource = null;
        this.cacheLimits = { maxSize: DEFAULT_EARTH_IMPORT_CONFIG.cacheSize, maxBytes: DEFAULT_EARTH_IMPORT_CONFIG.maxCacheBytes };
        this.diagnostics = { effectiveScreenSpaceError: this.maxScreenSpaceError, residentCount: 0, residentBytes: 0, degraded: false };
    }

    /**
     * @param {{ lat: number, lng: number, maxScreenSpaceError?: number }} config
     */
    async load(config) {
        this.disposeTiles();
        this.anchor = { lat: config.lat, lng: config.lng };
        this.currentSource = config.source ? structuredClone(config.source) : null;
        this.maxScreenSpaceError = config.maxScreenSpaceError ?? this.maxScreenSpaceError;
        this.status = "loading";
        this.error = null;

        if (config.signal?.aborted) throw Object.assign(new Error("Google Earth tile loading was cancelled."), { name: "AbortError" });
        const validation = await this.tileService.validateAccess({ signal: config.signal });
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

        if (config.geoFrame) {
            if (config.bounds) tilesRenderer.registerPlugin(new TileAoiPlugin(config.bounds));
        } else {
            const latRad = THREE.MathUtils.degToRad(config.lat);
            const lonRad = THREE.MathUtils.degToRad(config.lng);
            tilesRenderer.registerPlugin(new ReorientationPlugin({ lat: latRad, lon: lonRad, height: 0, recenter: true }));
        }

        tilesRenderer.errorTarget = this.maxScreenSpaceError;
        tilesRenderer.maxDepth = DEFAULT_EARTH_IMPORT_CONFIG.maxTileDepth;
        this.cacheLimits = configureTilesCache(tilesRenderer, config.source?.quality);
        tilesRenderer.loadAncestors = true;
        tilesRenderer.loadSiblings = false;

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
            const handleAbort = () => rejectRootReady(Object.assign(new Error("Google Earth tile loading was cancelled."), { name: "AbortError" }));
            cleanup = () => {
                tilesRenderer.removeEventListener("load-root-tileset", handleRootReady);
                tilesRenderer.removeEventListener("load-error", handleLoadError);
                config.signal?.removeEventListener?.("abort", handleAbort);
                if (this.pendingRootLoadCleanup === cleanup) {
                    this.pendingRootLoadCleanup = null;
                    this.pendingRootLoadReject = null;
                }
            };

            this.pendingRootLoadCleanup = cleanup;
            this.pendingRootLoadReject = rejectRootReady;
            tilesRenderer.addEventListener("load-root-tileset", handleRootReady);
            tilesRenderer.addEventListener("load-error", handleLoadError);
            config.signal?.addEventListener?.("abort", handleAbort, { once: true });
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
        if (config.geoFrame) {
            this.group.matrixAutoUpdate = false;
            this.group.matrix.fromArray(ecefToLocalMatrix(config.geoFrame));
            this.group.matrixWorldNeedsUpdate = true;
        }
        this.group.visible = this.visible;

        this.update(this.camera);
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

    setCacheLimits(quality = {}) {
        if (this.tilesRenderer) this.cacheLimits = configureTilesCache(this.tilesRenderer, quality);
    }

    getAttributions() {
        return this.attributions.map((entry) => ({ ...entry }));
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

    update(camera = this.camera, viewport = null) {
        if (!this.tilesRenderer || !this.camera || !this.renderer) return;
        if (this.isUpdating) return;

        this.isUpdating = true;
        try {
            if (camera && camera !== this.camera) {
                this.tilesRenderer.deleteCamera?.(this.camera);
                this.camera = camera;
            }
            this.camera.updateProjectionMatrix?.();
            this.camera.updateMatrixWorld?.(true);
            this.group?.updateMatrixWorld?.(true);
            this.tilesRenderer.setCamera(this.camera);
            const width = Number(viewport?.width);
            const height = Number(viewport?.height);
            if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 && this.tilesRenderer.setResolution) {
                this.tilesRenderer.setResolution(this.camera, width, height);
            } else {
                this.tilesRenderer.setResolutionFromRenderer(this.camera, this.renderer);
            }
            this.tilesRenderer.update();
            const cache = this.tilesRenderer.lruCache;
            const residentCount = Number(cache?.itemList?.length ?? cache?.itemSet?.size ?? 0);
            const residentBytes = Number(cache?.bytesSize ?? cache?.cachedBytes ?? 0);
            const pressured = residentCount > this.cacheLimits.maxSize || residentBytes > this.cacheLimits.maxBytes;
            const currentErrorTarget = Number.isFinite(this.tilesRenderer.errorTarget)
                ? this.tilesRenderer.errorTarget
                : this.maxScreenSpaceError;
            if (pressured) {
                this.tilesRenderer.errorTarget = Math.min(this.maxScreenSpaceError * 4, Math.max(this.maxScreenSpaceError + 1, currentErrorTarget * 1.25));
            } else if (currentErrorTarget > this.maxScreenSpaceError) {
                this.tilesRenderer.errorTarget = Math.max(this.maxScreenSpaceError, currentErrorTarget * 0.9);
            } else {
                this.tilesRenderer.errorTarget = currentErrorTarget;
            }
            this.diagnostics = {
                effectiveScreenSpaceError: this.tilesRenderer.errorTarget,
                residentCount,
                residentBytes,
                degraded: this.tilesRenderer.errorTarget > this.maxScreenSpaceError || Boolean(this.error),
                status: this.status,
                error: this.error,
            };
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
