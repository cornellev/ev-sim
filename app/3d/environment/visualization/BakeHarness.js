import * as THREE from "three";
import { BakeView } from "./BakeView";
import { BakePath } from "./BakePath";
import { buildSampleId, resolveViewPasses } from "./BakePass";
import { BuildingRegionPlanner } from "./BuildingRegionPlanner";
import { getRawBeautyImage, pollBakedImage } from "./BakeRoundTrip";
import {
    filterForSplatting,
    hitsToWorldPoints,
} from "./LidarSplatProjector";
import {
    checkBakeServerHealth,
    clearBakeServer,
    rgbaToPngBlob,
    uploadBakeBinary,
    uploadBakeFrame,
    uploadRunManifest,
    uploadSampleComplete,
} from "./bakeUpload";

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
        this.splatConfig = options.splat ?? {
            enabled: true,
            excludeTags: ["road"],
            bandNear: 0,
            bandFar: 15,
            maxSplatDistance: 60,
            maxPointsPerFrame: 20000,
            coverageVoxelSize: 0.25,
            radius: 0.06,
            adaptiveRadius: true,
            hideBakedGeometry: true,
            hideThreshold: 50,
        };

        this.server = {
            host: options.host ?? "http://localhost:8000",
            endpoint: options.endpoint ?? "/bake",
        };

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

        this._setupComplete = false;
        this._manifestUploaded = false;
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
        return this;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async checkServer() {
        return checkBakeServerHealth(this.server);
    }

    async start() {
        const healthy = await this.checkServer();
        if (!healthy) {
            console.warn("Bake server is not reachable at", this.server.host);
        }

        const clear = await clearBakeServer(this.server);

        if (clear) {
            console.log("Bake server cleared successfully.");
        }

        if (this.manifest && !this._manifestUploaded) {
            const ok = await uploadRunManifest(this.server, this.manifest);
            if (ok) {
                this._manifestUploaded = true;
            }
        }

        this.running = true;
        this.completed = false;
        this.processingSample = false;
        this.activePathIndex = 0;
        this.nextSampleDistance = 0;
        this.frameIndex = 0;
        this.regionPlanner = new BuildingRegionPlanner(this.manifest?.buildings ?? []);
    }

    stop() {
        this.running = false;
        this.processingSample = false;
    }

    /**
     * Called by the simulation loop, but intentionally not time-based. Each
     * invocation starts at most one capture/upload. The next path point is not
     * processed until the current sample has been fully handled.
     */
    update() {
        if (!this.running || this.completed || this.processingSample) return;
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

            this.nextSampleDistance += this.deltaDistance;
            this.frameIndex += 1;
            this.regionPlanner.advance(this.frameIndex);

            if (this.nextSampleDistance > path.totalLength) {
                this._advancePath();
            }
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
            return;
        }

        this.nextSampleDistance = 0;
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

            // Beauty-only capture. The round-trip re-bakes everything but the
            // road via a single non-road mask, so per-building masks are not
            // needed here. LiDAR + depth are still captured by capturePasses.
            const passes = resolveViewPasses([
                { id: "beauty", kind: "render", excludeTags: ["sign", "vehicle"] },
            ]);

            const capture = view.capturePasses(passes, metadata, {
                maskMinPixels: this.maskMinPixels,
                skipEmptyMasks: false,
            });
            if (!capture) continue;

            let bakedImage = getRawBeautyImage(capture);
            if (!bakedImage) {
                console.warn("BakeHarness: missing beauty pass for", sampleId);
                continue;
            }

            if (useModel) {
                const modelImage = await this._roundTripModelImage({
                    view,
                    viewSlug,
                    capture,
                    metadata,
                    bakedImage,
                });
                if (modelImage) bakedImage = modelImage;
            }

            if (this.splatConfig.enabled && accumulator && capture.lidar) {
                const worldPoints = hitsToWorldPoints(
                    capture.lidar,
                    capture.metadata.cameraExtrinsics,
                );
                const filtered = filterForSplatting(worldPoints, this.splatConfig);
                const commitResult = await accumulator.commitSliver(filtered, bakedImage, {
                    intrinsics: capture.metadata.cameraIntrinsics,
                    matrixWorld: capture.metadata.cameraExtrinsics.matrixWorld,
                    buildingId: regionPlan.activeBuildingId,
                    ...this.splatConfig,
                });

                accumulator.hideBakedGeometry(this.data.scene, this.splatConfig);

                console.log(
                    `BakeHarness: ${filtered.length} candidate hits -> committed ${commitResult.committed} splats for ${sampleId}`,
                    `(total ${accumulator.splatCount}, source ${bakedImage.source})`,
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
    async _roundTripModelImage({ view, viewSlug, capture, metadata, bakedImage }) {
        const healthy = await checkBakeServerHealth(this.server);
        if (!healthy) {
            console.warn("Bake server unreachable; using raw beauty render");
            return null;
        }

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
        };

        const uploads = [];
        let expectedFiles = 0;

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

        const maskData = view._renderMaskPass([], ["road"]);
        expectedFiles += 1;
        uploads.push((async () => {
            const blob = await rgbaToPngBlob(
                maskData,
                view.cameraSettings.width,
                view.cameraSettings.height,
                { linearToSrgb: false },
            );
            await uploadBakeFrame(this.server, blob, {
                ...sharedMetadata,
                filename: `mask_non_road_${viewSlug}.png`,
                fileRole: "mask",
                passId: "mask_non_road",
                maskTags: "no_road",
                processTag: "no_road_building",
                excludeTags: "road",
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
            return null;
        }

        return pollBakedImage(this.server, this.roundTrip, {
            sampleId: metadata.sampleId,
            viewId: view.name,
        });
    }
}

/** @deprecated Use BakeHarness */
export { BakeHarness as BakingHarness };
