import * as THREE from "three";
import { convertStringToLatLng } from "@/app/util/Location";
import { Barrel } from "../../city/objects/Barrel";
import { StopSign } from "../../city/objects/StopSign";
import { Intersection } from "../../city/Intersection";
import Unit from "@/app/util/Unit";
import { addDuctTape30cm, buildFiiiRoads, toScene } from "./fiiiCommon";

const barrelStart = convertStringToLatLng(`42°40'05.71"N 83°13'04.04"W`);
const barrelEnd = convertStringToLatLng(`42°40'06.30"N 83°13'03.90"W`);
const stopSignLL = convertStringToLatLng(`42°40'05.85"N 83°13'03.77"W`);

export async function FIII1(scene, data) {
    const { roads, baseOffset } = buildFiiiRoads();

    data.city().addRoads(roads);

    await data.city().setupRoads(scene);

    const intersection = new Intersection([roads[0], roads[1], roads[2], roads[3]]);

    data.city().addIntersection(intersection);
    await data.city().setupIntersections(scene);

    const stopWorld = toScene(stopSignLL, baseOffset);
    const stopSign = new StopSign(stopWorld.clone(), new Unit(5, Unit.Type.FOOT), 1);
    data.objects().addObject(stopSign);

    const b1 = toScene(barrelStart, baseOffset);
    const b2 = toScene(barrelEnd, baseOffset);
    data.objects().addObject(new Barrel(new THREE.Vector3(b1.x, 0, b1.z), new THREE.Vector3(0.75, 1, 0.75)));
    data.objects().addObject(new Barrel(new THREE.Vector3(b2.x, 0, b2.z), new THREE.Vector3(0.75, 1, 0.75)));

    addDuctTape30cm(data, intersection, roads, stopWorld);

    return {
        startingPosition: new THREE.Vector3(0.5964710243071336, 0, -1.575427667442955),
        startingRotation: new THREE.Euler(0, -3.115908887240864, 0)
    };
}
