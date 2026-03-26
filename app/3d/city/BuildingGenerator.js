import * as THREE from 'three';
import { Data } from '../data/Data';

function partitionLength(totalLength, minWidth, maxWidth, variation = 0.25) {
    if (totalLength <= 0) return [];

    // Tiny leftover strip: either skip it or keep one undersized lot.
    if (totalLength < minWidth) return [totalLength];

    // If the whole strip fits inside one valid building width, just use one.
    if (totalLength <= maxWidth) return [totalLength];

    const minCount = Math.ceil(totalLength / maxWidth);
    const maxCount = Math.floor(totalLength / minWidth);

    if (minCount > maxCount) {
        // Impossible to satisfy strictly; fallback to one strip
        return [totalLength];
    }

    // Pick a reasonable count near the midpoint width.
    const targetWidth = (minWidth + maxWidth) * 0.5;
    let count = Math.round(totalLength / targetWidth);
    count = THREE.MathUtils.clamp(count, minCount, maxCount);

    const baseWidth = totalLength / count;
    const widths = new Array(count).fill(baseWidth);

    // Optional jitter so every building is not identical,
    // while keeping total footprint exactly the same.
    if (variation > 0 && count > 1) {
        for (let pass = 0; pass < count * 3; pass++) {
            const i = Math.floor(Math.random() * (count - 1));

            const maxPositive = Math.min(
                widths[i] - minWidth,
                maxWidth - widths[i + 1],
                baseWidth * variation
            );

            const maxNegative = Math.min(
                maxWidth - widths[i],
                widths[i + 1] - minWidth,
                baseWidth * variation
            );

            const delta = THREE.MathUtils.lerp(-maxNegative, maxPositive, Math.random());

            widths[i] -= delta;
            widths[i + 1] += delta;
        }
    }

    return widths;
}

function makeFootprintsForSide(start, end, normal, params) {
    const tangentVec = new THREE.Vector3().subVectors(end, start).setY(0);
    const totalLength = tangentVec.length();
    if (totalLength < 0.001) return [];

    const tangent = tangentVec.clone().normalize();

    const inset = Math.min(params.intersectionInset, totalLength * 0.45);
    const usableStart = inset;
    const usableLength = totalLength - inset * 2;

    if (usableLength < params.minWidth) return [];

    const widths = partitionLength(
        usableLength,
        params.minWidth,
        params.maxWidth,
        0.3
    );

    const footprints = [];
    let cursor = usableStart;

    for (const width of widths) {
        const s0 = cursor;
        const s1 = cursor + width;

        const p0 = start.clone()
            .add(tangent.clone().multiplyScalar(s0))
            .add(normal.clone().multiplyScalar(params.depthOffRoad));

        const p1 = start.clone()
            .add(tangent.clone().multiplyScalar(s0))
            .add(normal.clone().multiplyScalar(params.depthOffRoad + params.buildingDepth));

        const p2 = start.clone()
            .add(tangent.clone().multiplyScalar(s1))
            .add(normal.clone().multiplyScalar(params.depthOffRoad + params.buildingDepth));

        const p3 = start.clone()
            .add(tangent.clone().multiplyScalar(s1))
            .add(normal.clone().multiplyScalar(params.depthOffRoad));

        footprints.push([p0, p1, p2, p3]);
        cursor = s1;
    }

    return footprints;
}

function toXZ(v) {
    return new THREE.Vector2(v.x, v.z);
}

function getFootprintAxes(footprint) {
    const pts = footprint.map(toXZ);

    const edge0 = pts[1].clone().sub(pts[0]).normalize();
    const edge1 = pts[3].clone().sub(pts[0]).normalize();

    return [edge0, edge1];
}

function projectFootprint(axis, footprint) {
    let min = Infinity;
    let max = -Infinity;

    for (const p3 of footprint) {
        const p = toXZ(p3);
        const d = p.dot(axis);
        if (d < min) min = d;
        if (d > max) max = d;
    }

    return { min, max };
}

function intervalsOverlap(a, b, padding = 0) {
    return a.max > b.min + padding && b.max > a.min + padding;
}

function footprintsOverlap(a, b, padding = 0) {
    const axes = [...getFootprintAxes(a), ...getFootprintAxes(b)];

    for (const axis of axes) {
        const projA = projectFootprint(axis, a);
        const projB = projectFootprint(axis, b);

        if (!intervalsOverlap(projA, projB, padding)) {
            return false;
        }
    }

    return true;
}

