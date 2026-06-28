import {
    cloneSkyConfig,
    normalizeSkyConfig,
    skyConfigToManifest,
    SKY_MODES,
} from "./EnvironmentSkyConfig.js";

function cloneRuntime(runtime = {}) {
    return {
        status: runtime.status ?? "idle",
        error: runtime.error ?? null,
    };
}

export class EnvironmentSkyState {
    constructor(options = {}) {
        this.config = normalizeSkyConfig(options);
        this.runtime = {
            status: "idle",
            error: null,
        };
        this.subscribers = new Set();
    }

    snapshot() {
        return {
            ...cloneSkyConfig(this.config),
            runtime: cloneRuntime(this.runtime),
        };
    }

    toManifest() {
        return skyConfigToManifest(this.config);
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot());
        return () => {
            this.subscribers.delete(callback);
        };
    }

    notify() {
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot));
    }

    update(patch = {}) {
        this.config = normalizeSkyConfig({
            ...this.config,
            ...patch,
            takram: {
                ...this.config.takram,
                ...(patch.takram ?? {}),
            },
            image: {
                ...this.config.image,
                ...(patch.image ?? {}),
            },
        });
        this.runtime = {
            status: "idle",
            error: null,
        };
        this.notify();
    }

    setMode(mode) {
        this.update({
            mode: mode === SKY_MODES.IMAGE ? SKY_MODES.IMAGE : SKY_MODES.TAKRAM,
        });
    }

    setTakramSettings(settings = {}) {
        this.update({
            takram: settings,
        });
    }

    setImageSettings(settings = {}) {
        this.update({
            image: settings,
        });
    }

    setImageLocalPreview(url = null, name = null) {
        this.update({
            mode: SKY_MODES.IMAGE,
            image: {
                localPreviewUrl: url,
                localPreviewName: name,
            },
        });
    }

    clearImageLocalPreview() {
        this.setImageLocalPreview(null, null);
    }

    setRuntimeStatus(status = "idle", error = null) {
        if (this.runtime.status === status && this.runtime.error === error) return;
        this.runtime = { status, error };
        this.notify();
    }
}
