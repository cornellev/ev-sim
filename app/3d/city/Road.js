import * as THREE from "three";
import Unit from "@/app/util/Unit";

const UP = new THREE.Vector3(0, 1, 0);

const RoadBorderType = {
    NONE: "none",
    SOLID_WHITE: "solid_white",
    SOLID_YELLOW: "solid_yellow",
    DASHED_WHITE: "dashed_white",
    DASHED_YELLOW: "dashed_yellow",
};

const DEFAULT_OPTIONS = {
    laneCount: 2,
    shoulderWidth: 0.8,
    tension: 0.15,
    elevation: 0.015,
    shoulderElevation: 0.008,
    markingElevation: 0.02,
    laneMarkingWidth: 0.14,
    dashLength: 3,
    dashGap: 2.2,
    centerLineType: RoadBorderType.DASHED_YELLOW,
    surfaceColor: 0x2f3236,
    shoulderColor: 0x55585d,
    whiteLineColor: 0xf3f3ef,
    yellowLineColor: 0xf0d25c,
    surfaceRoughness: 0.95,
    shoulderRoughness: 1,
    metalness: 0.02,
    direction: 1, // 0 = no direction, 1 = forward, -1 = backward
};

function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function getBorderColor(type, options) {
    if (type === RoadBorderType.SOLID_YELLOW || type === RoadBorderType.DASHED_YELLOW) {
        return options.yellowLineColor;
    } else if (type === RoadBorderType.SOLID_WHITE || type === RoadBorderType.DASHED_WHITE) {
        return options.whiteLineColor;
    }
    return null;
}

export function buildStripGeometry(leftPoints, rightPoints) {
    const count = Math.min(leftPoints.length, rightPoints.length);
    if (count < 2) return null;

    const positions = new Float32Array(count * 2 * 3);
    const uvs = new Float32Array(count * 2 * 2);
    const indices = new Uint32Array((count - 1) * 6);

    for (let i = 0; i < count; i++) {
        const left = leftPoints[i];
        const right = rightPoints[i];
        const pIndex = i * 6;
        const uvIndex = i * 4;
        const u = count > 1 ? i / (count - 1) : 0;

        positions[pIndex + 0] = left.x;
        positions[pIndex + 1] = left.y;
        positions[pIndex + 2] = left.z;
        positions[pIndex + 3] = right.x;
        positions[pIndex + 4] = right.y;
        positions[pIndex + 5] = right.z;

        uvs[uvIndex + 0] = 0;
        uvs[uvIndex + 1] = u;
        uvs[uvIndex + 2] = 1;
        uvs[uvIndex + 3] = u;
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
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
}

function computeOffsetPoint(curve, u, lateralOffset, y) {
    const point = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u).normalize();
    const normal = new THREE.Vector3().crossVectors(UP, tangent);

    if (normal.lengthSq() === 0) {
        normal.set(-tangent.z, 0, tangent.x);
    }

    normal.normalize();

    return point.addScaledVector(normal, lateralOffset).setY(y);
}

function sampleRoadEdges(curve, width, y, segments) {
    const left = [];
    const right = [];
    const halfWidth = width * 0.5;

    for (let i = 0; i <= segments; i++) {
        const u = segments === 0 ? 0 : i / segments;
        left.push(computeOffsetPoint(curve, u, halfWidth, y));
        right.push(computeOffsetPoint(curve, u, -halfWidth, y));
    }

    return { left, right };
}

function sampleOffsetCenterline(curve, lateralOffset, y, segments, startU = 0, endU = 1) {
    const points = [];

    for (let i = 0; i <= segments; i++) {
        const t = segments === 0 ? 0 : i / segments;
        points.push(computeOffsetPoint(curve, lerp(startU, endU, t), lateralOffset, y));
    }

    return points;
}