function footprintAreaXZ(footprint) {
    const a = toXZ(footprint[0]);
    const b = toXZ(footprint[1]);
    const d = toXZ(footprint[3]);

    const width = d.distanceTo(a);
    const depth = b.distanceTo(a);
    return width * depth;
}

function filterOverlappingFootprints(footprints, padding = 0.1) {
    // Keep larger footprints first
    const sorted = [...footprints].sort(
        (a, b) => footprintAreaXZ(b) - footprintAreaXZ(a)
    );

    const accepted = [];

    for (const candidate of sorted) {
        let overlaps = false;

        for (const existing of accepted) {
            if (footprintsOverlap(candidate, existing, padding)) {
                overlaps = true;
                break;
            }
        }

        if (!overlaps) {
            accepted.push(candidate);
        }
    }

    return accepted;
}

/**
 * @param {THREE.Scene} scene
 * @param {Data} data
 */
export function generateBuildings(scene, data) {
    const roads = data.city().getRoads();

    const params = {
        depthOffRoad: 2,
        buildingDepth: 5,
        minWidth: 5,
        maxWidth: 20,
        heightRange: [6, 14],
        intersectionInset: 0,   // push buildings away from road ends
        overlapPadding: 0.2     // tiny epsilon
    };

    const rectangles = [];

    for (const road of roads) {
        const leftPoints = road.roadEdges.left;
        const rightPoints = road.roadEdges.right;

        const leftStart = leftPoints[0].clone().setY(0);
        const leftEnd = leftPoints[leftPoints.length - 1].clone().setY(0);

        const up = new THREE.Vector3(0, 1, 0);
        const tangent = new THREE.Vector3().subVectors(leftEnd, leftStart).setY(0).normalize();

        const leftNormal = new THREE.Vector3().crossVectors(up, tangent).normalize();
        const rightNormal = leftNormal.clone().negate();

        const rightStart = rightPoints[0].clone().setY(0);
        const rightEnd = rightPoints[rightPoints.length - 1].clone().setY(0);

        rectangles.push(
            ...makeFootprintsForSide(leftStart, leftEnd, leftNormal, params),
            ...makeFootprintsForSide(rightStart, rightEnd, rightNormal, params)
        );
    }

    const filtered = filterOverlappingFootprints(
        rectangles,
        params.overlapPadding
    );

    console.log("Generated", rectangles.length, "building footprints,", filtered.length, "after filtering overlaps");


    // generate lines between each rectangle corner to visualize the building footprints
    // visualizeFootprints(scene, filtered);

    generateBuildingMeshes(scene, filtered, params);
}

function visualizeFootprints(scene, footprints) {
    const material = new THREE.LineBasicMaterial({ color: 0x00ff00 });

    for (const footprint of footprints) {
        // footprint = [p0, p1, p2, p3]
        const points = [
            ...footprint,
            footprint[0] // close the loop
        ];

        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);
        scene.add(line);
    }
}

function chooseTexture() {
    const basePath = `assets/textures/buildings/`;
    const maxIndex = 6;
    return `${basePath}${Math.ceil(Math.random() * maxIndex)}.jpg`;
}

function generateBuildingMeshes(scene, footprints, params) {
    const meshes = [];

    for (const footprint of footprints) {
        if (!footprint || footprint.length < 3) continue;

        const height = THREE.MathUtils.lerp(
            params.heightRange[0],
            params.heightRange[1],
            Math.random()
        );

        // Build the 2D shape in local XY, using -z so that after rotation
        // it lands back in world XZ with the same footprint orientation.
        let points2D = footprint.map(p => new THREE.Vector2(p.x, -p.z));

        // Keep outer contour winding consistent for triangulation/caps.
        if (THREE.ShapeUtils.isClockWise(points2D)) {
            points2D = points2D.reverse();
        }

        const shape = new THREE.Shape(points2D);

        const geometry = new THREE.ExtrudeGeometry(shape, {
            steps: 1,
            depth: height,
            bevelEnabled: false
        });

        // ExtrudeGeometry extrudes along local +Z.
        // Rotate so extrusion becomes world +Y.
        geometry.rotateX(-Math.PI / 2);

        // Put the base on the ground plane cleanly.
        geometry.computeBoundingBox();
        if (geometry.boundingBox) {
            geometry.translate(0, -geometry.boundingBox.min.y, 0);
        }

        geometry.computeVertexNormals();

        const texture = new THREE.TextureLoader().load(chooseTexture());
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, height / 10);
        const material = new THREE.MeshStandardMaterial({
            map: texture,
            side: THREE.FrontSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        scene.add(mesh);
        meshes.push(mesh);
    }

    return meshes;
}