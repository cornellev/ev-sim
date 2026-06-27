import * as THREE from "three";
import Unit from "../../../util/Unit.js";
import { Barrel } from "../../city/objects/Barrel.js";
import { OneWaySign } from "../../city/objects/OneWaySign.js";
import { StopSign } from "../../city/objects/StopSign.js";
import { Tire } from "../../city/objects/Tire.js";
import {
    getMapColorForAsset,
    getPlacementAsset,
    PLACEMENT_CATALOG,
} from "./placementCatalogData.js";

export { getMapColorForAsset, getPlacementAsset, PLACEMENT_CATALOG };

/**
 * @param {string} assetId
 * @param {THREE.Vector3 | { x: number, y?: number, z: number }} point
 */
export function createFusionObject(assetId, point) {
    const position = point instanceof THREE.Vector3
        ? point.clone()
        : new THREE.Vector3(point.x, point.y ?? 0, point.z);

    if (assetId === "stop-sign") {
        return new StopSign(position, new Unit(5, Unit.Type.FOOT), 1);
    }

    if (assetId === "one-way-sign") {
        return new OneWaySign(position, 1);
    }

    if (assetId === "tire") {
        return new Tire(position);
    }

    return new Barrel(position, new THREE.Vector3(0.75, 1, 0.75));
}
