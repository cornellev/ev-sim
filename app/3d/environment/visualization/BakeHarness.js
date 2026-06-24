import * as THREE from "three";
import { BakeView } from "./BakeView";
import { BakePath } from "./BakePath";
import { buildSampleId, resolveViewPasses } from "./BakePass";
import {
    checkBakeServerHealth,
    clearBakeServer,
    rgbaToPngBlob,
    uploadBakeFrame,
    uploadSampleComplete,
} from "./bakeUpload";

/**
 * Orchestrates BakeView cameras along BakePaths and uploads captured frames.
 */
export class BakeHarness {
    /**
     * @param {import("../../data/Data").Data} data
     * @param {Object} [options]
     */
    constructor(data, options = {}) {
        this.data = data;
        this.runId = options.runId || crypto.randomUUID();
        this.deltaDistance = options.deltaDistance ?? 1.0;

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

        this._setupComplete = false;
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
            view._passes = resolveViewPasses(viewConfig.passes);

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

        this.running = true;
        this.completed = false;
        this.processingSample = false;
        this.activePathIndex = 0;
        this.nextSampleDistance = 0;
        this.frameIndex = 0;
    }

    stop() {
        this.running = false;
        this.processingSample = false;
    }

    /**
     * Called by the simulation loop, but intentionally not time-based. Each
     * invocation starts at most one capture/upload. The next path point is not
     * processed until the current image has been sent to the bake server.
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
                await this._captureAndUpload(sample);
            }

            if (!this.running) return;

            this.nextSampleDistance += this.deltaDistance;
            this.frameIndex += 1;

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
     * @param {{ distance: number, segmentIndex: number }} sample
     */
    async _captureAndUpload(sample) {
        const frameIndex = this.frameIndex;
        const pathIndex = this.activePathIndex;
        const sampleId = buildSampleId(this.runId, frameIndex);
        const uploads = [];
        let expectedFiles = 0;

        for (const view of this.views) {
            const passes = view._passes || resolveViewPasses();
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
            };

            const capture = view.capturePasses(passes, metadata);
            if (!capture?.passes?.length) continue;

            const lidar = capture.lidar;
            const sharedMetadata = {
                ...metadata,
                position: JSON.stringify(capture.metadata.position),
                rotation: JSON.stringify(capture.metadata.rotation),
                lidarWidth: lidar?.width ?? 0,
                lidarHeight: lidar?.height ?? 0,
                lidarRange: lidar?.range ?? 0,
            };

            for (const passFrame of capture.passes) {
                expectedFiles += 1;

                uploads.push((async () => {
                    const blob = await rgbaToPngBlob(
                        passFrame.data,
                        passFrame.width,
                        passFrame.height,
                        { linearToSrgb: passFrame.kind !== "mask" },
                    );

                    const filename = `${passFrame.fileRole}_${passFrame.passId}_${viewSlug}.png`;
                    const ok = await uploadBakeFrame(this.server, blob, {
                        ...sharedMetadata,
                        filename,
                        fileRole: passFrame.fileRole,
                        passId: passFrame.passId,
                        includeTags: passFrame.includeTags.join(","),
                        excludeTags: passFrame.excludeTags.join(","),
                        maskTags: passFrame.maskTags.join(","),
                    });

                    if (!ok) {
                        console.warn(
                            "Bake upload failed for",
                            view.name,
                            passFrame.passId,
                            "at distance",
                            sample.distance,
                        );
                    }
                })());
            }
        }

        await Promise.allSettled(uploads);

        const completeOk = await uploadSampleComplete(this.server, {
            runId: this.runId,
            sampleId,
            frameIndex,
            pathIndex,
            distance: sample.distance,
            segmentIndex: sample.segmentIndex,
            expectedFiles,
        });

        if (!completeOk) {
            console.warn("Bake sample complete signal failed for", sampleId);
        }
    }
}

/** @deprecated Use BakeHarness */
export { BakeHarness as BakingHarness };
