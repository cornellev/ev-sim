import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Barrel } from "../../city/objects/Barrel";
import { Road } from "../../city/Road";
import Unit from "@/app/util/Unit";
import { Intersection } from "../../city/Intersection";

const barrel = convertStringToLatLng(`42°40'06.30"N 83°13'03.90"W`);

const locations = [
    {
        start: convertStringToLatLng(`42°40'06.05"N 83°13'03.31"W`),
        end: convertStringToLatLng(`42°40'06.04"N 83°13'03.81"W`)
    },
    {
        start: convertStringToLatLng(`42°40'05.44"N 83°13'03.97"W`),
        end: convertStringToLatLng(`42°40'05.91"N 83°13'03.98"W`)
    },
    {
        start: convertStringToLatLng(`42°40'06.01"N 83°13'04.64"W`),
        end: convertStringToLatLng(`42°40'06.02"N 83°13'04.13"W`)
    },
    {
        start: convertStringToLatLng(`42°40'06.47"N 83°13'03.97"W`),
        end: convertStringToLatLng(`42°40'06.14"N 83°13'03.96"W`)
    }
];

export async function Q4(scene, data) {
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

    // add barrel
    const pos = convertFromLatLng(barrel.lat, barrel.lng).sub(baseOffset);
    pos.z *= -1;

    const barrelObj = new Barrel(new THREE.Vector3(pos.x, 0, pos.z), new THREE.Vector3(0.75, 1, 0.75));
    data.objects().addObject(barrelObj);

    const intersection = new Intersection([
        roads[0],
        roads[1],
        roads[2],
        roads[3]
    ]);

    data.city().addIntersection(intersection);
    await data.city().setupIntersections(scene);

    return {
        startingPosition: new THREE.Vector3(0.5964710243071336, 0, -1.575427667442955),
        startingRotation: new THREE.Euler(0, -3.115908887240864, 0)
    }
}

// start position:
// x: 0.5964710243071336, y: 0, z: -1.575427667442955
// euler x: 0, y: -3.115908887240864, z: 0