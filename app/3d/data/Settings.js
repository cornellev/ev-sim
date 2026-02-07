
export class Settings {
    constructor() {
        this.cameraControlsEnabled = true;
        
        this.disableControls = this.disableControls.bind(this);
        this.enableControls = this.enableControls.bind(this);
    }
    disableControls() {
        this.cameraControlsEnabled = false;
    }
    enableControls() {
        this.cameraControlsEnabled = true;
    }
}