const { Data } = require("../3d/data/Data");

class PhysicsEngine {
    /**
     * @param {Data} data 
     */
    constructor(data) {
        this.data = data;
        this.rigidBodies = [];
    }
}