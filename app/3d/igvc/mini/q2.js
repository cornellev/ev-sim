import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Road } from "../../city/Road";
import Unit from "@/app/util/Unit";

const road = {
    start: convertStringToLatLng(`42°40'05.93"N 83°13'03.15"W`),
    end: convertStringToLatLng(`42°40'04.71"N 83°13'03.11"W`)
}

const locations = [road];

export async function Q2(scene, data) {
    const roads = [];
    let baseOffset = null;
    
    for (const {start, end} of locations) {
        const vstart = convertFromLatLng(start.lat, start.lng);
        const vend = convertFromLatLng(end.lat, end.lng);
        if (!baseOffset) {
            baseOffset = vstart.clone();
        }
        vstart.sub(baseOffset);
        vend.sub(baseOffset);

        vstart.z *= -1; // flip x to match typical 3D coordinate system (optional, depends on your conventions)
        vend.z *= -1;

        const road = new Road([
            vstart,
            vstart.clone().lerp(vend, 0.5),
            vend
        ], new Unit(20, Unit.Type.FOOT), Road.BorderType.SOLID_WHITE, Road.BorderType.SOLID_WHITE, {
            laneCount: 2,
            shoulderWidth: 3
        });
        roads.push(road);
    }

    data.city().addRoads(roads);

    await data.city().setupRoads(scene);
}