function createPolylineRibbon(points, width) {
    if (!points || points.length < 2) return null;

    const left = [];
    const right = [];
    const halfWidth = width * 0.5;

    for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const prev = points[Math.max(i - 1, 0)];
        const next = points[Math.min(i + 1, points.length - 1)];
        const tangent = next.clone().sub(prev);

        tangent.y = 0;

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

export function createSolidLine(curve, offset, options) {
    const points = sampleOffsetCenterline(curve, offset, options.markingElevation, options.segments);
    const geometry = createPolylineRibbon(points, options.laneMarkingWidth);
    if (!geometry) return null;

    const material = new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: 0.8,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 10;
    return mesh;
}

export function createDashedLine(curve, offset, options) {
    const group = new THREE.Group();
    const totalLength = curve.getLength();
    const stride = Math.max(0.2, options.dashLength + options.dashGap);

    const material = new THREE.MeshStandardMaterial({
        color: options.color,
        roughness: 0.8,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
    });

    for (let start = 0; start < totalLength; start += stride) {
        const end = Math.min(start + options.dashLength, totalLength);
        if (end <= start) continue;

        const startU = totalLength === 0 ? 0 : start / totalLength;
        const endU = totalLength === 0 ? 1 : end / totalLength;
        const points = sampleOffsetCenterline(
            curve,
            offset,
            options.markingElevation,
            Math.max(3, Math.ceil((end - start) * 2)),
            startU,
            endU
        );
        const geometry = createPolylineRibbon(points, options.laneMarkingWidth);
        if (!geometry) continue;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 10;
        group.add(mesh);
    }

    return group;
}

function createBorder(curve, type, offset, options) {
    if (!type || type === RoadBorderType.NONE) return null;

    const isYellow = type === RoadBorderType.SOLID_YELLOW || type === RoadBorderType.DASHED_YELLOW;
    const isDashed = type === RoadBorderType.DASHED_WHITE || type === RoadBorderType.DASHED_YELLOW;
    const color = isYellow ? options.yellowLineColor : options.whiteLineColor;

    return isDashed
        ? createDashedLine(curve, offset, { ...options, color })
        : createSolidLine(curve, offset, { ...options, color });
}

/**
 * A road in the city.
 * Uses a spline-defined centerline and builds a clean, simulation-ready road surface.
 */
export class Road {
    static BorderType = RoadBorderType;

    /**
     * @param {THREE.Vector3[]} points - control points for the road centerline
     * @param {Unit} width
     */
    constructor(
        points = [],
        width = new Unit(4, Unit.Type.METER),
        borderLeft = Road.BorderType.SOLID_WHITE,
        borderRight = Road.BorderType.SOLID_WHITE,
        options = {}
    ) {
        this.points = points;
        this.width = width;
        this.borderLeft = borderLeft;
        this.borderRight = borderRight;
        this.options = { ...DEFAULT_OPTIONS, ...options };

        this.root = null;

        this.roadEdges = null;

        this.oneWay = this.options.centerLineType === Road.BorderType.DASHED_WHITE || this.options.centerLineType === Road.BorderType.SOLID_WHITE;
        this.direction = this.oneWay ? options.direction : 0;
        if (this.direction === 0 && this.oneWay) {
            this.direction = 1;
        }
    }

    setup(scene) {
        if (this.points.length < 2) return null;

        if (this.root?.parent) {
            this.root.parent.remove(this.root);
        }

        const widthMeters = this.width.getValue(Unit.Type.METER);
        const curve = new THREE.CatmullRomCurve3(this.points, false, "catmullrom", this.options.tension);
        const segments = Math.max(48, Math.ceil(curve.getLength() * 2.5));
        const laneCount = Math.max(1, Math.round(this.options.laneCount));
        const laneWidth = widthMeters / laneCount;
        const shoulderWidth = Math.max(0, this.options.shoulderWidth);

        const shoulderEdges = sampleRoadEdges(curve, widthMeters + shoulderWidth * 2, this.options.shoulderElevation, segments);
        const roadEdges = sampleRoadEdges(curve, widthMeters, this.options.elevation, segments);
        this.roadEdges = roadEdges;

        const shoulderGeometry = buildStripGeometry(shoulderEdges.left, shoulderEdges.right);
        const roadGeometry = buildStripGeometry(roadEdges.left, roadEdges.right);
        if (!shoulderGeometry || !roadGeometry) return null;

        const shoulderMaterial = new THREE.MeshStandardMaterial({
            color: this.options.shoulderColor,
            roughness: this.options.shoulderRoughness,
            metalness: this.options.metalness,
            side: THREE.DoubleSide,
        });

        const roadMaterial = new THREE.MeshStandardMaterial({
            color: this.options.surfaceColor,
            roughness: this.options.surfaceRoughness,
            metalness: this.options.metalness,
            side: THREE.DoubleSide,
        });

        const root = new THREE.Group();
        root.name = "Road";

        const shoulderMesh = new THREE.Mesh(shoulderGeometry, shoulderMaterial);
        shoulderMesh.receiveShadow = true;
        root.add(shoulderMesh);

        const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
        roadMesh.receiveShadow = true;
        root.add(roadMesh);

        const leftBorder = createBorder(curve, this.borderLeft, widthMeters * 0.5, {
            ...this.options,
            segments,
        });
        if (leftBorder) root.add(leftBorder);

        const rightBorder = createBorder(curve, this.borderRight, -widthMeters * 0.5, {
            ...this.options,
            segments,
        });
        if (rightBorder) root.add(rightBorder);

        for (let laneIndex = 1; laneIndex < laneCount; laneIndex++) {
            const offset = -widthMeters * 0.5 + laneIndex * laneWidth;
            const type = laneCount === 2 && laneIndex === 1
                ? this.options.centerLineType
                : Road.BorderType.DASHED_WHITE;
            const divider = createBorder(curve, type, offset, {
                ...this.options,
                segments,
            });
            if (divider) root.add(divider);
        }

        this.root = root;
        scene.add(root);
        return root;
    }
}