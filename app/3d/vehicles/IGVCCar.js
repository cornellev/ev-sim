import * as THREE from "three";
import { PhysicalVehicle } from "./Vehicle";
import { LiDAR3d } from "../devices/LiDAR3d";
import Unit from "@/app/util/Unit";

export class IGVCCar extends PhysicalVehicle {
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler()) {
        super(db, position, rotation);
        
        this.dimensions = new THREE.Vector3(
            new Unit(38.933, Unit.Type.INCH).getValue(Unit.Type.METER), // length
            new Unit(18, Unit.Type.INCH).getValue(Unit.Type.METER), // height
            new Unit(26.94, Unit.Type.INCH).getValue(Unit.Type.METER), // width
        );
    }

    setupDevices() {
        const lidar = new LiDAR3d( //todo: setup
            new THREE.Vector3(0, 1, 0),
            new THREE.Euler(0, 0, 0), 
            20,
            2,
            [0, 360],
            0.5,
            [-20, 20]
        );

        this.addDevice(lidar);
    }


    async update(dt) {

    }

    async addToScene(scene) {
        const geometry = new THREE.BoxGeometry(
            this.dimensions.x,
            this.dimensions.y,
            this.dimensions.z
        );
        const material = new THREE.MeshStandardMaterial({ color: 0x0077ff });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(this.position);
        mesh.rotation.copy(this.rotation);

        this.sceneObject.add(mesh);
        scene.add(this.sceneObject);
    }
}