export class PhysicsEngine {
    /**
     * @param {Data} data 
     */
    constructor(data, { loadPhysics = () => import("@dimforge/rapier3d") } = {}) {
        this.data = data;

        this.world = null; // placeholder for physics world object (e.g., from a physics library like Cannon.js or Ammo.js)

        this.rigidbodies = []; // list of rigid bodies in the simulation; can be used for collision detection, etc.


        this._initialization = loadPhysics().then(RAPIER => {
            let gravity = { x: 0, y: -9.81, z: 0 };
            this.world = new RAPIER.World(gravity);
            console.log("Physics engine initialized with gravity", gravity);
            return this.world;
        });
    }

    async start() {
        await this._initialization;

        // For now, the physics engine doesn't do anything active; it just provides a structure for future physics updates and a place to store physics-related state if needed.
    }

    async step(deltaTime) {
        if (!this.world) return;

        this.world.timestep = deltaTime;
        this.world.step();
    }

    async stop() {
        // Clean up any physics-related resources if needed. For now, there's nothing to clean up.
    }


}