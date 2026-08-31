import * as THREE from "three";
import { PhysicalVehicle } from "./Vehicle";
import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";
import { attachVehiclePlant, resetVehiclePlant, syncVehicleFromPlant } from "./VehiclePlantAdapter.js";

function normalizeKeyframes(keyframes) {
    return (keyframes || [])
        .filter((frame) => frame && Number.isFinite(frame.x) && Number.isFinite(frame.y))
        .map((frame, index) => ({
            t: Number.isFinite(frame.t) ? frame.t : index,
            x: frame.x,
            y: frame.y,
            yaw: Number.isFinite(frame.yaw) ? frame.yaw : 0,
            velocity: Number.isFinite(frame.velocity) ? frame.velocity : 0,
        }))
        .sort((a, b) => a.t - b.t);
}

export class ScenarioCar extends PhysicalVehicle {
    constructor(db, {
        id,
        keyframes = [],
        length = 4.5,
        width = 2.0,
        height = 1.5,
        color = 0x3aa0ff,
        roofColor = 0x9fd1ff,
        wheelColor = 0x1d1d1d,
        lift = 0,
        freezeAtEnd = true,
        playbackRate = 1,
        autoplay = true,
    } = {}) {
        const frames = normalizeKeyframes(keyframes);
        const first = frames[0] || { x: 0, y: 0, yaw: 0 };

        super(
            db,
            new THREE.Vector3(first.x, lift, first.y),
            new THREE.Euler(0, -first.yaw, 0)
        );

        this.id = id || crypto.randomUUID();
        this.length = Number.isFinite(length) ? length : 4.5;
        this.width = Number.isFinite(width) ? width : 2.0;
        this.height = Number.isFinite(height) ? height : 1.5;
        this.color = color;
        this.roofColor = roofColor;
        this.wheelColor = wheelColor;
        this.lift = Number.isFinite(lift) ? lift : 0;
        this.freezeAtEnd = freezeAtEnd !== false;
        this.playbackRate = Number.isFinite(playbackRate) ? playbackRate : 1;
        this.keyframes = frames;
        this.elapsedTime = 0;
        this.started = false;
        this.completed = false;
        this.currentSpeed = first.velocity || 0;
        this.autoplay = autoplay === true;
        this.isPlaying = this.autoplay;

        attachVehiclePlant(this, {
            id: this.id,
            type: "scenario-car",
            pose: { position: this.position, rotation: this.rotation },
            keyframes: this.keyframes,
        }, { manifest: getBuiltInVehicleManifest("scenario-car") }, {
            lift: this.lift,
            freezeAtEnd: this.freezeAtEnd,
            playbackRate: this.playbackRate,
            autoplay: this.autoplay,
        });
        this.plant.started = false;


        this.sceneObject = this.createSceneObject();
        this.sceneObject.name = `ScenarioCar_${this.id}`;
        this.sceneObject.userData = {
            vehicleType: "scenario-car",
            vehicleId: this.id,
        };

        if (this.keyframes.length) {
            this.applyState(this.keyframes[0]);
        }
    }

    setupDevices() {
        // Scenario vehicles are passive by default.
    }

    createSceneObject() {
        const root = new THREE.Group();

        const bodyMat = new THREE.MeshStandardMaterial({
            color: this.color,
            roughness: 0.7,
            metalness: 0.1,
        });
        const roofMat = new THREE.MeshStandardMaterial({
            color: this.roofColor,
            roughness: 0.55,
            metalness: 0.15,
        });
        const wheelMat = new THREE.MeshStandardMaterial({
            color: this.wheelColor,
            roughness: 1,
            metalness: 0,
        });

        const body = new THREE.Mesh(
            new THREE.BoxGeometry(this.length, this.height * 0.55, this.width),
            bodyMat
        );
        body.position.y = this.height * 0.275;
        body.castShadow = true;
        body.receiveShadow = true;
        root.add(body);

        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(this.length * 0.5, this.height * 0.4, this.width * 0.72),
            roofMat
        );
        cabin.position.set(this.length * -0.05, this.height * 0.68, 0);
        cabin.castShadow = true;
        cabin.receiveShadow = true;
        root.add(cabin);

