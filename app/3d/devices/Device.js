import { DeviceDatabase } from "../data/DeviceDatabase";
import { Euler, Quaternion, Vector3 } from "three";
import { Object } from "../data/objects/Object";

export default class Device extends Object {
    constructor(name, settings={ position: new Vector3(0, 0, 0), rotation: new Euler(0, 0, 0) }) {
        super(true, true, false);

        this.name = name || "Generic Device";
        // position, rotation are LOCAL to the parent vehicle (for settings)
        this.settings = settings;
        this.enabled = true;
        this.parent = null;

        this.parentVehicle = null; // set when added to a vehicle, for easy access to parent vehicle's position + rotation

        this.tags = [];
    }

    getPosition() {
        const localPosition = new Vector3().copy(this.settings.position || new Vector3(0, 0, 0));
        if (!this.parentVehicle) {
            return localPosition;
        }

        const parentPosition = this.parentVehicle.sceneObject
            ? this.parentVehicle.sceneObject.getWorldPosition(new Vector3())
            : new Vector3().copy(this.parentVehicle.position || new Vector3(0, 0, 0));

        const parentRotation = this.parentVehicle.sceneObject
            ? this.parentVehicle.sceneObject.getWorldQuaternion(new Quaternion())
            : new Quaternion().setFromEuler(this.parentVehicle.rotation || new Euler(0, 0, 0));

        return localPosition.applyQuaternion(parentRotation).add(parentPosition);
    }

    getRotation() {
        const localRotation = this.settings.rotation || new Euler(0, 0, 0);
        const localEuler = localRotation.isEuler
            ? localRotation
            : new Euler(localRotation.x || 0, localRotation.y || 0, localRotation.z || 0, "XYZ");

        if (!this.parentVehicle) {
            return new Euler(localEuler.x, localEuler.y, localEuler.z, localEuler.order || "XYZ");
        }

        const parentQuat = this.parentVehicle.sceneObject
            ? this.parentVehicle.sceneObject.getWorldQuaternion(new Quaternion())
            : new Quaternion().setFromEuler(this.parentVehicle.rotation || new Euler(0, 0, 0));

        const localQuat = new Quaternion().setFromEuler(localEuler);
        const combined = parentQuat.multiply(localQuat);

        return new Euler().setFromQuaternion(combined, localEuler.order || "XYZ");
    }

    onParentUpdate() {
        // Override in subclasses if needed, called when parent vehicle updates position or rotation
    }

    /**
     * @return {DeviceDatabase}
     */
    getParent() {
        return this.parent;
    }

    setup(scene) {
        // Override in subclasses
    }

}