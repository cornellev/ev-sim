
export class KeyManager {
    constructor() {
        this.keysDown = {};
        this.keysUp = {};
        this.keysPress = {};
        this.whileDownCallbacks = {};
        this.down = new Set();
        this.telemetry = null;
    }

    attachTelemetry(store) {
        this.telemetry = store;
    }

    _publishKey(key, down, event) {
        this.telemetry?.publishSignal?.(`inputs.keyboard.${String(key)}`, Boolean(down), {
            source: "keyboard",
            type: "boolean",
            category: "inputs",
            replayRole: "input",
            logClass: "core",
            descriptorMetadata: { code: event?.code || null },
        });
    }

    registerKeyDown(key, callback) {
        if (!this.keysDown[key]) this.keysDown[key] = [];
        this.keysDown[key].push(callback);
        return () => {
            this.keysDown[key] = this.keysDown[key]?.filter((registered) => registered !== callback) ?? [];
        };
    }

    registerKeyUp(key, callback) {
        if (!this.keysUp[key]) this.keysUp[key] = [];
        this.keysUp[key].push(callback);
        return () => {
            this.keysUp[key] = this.keysUp[key]?.filter((registered) => registered !== callback) ?? [];
        };
    }

    registerKeyPress(key, callback) {
        if (!this.keysPress[key]) this.keysPress[key] = [];
        this.keysPress[key].push(callback);
        return () => {
            this.keysPress[key] = this.keysPress[key]?.filter((registered) => registered !== callback) ?? [];
        };
    }

    registerWhileDown(key, callback) {
        if (!this.whileDownCallbacks[key]) this.whileDownCallbacks[key] = [];
        this.whileDownCallbacks[key].push(callback);
        return () => {
            this.whileDownCallbacks[key] = this.whileDownCallbacks[key]?.filter((registered) => registered !== callback) ?? [];
        };
    }

    onKeyDown(event) {
        const key = event.key;
        const wasAlreadyDown = this.down.has(key);

        this.down.add(key);
        if (!wasAlreadyDown) this._publishKey(key, true, event);

        if (!wasAlreadyDown && this.keysDown[key]) {
            this.keysDown[key].forEach((callback) => callback?.(event));
        }
    }

    onKeyUp(event) {
        const key = event.key;

        this.down.delete(key);
        this._publishKey(key, false, event);

        if (this.keysUp[key]) {
            this.keysUp[key].forEach((callback) => callback?.(event));
        }
    }

    onKeyPress(event) {
        const key = event.key;

        if (this.keysPress[key]) {
            this.keysPress[key].forEach((callback) => callback?.(event));
        }
    }

    releaseAll() {
        for (const key of this.down) {
            this._publishKey(key, false, null);
        }
        this.down.clear();
    }

    update(deltaTime) {
        for (const key of this.down) {
            const callbacks = this.whileDownCallbacks[key];
            if (!callbacks) continue;

            callbacks.forEach((callback) => callback?.(deltaTime));
        }
    }
}
