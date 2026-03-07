
export class KeyManager {
    constructor() {
        this.keysDown = {};
        this.keysUp = {};
        this.keysPress = {};
        
        this.whileDownCallbacks = {};
        this.intervals = {};
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

    registerKeyPress(key, callback) {
        if (!this.keysPress[key]) {
            this.keysPress[key] = [];
        }
        
        this.keysPress[key].push(callback);
    }

    registerWhileDown(key, callback) {
        if (!this.whileDownCallbacks[key]) {
            this.whileDownCallbacks[key] = [];
        }
        
        this.whileDownCallbacks[key].push(callback);
    }
            

    onKeyDown(event) {
        const key = event.key;
        if (this.keysDown[key]) {
            this.keysDown[key].forEach(callback => callback != null ? callback(event) : null);
        }
    }

    onKeyUp(event) {
        const key = event.key;
        if (this.keysUp[key]) {
            this.keysUp[key].forEach(callback => callback != null ? callback(event) : null);
        }

        if (this.whileDownCallbacks[key] && this.intervals[key]) {
            clearInterval(this.intervals[key]);
            delete this.intervals[key];
        }
    }

    onKeyPress(event) {
        const key = event.key;
        if (this.keysPress[key]) {
            this.keysPress[key].forEach(callback => callback != null ? callback(event) : null);
        }

        if (this.whileDownCallbacks[key] && !this.intervals[key]) {
            this.intervals[key] = setInterval(() => {
                this.whileDownCallbacks[key].forEach(cb => cb());
            }, 100); // call every 100ms
        }
    }
}