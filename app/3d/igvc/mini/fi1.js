import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Barrel } from "../../city/objects/Barrel";
import { Road } from "../../city/Road";
import Unit from "@/app/util/Unit";
import { Box } from "../../data/objects/Box";

const road = {
    start: convertStringToLatLng(`42°40'05.93"N 83°13'03.15"W`),
    end: convertStringToLatLng(`42°40'04.71"N 83°13'03.11"W`)
};

const barrel = convertStringToLatLng(`42°40'05.20"N 83°13'03.19"W`);

const locations = [road];

export async function FI1(scene, data) {
    const roads = [];
    let baseOffset = null;
    let segStart = null;
    let segEnd = null;

    for (const { start, end } of locations) {
        const vstart = convertFromLatLng(start.lat, start.lng);
        const vend = convertFromLatLng(end.lat, end.lng);
        if (!baseOffset) {
            baseOffset = vstart.clone();
        }
        vstart.sub(baseOffset);
        vend.sub(baseOffset);

        vstart.z *= -1;
        vend.z *= -1;

        segStart = vstart.clone();
        segEnd = vend.clone();

        const roadMesh = new Road(
            [vstart, vstart.clone().lerp(vend, 0.5), vend],
            new Unit(20, Unit.Type.FOOT),
            Road.BorderType.SOLID_WHITE,
            Road.BorderType.SOLID_WHITE,
            {
                laneCount: 2,
                shoulderWidth: 3
            }
        );
        roads.push(roadMesh);
    }

    data.city().addRoads(roads);

    await data.city().setupRoads(scene);

    const pos = convertFromLatLng(barrel.lat, barrel.lng).sub(baseOffset);
    pos.z *= -1;

    const barrelObj = new Barrel(new THREE.Vector3(pos.x, 0, pos.z), new THREE.Vector3(0.75, 1, 0.75));
    data.objects().addObject(barrelObj);

    const mid = segStart.clone().lerp(segEnd, 0.52);
    const mannequin = new Box(
        new THREE.Vector3(mid.x, 0.9, mid.z),
        new THREE.Vector3(0.38, 1.75, 0.28)
    );
    mannequin.color(0xff6600);
    data.objects().addObject(mannequin);

    return {
        startingPosition: new THREE.Vector3(-1.417105926071305, 0, -0.6976319457007996),
        startingRotation: new THREE.Euler(0, -1.6271112603790705, 0)
    };
}
