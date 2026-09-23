import { selectVehicleCamera } from "./selectVehicleCamera.js";
import { copyVehicleCameraToView } from "./copyVehicleCameraToView.js";

export const PERSPECTIVE_CONTROL_LOCK = "perspective-view";

function deviceLabel(device) {
    if (device?.name && String(device.name).trim()) return String(device.name);
    if (device?.telemetryId) return String(device.telemetryId);
    return "Vehicle camera";
}

function snapshotChanged(previous, next) {
    return previous.active !== next.active
        || previous.locked !== next.locked
        || previous.label !== next.label;
}

/** Predicted path ribbons sit in the middle of a forward vehicle camera. */
function syncPredictedPaths(data, hide) {
    const vehicles = data?.vehicles?.()?.vehicles;
    if (Array.isArray(vehicles)) {
        for (const entry of vehicles) {
            if (!entry?.path) continue;
            entry.path.visible = !hide && entry.controlsEnabled !== false;
        }
    }
    data?.simulation?.()?.autonomyOverlay?.setPredictedPathHidden?.(hide);
}

export class PerspectiveViewController {
    constructor({ data, getCamera, getControls, getRenderer } = {}) {
        this.data = data ?? null;
        this.getCamera = getCamera ?? (() => this.data?.camera ?? null);
        this.getControls = getControls ?? (() => this.data?.simulation?.()?.controls ?? null);
        this.getRenderer = getRenderer ?? (() => this.data?.renderer ?? null);
        this.active = false;
        this.locked = false;
        this.label = "";
        this.saved = null;
        this.listeners = new Set();
    }

    getSnapshot() {
        return {
            active: this.active,
            locked: this.locked,
            label: this.label,
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    enter() {
        if (this.active) return this.getSnapshot();
        this.#capture();
        this.active = true;
        this.applyFrame(this.getCamera(), this.getControls());
        if (!this.locked) this.label = "No vehicle camera";
        this.#emit();
        return this.getSnapshot();
    }

    exit() {
        if (!this.active) return this.getSnapshot();
        const camera = this.getCamera();
        const controls = this.getControls();
        if (camera && this.saved) {
            camera.position.copy(this.saved.position);
            camera.quaternion.copy(this.saved.quaternion);
            camera.fov = this.saved.fov;
            camera.near = this.saved.near;
            camera.far = this.saved.far;
            const renderer = this.getRenderer();
            const width = renderer?.domElement?.clientWidth || renderer?.domElement?.width || 0;
            const height = renderer?.domElement?.clientHeight || renderer?.domElement?.height || 0;
            camera.aspect = width > 0 && height > 0 ? width / height : this.saved.aspect;
            camera.updateProjectionMatrix();
        }
        if (controls?.target && this.saved?.target) controls.target.copy(this.saved.target);
        this.#releaseControls();
        if (controls) controls.enabled = this.data?.settings?.()?.cameraControlsEnabled !== false;
        controls?.update?.();
        syncPredictedPaths(this.data, false);
        this.active = false;
        this.locked = false;
        this.label = "";
        this.saved = null;
        this.#emit();
        return this.getSnapshot();
    }

    toggle() {
        return this.active ? this.exit() : this.enter();
    }

    applyFrame(camera, controls) {
        if (!this.active || !camera) return;
        const previous = this.getSnapshot();
        const selected = selectVehicleCamera(this.data);
        const device = selected?.device ?? null;
        if (!device) {
            if (this.locked) this.#releaseControls();
            this.locked = false;
            this.label = "No vehicle camera";
            if (controls) controls.enabled = this.data?.settings?.()?.cameraControlsEnabled !== false;
        } else {
            copyVehicleCameraToView(camera, device);
            if (!this.locked) this.#holdControls();
            this.locked = true;
            this.label = deviceLabel(device);
            if (controls) controls.enabled = false;
        }
        syncPredictedPaths(this.data, this.locked);
        if (snapshotChanged(previous, this.getSnapshot())) this.#emit();
    }

    #capture() {
        const camera = this.getCamera();
        const controls = this.getControls();
        if (!camera) {
            this.saved = null;
            return;
        }
        this.saved = {
            position: camera.position.clone(),
            quaternion: camera.quaternion.clone(),
            fov: camera.fov,
            near: camera.near,
            far: camera.far,
            aspect: camera.aspect,
            target: controls?.target?.clone?.() ?? null,
        };
    }

    #holdControls() {
        this.data?.settings?.()?.disableControls?.(PERSPECTIVE_CONTROL_LOCK);
    }

    #releaseControls() {
        this.data?.settings?.()?.enableControls?.(PERSPECTIVE_CONTROL_LOCK);
    }

    #emit() {
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) listener(snapshot);
    }
}
