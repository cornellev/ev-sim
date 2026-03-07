import * as THREE from 'three';

export class CameraFollower {
    constructor() {
        this.camera = null
        this.cameraOffset = new THREE.Vector3(0, 5, -10);
        this.lookAtOffset = new THREE.Vector3();
        this.smoothTarget = new THREE.Vector3();
        this._currentLookAt = new THREE.Vector3();
        this._desiredPosition = new THREE.Vector3();
        this._desiredLookAt = new THREE.Vector3();
        this._worldPosition = new THREE.Vector3();
        this._worldQuaternion = new THREE.Quaternion();
        this._initialized = false;
    }

    updateCamera(target, deltaTime) {
        if (!this.camera) return;

        if (!target) return;

        if (target instanceof THREE.Object3D) {
            target.getWorldPosition(this._worldPosition);
            target.getWorldQuaternion(this._worldQuaternion);

            this._desiredPosition.copy(this.cameraOffset).applyQuaternion(this._worldQuaternion).add(this._worldPosition);
            this._desiredLookAt.copy(this.lookAtOffset).applyQuaternion(this._worldQuaternion).add(this._worldPosition);
        } else {
            const { position, rotation } = target;
            if (!position || !rotation) return;

            this._desiredPosition.copy(this.cameraOffset).applyEuler(rotation).add(position);
            this._desiredLookAt.copy(this.lookAtOffset).applyEuler(rotation).add(position);
        }

        if (!this._initialized) {
            this.smoothTarget.copy(this._desiredPosition);
            this._currentLookAt.copy(this._desiredLookAt);
            this._initialized = true;
        }

        const smoothing = 1 - Math.exp(-5 * deltaTime);

        // Smoothly interpolate the camera's position towards the desired position
        this.smoothTarget.lerp(this._desiredPosition, smoothing);
        this._currentLookAt.lerp(this._desiredLookAt, smoothing);
        this.camera.position.copy(this.smoothTarget);

        // Make the camera look at the target
        this.camera.lookAt(this._currentLookAt);
    }
}