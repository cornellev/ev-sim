import { TAG_IDS } from "../3d/data/ObjectTagRegistry.js";

export const PERCEPTION_LABEL_CATALOG_VERSION = 1;

/**
 * IDs 0-6 deliberately mirror ObjectTagRegistry because those values are
 * already stored in LiDAR GPU textures. New classes are append-only.
 */
export const PERCEPTION_CLASS_IDS = Object.freeze({
    unknown: TAG_IDS.unknown,
    building: TAG_IDS.building,
    sign: TAG_IDS.sign,
    vehicle: TAG_IDS.vehicle,
    road: TAG_IDS.road,
    barrel: TAG_IDS.barrel,
    tire: TAG_IDS.tire,
    lane: 7,
    traffic_light: 8,
    pedestrian: 9,
    cyclist: 10,
});

const CLASS_NAME_ALIASES = Object.freeze({
    "traffic-sign": "sign",
    traffic_sign: "sign",
    "traffic-light": "traffic_light",
    trafficlight: "traffic_light",
    lanelet: "lane",
    intersection: "road",
    car: "vehicle",
    truck: "vehicle",
    bus: "vehicle",
    motorcycle: "vehicle",
    bicycle: "cyclist",
});

const NAME_BY_ID = new Map(
    Object.entries(PERCEPTION_CLASS_IDS).map(([name, id]) => [id, name]),
);

export function normalizePerceptionClassName(value) {
    const name = String(value ?? "unknown").trim().toLowerCase();
    return CLASS_NAME_ALIASES[name] || (name in PERCEPTION_CLASS_IDS ? name : "unknown");
}

export function perceptionClassId(value) {
    if (Number.isInteger(value) && NAME_BY_ID.has(value)) return value;
    return PERCEPTION_CLASS_IDS[normalizePerceptionClassName(value)];
}

export function perceptionClassName(value) {
    return NAME_BY_ID.get(Number(value)) || "unknown";
}

export function listPerceptionLabels() {
    return Object.entries(PERCEPTION_CLASS_IDS)
        .map(([name, id]) => ({ id, name }))
        .sort((left, right) => left.id - right.id);
}
