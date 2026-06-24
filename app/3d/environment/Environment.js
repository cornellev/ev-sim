import { Data } from "../data/Data";

/**
 * What is an environment?
 * 
 * An environment describes the scene in which the simulation takes place.
 * For example, a city, or a rural area, or a highway.
 * 
 * Generally, it's a collection of objects that can be used to create a realistic simulation.
 * For example, a city environment might include buildings, roads, traffic lights, and pedestrians.
 * A rural environment might include trees, grass, and animals.
 * A highway environment might include cars, trucks, and traffic signs.
 * 
 * This acts as a container for all the objects in the scene, and can be used to manage them.
 */
class Environment {
    /**
     * 
     * @param {Data} data 
     */
    constructor(data) {
        if (!!data) throw new Error("Data object is required to create an environment.");

        this.data = data; // general data object

        // A list of all the static objects (as in, that don't move) in the environment.
        // These are particularly objects can still interact with LiDAR and other sensors, but they don't move.
        // Some examples are: Buildings, static cars, stop signs (or general signs), traffic lights, cones, etc.
        this.staticObjects = []; // Type: Array of GLSLObject

        // A list of all the dynamic objects (as in, that do move) in the environment.
        // Some examples are: Pedestrians, cyclists, moving cars, animals, etc.
        this.dynamicObjects = []; // Type: Array of GLSLObject

        // A list of visual objects that aren't necessarily part of the simulation, but are there for visual purposes.
        // For example, a skybox, or a ground plane.
        this.visualObjects = []; // Type: Array of ThreeJS objects

        
    }
}