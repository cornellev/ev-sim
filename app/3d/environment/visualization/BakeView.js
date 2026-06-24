import * as THREE from "three";
import { objectMatchesTags } from "../../data/ObjectTagRegistry";
import { Shader, standardVTX } from "../../shaders/Shader";
import { frag3d } from "../../shaders/Lidar3dShader";
import { parseLidarHits } from "../../devices/LidarHitDecoder";
import { passFileRole } from "./BakePass";

/**
 * @param {THREE.Object3D} threeObject
 * @returns {import("../../data/objects/Object").Object|null}
 */
function getFusionObject(threeObject) {
    let current = threeObject;
    while (current) {
        if (current.userData?.fusionObject) {
            return current.userData.fusionObject;
        }
        current = current.parent;
    }
    return null;
}

/**
 * BakeView is not a simulation Device. It is a harness-owned capture processor
 * that renders RGB and LiDAR buffers only when BakeHarness asks it to capture.
 */
export class BakeView {
    constructor(name = "Bake View", settings = {}) {
        const {
            position = new THREE.Vector3(0, 1, 0),
            rotation = new THREE.Euler(0, 0, 0),
            range,
            lidar = {},
            camera = {},
            channels = {},
            maxFramesPerChannel = 120,
            includeTags = [],
            excludeTags = [],
        } = settings;

        const cameraWidth = camera.width ?? 1920;
        const cameraHeight = camera.height ?? 1080;
        const cameraVerticalFov = camera.fov ?? 75;
        const cameraAspect = cameraWidth / Math.max(1, cameraHeight);
        const cameraHorizontalFov = THREE.MathUtils.radToDeg(
            2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cameraVerticalFov) / 2) * cameraAspect)
        );

        this.name = name || "Bake View";
        this.settings = {
            position: position.clone(),
            rotation: rotation.clone(),
        };

        this.range = lidar.range ?? range ?? camera.far ?? 500;
        this.thetaRange = lidar.thetaRange ?? [-cameraHorizontalFov / 2, cameraHorizontalFov / 2];
        this.phiRange = lidar.phiRange ?? [-cameraVerticalFov / 2, cameraVerticalFov / 2];
        const lidarWidth = lidar.width ?? 640;
        const lidarHeight = lidar.height ?? 360;
        this.thetaStep = lidar.thetaStep ?? Math.max(0.1, cameraHorizontalFov / lidarWidth);
        this.phiStep = lidar.phiStep ?? Math.max(0.1, cameraVerticalFov / lidarHeight);

        this.cameraSettings = {
            width: cameraWidth,
            height: cameraHeight,
            fov: cameraVerticalFov,
            near: camera.near ?? 0.1,
            far: camera.far ?? Math.max(this.range, 500),
        };

        this.channels = {
            lidar: channels.lidar || `${this.name}/lidar3d`,
            camera: channels.camera || `${this.name}/camera`,
        };

        this.maxFramesPerChannel = Math.max(1, maxFramesPerChannel);
        this.includeTags = [...includeTags];
        this.excludeTags = [...excludeTags];

        this.recording = {
            [this.channels.lidar]: [],
            [this.channels.camera]: [],
        };

        this.listeners = {
            [this.channels.lidar]: [],
            [this.channels.camera]: [],
        };

        this.scene = null;
        this.renderer = null;
        this.data = null;
        this.sensorCamera = null;
        this.cameraRenderTarget = null;
        this.cameraPixelBuffer = null;
        this.shader = new Shader(
            Math.ceil((this.thetaRange[1] - this.thetaRange[0]) / this.thetaStep),
            Math.ceil((this.phiRange[1] - this.phiRange[0]) / this.phiStep),
            standardVTX,
            frag3d,
            {
                u_origin: { value: this.settings.position },
                u_thetaStart: { value: this.thetaRange[0] },
                u_thetaEnd: { value: this.thetaRange[1] },
                u_thetaStep: { value: this.thetaStep },
                u_phiStart: { value: this.phiRange[0] },
                u_phiEnd: { value: this.phiRange[1] },
                u_phiStep: { value: this.phiStep },
                u_range: { value: this.range },
                boxCount: { value: 0 },
                triCount: { value: 0 },
                u_boxPosTex: { value: null },
                u_boxScaleTex: { value: null },
                u_boxTagTex: { value: null },
                u_triPosTex: { value: null },
                u_triTagTex: { value: null },
                u_sensorRotation: { value: new THREE.Matrix3() },
            }
        );

        this.buff = null;
        this.hits = [];
        this.distances = [];
        this._captureInFlight = false;
        this._hiddenObjects = [];
        this._boostedMaterials = [];
        this._maskRestoreState = null;
        this._maskMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            toneMapped: false,
        });

        this.shader.onData((buffer) => {
            this.buff = buffer;
        });
    }

    /**
     * @param {{ scene: THREE.Scene, renderer: THREE.WebGLRenderer, data: import("../data/Data").Data }} context
     */
    setup({ scene, renderer, data }) {
        this.scene = scene;
        this.renderer = renderer;
        this.data = data;

        this.sensorCamera = new THREE.PerspectiveCamera(
            this.cameraSettings.fov,
            this.cameraSettings.width / this.cameraSettings.height,
            this.cameraSettings.near,
            this.cameraSettings.far,
        );

        this.sensorCamera.position.copy(this.getPosition());
        this.sensorCamera.rotation.copy(this.getRotation());
        this.sensorCamera.updateMatrixWorld(true);
        scene.add(this.sensorCamera);

        this.cameraRenderTarget = new THREE.WebGLRenderTarget(
            this.cameraSettings.width,
            this.cameraSettings.height,
            {
                format: THREE.RGBAFormat,
                type: THREE.UnsignedByteType,
                depthBuffer: true,
                stencilBuffer: false,
            }
        );

        this.cameraPixelBuffer = new Uint8Array(
            this.cameraSettings.width * this.cameraSettings.height * 4
        );

        this.shader.setup(renderer);
    }

    getPosition() {
        return this.settings.position;
    }

    getRotation() {
        return this.settings.rotation;
    }

    setPose(position, rotation) {
        this.settings.position.copy(position);
        this.settings.rotation.copy(rotation);
        this.updateCameraPose();
    }

    updateCameraPose() {
        if (!this.sensorCamera) return;
        this.sensorCamera.position.copy(this.getPosition());
        this.sensorCamera.rotation.copy(this.getRotation());
        this.sensorCamera.updateMatrixWorld(true);
    }

    setIncludeTags(tags = []) {
        this.includeTags = [...tags];
    }

    setExcludeTags(tags = []) {
        this.excludeTags = [...tags];
    }

    /**
     * @param {import("../../data/objects/Object").Object} fusionObject
     * @returns {boolean}
     */
    shouldShowObject(fusionObject) {
        return objectMatchesTags(fusionObject, this.includeTags, this.excludeTags);
    }

    /**
     * @param {THREE.Scene} scene
     * @param {string[]} [includeTags]
     * @param {string[]} [excludeTags]
     */
    _applyVisibilityFilter(scene, includeTags = this.includeTags, excludeTags = this.excludeTags) {
        this._hiddenObjects = [];

        scene.traverse((object) => {
            if (!object.visible) return;
            if (!(object.isMesh || object.isGroup)) return;

            const fusionObject = getFusionObject(object);
            if (!fusionObject) return;

            if (!objectMatchesTags(fusionObject, includeTags, excludeTags)) {
                this._hiddenObjects.push(object);
                object.visible = false;
            }
        });
    }

    _restoreVisibility() {
        for (const object of this._hiddenObjects) {
            object.visible = true;
        }
        this._hiddenObjects = [];
    }

    /**
     * Dark asphalt materials can be crushed in offscreen readback. Lift only
     * bake-tagged road surfaces while capturing; the live scene is unchanged.
     */
    _applyCaptureMaterialBoost() {
        this._boostedMaterials = [];

        this.scene.traverse((object) => {
            if (!object.isMesh || !object.userData?.bakeRoadSurface) return;
            const materials = Array.isArray(object.material) ? object.material : [object.material];

            for (const material of materials) {
                if (!material) continue;

                this._boostedMaterials.push({
                    material,
                    color: material.color?.clone?.(),
                    emissive: material.emissive?.clone?.(),
                    emissiveIntensity: material.emissiveIntensity,
                    toneMapped: material.toneMapped,
                });

                if (material.color) {
                    material.color.multiplyScalar(1.35);
                }
                if (material.emissive) {
                    material.emissive.set(material.color ?? 0x333333);
                    material.emissiveIntensity = Math.max(material.emissiveIntensity ?? 0, 0.12);
                }
                if ("toneMapped" in material) {
                    material.toneMapped = true;
                }
            }
        });
    }

    _restoreCaptureMaterialBoost() {
        for (const state of this._boostedMaterials) {
            if (state.color && state.material.color) {
                state.material.color.copy(state.color);
            }
            if (state.emissive && state.material.emissive) {
                state.material.emissive.copy(state.emissive);
            }
            if (state.emissiveIntensity !== undefined) {
                state.material.emissiveIntensity = state.emissiveIntensity;
            }
            if (state.toneMapped !== undefined) {
                state.material.toneMapped = state.toneMapped;
            }
        }
        this._boostedMaterials = [];
    }

    parseDistances() {
        if (!this.buff) return;

        this.distances = [];
        this.hits = parseLidarHits(this.buff, this.range);
        for (const hit of this.hits) {
            this.distances.push(hit.distance);
        }
    }

    /**
     * Run the bake LiDAR shader pass for the current pose and camera FOV.
     * @returns {Object|null}
     */
    _captureLidar() {
        const objectDb = this.data?.objects?.();
        if (!objectDb || !this.shader) return null;

        const { posTexture, scaleTexture, tagTexture: boxTagTexture, count } = objectDb.t_boxes();
        const { posTexture: triPosTexture, tagTexture: triTagTexture, count: triCount } = objectDb.t_triangles();

        const sensorRotationMatrix = new THREE.Matrix3().setFromMatrix4(
            new THREE.Matrix4().makeRotationFromEuler(this.getRotation())
        );

        this.shader.update({
            u_origin: { value: this.getPosition() },
            u_sensorRotation: { value: sensorRotationMatrix },
            boxCount: { value: count },
            u_boxPosTex: { value: posTexture },
            u_boxScaleTex: { value: scaleTexture },
            u_boxTagTex: { value: boxTagTexture },
            triCount: { value: triCount },
            u_triPosTex: { value: triPosTexture },
            u_triTagTex: { value: triTagTexture },
        });

        if (!this.buff) return null;

        this.parseDistances();

        return {
            timestamp: Date.now(),
            width: this.shader.size.w,
            height: this.shader.size.h,
            format: "float32-rgba",
            data: new Float32Array(this.buff),
            hits: this.hits,
            thetaRange: [...this.thetaRange],
            phiRange: [...this.phiRange],
            range: this.range,
        };
    }

    _renderCameraPixels() {
        const previousRenderTarget = this.renderer.getRenderTarget();
        try {
            this.renderer.setRenderTarget(this.cameraRenderTarget);
            this.renderer.render(this.scene, this.sensorCamera);
            this.renderer.readRenderTargetPixels(
                this.cameraRenderTarget,
                0,
                0,
                this.cameraSettings.width,
                this.cameraSettings.height,
                this.cameraPixelBuffer,
            );
        } finally {
            this.renderer.setRenderTarget(previousRenderTarget);
        }

        return new Uint8Array(this.cameraPixelBuffer);
    }

    /**
     * Render a binary mask where tagged fusion objects are white on black.
     * @param {string[]} includeTags
     * @param {string[]} excludeTags
     */
    _renderMaskPass(includeTags = [], excludeTags = []) {
        const previousBackground = this.scene.background;
        this.scene.background = new THREE.Color(0x000000);
        this._maskRestoreState = {
            background: previousBackground,
            entries: [],
        };

        this.scene.traverse((object) => {
            if (!object.isMesh) return;

            const fusionObject = getFusionObject(object);
            const matches = fusionObject
                ? objectMatchesTags(fusionObject, includeTags, excludeTags)
                : false;

            const previousVisible = object.visible;
            const previousMaterial = object.material;
            const previousCastShadow = object.castShadow;
            const previousReceiveShadow = object.receiveShadow;

            if (matches) {
                object.visible = true;
                object.material = this._maskMaterial;
                object.castShadow = false;
                object.receiveShadow = false;
            } else {
                object.visible = false;
            }

            this._maskRestoreState.entries.push({
                object,
                visible: previousVisible,
                material: previousMaterial,
                castShadow: previousCastShadow,
                receiveShadow: previousReceiveShadow,
            });
        });

        const rgba = this._renderCameraPixels();
        this._restoreMaskPass();
        return rgba;
    }

    _restoreMaskPass() {
        if (!this._maskRestoreState) return;

        for (const entry of this._maskRestoreState.entries) {
            entry.object.visible = entry.visible;
            entry.object.material = entry.material;
            entry.object.castShadow = entry.castShadow;
            entry.object.receiveShadow = entry.receiveShadow;
        }

        this.scene.background = this._maskRestoreState.background;
        this._maskRestoreState = null;
    }

    /**
     * @param {import("./BakePass").BakePassDescriptor[]} passes
     * @param {Object} metadata
     * @returns {{ passes: Object[], lidar: Object|null, metadata: Object }|null}
     */
    capturePasses(passes = [], metadata = {}) {
        if (
            this._captureInFlight ||
            !this.sensorCamera ||
            !this.cameraRenderTarget ||
            !this.cameraPixelBuffer ||
            !this.renderer ||
            !this.scene ||
            !Array.isArray(passes) ||
            passes.length === 0
        ) {
            return null;
        }

        this._captureInFlight = true;
        this.updateCameraPose();

        const position = this.getPosition();
        const rotation = this.getRotation();
        const frameMetadata = {
            ...metadata,
            viewId: this.name,
            cameraId: this.name,
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
        };

        const lidarFrame = this._captureLidar();
        if (lidarFrame) {
            lidarFrame.metadata = { ...frameMetadata };
            this._recordFrame(this.channels.lidar, lidarFrame);
        }

        const passResults = [];

        for (const pass of passes) {
            if (pass.upload === false) continue;

            const includeTags = pass.includeTags ?? this.includeTags;
            const excludeTags = pass.excludeTags ?? this.excludeTags;

            let rgba;
            if (pass.kind === "mask") {
                rgba = this._renderMaskPass(includeTags, excludeTags);
            } else {
                this._applyVisibilityFilter(this.scene, includeTags, excludeTags);
                this._applyCaptureMaterialBoost();
                try {
                    rgba = this._renderCameraPixels();
                } finally {
                    this._restoreCaptureMaterialBoost();
                    this._restoreVisibility();
                }
            }

            const passFrame = {
                timestamp: Date.now(),
                width: this.cameraSettings.width,
                height: this.cameraSettings.height,
                format: "rgba8",
                data: rgba,
                passId: pass.id,
                kind: pass.kind,
                fileRole: passFileRole(pass),
                includeTags: [...includeTags],
                excludeTags: [...excludeTags],
                maskTags: pass.kind === "mask" ? [...includeTags] : [],
                metadata: {
                    ...frameMetadata,
                    passId: pass.id,
                    fileRole: passFileRole(pass),
                    includeTags: [...includeTags],
                    excludeTags: [...excludeTags],
                    maskTags: pass.kind === "mask" ? [...includeTags] : [],
                },
            };

            if (pass.kind === "render") {
                this._recordFrame(this.channels.camera, passFrame);
            }

            passResults.push(passFrame);
        }

        this._captureInFlight = false;

        return {
            passes: passResults,
            lidar: lidarFrame,
            metadata: frameMetadata,
        };
    }

    /**
     * @param {Object} metadata
     * @returns {{ camera: Object, lidar: Object|null, metadata: Object }|null}
     */
    captureFrame(metadata = {}) {
        const capture = this.capturePasses([{
            id: "beauty",
            kind: "render",
            includeTags: this.includeTags,
            excludeTags: this.excludeTags,
        }], metadata);

        if (!capture?.passes?.length) return null;

        return {
            camera: capture.passes[0],
            lidar: capture.lidar,
            metadata: capture.metadata,
        };
    }

    _recordFrame(channelName, frame) {
        const bucket = this.recording[channelName];
        if (!bucket) return;

        bucket.push(frame);
        if (bucket.length > this.maxFramesPerChannel) {
            bucket.splice(0, bucket.length - this.maxFramesPerChannel);
        }

        const callbacks = this.listeners[channelName] || [];
        for (const callback of callbacks) {
            callback(frame, channelName, this);
        }
    }

    onChannel(channelName, callback) {
        if (!this.listeners[channelName]) {
            this.listeners[channelName] = [];
        }
        this.listeners[channelName].push(callback);
    }

    getChannelFrames(channelName) {
        return this.recording[channelName] || [];
    }

    getLatestFrame(channelName) {
        const channel = this.getChannelFrames(channelName);
        return channel.length ? channel[channel.length - 1] : null;
    }

    clearChannel(channelName) {
        if (!this.recording[channelName]) return;
        this.recording[channelName] = [];
    }
}
