import * as THREE from "three";

import { laneDividerDescriptors } from "../../roads/RoadLaneModel.js";
import { authorRoadsFromMetric } from "../../roads/RoadGeometryRecord.js";
import { compileRoadNetworkGeometry, planRoadNetworkGeometry } from "../../roads/RoadNetworkGeometry.js";

const MARKING_ELEVATION = 0.02;
const LANE_MARKING_WIDTH = 0.2;
const DASH_LENGTH = 3.5;
const DASH_GAP = 2.5;
const WHITE = 0xf3f3ef;
const YELLOW = 0xf0d25c;

const BORDER = Object.freeze({
    NONE: "none",
    SOLID_WHITE: "solid_white",
    SOLID_YELLOW: "solid_yellow",
    DASHED_WHITE: "dashed_white",
    DASHED_YELLOW: "dashed_yellow",
});

function metric(value) {
    return Math.round(Number(value) * 1e6) / 1e6;
}

function ribbonGeometry(points, type) {
    if (!type || type === BORDER.NONE || !Array.isArray(points) || points.length < 2) return null;
    const dashed = type === BORDER.DASHED_WHITE || type === BORDER.DASHED_YELLOW;
    const dashLength = Math.max(0.01, DASH_LENGTH);
    const dashGap = Math.max(0, DASH_GAP);
    const cycle = dashLength + dashGap;
    const halfWidth = Math.max(0.005, LANE_MARKING_WIDTH * 0.5);
    const vertices = [];
    const indices = [];
    let distance = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length <= 1e-9) continue;
        const include = !dashed || cycle <= 0 || ((distance + length * 0.5) % cycle) < dashLength;
        distance += length;
        if (!include) continue;
        const nx = -dz / length * halfWidth;
        const nz = dx / length * halfWidth;
        const offset = vertices.length;
        vertices.push(
            { x: start.x + nx, y: start.y + MARKING_ELEVATION, z: start.z + nz },
            { x: start.x - nx, y: start.y + MARKING_ELEVATION, z: start.z - nz },
            { x: end.x + nx, y: end.y + MARKING_ELEVATION, z: end.z + nz },
            { x: end.x - nx, y: end.y + MARKING_ELEVATION, z: end.z - nz },
        );
        indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
    }
    if (!indices.length) return null;
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((point, index) => {
        positions[index * 3] = metric(point.x);
        positions[index * 3 + 1] = metric(point.y);
        positions[index * 3 + 2] = metric(point.z);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function createMarkingMesh(points, type) {
    const geometry = ribbonGeometry(points, type);
    if (!geometry) return null;
    const yellow = type === BORDER.SOLID_YELLOW || type === BORDER.DASHED_YELLOW;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: yellow ? YELLOW : WHITE,
        side: THREE.DoubleSide,
    }));
    mesh.name = "RoadMarking";
    mesh.renderOrder = 10;
    mesh.userData.cevSimRenderRuntimeOwned = true;
    mesh.userData.cevSimRoadMarking = true;
    return mesh;
}

function markingLines(entry) {
    const lines = [
        [entry.carriagewayLeft, entry.edge.borderLeft ?? BORDER.SOLID_WHITE],
        [entry.carriagewayRight, entry.edge.borderRight ?? BORDER.SOLID_WHITE],
    ];
    for (const divider of laneDividerDescriptors(entry.edge)) {
        const left = entry.laneCenterlines?.[divider.dividerIndex - 1];
        const right = entry.laneCenterlines?.[divider.dividerIndex];
        if (!left || !right) continue;
        const count = Math.min(left.length, right.length);
        const points = Array.from({ length: count }, (_, index) => ({
            x: (left[index].x + right[index].x) * 0.5,
            y: (left[index].y + right[index].y) * 0.5,
            z: (left[index].z + right[index].z) * 0.5,
        }));
        // An authored boundary style wins. Otherwise opposing lanes are dashed
        // yellow and same-direction lanes are dashed white.
        lines.push([
            points,
            divider.marking ?? (divider.opposing ? BORDER.DASHED_YELLOW : BORDER.DASHED_WHITE),
        ]);
    }
    return lines;
}

/** Appearance-only lane paint. Empty roads add nothing and analytic bindings stay untouched. */
export function addPbrRoadMarkings(scene, roads) {
    if (!scene || !Array.isArray(roads?.edges) || roads.edges.length === 0) return [];
    // Metric world records omit editor knot ids. Rehydrate them the same way
    // world validation compiles drivable surfaces.
    const compiled = compileRoadNetworkGeometry(planRoadNetworkGeometry(authorRoadsFromMetric(roads)));
    const meshes = [];
    for (const entry of compiled.edges) {
        for (const [points, type] of markingLines(entry)) {
            const mesh = createMarkingMesh(points, type);
            if (!mesh) continue;
            scene.add(mesh);
            meshes.push(mesh);
        }
    }
    return meshes;
}
