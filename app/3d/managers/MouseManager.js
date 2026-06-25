
export class MouseManager {
    constructor() {
        this.onClick = [];
        this.onMove = [];
        this.onDown = [];
        this.onUp = [];
    }

    registerClick(callback) {
        this.onClick.push(callback);
        return () => {
            this.onClick = this.onClick.filter((registered) => registered !== callback);
        };
    }

    registerMove(callback) {
        this.onMove.push(callback);
        return () => {
            this.onMove = this.onMove.filter((registered) => registered !== callback);
        };
    }

    registerDown(callback) {
        this.onDown.push(callback);
        return () => {
            this.onDown = this.onDown.filter((registered) => registered !== callback);
        };
    }

    registerUp(callback) {
        this.onUp.push(callback);
        return () => {
            this.onUp = this.onUp.filter((registered) => registered !== callback);
        };
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
