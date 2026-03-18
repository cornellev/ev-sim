import { DeviceDatabase } from "../data/DeviceDatabase";
import { Vector3 } from "three";
import { Object } from "../data/objects/Object";

export default class Device extends Object {
    constructor(name, settings={ position: new Vector3(0, 0, 0), rotation: new Vector3(0, 0, 0) }) {
        super(true, true, false);

        this.name = name || "Generic Device";
        // position, rotation are LOCAL to the parent vehicle (for settings)
        this.settings = settings;
        this.enabled = true;
        this.parent = null;

        this.parentVehicle = null; // set when added to a vehicle, for easy access to parent vehicle's position + rotation
    }

    getPosition() {
        const add = this.parentVehicle ? this.parentVehicle.position : new Vector3(0, 0, 0);
        return new Vector3().copy(this.settings.position).add(add);
    }

    getRotation() {
        const add = this.parentVehicle ? this.parentVehicle.rotation : new Vector3(0, 0, 0);
        return new Vector3().copy(this.settings.rotation).add(add);
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