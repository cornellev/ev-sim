import * as THREE from "three";
import { Data } from "../data/Data";
import { LiDAR3d } from "../devices/LiDAR3d";
import { PhysicalVehicle, Vehicle } from "./Vehicle";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

export class BigCar extends PhysicalVehicle {
    constructor(db, position=new Vector3(), rotation=new Euler()) {
        super(db, position, rotation);
    }

    setupDevices() {
        const lidar = new LiDAR3d(
            new THREE.Vector3(0, 10, 0), // position
            new THREE.Euler(0, 0, 0) // rotation
        );
        
        
        this.addDevice(lidar);
    }

    async addToScene(scene) {

        console.log("Loading BigCar model...");
        // gltf loader to load a car model
        const loader = new GLTFLoader();
        
        const gltf = await loader.loadAsync("/shell/shell.gltf");

        // scale down by 100x
        gltf.scene.scale.set(0.01, 0.01, 0.01);

        gltf.scene.position.copy(this.position);
        gltf.scene.rotation.copy(this.rotation);

        // rotate it -90
        gltf.scene.rotateX(-Math.PI / 2);


        this.sceneObject = new THREE.Group();
        this.sceneObject.add(gltf.scene);
        scene.add(this.sceneObject);

        console.log("BigCar added to scene");
    }
}