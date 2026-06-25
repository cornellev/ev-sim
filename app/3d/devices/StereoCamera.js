import { LiDAR3d } from "./LiDAR3d";
import * as THREE from "three";
import { withPixelPackBufferUnbound } from "../util/glReadback.js";


export class StereoCamera extends LiDAR3d {
    constructor(name="Stereo Camera", settings={}) {
        const {
            position = new THREE.Vector3(0, 1, 0),
            rotation = new THREE.Euler(0, 0, 0),
            range = 10,
            thetaStep = 1,
            thetaRange,
            phiStep = 1,
            phiRange,
            camera = {},
            channels = {},
            maxFramesPerChannel = 120,
        } = settings;

        const cameraWidth = camera.width ?? 320;
        const cameraHeight = camera.height ?? 180;
        const cameraAspect = cameraWidth / Math.max(1, cameraHeight);
        const cameraVerticalFov = camera.fov ?? 75;
        const cameraHorizontalFov = THREE.MathUtils.radToDeg(
            2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cameraVerticalFov) / 2) * cameraAspect)
        );

        const resolvedThetaRange = thetaRange ?? [-cameraHorizontalFov / 2, cameraHorizontalFov / 2];
        const resolvedPhiRange = phiRange ?? [-cameraVerticalFov / 2, cameraVerticalFov / 2];

        super(position, rotation, range, thetaStep, resolvedThetaRange, phiStep, resolvedPhiRange);

        this.name = name || "Stereo Camera";

        this.cameraSettings = {
            width: cameraWidth,
            height: cameraHeight,
            fov: cameraVerticalFov,
            near: camera.near ?? 0.1,
            far: camera.far ?? Math.max(1000, range * 2),
        };

        this.channels = {
            lidar: channels.lidar || `${this.name}/lidar3d`,
            camera: channels.camera || `${this.name}/camera`,
        };

        this.maxFramesPerChannel = Math.max(1, maxFramesPerChannel);

        this.recording = {
            [this.channels.lidar]: [],
            [this.channels.camera]: [],
        };

        this.listeners = {
            [this.channels.lidar]: [],
            [this.channels.camera]: [],
        };

        this.tags = ["distance", "pointcloud", "camera"];

        this.sensorCamera = null;
        this.cameraRenderTarget = null;
        this.cameraPixelBuffer = null;
        this._cameraCaptureInFlight = false;
    }

    setup(scene) {
        super.setup(scene);

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
    }

    onParentUpdate() {
        super.onParentUpdate();

        if (!this.sensorCamera) return;

        this.sensorCamera.position.copy(this.getPosition());
        this.sensorCamera.rotation.copy(this.getRotation());
        this.sensorCamera.updateMatrixWorld(true);
    }

    execute() {
        super.execute();

        if (this._cameraCaptureInFlight || !this.sensorCamera || !this.cameraRenderTarget || !this.cameraPixelBuffer) {
            return;
        }

        const data = this.getParent()?.getParent?.();
        const renderer = data?.renderer;
        const scene = data?.scene;

        if (!renderer || !scene) return;

        this._cameraCaptureInFlight = true;

        this.sensorCamera.position.copy(this.getPosition());
        this.sensorCamera.rotation.copy(this.getRotation());
        this.sensorCamera.updateMatrixWorld(true);

        const previousRenderTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(this.cameraRenderTarget);
        renderer.render(scene, this.sensorCamera);
        withPixelPackBufferUnbound(renderer, () => {
            renderer.readRenderTargetPixels(
                this.cameraRenderTarget,
                0,
                0,
                this.cameraSettings.width,
                this.cameraSettings.height,
                this.cameraPixelBuffer,
            );
        });
        renderer.setRenderTarget(previousRenderTarget);

        this._recordFrame(this.channels.camera, {
            timestamp: Date.now(),
            width: this.cameraSettings.width,
            height: this.cameraSettings.height,
            format: "rgba8",
            data: new Uint8Array(this.cameraPixelBuffer),
        });

        this._cameraCaptureInFlight = false;
    }

    emitRays(buffer) {
        super.emitRays(buffer);

        this._recordFrame(this.channels.lidar, {
            timestamp: Date.now(),
            width: this.shader?.size?.w ?? 0,
            height: this.shader?.size?.h ?? 0,
            format: "float32-rgba",
            data: new Float32Array(buffer),
        });
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