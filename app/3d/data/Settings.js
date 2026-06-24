
export class Settings {
    constructor() {
        this._cameraControlLocks = new Set();
        this.cameraControlsEnabled = true;
        
        this.disableControls = this.disableControls.bind(this);
        this.enableControls = this.enableControls.bind(this);
    }

    disableControls(lock = "default") {
        this._cameraControlLocks.add(lock);
        this.cameraControlsEnabled = false;
    }

    enableControls(lock = "default") {
        this._cameraControlLocks.delete(lock);
        this.cameraControlsEnabled = this._cameraControlLocks.size === 0;
    }
}
