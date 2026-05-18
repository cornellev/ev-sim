import * as THREE from "three";
import { convertFromLatLng, convertStringToLatLng } from "@/app/util/Location";
import { Box } from "../../data/objects/Box";
import { Road } from "../../city/Road";
import Unit from "@/app/util/Unit";

/** Same four-leg layout as q3/q4 (do not import q3 — duplicate constants only). */
export const FIII_LOCATIONS = [
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

/**
 * Dashed “duct tape” line ~30 cm on the vehicle side of the stop line (FIII.*).
 * @param {THREE.Vector3} stopSignWorld Position used to pick the nearest yield boundary.
 */
export function addDuctTape30cm(data, intersection, roads, stopSignWorld) {
    const lines = intersection.yieldBoundaries;
    if (!lines?.length) return;

    const center = new THREE.Vector3();
    let n = 0;
    for (const r of roads) {
        for (const p of r.points) {
            center.add(p);
            n++;
        }
    }
    center.divideScalar(Math.max(1, n));

    let best = null;
    let bestD = Infinity;
    for (const line of lines) {
        if (!line.length) continue;
        const mid = line[0].clone();
        if (line.length > 1) mid.lerp(line[line.length - 1], 0.5);
        const d = mid.distanceToSquared(stopSignWorld);
        if (d < bestD) {
            bestD = d;
            best = line;
        }
    }
    if (!best || best.length < 1) return;

    const p0 = best[0];
    const p1 = best[best.length - 1];
    const midStop = p0.clone().lerp(p1, 0.5);
    const outward = midStop.clone().sub(center);
    outward.y = 0;
    if (outward.lengthSq() < 1e-10) return;
    outward.normalize();

    const tapeMid = midStop.clone().addScaledVector(outward, 0.32);

    let tangent = p1.clone().sub(p0);
    tangent.y = 0;
    if (tangent.lengthSq() < 1e-10) tangent.set(1, 0, 0);
    else tangent.normalize();

    for (let i = -6; i <= 6; i += 2) {
        const origin = tapeMid.clone().addScaledVector(tangent, i * 0.16);
        const dash = new Box(
            origin.clone().add(new THREE.Vector3(0, 0.015, 0)),
            new THREE.Vector3(0.14, 0.008, 0.09)
        );
        dash.color(0xfff8dc);
        data.objects().addObject(dash);
    }
}

/** @returns {{ roads: any[], baseOffset: THREE.Vector3 }} */
export function buildFiiiRoads() {
    const roads = [];
    let baseOffset = null;

    for (const { start, end } of FIII_LOCATIONS) {
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

    return { roads, baseOffset };
}

export function toScene(latLng, baseOffset) {
    const pos = convertFromLatLng(latLng.lat, latLng.lng).sub(baseOffset);
    pos.z *= -1;
    return new THREE.Vector3(pos.x, 0, pos.z);
}