        const wheelGeometry = new THREE.CylinderGeometry(this.height * 0.16, this.height * 0.16, this.width * 0.12, 20);
        wheelGeometry.rotateZ(Math.PI / 2);

        const wheelOffsets = [
            [this.length * 0.28, this.height * 0.16, this.width * 0.48],
            [this.length * 0.28, this.height * 0.16, -this.width * 0.48],
            [-this.length * 0.28, this.height * 0.16, this.width * 0.48],
            [-this.length * 0.28, this.height * 0.16, -this.width * 0.48],
        ];

        for (const [x, y, z] of wheelOffsets) {
            const wheel = new THREE.Mesh(wheelGeometry, wheelMat);
            wheel.position.set(x, y, z);
            wheel.castShadow = true;
            root.add(wheel);
        }

        return root;
    }

    addToScene(scene) {
        if (!scene || typeof scene.add !== "function") {
            throw new Error("ScenarioCar.addToScene requires a THREE.Scene or THREE.Object3D parent");
        }

        if (this.sceneObject.parent !== scene) {
            scene.add(this.sceneObject);
        }
    }

    start(_scene = null, { resetPlant = true } = {}) {
        this.started = true;
        this.elapsedTime = 0;
        this.completed = false;
        if (resetPlant) this.plant.resetRunState();
        this.plant.started = true;
        this.plant.isPlaying = this.isPlaying;

        if (!this.keyframes.length) {
            this.sceneObject.visible = false;
            return;
        }

        this.sceneObject.visible = this.keyframes[0].t <= 0;
        this.applyState(this.keyframes[0]);
    }

    play({ restart = false } = {}) {
        if (restart || this.completed) {
            this.restart();
        }

        this.isPlaying = true;
        this.plant.play({ restart: false });
    }

    pause() {
        this.isPlaying = false;
        this.plant.pause();
    }

    restart() {
        this.elapsedTime = 0;
        this.completed = false;
        this.plant.restart();

        if (!this.keyframes.length) {
            this.sceneObject.visible = false;
            return;
        }

        this.sceneObject.visible = this.keyframes[0].t <= 0;
        this.applyState(this.keyframes[0]);
    }

    resetRunState(entry = {}) {
        super.resetRunState(entry);
        resetVehiclePlant(this, entry);
        this.isPlaying = this.autoplay;
        this.start(null, { resetPlant: false });
    }

    getDeterministicState() {
        return super.getDeterministicState();
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.pause();
            return false;
        }

        this.play({ restart: this.completed });
        return true;
    }

    sampleState(timeSeconds) {
        return this.plant.sampleScenarioState(timeSeconds);
    }

    applyState(state) {
        if (!state) return;

        this.currentSpeed = Number.isFinite(state.velocity) ? state.velocity : 0;
        this.velocity.set(this.currentSpeed, 0, 0);

        this.updatePosition(new THREE.Vector3(state.x, this.lift, state.y));
        this.updateRotation(new THREE.Euler(0, -state.yaw, 0));
    }

    update(deltaTime) {
        if (!this.started || !this.keyframes.length || this.completed || !this.isPlaying) {
            return;
        }

        const first = this.keyframes[0];
        this.plant.started = this.started;
        this.plant.isPlaying = this.isPlaying;
        this.plant.update(deltaTime);
        this.elapsedTime = this.plant.elapsedTime;
        if (this.plant.elapsedTime < first.t) {
            this.sceneObject.visible = false;
            return;
        }

        this.sceneObject.visible = true;
        syncVehicleFromPlant(this);
        this.currentSpeed = this.plant.currentSpeed;
        this.completed = this.plant.completed;
        if (this.completed) this.elapsedTime = this.keyframes.at(-1).t;
    }
}
