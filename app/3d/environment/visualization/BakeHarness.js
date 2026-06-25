import * as THREE from "three";
import { BakeView } from "./BakeView";
import { BakePath } from "./BakePath";
import { buildSampleId, resolveViewPasses } from "./BakePass";
import {
    BuildingRegionPlanner,
    resolvePassesForSample,
} from "./BuildingRegionPlanner";
import { getRawBeautyImage, pollBakedImage } from "./BakeRoundTrip";
import {
    filterForSplatting,
    hitsToWorldPoints,
    worldToPixel,
} from "./LidarSplatProjector";
import {
    buildCenterSliverBounds,
    composeImageThroughMask,
    countMaskPixelsInSliver,
    maskAllowsPixel,
    pixelInSliver,
} from "./BakeImageMask";
import {
    checkBakeServerHealth,
    clearBakeServer,
    rgbaToPngBlob,
    uploadBakeBinary,
    uploadBakeFrame,
    uploadRunManifest,
    uploadSampleComplete,
} from "./bakeUpload";
import {
    applyBakeTelemetryPatch,
    calculateBakeTotalSamples,
    createBakeTelemetrySnapshot,
    markBakeErrored,
    markBakeStopped,
} from "./BakeTelemetry";

function countBy(items, getKey) {
    const counts = {};
    for (const item of items || []) {
        const key = getKey(item) ?? "missing";
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

function countOpaqueWhitePixels(rgba) {
    let count = 0;
    for (let i = 0; i < (rgba?.length ?? 0); i += 4) {
        if (rgba[i + 3] > 0 && rgba[i] > 0) count += 1;
    }
    return count;
}

function summarizePoints(points, limit = 6) {
    return (points || []).slice(0, limit).map((point) => ({
        tagName: point.tagName,
        tagId: point.tagId,
        distance: Number(point.distance?.toFixed?.(3) ?? point.distance),
        world: point.world ? {
            x: Number(point.world.x.toFixed(3)),
            y: Number(point.world.y.toFixed(3)),
            z: Number(point.world.z.toFixed(3)),
        } : null,
    }));
}

function round(value, digits = 2) {
    if (!Number.isFinite(value)) return value;
    return Number(value.toFixed(digits));
}

function summarizeImage(image, extra = {}) {
    if (!image?.data) return null;
    return {
        data: image.data,
        width: image.width,
        height: image.height,
        colorSpace: image.colorSpace ?? "linear",
        source: image.source ?? "raw",
        passId: image.passId ?? extra.passId ?? null,
        sampleId: extra.sampleId ?? null,
        viewId: extra.viewId ?? null,
        updatedAt: Date.now(),
    };
}

function summarizeMask(maskImage, extra = {}) {
    if (!maskImage?.data) return null;
    const whitePixels = extra.whitePixels ?? countOpaqueWhitePixels(maskImage.data);
    const totalPixels = Math.max(1, (maskImage.width ?? 0) * (maskImage.height ?? 0));

    return {
        data: maskImage.data,
        width: maskImage.width,
        height: maskImage.height,
        passId: maskImage.passId ?? null,
        buildingId: maskImage.buildingId ?? null,
        activeBuildingId: extra.activeBuildingId ?? maskImage.buildingId ?? null,
        visibleBuildingIds: extra.visibleBuildingIds ?? [],
        hasVisibleBuilding: extra.hasVisibleBuilding ?? null,
        processTag: maskImage.processTag ?? null,
        includeTags: maskImage.includeTags ?? [],
        excludeTags: maskImage.excludeTags ?? [],
        maskTags: maskImage.maskTags ?? [],
        whitePixels,
        totalPixels,
        coverage: round(whitePixels / totalPixels, 4),
        sliverPixels: extra.sliverPixels ?? null,
        sliverBounds: extra.sliverBounds ?? null,
        updatedAt: Date.now(),
    };
}

function summarizeLidarFrame(lidarFrame, extra = {}) {
    if (!lidarFrame) return null;
    const rawHits = lidarFrame.hits ?? [];
    const hitHits = rawHits.filter((hit) => hit?.hit);

    return {
        width: lidarFrame.width ?? 0,
        height: lidarFrame.height ?? 0,
        range: lidarFrame.range ?? 0,
        thetaRange: lidarFrame.thetaRange ?? null,
        phiRange: lidarFrame.phiRange ?? null,
        thetaStep: lidarFrame.thetaStep ?? null,
        phiStep: lidarFrame.phiStep ?? null,
        hitCount: hitHits.length,
        totalRays: rawHits.length,
        tagCounts: countBy(hitHits, (hit) => hit.tagName),
        kindCounts: countBy(hitHits, (hit) => hit.objectKind),
        worldPointCount: extra.worldPointCount ?? null,
        filteredCount: extra.filteredCount ?? null,
        updateCandidateCount: extra.updateCandidateCount ?? null,
        sampleFilteredPoints: extra.sampleFilteredPoints ?? [],
        updatedAt: Date.now(),
    };
}

function imageFromPass(pass) {
    if (!pass?.data) return null;
    return {
        data: pass.data,
        width: pass.width,
        height: pass.height,
        passId: pass.passId,
        includeTags: pass.includeTags ?? [],
        excludeTags: pass.excludeTags ?? [],
        maskTags: pass.maskTags ?? [],
        buildingId: pass.buildingId ?? null,
        processTag: pass.processTag ?? null,
        modelSeedKey: pass.modelSeedKey ?? null,
    };
}

function deriveModelSeed(runId, frameIndex, seedKey = "") {
    const input = `${runId}:${frameIndex}:${seedKey}`;
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function pointsInUpdateRegion(points, intrinsics, matrixWorld, processMaskImage, sliverBounds) {
    const candidates = [];
    for (const point of points) {
        const pixel = worldToPixel(point.world, intrinsics, matrixWorld);
        if (!pixel) continue;
        if (!pixelInSliver(pixel.px, sliverBounds)) continue;
        if (!maskAllowsPixel(processMaskImage, pixel.px, pixel.py)) continue;
        candidates.push(point);
    }
    return candidates;
}

/**
 * Orchestrates BakeView cameras along BakePaths, uploads captures, and
 * incrementally builds Gaussian splats from sequential frames.
 */
export class BakeHarness {
    /**
     * @param {import("../../data/Data").Data} data
     * @param {Object} [options]
     */
    constructor(data, options = {}) {
        this.data = data;
        this.runId = options.runId || `bake-${options.seed ?? 42}`;
        this.deltaDistance = options.deltaDistance ?? 1.0;
        this.passPolicy = options.passPolicy ?? {
            beautyAlways: true,
            activeBuildingMask: true,
            contextMask: false,
            skipEmptyMasks: true,
        };
        this.maskMinPixels = options.maskMinPixels ?? 64;
        this.manifest = options.manifest ?? null;
        this.roundTrip = options.roundTrip ?? {
            useModel: false,
            pollIntervalMs: 1000,
            timeoutMs: 180000,
            resultEndpoint: "/bake/result",
        };
        this.debug = {
            saveRawCaptures: false,
            logPipeline: false,
            buildingTileMaterials: false,
            buildingTileSize: 2,
            ...options.debug,
        };
        const defaultSplatConfig = {
            enabled: true,
            excludeTags: ["road"],
            bandNear: 0,
            bandFar: 15,
            maxSplatDistance: 60,
            maxPointsPerFrame: 20000,
            coverageVoxelSize: 0.25,
            coverageNeighbor: true,
            updateSliver: {
                enabled: true,
                widthPx: 320,
                minMaskPixels: 1,
                requireBuildingHit: true,
            },
            radius: 0.06,
            adaptiveRadius: true,
            hideBakedGeometry: false,
            hideThreshold: 50,
        };
        this.splatConfig = {
            ...defaultSplatConfig,
            ...options.splat,
            updateSliver: {
                ...defaultSplatConfig.updateSliver,
                ...(options.splat?.updateSliver ?? {}),
            },
        };

        this.server = {
            host: options.host ?? "http://localhost:8000",
            endpoint: options.endpoint ?? "/bake",
        };

        this.telemetryListeners = new Set();
        this._telemetrySnapshot = createBakeTelemetrySnapshot({
            runId: this.runId,
            server: {
                host: this.server.host,
                endpoint: this.server.endpoint,
                useModel: this.roundTrip.useModel === true,
            },
        });

        this.viewConfigs = options.views ?? [
            {
                name: "bake/view/left",
                position: new THREE.Vector3(0, 1.5, 0),
                rotation: new THREE.Euler(0, 0, 0),
                includeTags: [],
                excludeTags: [],
            },
        ];

        this.position = new THREE.Vector3(0, 0, 0);
        this.rotation = new THREE.Euler(0, 0, 0);

        /** @type {BakePath[]} */
        this.paths = [];
        this.views = [];

        this.activePathIndex = 0;
        this.nextSampleDistance = 0;
        this.frameIndex = 0;
        this.running = false;
        this.completed = false;
        this.processingSample = false;
        this.regionPlanner = new BuildingRegionPlanner(this.manifest?.buildings ?? []);
        this.manualAdvance = false;
        this._pendingManualSamples = 0;

        this._setupComplete = false;
        this._manifestUploaded = false;
    }

    getSnapshot() {
        return {
            ...this._telemetrySnapshot,
            server: { ...this._telemetrySnapshot.server },
            recentEvents: [...(this._telemetrySnapshot.recentEvents ?? [])],
            warnings: [...(this._telemetrySnapshot.warnings ?? [])],
        };
    }

    subscribe(listener) {
        this.telemetryListeners.add(listener);
        listener(this.getSnapshot());
        return () => {
            this.telemetryListeners.delete(listener);
        };
    }

    _emitTelemetry() {
        const snapshot = this.getSnapshot();
        for (const listener of this.telemetryListeners) {
            listener(snapshot);
        }
    }

    _totalSamples() {
        return calculateBakeTotalSamples(this.paths, this.deltaDistance);
    }

    _updateTelemetry(patch = {}, event = null) {
        this._telemetrySnapshot = applyBakeTelemetryPatch(
            this._telemetrySnapshot,
            patch,
            event,
        );
        this._emitTelemetry();
    }

    _controlSnapshot() {
        return {
            manualAdvance: this.manualAdvance,
            pendingManualSamples: this._pendingManualSamples,
        };
    }

    _nextPhotoSnapshot() {
        const path = this.paths[this.activePathIndex];
        return {
            nextFrameIndex: this.frameIndex,
            nextSampleId: this.completed || !path ? null : buildSampleId(this.runId, this.frameIndex),
            nextDistance: path ? this.nextSampleDistance : null,
        };
    }

    setManualAdvance(enabled) {
        this.manualAdvance = Boolean(enabled);
        if (!this.manualAdvance) {
            this._pendingManualSamples = 0;
        }

        this._updateTelemetry(
            {
                control: this._controlSnapshot(),
                ...this._nextPhotoSnapshot(),
            },
            {
                type: "control",
                severity: "info",
                message: this.manualAdvance ? "Manual photo advance enabled" : "Automatic bake advance enabled",
            },
        );
    }

    requestNextPhoto() {
        this.manualAdvance = true;
        this._pendingManualSamples += 1;
        this._updateTelemetry(
            {
                stage: this.running ? "Next photo queued" : "Waiting to start",
                control: this._controlSnapshot(),
                ...this._nextPhotoSnapshot(),
            },
            {
                type: "control",
                severity: "info",
                message: "Next photo queued",
            },
        );
    }

    /**
     * @param {THREE.Scene} scene
     */
    setup(scene) {
        if (this._setupComplete) return;

        for (const viewConfig of this.viewConfigs) {
            const localPosition = viewConfig.position.clone();
            const localRotation = viewConfig.rotation.clone();

            const view = new BakeView(viewConfig.name, {
                position: localPosition,
                rotation: localRotation,
                camera: viewConfig.camera,
                lidar: viewConfig.lidar,
                channels: viewConfig.channels,
                includeTags: viewConfig.includeTags ?? [],
                excludeTags: viewConfig.excludeTags ?? [],
                maxFramesPerChannel: viewConfig.maxFramesPerChannel ?? 240,
            });

            view._localOffset = {
                position: localPosition.clone(),
                rotation: localRotation.clone(),
            };
            view._defaultPasses = resolveViewPasses(viewConfig.passes);

            this.views.push(view);
            view.setup({
                scene,
                renderer: this.data.renderer,
                data: this.data,
            });
        }

        this._setupComplete = true;
    }

    /**
     * @param {BakePath} path
     * @returns {this}
     */
    addPath(path) {
        this.paths.push(path);
        this._updateTelemetry({
            totalPaths: this.paths.length,
            totalSamples: this._totalSamples(),
        });
        return this;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async checkServer() {
        return checkBakeServerHealth(this.server);
    }

    async start() {
        const startedAt = Date.now();
        this._telemetrySnapshot = createBakeTelemetrySnapshot({
            runId: this.runId,
            startedAt,
            status: "preparing",
            stage: "Preparing bake",
            server: {
                host: this.server.host,
                endpoint: this.server.endpoint,
                useModel: this.roundTrip.useModel === true,
            },
            now: startedAt,
        });
        this._updateTelemetry(
            {
                totalPaths: this.paths.length,
                totalSamples: this._totalSamples(),
                completedSamples: 0,
            },
            {
                type: "preparing",
                severity: "info",
                message: "Preparing bake run",
            },
        );

        const healthy = await this.checkServer();
        this._updateTelemetry(
            {
                stage: healthy ? "Clearing bake server" : "Bake server unreachable",
                server: { healthy },
            },
            healthy
                ? {
                    type: "server",
                    severity: "info",
                    message: "Bake server reachable",
                }
                : {
                    type: "server",
                    severity: "warning",
                    message: "Bake server is not reachable",
                    detail: this.server.host,
                },
        );
        if (!healthy) {
            console.warn("Bake server is not reachable at", this.server.host);
        }

        const clear = await clearBakeServer(this.server);

        if (clear) {
            console.log("Bake server cleared successfully.");
            this._updateTelemetry(
                { stage: "Bake server cleared" },
                {
                    type: "server-cleared",
                    severity: "info",
                    message: "Bake server cleared",
                },
            );
        } else {
            this._updateTelemetry(
                { stage: "Continuing with uncleared server" },
                {
                    type: "server-clear",
                    severity: "warning",
                    message: "Unable to clear bake server",
                },
            );
        }

        if (this.manifest && !this._manifestUploaded) {
            this._updateTelemetry({ stage: "Uploading manifest" });
            const ok = await uploadRunManifest(this.server, this.manifest);
            if (ok) {
                this._manifestUploaded = true;
                this._updateTelemetry(
                    { stage: "Manifest uploaded" },
                    {
                        type: "manifest",
                        severity: "info",
                        message: "Bake manifest uploaded",
                    },
                );
            } else {
                this._updateTelemetry(
                    { stage: "Manifest upload failed" },
                    {
                        type: "manifest",
                        severity: "warning",
                        message: "Bake manifest upload failed",
                    },
                );
            }
        }

        this.running = true;
        this.completed = false;
        this.processingSample = false;
        this.activePathIndex = 0;
        this.nextSampleDistance = 0;
        this.frameIndex = 0;
        this.manualAdvance = true;
        this._pendingManualSamples = 0;
        this.regionPlanner = new BuildingRegionPlanner(this.manifest?.buildings ?? []);

        this.data.splats?.()?.reset?.();

        this._updateTelemetry(
            {
                status: "running",
                stage: "Manual advance ready",
                activePathIndex: this.activePathIndex,
                frameIndex: this.frameIndex,
                sampleId: null,
                currentFrameIndex: null,
                currentSampleId: null,
                totalPaths: this.paths.length,
                totalSamples: this._totalSamples(),
                completedSamples: 0,
                ...this._nextPhotoSnapshot(),
                server: {
                    healthy,
                    awaitingModel: false,
                    useModel: this.roundTrip.useModel === true,
                },
                control: this._controlSnapshot(),
            },
            {
                type: "started",
                severity: "info",
                message: "Bake run started in manual advance",
            },
        );
    }

    stop() {
        this.running = false;
        this.processingSample = false;
        this._telemetrySnapshot = markBakeStopped(this._telemetrySnapshot);
        this._emitTelemetry();
    }

    /**
     * Called by the simulation loop, but intentionally not time-based. Each
     * invocation starts at most one capture/upload. The next path point is not
     * processed until the current sample has been fully handled.
     */
    update() {
        if (!this.running || this.completed || this.processingSample) return;
        if (this.manualAdvance) {
            if (this._pendingManualSamples <= 0) return;
            this._pendingManualSamples -= 1;
            this._updateTelemetry({
                control: this._controlSnapshot(),
                ...this._nextPhotoSnapshot(),
            });
        }
        this._processNextSample();
    }

    async _processNextSample() {
        this.processingSample = true;
        try {
            const path = this.paths[this.activePathIndex];
            if (!path || path.vertices.length === 0) {
                this._advancePath();
                return;
            }

            if (this.nextSampleDistance > path.totalLength) {
                this._advancePath();
                return;
            }

            const sample = path.sampleAtDistance(this.nextSampleDistance);
            if (sample) {
                this._applySample(sample);
                await this._processSampleSequential(sample);
            }

            if (!this.running) return;

            const completedSamples = Math.min(this.frameIndex + 1, this._totalSamples());
            this._updateTelemetry(
                {
                    stage: "Sample complete",
                    completedSamples,
                    frameIndex: this.frameIndex,
                    currentFrameIndex: this.frameIndex,
                    currentSampleId: buildSampleId(this.runId, this.frameIndex),
                    activePathIndex: this.activePathIndex,
                },
                {
                    type: "sample-complete",
                    severity: "info",
                    message: `${buildSampleId(this.runId, this.frameIndex)} complete`,
                },
            );

            this.nextSampleDistance += this.deltaDistance;
            this.frameIndex += 1;
            this.regionPlanner.advance(this.frameIndex);

            if (this.nextSampleDistance > path.totalLength) {
                this._advancePath();
            } else {
                this._updateTelemetry({
                    stage: this.manualAdvance ? "Manual advance ready" : "Running",
                    frameIndex: this.frameIndex,
                    activePathIndex: this.activePathIndex,
                    ...this._nextPhotoSnapshot(),
                    control: this._controlSnapshot(),
                });
            }
        } catch (error) {
            console.warn("BakeHarness: sample processing failed", error);
            this.running = false;
            this.completed = false;
            this._telemetrySnapshot = markBakeErrored(this._telemetrySnapshot, error);
            this._emitTelemetry();
        } finally {
            this.processingSample = false;
        }
    }

    _advancePath() {
        this.activePathIndex += 1;

        if (this.activePathIndex >= this.paths.length) {
            this.completed = true;
            this.running = false;
            console.log("BakeHarness: All paths completed.");
            this._updateTelemetry(
                {
                    status: "complete",
                    stage: "Complete",
                    completedSamples: this._totalSamples(),
                    finishedAt: Date.now(),
                    nextFrameIndex: null,
                    nextSampleId: null,
                    nextDistance: null,
                    server: { awaitingModel: false },
                },
                {
                    type: "complete",
                    severity: "info",
                    message: "Bake run complete",
                },
            );
            return;
        }

        this.nextSampleDistance = 0;
        this._updateTelemetry(
            {
                stage: this.manualAdvance ? "Manual advance ready" : "Advancing path",
                activePathIndex: this.activePathIndex,
                ...this._nextPhotoSnapshot(),
                control: this._controlSnapshot(),
            },
            {
                type: "path",
                severity: "info",
                message: `Advancing to path ${this.activePathIndex + 1}`,
            },
        );
    }

    /**
     * @param {{ position: THREE.Vector3, rotation: THREE.Euler, distance: number, segmentIndex: number }} sample
     */
    _applySample(sample) {
        this.position.copy(sample.position);
        this.rotation.copy(sample.rotation);

        const harnessQuat = new THREE.Quaternion().setFromEuler(this.rotation);

        for (const view of this.views) {
            const offset = view._localOffset || {
                position: view.settings.position.clone(),
                rotation: view.settings.rotation.clone(),
            };

            const worldPosition = offset.position.clone()
                .applyQuaternion(harnessQuat)
                .add(this.position);

            const localQuat = new THREE.Quaternion().setFromEuler(offset.rotation);
            const worldQuat = harnessQuat.clone().multiply(localQuat);
            const worldRotation = new THREE.Euler().setFromQuaternion(worldQuat, "XYZ");

            view.setPose(worldPosition, worldRotation);
        }
    }

    /**
     * Sequential render -> (optional model round-trip) -> splat.
     *
     * With roundTrip.useModel === false this loop never touches the bake
     * server: each frame is rendered locally, projected from LiDAR, and
     * splatted immediately so the splat cloud visibly builds up sliver by
     * sliver. The server (and therefore the model) is only engaged when
     * useModel is explicitly enabled.
     * @param {{ distance: number, segmentIndex: number }} sample
     */
    async _processSampleSequential(sample) {
        const frameIndex = this.frameIndex;
        const pathIndex = this.activePathIndex;
        const sampleId = buildSampleId(this.runId, frameIndex);
        const accumulator = this.data.splats?.();
        const useModel = this.roundTrip.useModel === true;

        this._updateTelemetry(
            {
                status: "running",
                stage: "Capturing",
                activePathIndex: pathIndex,
                frameIndex,
                totalPaths: this.paths.length,
                totalSamples: this._totalSamples(),
                completedSamples: frameIndex,
                sampleId,
                currentFrameIndex: frameIndex,
                currentSampleId: sampleId,
                viewId: null,
                server: {
                    useModel,
                    awaitingModel: false,
                },
            },
            {
                type: "capture",
                severity: "info",
                message: `Capturing ${sampleId}`,
            },
        );

        for (const view of this.views) {
            const regionPlan = this.regionPlanner.planForView(
                this.data.scene,
                view.sensorCamera,
            );

            const viewSlug = view.name.replace(/\//g, "_");
            const metadata = {
                runId: this.runId,
                sampleId,
                pathIndex,
                distance: sample.distance,
                frameIndex,
                viewId: view.name,
                cameraId: view.name,
                segmentIndex: sample.segmentIndex,
                expectedFiles: 0,
                activeBuildingId: regionPlan.activeBuildingId ?? "",
                visibleBuildingIds: regionPlan.visibleBuildingIds.join(","),
            };

            this._updateTelemetry({
                stage: "Planning region",
                viewId: view.name,
                mask: {
                    ...(this._telemetrySnapshot.mask ?? {}),
                    activeBuildingId: regionPlan.activeBuildingId,
                    visibleBuildingIds: regionPlan.visibleBuildingIds,
                    hasVisibleBuilding: regionPlan.hasVisibleBuilding,
                    updatedAt: Date.now(),
                },
            });

            const passes = resolvePassesForSample(this.passPolicy, {
                activeBuildingId: regionPlan.activeBuildingId,
                hasVisibleBuilding: regionPlan.hasVisibleBuilding,
                visibleBuildingIds: regionPlan.visibleBuildingIds,
            });

            const capture = view.capturePasses(passes, metadata, {
                maskMinPixels: this.maskMinPixels,
                skipEmptyMasks: false,
                debug: this.debug,
            });
            if (!capture) {
                this._updateTelemetry(
                    {
                        stage: "Capture skipped",
                        viewId: view.name,
                    },
                    {
                        type: "capture",
                        severity: "warning",
                        message: `Capture skipped for ${view.name}`,
                    },
                );
                continue;
            }

            let bakedImage = getRawBeautyImage(capture);
            if (!bakedImage) {
                console.warn("BakeHarness: missing beauty pass for", sampleId);
                this._updateTelemetry(
                    {
                        stage: "Missing image",
                        viewId: view.name,
                    },
                    {
                        type: "capture",
                        severity: "warning",
                        message: "Missing beauty pass",
                        detail: sampleId,
                    },
                );
                continue;
            }

            const processMaskPass = capture.passes.find((pass) => pass.kind === "mask");
            const processMaskImage = imageFromPass(processMaskPass);
            const rawHits = capture.lidar?.hits ?? [];
            const hitHits = rawHits.filter((hit) => hit?.hit);
            this._updateTelemetry(
                {
                    stage: "Captured frame",
                    viewId: view.name,
                    lastImage: summarizeImage(bakedImage, {
                        sampleId,
                        viewId: view.name,
                        passId: "beauty",
                    }),
                    mask: summarizeMask(processMaskImage, {
                        activeBuildingId: regionPlan.activeBuildingId,
                        visibleBuildingIds: regionPlan.visibleBuildingIds,
                        hasVisibleBuilding: regionPlan.hasVisibleBuilding,
                    }),
                    lidar: summarizeLidarFrame(capture.lidar),
                },
                {
                    type: "capture",
                    severity: "info",
                    message: `Captured ${view.name}`,
                },
            );
            const captureDebugData = {
                sampleId,
                frameIndex,
                viewId: view.name,
                useModel,
                activeBuildingId: regionPlan.activeBuildingId,
                visibleBuildingIds: regionPlan.visibleBuildingIds,
                imageSourceBeforeModel: bakedImage.source,
                lidar: capture.lidar ? {
                    width: capture.lidar.width,
                    height: capture.lidar.height,
                    thetaRange: capture.lidar.thetaRange,
                    phiRange: capture.lidar.phiRange,
                    thetaStep: capture.lidar.thetaStep,
                    phiStep: capture.lidar.phiStep,
                    hitCount: hitHits.length,
                    tagCounts: countBy(hitHits, (hit) => hit.tagName),
                    kindCounts: countBy(hitHits, (hit) => hit.objectKind),
                } : null,
                splatConfig: {
                    excludeTags: this.splatConfig.excludeTags,
                    bandNear: this.splatConfig.bandNear,
                    bandFar: this.splatConfig.bandFar,
                    maxSplatDistance: this.splatConfig.maxSplatDistance,
                    updateSliver: this.splatConfig.updateSliver,
                },
                processMask: processMaskImage ? {
                    passId: processMaskImage.passId,
                    buildingId: processMaskImage.buildingId,
                    processTag: processMaskImage.processTag,
                    whitePixels: countOpaqueWhitePixels(processMaskImage.data),
                } : null,
            };
            if (this.debug.logPipeline === true) {
                console.log("BakeHarness: captured sample", captureDebugData);
            }

            if (this.debug.saveRawCaptures && !useModel) {
                await this._uploadRawCaptureDebug({
                    view,
                    viewSlug,
                    metadata,
                    bakedImage,
                });
            }

            if (useModel) {
                const modelImage = await this._roundTripModelImage({
                    view,
                    viewSlug,
                    capture,
                    metadata,
                    bakedImage,
                    processMask: processMaskImage,
                });
                if (modelImage && processMaskImage) {
                    bakedImage = composeImageThroughMask(bakedImage, modelImage, processMaskImage);
                    this._updateTelemetry(
                        {
                            stage: "Mask composition",
                            lastImage: summarizeImage(bakedImage, {
                                sampleId,
                                viewId: view.name,
                                passId: "beauty",
                            }),
                            server: { awaitingModel: false },
                        },
                        {
                            type: "mask-compose",
                            severity: "info",
                            message: "Model image composed through mask",
                        },
                    );
                } else if (modelImage) {
                    bakedImage = modelImage;
                    this._updateTelemetry({
                        stage: "Model image received",
                        lastImage: summarizeImage(bakedImage, {
                            sampleId,
                            viewId: view.name,
                            passId: "beauty",
                        }),
                        server: { awaitingModel: false },
                    });
                } else {
                    this._updateTelemetry(
                        {
                            stage: "Model unavailable",
                            server: { awaitingModel: false },
                        },
                        {
                            type: "model",
                            severity: "warning",
                            message: "Model result unavailable; skipping splat commit",
                            detail: sampleId,
                        },
                    );
                    continue;
                }
            }

            if (this.splatConfig.enabled && accumulator && capture.lidar) {
                if (!processMaskImage) {
                    console.warn("BakeHarness: missing process mask for", sampleId);
                    this._updateTelemetry(
                        {
                            stage: "Missing mask",
                            viewId: view.name,
                        },
                        {
                            type: "mask",
                            severity: "warning",
                            message: "Missing process mask",
                            detail: sampleId,
                        },
                    );
                    continue;
                }

                const sliverBounds = buildCenterSliverBounds(
                    bakedImage.width,
                    this.splatConfig.updateSliver,
                );
                const maskPixelsInSliver = countMaskPixelsInSliver(processMaskImage, sliverBounds);
                const minMaskPixels = this.splatConfig.updateSliver?.minMaskPixels ?? 1;
                this._updateTelemetry({
                    stage: "Evaluating mask",
                    mask: summarizeMask(processMaskImage, {
                        sliverPixels: maskPixelsInSliver,
                        sliverBounds,
                    }),
                });
                if (maskPixelsInSliver < minMaskPixels) {
                    if (this.debug.logPipeline === true) {
                        console.log(
                            `BakeHarness: skipped ${sampleId}; center sliver has ${maskPixelsInSliver} update pixels`,
                        );
                    }
                    this._updateTelemetry(
                        {
                            stage: "Skipped empty sliver",
                            mask: summarizeMask(processMaskImage, {
                                sliverPixels: maskPixelsInSliver,
                                sliverBounds,
                            }),
                        },
                        {
                            type: "mask",
                            severity: "warning",
                            message: "Center sliver has too few mask pixels",
                            detail: `${maskPixelsInSliver}/${minMaskPixels}`,
                        },
                    );
                    continue;
                }

                const worldPoints = hitsToWorldPoints(
                    capture.lidar,
                    capture.metadata.cameraExtrinsics,
                );
                const filtered = filterForSplatting(worldPoints, this.splatConfig);
                const updateCandidates = pointsInUpdateRegion(
                    filtered,
                    capture.metadata.cameraIntrinsics,
                    capture.metadata.cameraExtrinsics.matrixWorld,
                    processMaskImage,
                    sliverBounds,
                );
                this._updateTelemetry({
                    stage: "LiDAR filtering",
                    lidar: summarizeLidarFrame(capture.lidar, {
                        worldPointCount: worldPoints.length,
                        filteredCount: filtered.length,
                        updateCandidateCount: updateCandidates.length,
                        sampleFilteredPoints: summarizePoints(filtered),
                    }),
                });
                if (
                    this.splatConfig.updateSliver?.requireBuildingHit !== false
                    && updateCandidates.length === 0
                ) {
                    if (this.debug.logPipeline === true) {
                        console.log(
                            `BakeHarness: skipped ${sampleId}; no LiDAR candidates inside update sliver`,
                        );
                    }
                    this._updateTelemetry(
                        {
                            stage: "Skipped LiDAR update",
                            lidar: summarizeLidarFrame(capture.lidar, {
                                worldPointCount: worldPoints.length,
                                filteredCount: filtered.length,
                                updateCandidateCount: updateCandidates.length,
                                sampleFilteredPoints: summarizePoints(filtered),
                            }),
                        },
                        {
                            type: "lidar",
                            severity: "warning",
                            message: "No LiDAR candidates inside update sliver",
                            detail: sampleId,
                        },
                    );
                    continue;
                }

                const filteredDebugData = {
                    sampleId,
                    frameIndex,
                    viewId: view.name,
                    imageSource: bakedImage.source,
                    worldPointCount: worldPoints.length,
                    filteredCount: filtered.length,
                    updateCandidateCount: updateCandidates.length,
                    maskPixelsInSliver,
                    sliverBounds,
                    worldTagCounts: countBy(worldPoints, (point) => point.tagName),
                    filteredTagCounts: countBy(filtered, (point) => point.tagName),
                    filteredNonBuildingCount: filtered.filter((point) => point.tagName !== "building").length,
                    sampleFilteredPoints: summarizePoints(filtered),
                };
                if (this.debug.logPipeline === true) {
                    console.log("BakeHarness: filtered update candidates", filteredDebugData);
                }

                this._updateTelemetry({ stage: "Committing splats" });
                const commitResult = await accumulator.commitSliver(filtered, bakedImage, {
                    intrinsics: capture.metadata.cameraIntrinsics,
                    matrixWorld: capture.metadata.cameraExtrinsics.matrixWorld,
                    buildingId: processMaskImage.buildingId ?? null,
                    runId: this.runId,
                    sampleId,
                    frameIndex,
                    viewId: view.name,
                    imageSource: bakedImage.source,
                    maskImage: processMaskImage,
                    sliverBounds,
                    ...this.splatConfig,
                });

                accumulator.hideBakedGeometry(this.data.scene, this.splatConfig, {
                    runId: this.runId,
                    sampleId,
                    frameIndex,
                    viewId: view.name,
                    activeBuildingId: regionPlan.activeBuildingId,
                    committedThisFrame: commitResult.committed,
                });

                console.log(
                    `BakeHarness: ${filtered.length} candidate hits -> committed ${commitResult.committed} splats for ${sampleId}`,
                    `(total ${accumulator.splatCount}, source ${bakedImage.source})`,
                );

                this._updateTelemetry(
                    {
                        stage: "Splat commit",
                        lastImage: summarizeImage(bakedImage, {
                            sampleId,
                            viewId: view.name,
                            passId: "beauty",
                        }),
                        splat: {
                            committed: commitResult.committed,
                            total: accumulator.splatCount,
                            inputCount: filtered.length,
                            skippedCovered: commitResult.skippedCovered ?? 0,
                            skippedNoPixel: commitResult.skippedNoPixel ?? 0,
                            skippedNoColor: commitResult.skippedNoColor ?? 0,
                            skippedMasked: commitResult.skippedMasked ?? 0,
                            skippedBuildingMask: commitResult.skippedBuildingMask ?? 0,
                            skippedSliver: commitResult.skippedSliver ?? 0,
                            skippedWrongBuilding: commitResult.skippedWrongBuilding ?? 0,
                            updatedAt: Date.now(),
                        },
                    },
                    {
                        type: "splat",
                        severity: commitResult.committed > 0 ? "info" : "warning",
                        message: `${commitResult.committed} splats committed`,
                        detail: `${filtered.length} candidates`,
                    },
                );
            }
        }
    }

    /**
     * Upload the frame for model processing and poll for the baked result.
     * Returns the decoded model image, or null on any failure so the caller
     * can fall back to the raw render.
     * @returns {Promise<Object|null>}
     */
    async _roundTripModelImage({ view, viewSlug, capture, metadata, bakedImage, processMask }) {
        this._updateTelemetry({
            stage: "Checking model server",
            server: { awaitingModel: false },
        });

        const healthy = await checkBakeServerHealth(this.server);
        this._updateTelemetry({
            server: { healthy },
        });
        if (!healthy) {
            console.warn("Bake server unreachable; using raw beauty render");
            this._updateTelemetry(
                {
                    stage: "Model server unreachable",
                    server: { healthy: false, awaitingModel: false },
                },
                {
                    type: "server",
                    severity: "warning",
                    message: "Model server unreachable",
                    detail: this.server.host,
                },
            );
            return null;
        }

        if (!processMask?.data) {
            console.warn("Bake round-trip skipped; missing process mask for", metadata.sampleId);
            this._updateTelemetry(
                {
                    stage: "Model skipped",
                    server: { awaitingModel: false },
                },
                {
                    type: "model",
                    severity: "warning",
                    message: "Model skipped because process mask is missing",
                    detail: metadata.sampleId,
                },
            );
            return null;
        }

        const modelSeed = deriveModelSeed(
            this.runId,
            metadata.frameIndex,
            processMask.modelSeedKey ?? processMask.buildingId ?? processMask.passId,
        );

        const sharedMetadata = {
            ...metadata,
            position: JSON.stringify(capture.metadata.position),
            rotation: JSON.stringify(capture.metadata.rotation),
            cameraIntrinsics: JSON.stringify(capture.metadata.cameraIntrinsics),
            cameraExtrinsics: JSON.stringify(capture.metadata.cameraExtrinsics),
            lidarWidth: capture.lidar?.width ?? 0,
            lidarHeight: capture.lidar?.height ?? 0,
            lidarRange: capture.lidar?.range ?? 0,
            coordinateSystem: "threejs-y-up-right-handed",
            modelSeed,
        };

        const uploads = [];
        let expectedFiles = 0;

        this._updateTelemetry({
            stage: "Uploading capture bundle",
            server: { awaitingModel: false },
        });

        expectedFiles += 1;
        uploads.push((async () => {
            const blob = await rgbaToPngBlob(bakedImage.data, bakedImage.width, bakedImage.height, {
                linearToSrgb: true,
            });
            await uploadBakeFrame(this.server, blob, {
                ...sharedMetadata,
                filename: `render_beauty_${viewSlug}.png`,
                fileRole: "render",
                passId: "beauty",
            });
        })());

        const maskDebugData = {
            sampleId: metadata.sampleId,
            frameIndex: metadata.frameIndex,
            viewId: view.name,
            viewSlug,
            width: processMask.width,
            height: processMask.height,
            whitePixels: countOpaqueWhitePixels(processMask.data),
            totalPixels: processMask.width * processMask.height,
            includeTags: processMask.includeTags,
            excludeTags: processMask.excludeTags,
            processTag: processMask.processTag ?? "building",
            buildingId: processMask.buildingId,
            modelSeed,
        };
        if (this.debug.logPipeline === true) {
            console.log("BakeHarness: round-trip process mask", maskDebugData);
        }
        this._updateTelemetry({
            mask: summarizeMask(processMask, {
                whitePixels: maskDebugData.whitePixels,
            }),
        });
        expectedFiles += 1;
        uploads.push((async () => {
            const blob = await rgbaToPngBlob(
                processMask.data,
                processMask.width,
                processMask.height,
                { linearToSrgb: false },
            );
            await uploadBakeFrame(this.server, blob, {
                ...sharedMetadata,
                filename: `${processMask.passId || "mask_process"}_${viewSlug}.png`,
                fileRole: "mask",
                passId: processMask.passId || "mask_process",
                maskTags: (processMask.maskTags ?? ["building"]).join(","),
                processTag: processMask.processTag ?? "building",
                includeTags: (processMask.includeTags ?? []).join(","),
                excludeTags: (processMask.excludeTags ?? []).join(","),
                buildingId: processMask.buildingId ?? "",
                modelSeed,
            });
        })());

        if (capture.lidar?.data) {
            expectedFiles += 1;
            uploads.push(uploadBakeBinary(this.server, capture.lidar.data.buffer, {
                ...sharedMetadata,
                filename: `lidar_range_${viewSlug}.bin`,
                fileRole: "lidar",
                passId: "lidar",
                contentType: "application/octet-stream",
            }));
        }

        if (capture.depth?.data) {
            expectedFiles += 1;
            uploads.push((async () => {
                const blob = await rgbaToPngBlob(
                    capture.depth.data,
                    capture.depth.width,
                    capture.depth.height,
                    { linearToSrgb: false },
                );
                await uploadBakeFrame(this.server, blob, {
                    ...sharedMetadata,
                    filename: `depth_${viewSlug}.png`,
                    fileRole: "depth",
                    passId: "depth",
                });
            })());
        }

        await Promise.allSettled(uploads);
        this._updateTelemetry(
            {
                stage: "Capture bundle uploaded",
            },
            {
                type: "upload",
                severity: "info",
                message: `${expectedFiles} files uploaded`,
                detail: metadata.sampleId,
            },
        );

        const completeOk = await uploadSampleComplete(this.server, {
            runId: this.runId,
            sampleId: metadata.sampleId,
            frameIndex: metadata.frameIndex,
            pathIndex: metadata.pathIndex,
            distance: metadata.distance,
            segmentIndex: metadata.segmentIndex,
            expectedFiles,
        });

        if (!completeOk) {
            console.warn("Bake sample complete signal failed for", metadata.sampleId);
            this._updateTelemetry(
                {
                    stage: "Complete signal failed",
                    server: { awaitingModel: false },
                },
                {
                    type: "upload",
                    severity: "warning",
                    message: "Sample complete signal failed",
                    detail: metadata.sampleId,
                },
            );
            return null;
        }

        const pollStartedAt = Date.now();
        this._updateTelemetry({
            stage: "Waiting for model",
            server: { awaitingModel: true },
        });

        const modelImage = await pollBakedImage(this.server, this.roundTrip, {
            sampleId: metadata.sampleId,
            viewId: view.name,
        });

        this._updateTelemetry({
            server: {
                awaitingModel: false,
                lastLatencyMs: Date.now() - pollStartedAt,
            },
        });

        if (!modelImage) {
            this._updateTelemetry(
                {
                    stage: "Model fallback",
                },
                {
                    type: "model",
                    severity: "warning",
                    message: "Model result timed out or was unavailable",
                    detail: metadata.sampleId,
                },
            );
            return null;
        }

        this._updateTelemetry(
            {
                stage: "Model result ready",
                lastImage: summarizeImage(modelImage, {
                    sampleId: metadata.sampleId,
                    viewId: view.name,
                    passId: "model",
                }),
            },
            {
                type: "model",
                severity: "info",
                message: "Model result ready",
                detail: `${Date.now() - pollStartedAt}ms`,
            },
        );

        return modelImage;
    }

    async _uploadRawCaptureDebug({ view, viewSlug, metadata, bakedImage }) {
        try {
            const blob = await rgbaToPngBlob(bakedImage.data, bakedImage.width, bakedImage.height, {
                linearToSrgb: true,
            });
            const ok = await uploadBakeFrame(this.server, blob, {
                ...metadata,
                filename: `debug_raw_beauty_${viewSlug}.png`,
                fileRole: "debug_render",
                passId: "debug_beauty",
                debugOnly: true,
                debugBuildingTileMaterials: this.debug.buildingTileMaterials === true,
            });
            if (!ok) console.warn("BakeHarness: debug raw capture upload failed", metadata.sampleId);
        } catch (error) {
            console.warn("BakeHarness: debug raw capture upload failed", error);
        }
    }
}

/** @deprecated Use BakeHarness */
export { BakeHarness as BakingHarness };
