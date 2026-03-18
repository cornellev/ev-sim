import Unit from "@/app/util/Unit";
import { Road } from "./Road";
import * as THREE from "three";
import { convertFromLatLng } from "@/app/util/Location";

export async function LoadRoadsFromGeoJSON(scene, url) {
    const response = await fetch(url);
    const geojson = await response.json();
    const features = geojson.features;

    const base = features[0].geometry.coordinates[0];
    const baseVec = convertFromLatLng(base[1], base[0]);
    console.log("Base vector:", baseVec);

    for (let feature of features) {
        const geometry = feature.geometry;
        const { lengthinv, DIRECT1, TOTALANES, ROW_WIDTH, WIDTH_C_C } = feature.properties;
        if (geometry.type === "LineString") {
            const points = geometry.coordinates.map(([lng, lat]) => {
                const vec = convertFromLatLng(lat, lng);
                return new THREE.Vector3(vec.x - baseVec.x, 0, vec.z - baseVec.z);
            });

            const road = new Road(points, 
                new Unit(lengthinv, Unit.Type.INCH),
                Road.BorderType.SOLID_WHITE,
                Road.BorderType.SOLID_WHITE,
                {
                    laneCount: TOTALANES
                }
            );

            road.setup(scene);
        }
    }
}