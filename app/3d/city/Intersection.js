import * as THREE from "three";
import Unit from "@/app/util/Unit";
import { Road } from "./Road";

const UP = new THREE.Vector3(0, 1, 0);

const DEFAULT_OPTIONS = {
    cornerSamples: 12,
    cornerInsetScale: 0.9,
    cornerInsetMin: 1.4,
    cornerInsetMax: 6,
    lineSamples: 24,
    lineWidth: 0.1,
    stopLineWidth: 0.35,
    stopLineInset: 0.8,
    lineRoughness: 0.8,
    lineMetalness: 0,
    lineRenderOrder: 12,
    oppositeRoadDotThreshold: -0.92,
};

function averagePoints(points) {
    if (!points.length) return new THREE.Vector3();

    const sum = new THREE.Vector3();
    for (const point of points) {
        sum.add(point);
    }

    return sum.multiplyScalar(1 / points.length);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function dedupeClosingPoint(points) {
    if (points.length < 2) return points;

    const first = points[0];
    const last = points[points.length - 1];
    return first.distanceToSquared(last) < 1e-8 ? points.slice(0, -1) : points;
}

function buildPlanarShapeGeometry(points, y) {
    const clean = dedupeClosingPoint(points);
    if (clean.length < 3) return null;

    const shape = new THREE.Shape();
    shape.moveTo(clean[0].x, clean[0].z);

    for (let i = 1; i < clean.length; i++) {
        shape.lineTo(clean[i].x, clean[i].z);
    }

    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape, 24);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, y, 0);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function buildStripGeometry(leftPoints, rightPoints) {
    const count = Math.min(leftPoints.length, rightPoints.length);
    if (count < 2) return null;

    const positions = new Float32Array(count * 2 * 3);
    const indices = new Uint32Array((count - 1) * 6);

    for (let i = 0; i < count; i++) {
        const left = leftPoints[i];
        const right = rightPoints[i];
        const index = i * 6;

        positions[index + 0] = left.x;
        positions[index + 1] = left.y;
        positions[index + 2] = left.z;
        positions[index + 3] = right.x;
        positions[index + 4] = right.y;
        positions[index + 5] = right.z;
    }

    let ii = 0;
    for (let i = 0; i < count - 1; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;

        indices[ii++] = a;
        indices[ii++] = b;
        indices[ii++] = d;
        indices[ii++] = a;
        indices[ii++] = d;
        indices[ii++] = c;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function createPolylineRibbon(points, width) {
    if (!points || points.length < 2) return null;

    const left = [];
    const right = [];
    const halfWidth = width * 0.5;

    for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        const tangent = next.clone().sub(prev).setY(0);

        if (tangent.lengthSq() === 0) {
            tangent.set(1, 0, 0);
        } else {
            tangent.normalize();
        }

        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        left.push(current.clone().addScaledVector(normal, halfWidth));
        right.push(current.clone().addScaledVector(normal, -halfWidth));
    }

    return buildStripGeometry(left, right);
}

function intersectRays2D(pointA, dirA, pointB, dirB) {
    const det = dirA.x * dirB.z - dirA.z * dirB.x;
    if (Math.abs(det) < 1e-6) return null;

    const dx = pointB.x - pointA.x;
    const dz = pointB.z - pointA.z;
    const t = (dx * dirB.z - dz * dirB.x) / det;

    return new THREE.Vector3(
        pointA.x + dirA.x * t,
        pointA.y,
        pointA.z + dirA.z * t,
    );
}

function sampleQuadraticCurve(start, control, end, segments, y) {
    const curve = new THREE.QuadraticBezierCurve3(
        start.clone().setY(y),
        control.clone().setY(y),
        end.clone().setY(y),
    );

    return curve.getPoints(Math.max(2, segments));
}

function createRoundedCorner(start, end, tangentA, tangentB, fallbackCenter, segments, y) {
    const control = intersectRays2D(start, tangentA, end, tangentB)
        || start.clone().lerp(end, 0.5).lerp(fallbackCenter, 0.35);

    return sampleQuadraticCurve(start, control, end, segments, y);
}

function getInsetAmount(current, next, options) {
    const desiredInset = clamp(
        Math.min(current.width, next.width) * options.cornerInsetScale,
        options.cornerInsetMin,
        options.cornerInsetMax,
    );
    const maxInset = Math.max(0, Math.min(current.approachLength, next.approachLength) * 0.8);

    return Math.min(desiredInset, maxInset);
}

function getBoundaryPoint(connection, key, inset) {
    return connection[key].clone().addScaledVector(connection.tangent, inset);
}

function buildRoundedBoundary(connections, startKey, endKey, center, samples, options) {
    if (connections.length < 2) return [];

    const boundary = [connections[0][startKey].clone()];

    for (let i = 0; i < connections.length; i++) {
        const current = connections[i];
        const next = connections[(i + 1) % connections.length];
        const inset = getInsetAmount(current, next, options);
        const currentEnd = current[endKey].clone();
        const nextStart = next[startKey].clone();
        const endPoint = getBoundaryPoint(current, endKey, inset);
        const nextStartPoint = getBoundaryPoint(next, startKey, inset);

        boundary.push(currentEnd);

        if (currentEnd.distanceToSquared(endPoint) > 1e-8) {
            boundary.push(endPoint);
        }

        const cornerPoints = createRoundedCorner(
            endPoint,
            nextStartPoint,
            current.tangent,
            next.tangent,
            center,
            samples,
            endPoint.y,
        );

        boundary.push(...cornerPoints.slice(1));

        if (nextStartPoint.distanceToSquared(nextStart) > 1e-8) {
            boundary.push(nextStart);
        }
    }

    return dedupeClosingPoint(boundary);
}

function lineTypeColor(type, connection) {
    const isYellow = type === Road.BorderType.SOLID_YELLOW || type === Road.BorderType.DASHED_YELLOW;
    return isYellow ? connection.yellowLineColor : connection.whiteLineColor;
}

function isRoadDirectedIntoIntersection(connection) {
    const direction = connection.road?.direction ?? connection.road?.options?.direction ?? 0;
    if (direction === 0) return false;

    return connection.useStart ? direction < 0 : direction > 0;
}

function createStopLineSegment(connection, inset) {
    const offset = -Math.max(0, inset);
    const start = connection.roadRight.clone()
        .addScaledVector(connection.tangent, offset)
        .setY(connection.markingElevation);
    const end = connection.roadLeft.clone()
        .addScaledVector(connection.tangent, offset)
        .setY(connection.markingElevation);

    return [start, end];
}

function createLineMaterial(color) {
    return new THREE.MeshStandardMaterial({
        color,
        roughness: DEFAULT_OPTIONS.lineRoughness,
        metalness: DEFAULT_OPTIONS.lineMetalness,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });
}

function addRibbonLine(root, points, width, material) {
    const geometry = createPolylineRibbon(points, width);
    if (!geometry) return;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = DEFAULT_OPTIONS.lineRenderOrder;
    root.add(mesh);
}

function addDashedRibbon(root, start, control, end, width, material, dashLength, dashGap, y) {
    const curve = new THREE.QuadraticBezierCurve3(
        start.clone().setY(y),
        control.clone().setY(y),
        end.clone().setY(y),
    );
    const totalLength = curve.getLength();
    const stride = Math.max(0.2, dashLength + dashGap);

    for (let distance = 0; distance < totalLength; distance += stride) {
        const segmentEnd = Math.min(distance + dashLength, totalLength);
        const u0 = totalLength === 0 ? 0 : distance / totalLength;
        const u1 = totalLength === 0 ? 1 : segmentEnd / totalLength;
        const points = [];
        const segments = Math.max(3, Math.ceil((segmentEnd - distance) * 2));

        for (let i = 0; i <= segments; i++) {
            const u = THREE.MathUtils.lerp(u0, u1, i / segments);
            points.push(curve.getPointAt(u));
        }

        addRibbonLine(root, points, width, material);
    }
}

function getRoadConnectionData(road, referencePoint) {
    const points = road?.points || [];
    if (points.length < 2) return null;

    const first = points[0];
    const last = points[points.length - 1];
    const useStart = first.distanceToSquared(referencePoint) <= last.distanceToSquared(referencePoint);
    const mouthCenter = (useStart ? first : last).clone();
    const neighbor = (useStart ? points[1] : points[points.length - 2]).clone();
    const tangent = mouthCenter.clone().sub(neighbor).setY(0);
    if (tangent.lengthSq() === 0) return null;
    tangent.normalize();
    const approachLength = Math.max(0, mouthCenter.distanceTo(neighbor));

    const left = new THREE.Vector3().crossVectors(UP, tangent).normalize();
    const width = road.width.getValue(Unit.Type.METER);
    const halfWidth = width * 0.5;
    const shoulderWidth = Math.max(0, road.options?.shoulderWidth ?? 0);
    const shoulderHalfWidth = halfWidth + shoulderWidth;
    const elevation = road.options?.elevation ?? 0.015;
    const shoulderElevation = road.options?.shoulderElevation ?? 0.008;

    return {
        road,
        useStart,
        mouthCenter,
        tangent,
        approachLength,
        left,
        width,
        halfWidth,
        laneCount: Math.max(1, Math.round(road.options?.laneCount ?? 1)),
        roadLeft: mouthCenter.clone().addScaledVector(left, halfWidth).setY(elevation),
        roadRight: mouthCenter.clone().addScaledVector(left, -halfWidth).setY(elevation),
        shoulderLeft: mouthCenter.clone().addScaledVector(left, shoulderHalfWidth).setY(shoulderElevation),
        shoulderRight: mouthCenter.clone().addScaledVector(left, -shoulderHalfWidth).setY(shoulderElevation),
        elevation,
        shoulderElevation,
        markingElevation: road.options?.markingElevation ?? 0.02,
        laneMarkingWidth: road.options?.laneMarkingWidth ?? DEFAULT_OPTIONS.lineWidth,
        centerLineType: road.options?.centerLineType ?? Road.BorderType.DASHED_YELLOW,
        dashLength: road.options?.dashLength ?? 3,
        dashGap: road.options?.dashGap ?? 2.2,
        whiteLineColor: road.options?.whiteLineColor ?? 0xf3f3ef,
        yellowLineColor: road.options?.yellowLineColor ?? 0xf0d25c,
    };
}

function sortConnections(connections) {
    return [...connections].sort(
        (a, b) => Math.atan2(-a.tangent.z, -a.tangent.x) - Math.atan2(-b.tangent.z, -b.tangent.x),
    );
}

export class Intersection {
    /**
     * @param {Road[]} roads Roads ordered clockwise around the intersection.
     * @param {Object} options
     */
    constructor(roads = [], options = {}) {
        this.roads = roads;
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.root = null;
    }

    setup(scene) {
        if (!scene || this.roads.length < 2) return null;

        if (this.root?.parent) {
            this.root.parent.remove(this.root);
        }

        const referenceCenter = averagePoints(this.roads.flatMap((road) => road?.points || []));
        const connections = sortConnections(this.roads
            .map((road) => getRoadConnectionData(road, referenceCenter))
            .filter(Boolean));

        if (connections.length < 2) return null;

        const boundaryCenter = averagePoints(connections.map((connection) => connection.mouthCenter));
        const roadBoundary = buildRoundedBoundary(
            connections,
            "roadRight",
            "roadLeft",
            boundaryCenter,
            this.options.cornerSamples,
            this.options,
        );
        const shoulderBoundary = buildRoundedBoundary(
            connections,
            "shoulderRight",
            "shoulderLeft",
            boundaryCenter,
            this.options.cornerSamples,
            this.options,
        );

        const roadGeometry = buildPlanarShapeGeometry(roadBoundary, connections[0].elevation);
        const shoulderGeometry = buildPlanarShapeGeometry(shoulderBoundary, connections[0].shoulderElevation);
        if (!roadGeometry || !shoulderGeometry) return null;

        const baseRoadOptions = connections[0].road.options || {};
        const root = new THREE.Group();
        root.name = "Intersection";

        const shoulderMaterial = new THREE.MeshStandardMaterial({
            color: this.options.shoulderColor ?? baseRoadOptions.shoulderColor ?? 0x55585d,
            roughness: this.options.shoulderRoughness ?? baseRoadOptions.shoulderRoughness ?? 1,
            metalness: this.options.metalness ?? baseRoadOptions.metalness ?? 0.02,
            side: THREE.DoubleSide,
        });

        const roadMaterial = new THREE.MeshStandardMaterial({
            color: this.options.surfaceColor ?? baseRoadOptions.surfaceColor ?? 0x2f3236,
            roughness: this.options.surfaceRoughness ?? baseRoadOptions.surfaceRoughness ?? 0.95,
            metalness: this.options.metalness ?? baseRoadOptions.metalness ?? 0.02,
            side: THREE.DoubleSide,
        });

        const shoulderMesh = new THREE.Mesh(shoulderGeometry, shoulderMaterial);
        shoulderMesh.receiveShadow = true;
        root.add(shoulderMesh);

        const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
        roadMesh.receiveShadow = true;
        root.add(roadMesh);

        if (connections.length > 2) {
            for (const connection of connections) {
                if (!isRoadDirectedIntoIntersection(connection)) continue;

                const stopLinePoints = createStopLineSegment(
                    connection,
                    Math.min(this.options.stopLineInset, connection.approachLength * 0.5),
                );

                addRibbonLine(
                    root,
                    stopLinePoints,
                    this.options.stopLineWidth ?? connection.laneMarkingWidth,
                    createLineMaterial(connection.whiteLineColor),
                );
            }
        }

        this.root = root;
        scene.add(root);
        return root;
    }
}