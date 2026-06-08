
export class KeyManager {
    constructor() {
        this.keysDown = {};
        this.keysUp = {};
        this.keysPress = {};
        this.whileDownCallbacks = {};
        this.down = new Set();
    }

    registerKeyDown(key, callback) {
        if (!this.keysDown[key]) this.keysDown[key] = [];
        this.keysDown[key].push(callback);
    }

    registerKeyUp(key, callback) {
        if (!this.keysUp[key]) this.keysUp[key] = [];
        this.keysUp[key].push(callback);
    }

    registerKeyPress(key, callback) {
        if (!this.keysPress[key]) this.keysPress[key] = [];
        this.keysPress[key].push(callback);
    }

    registerWhileDown(key, callback) {
        if (!this.whileDownCallbacks[key]) this.whileDownCallbacks[key] = [];
        this.whileDownCallbacks[key].push(callback);
    }

    onKeyDown(event) {
        const key = event.key;
        const wasAlreadyDown = this.down.has(key);

        this.down.add(key);

        if (!wasAlreadyDown && this.keysDown[key]) {
            this.keysDown[key].forEach((callback) => callback?.(event));
        }
    }

    onKeyUp(event) {
        const key = event.key;

        this.down.delete(key);

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

    update(deltaTime) {
        for (const key of this.down) {
            const callbacks = this.whileDownCallbacks[key];
            if (!callbacks) continue;

            callbacks.forEach((callback) => callback?.(deltaTime));
        }
    }
}