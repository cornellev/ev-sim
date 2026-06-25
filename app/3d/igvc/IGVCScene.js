import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Road } from "../city/Road";
import Unit from "@/app/util/Unit";
import { Data } from "../data/Data";
import { Intersection } from "../city/Intersection";
import { StopSign } from "../city/objects/StopSign";
import { generateBuildings } from "../city/BuildingGenerator";
import { Barrel } from "../city/objects/Barrel";

const locations = `42°40'05.93"N 83°13'03.15"W -> 42°40'04.71"N 83°13'03.11"W
42°40'04.59"N 83°13'02.44"W -> 42°40'04.59"N 83°13'02.95"W
42°40'04.58"N 83°13'03.24"W -> 42°40'04.57"N 83°13'03.78"W
42°40'06.05"N 83°13'03.31"W -> 42°40'06.04"N 83°13'03.81"W
42°40'06.14"N 83°13'03.96"W -> 42°40'06.28"N 83°13'03.96"W
42°40'06.02"N 83°13'04.13"W -> 42°40'06.01"N 83°13'04.64"W
42°40'05.91"N 83°13'03.98"W -> 42°40'05.43"N 83°13'03.97"W
42°40'05.30"N 83°13'04.10"W -> 42°40'05.29"N 83°13'04.26"W
42°40'05.31"N 83°13'03.80"W -> 42°40'05.31"N 83°13'03.62"W
42°40'05.19"N 83°13'03.95"W -> 42°40'04.70"N 83°13'03.94"W
42°40'04.56"N 83°13'04.08"W -> 42°40'04.55"N 83°13'04.58"W
42°40'04.69"N 83°13'04.74"W -> 42°40'05.90"N 83°13'04.79"W`.split("\n").map(line => line.split(" -> "));

const raw_intersections = `0,3
0,1,2
2,10,9
9,7,6,8
3,6,5,4
11,5
10,11`.split("\n").map(line => line.split(",").map(i => parseInt(i)));

const stopSigns = [
    {
        position: convertStringToLatLng(`42°40'05.85"N 83°13'03.77"W`),
        dir: 1
    },
    {
        position: convertStringToLatLng(`42°40'04.75"N 83°13'03.30"W`),
        dir: 3
    },
    {
        position: convertStringToLatLng(`42°40'05.86"N 83°13'04.17"W`),
        dir: 0
    }
]

const barrels = `42°40'05.62"N 83°13'03.20"W
42°40'05.19"N 83°13'03.06"W
42°40'05.25"N 83°13'04.70"W
42°40'05.66"N 83°13'04.85"W
42°40'04.71"N 83°13'03.77"W`.split("\n").map(convertStringToLatLng);

export const locationsLatLng = locations.map(([start, end]) => {
    return {
        start: convertStringToLatLng(start),
        end: convertStringToLatLng(end)
    };
});


/**
 * 
 * @param {THREE.Scene} scene 
 * @param {Data} data 
 */
export async function setupIGVC(scene, data) {
    const roads = [];
    let baseOffset = null;

    
    for (const {start, end} of locationsLatLng) {
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

    console.log("IGVC scene setup complete");

    for (const [i, rds] of raw_intersections.entries()) {
        const iroads = [];
        for (const roadIndex of rds) {
            iroads.push(roads[roadIndex]);
        }
        // console.log(iroads)
        const intersection = new Intersection(iroads);
        
        data.city().addIntersection(intersection);
    }

    data.city().setupIntersections(scene);

    for (const {position, dir} of stopSigns) {
        const pos = convertFromLatLng(position.lat, position.lng).sub(baseOffset);
        pos.z *= -1;

        const stopSign = new StopSign(new THREE.Vector3(pos.x, 0, pos.z), new Unit(5, Unit.Type.FOOT), dir);
        data.objects().addObject(stopSign);
    }   

    for (const position of barrels) {
        const pos = convertFromLatLng(position.lat, position.lng).sub(baseOffset);
        pos.z *= -1;

        const barrel = new Barrel(new THREE.Vector3(pos.x, 0, pos.z), new THREE.Vector3(0.75, 1, 0.75));
        data.objects().addObject(barrel);
    }

    generateBuildings(scene, data, {
        seed: data.bakeRunConfig?.()?.seed ?? 42,
        debugTileMaterials: data.bakeRunConfig?.()?.debug?.buildingTileMaterials === true,
        debugTileSize: data.bakeRunConfig?.()?.debug?.buildingTileSize ?? 2,
    });

    // generate floor
    const floorSize = 200;
    const floorGeometry = new THREE.PlaneGeometry(floorSize, floorSize);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x555555 });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05; // slight offset to prevent z-fighting with road surfaces
    // scene.add(floor);
    
}