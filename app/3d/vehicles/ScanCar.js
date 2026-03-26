import * as THREE from "three";
import { PhysicalVehicle } from "./Vehicle";
import { Data } from "../data/Data";
import { StereoCamera } from "../devices/StereoCamera";

export class ScanCar extends PhysicalVehicle {
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler()) {
        super(db, position, rotation);


    }

    setupDevices() {
        const angle = Math.PI / 2.75;
        const stereoCamera = new StereoCamera(
            "Left Stereo Camera",
            {
                position: new THREE.Vector3(0, 1.5, -0.5), // position relative to car center
                rotation: new THREE.Euler(0, -angle, 0), // rotated to face right side (+Z)
                range: 20,
                thetaStep: 2,
                phiStep: 1,
                camera: {
                    width: 320,
                    height: 180,
                    fov: 75,
                    near: 0.1,
                    far: 200,
                },
                channels: {
                    lidar: "bigcar/stereo/lidar3d",
                    camera: "bigcar/stereo/camera",
                },
                maxFramesPerChannel: 180,
            }
        );

        const camera2 = new StereoCamera(
            "Right Stereo Camera",
            {
                position: new THREE.Vector3(0, 1.5, 0.5), // position relative to car center
                rotation: new THREE.Euler(0, angle, 0), // rotated to face left side (-Z)
                range: 20,
                thetaStep: 2,
                phiStep: 1,
                camera: {
                    width: 320,
                    height: 180,
                    fov: 75,
                    near: 0.1,
                    far: 200,
                },
                channels: {
                    lidar: "bigcar/stereo/lidar3d",
                    camera: "bigcar/stereo/camera",
                },
                maxFramesPerChannel: 180,
            }
        );

        this.addDevice(stereoCamera);
        this.addDevice(camera2);
    }

    async addToScene(scene) {
        const box = new THREE.BoxGeometry(1, 0.5, 0.5);
        const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
        const mesh = new THREE.Mesh(box, material);

        // add a block at the front to represent the LiDAR sensor
        const sensorBox = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        const sensorMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        const sensorMesh = new THREE.Mesh(sensorBox, sensorMaterial);
        sensorMesh.position.set(0.5, 0, 0); // position it at the front of the car
        mesh.add(sensorMesh);

        mesh.position.copy(this.position).add(new THREE.Vector3(0, 0.25, 0)); // raise it so the bottom is at y=0
        mesh.rotation.copy(this.rotation);
        this._mesh = mesh;
        scene.add(mesh);
    }

    disableControls() {}
}

/**
 * 
 * @param {Data} data 
 * @param {THREE.Scene} scene 
 */
export async function setupScanCar(data, scene) {
    const car = new ScanCar(data.vehicles(), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0));
    await car.addToScene(scene);
}