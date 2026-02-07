
export class MouseManager {
    constructor() {
        this.onClick = [];
        this.onMove = [];
        this.onDown = [];
        this.onUp = [];
    }

    registerClick(callback) {
        this.onClick.push(callback);
    }

    registerMove(callback) {
        this.onMove.push(callback);
    }

    handleClick(event) {
        this.onClick.forEach(callback => callback(event));
    }

    handleMove(event) {
        this.onMove.forEach(callback => callback(event));
    }

    handleDown(event) {
        this.onDown.forEach(callback => callback(event));
    }
    
    handleUp(event) {
        this.onUp.forEach(callback => callback(event));
    }
}