import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Barrel } from "../../city/objects/Barrel";
import { StopSign } from "../../city/objects/StopSign";
import { Road } from "../../city/Road";
import Unit from "@/app/util/Unit";

const road = {
    start: convertStringToLatLng(`42°40'05.93"N 83°13'03.15"W`),
    end: convertStringToLatLng(`42°40'04.71"N 83°13'03.11"W`)
};

const barrel = convertStringToLatLng(`42°40'05.20"N 83°13'03.19"W`);

/** Secondary stop-sign props for judge swap simulation (same mesh, offset positions). */
const extraStops = [
    convertStringToLatLng(`42°40'05.15"N 83°13'03.18"W`),
    convertStringToLatLng(`42°40'04.95"N 83°13'03.14"W`)
];

const locations = [road];

export async function FII1(scene, data) {
    const roads = [];
    let baseOffset = null;

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

    const bpos = convertFromLatLng(barrel.lat, barrel.lng).sub(baseOffset);
    bpos.z *= -1;

    const barrelObj = new Barrel(new THREE.Vector3(bpos.x, 0, bpos.z), new THREE.Vector3(0.75, 1, 0.75));
    data.objects().addObject(barrelObj);

    const curve = new THREE.CatmullRomCurve3(
        [roads[0].points[0], roads[0].points[1], roads[0].points[2]],
        false,
        "catmullrom",
        roads[0].options.tension ?? 0.15
    );
    const signGround = curve.getPointAt(0.82);
    signGround.y = 0;
    const stopSign = new StopSign(new THREE.Vector3(signGround.x, signGround.y, signGround.z), new Unit(5, Unit.Type.FOOT), 1);
    data.objects().addObject(stopSign);

    for (const ll of extraStops) {
        const p = convertFromLatLng(ll.lat, ll.lng).sub(baseOffset);
        p.z *= -1;
        const sign = new StopSign(new THREE.Vector3(p.x, 0, p.z), new Unit(5, Unit.Type.FOOT), 1);
        data.objects().addObject(sign);
    }

    return {
        startingPosition: new THREE.Vector3(-1.417105926071305, 0, -0.6976319457007996),
        startingRotation: new THREE.Euler(0, -1.6271112603790705, 0)
    };
}
