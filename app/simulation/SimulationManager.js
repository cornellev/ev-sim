import { Data } from "../3d/data/Data";

export class SimulationManager {
    /**
     * @param {Data} data 
     */
    constructor(data) {
        this.data = data;

        this.state = {
            time: 0,
            steps: 0,
            deltaTime: 0.016, // 16 ms per step = 60 steps per second
            running: false,
            speed: 1, // multiplier for simulation speed; 1 = real time, 2 = 2x speed, etc.
        }
    }

    start() {
        this.state.running = true;
        this.data.physics().start();
    }

    execute() {
        this.data.physics().step(this.state.deltaTime * this.state.speed);
    }

    stop() {
        this.state.running = false;
        this.data.physics().stop();
    }

    
}