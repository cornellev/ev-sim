
export class KeyManager {
    constructor() {
        this.keysDown = {};
        this.keysUp = {};
    }

    registerKeyDown(key, callback) {
        if (!this.keysDown[key]) {
            this.keysDown[key] = [];
        }

        this.keysDown[key].push(callback);
    }

    registerKeyUp(key, callback) {
        if (!this.keysUp[key]) {
            this.keysUp[key] = [];
        }
        
        this.keysUp[key].push(callback);
    }
            

    onKeyDown(event) {
        const key = event.key;
        if (this.keysDown[key]) {
            this.keysDown[key].forEach(callback => callback(event));
        }
    }

    onKeyUp(event) {
        const key = event.key;
        if (this.keysUp[key]) {
            this.keysUp[key].forEach(callback => callback(event));
        }
    }
}