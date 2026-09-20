import * as THREE from "three";
import { lerp } from "three/src/math/MathUtils";
import Unit from "@/app/util/Unit";
import { CameraFollower } from "../tools/CameraFollower";
import { LiDAR3d } from "../devices/LiDAR3d";
import { StereoCamera } from "../devices/StereoCamera";

const WHEELBASE = new Unit(49, Unit.Type.INCH).getValue(Unit.Type.METER);
const LOOKAHEAD = 15;
const SEGMENTS = 80;
const PATH_WIDTH = 1;
const PATH_Y = 0.02;
const UP = new THREE.Vector3(0, 1, 0);

function distancePointToSegmentXZ(point, a, b) {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const apx = point.x - a.x;
    const apz = point.z - a.z;

    const abLenSq = abx * abx + abz * abz;
    if (abLenSq === 0) {
        const dx = point.x - a.x;
        const dz = point.z - a.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    const t = THREE.MathUtils.clamp((apx * abx + apz * abz) / abLenSq, 0, 1);
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const dx = point.x - cx;
    const dz = point.z - cz;
    return Math.sqrt(dx * dx + dz * dz);
}

function isPointOverLane(point, lanePoints, laneHalfWidth) {
    if (!lanePoints || lanePoints.length < 2) return false;

    const maxVerticalDelta = 4;
    let minDist = Number.POSITIVE_INFINITY;
    let nearestLaneY = 0;

    for (let i = 0; i < lanePoints.length - 1; i++) {
        const a = lanePoints[i];
        const b = lanePoints[i + 1];
        const dist = distancePointToSegmentXZ(point, a, b);
        if (dist < minDist) {
            minDist = dist;
            nearestLaneY = (a.y + b.y) * 0.5;
        }
    }

    return minDist <= laneHalfWidth && Math.abs(point.y - nearestLaneY) <= maxVerticalDelta;
}

function isPointNearbyLane(point, lanePoints, laneHalfWidth, nearbyThreshold) {
    if (!lanePoints || lanePoints.length < 2) return false;

    const maxVerticalDelta = 4;
    let minDist = Number.POSITIVE_INFINITY;
    let nearestLaneY = 0;

    for (let i = 0; i < lanePoints.length - 1; i++) {
        const a = lanePoints[i];
        const b = lanePoints[i + 1];
        const dist = distancePointToSegmentXZ(point, a, b);
        if (dist < minDist) {
            minDist = dist;
            nearestLaneY = (a.y + b.y) * 0.5;
        }
    }

    return minDist <= nearbyThreshold && Math.abs(point.y - nearestLaneY) <= maxVerticalDelta;
}

export function makePathGradientTexture({
    width = 256,
    height = 4,
    color = 0xff0000,
    startAlpha = 0.7,
    fadeStart = 0.6,
    endAlpha = 0.0,
} = {}) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");

    const c = new THREE.Color(color);
    const r = Math.round(c.r * 255);
    const g = Math.round(c.g * 255);
    const b = Math.round(c.b * 255);

    const grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0.0, `rgba(${r},${g},${b},${startAlpha})`);
    grad.addColorStop(fadeStart, `rgba(${r},${g},${b},${startAlpha})`);
    grad.addColorStop(1.0, `rgba(${r},${g},${b},${endAlpha})`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

export function createPathRibbonMesh() {
    const vertCount = (SEGMENTS + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);

    for (let i = 0; i <= SEGMENTS; i++) {
        const u = i / SEGMENTS;
        const uvBase = i * 2 * 2;
        uvs[uvBase + 0] = u; uvs[uvBase + 1] = 0;
        uvs[uvBase + 2] = u; uvs[uvBase + 3] = 1;
    }

    const indices = new (vertCount > 65535 ? Uint32Array : Uint16Array)(SEGMENTS * 6);
    let k = 0;
    for (let i = 0; i < SEGMENTS; i++) {
        const a = 2 * i;
        const b = 2 * i + 1;
        const c = 2 * (i + 1);
        const d = 2 * (i + 1) + 1;

        indices[k++] = a; indices[k++] = b; indices[k++] = d;
        indices[k++] = a; indices[k++] = d; indices[k++] = c;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    const gradientTex = makePathGradientTexture({
        color: 0x6ae5a3,
        startAlpha: 0.6,
        fadeStart: 0.6,
        endAlpha: 0.0,
    });

    const material = new THREE.MeshBasicMaterial({
        map: gradientTex,
        color: 0xffffff,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999;
    return mesh;
}

export function updatePathRibbonGeometry(geometry, carObject3D, steeringAngleRad) {
    const curvature = Math.tan(steeringAngleRad) / WHEELBASE;

    const pos = new THREE.Vector3();
    pos.y = PATH_Y;

    const heading = new THREE.Vector3(0, 0, 1);
    heading.y = 0;
    heading.normalize();

    const ds = LOOKAHEAD / SEGMENTS;

    const positionAttr = geometry.getAttribute("position");
    const arr = positionAttr.array;

    const tangent = new THREE.Vector3();
    const leftN = new THREE.Vector3();
    const p = new THREE.Vector3().copy(pos);

    for (let i = 0; i <= SEGMENTS; i++) {
        tangent.copy(heading);
        leftN.set(-tangent.z, 0, tangent.x).normalize();

        const halfW = PATH_WIDTH * 0.5;
        const leftP = new THREE.Vector3().copy(p).addScaledVector(leftN, +halfW);
        const rightP = new THREE.Vector3().copy(p).addScaledVector(leftN, -halfW);

        const base = i * 2 * 3;
        arr[base + 0] = leftP.x; arr[base + 1] = leftP.y; arr[base + 2] = leftP.z;
        arr[base + 3] = rightP.x; arr[base + 4] = rightP.y; arr[base + 5] = rightP.z;

        p.addScaledVector(heading, ds);
        heading.applyAxisAngle(UP, curvature * ds).normalize();
    }

    positionAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
}

function setupPlaygroundDevices(vehicle) {
    if (vehicle.vehicleManifestId === "igvc-car") {
        const lidar = new LiDAR3d(
            new THREE.Vector3(0, 1, 0),
            new THREE.Euler(0, 0, 0),
            20,
            2,
            [0, 360],
            0.5,
            [-20, 20],
        );
        vehicle.addDevice(lidar);
        return;
    }

    const lidar = new LiDAR3d(
        new THREE.Vector3(0.35, 0.8, 0),
        new THREE.Euler(0, 0, 0),
    );

    const stereoCamera = new StereoCamera("Front Stereo Camera", {
        position: new THREE.Vector3(1.5, 0.5, 0),
        rotation: new THREE.Euler(0, 0, 0),
        range: 20,
        thetaStep: 2,
        phiStep: 1,
        camera: {
            width: 320,
            height: 180,
            fov: 75,
            near: 0.1,
            far: 200,
        },
        channels: {
            lidar: "bigcar/stereo/lidar3d",
            camera: "bigcar/stereo/camera",
        },
        maxFramesPerChannel: 180,
    });

    vehicle.addDevice(lidar);
    vehicle.addDevice(stereoCamera);
}

function renderPath(vehicle) {
    if (!vehicle.path) return;
    vehicle.displaySteeringAngle = lerp(vehicle.displaySteeringAngle, vehicle.steeringAngle, 0.1);
    updatePathRibbonGeometry(vehicle.path.geometry, vehicle.sceneObject, vehicle.displaySteeringAngle);
}

function updateLaneMeshVisibility(vehicle) {
    const city = vehicle.db?.getParent?.()?.city?.();
    const roads = city?.roads ?? [];
    const intersections = city?.intersections ?? [];
    const laneObjects = roads.concat(intersections);
    if (laneObjects.length === 0) return;

    const carPosition = vehicle.sceneObject
        ? vehicle.sceneObject.getWorldPosition(new THREE.Vector3())
        : vehicle.position;

    const activeLanes = [];

    for (let roadIndex = 0; roadIndex < laneObjects.length; roadIndex++) {
        const road = laneObjects[roadIndex];
        if (!road?.laneMeshes?.length || !road?.lanes?.length || !road?.width) continue;

        const laneCount = Math.max(1, Math.round(road.options?.laneCount ?? road.lanes.length));
        const laneWidth = road.width.getValue(Unit.Type.METER) / laneCount;
        const laneHalfWidth = laneWidth * 0.75 * 0.5;

        for (let laneIndex = 0; laneIndex < road.laneMeshes.length; laneIndex++) {
            const lanePoints = road.lanes[laneIndex];
            const laneMesh = road.laneMeshes[laneIndex];
            if (!laneMesh || !lanePoints) continue;

            const overLane = isPointOverLane(carPosition, lanePoints, laneHalfWidth);
            laneMesh.visible = overLane;

            if (overLane || isPointNearbyLane(carPosition, lanePoints, laneHalfWidth, 10)) {
                activeLanes.push({
                    road,
                    roadIndex,
                    laneIndex,
                    lanePoints,
                    laneWidth,
                    laneCount,
                    in_road: overLane,
                });
            }
        }
    }
}

/**
 * Playground-only presentation: path ribbon, chase camera, WASD gate, and the
 * historical BigCar / IGVCCar device construction.
 */
export function attachEgoPresentation(vehicle, options = {}) {
    vehicle.controlsEnabled = true;
    vehicle.follower = new CameraFollower();
    vehicle.follower.cameraOffset.set(-5, 4, 0);
    if (vehicle.cameraFocusOffset) {
        vehicle.follower.lookAtOffset.copy(vehicle.cameraFocusOffset);
    }

    if (options.playgroundDevices) {
        setupPlaygroundDevices(vehicle);
    }

    if (vehicle.sceneObject) {
        const curve = createPathRibbonMesh();
        curve.rotation.y = Math.PI / 2;
        vehicle.sceneObject.add(curve);
        vehicle.path = curve;
    }

    vehicle.disableControls = function disableControls() {
        this.controlsEnabled = false;
        if (this.path) this.path.visible = false;
    };

    vehicle.renderPath = () => renderPath(vehicle);
    vehicle.updateLaneMeshVisibility = () => updateLaneMeshVisibility(vehicle);
    vehicle._egoPresentation = true;

    const browserWindow = Object.getOwnPropertyDescriptor(globalThis, "window")?.value;
    if (browserWindow && browserWindow === globalThis) {
        browserWindow.getPositionAndRotationOfBigCar = () => {
            const pos = vehicle.position.clone();
            const rot = vehicle.rotation.clone();
            return { position: pos, rotation: rot };
        };
    }

    return vehicle;
}

export function updateEgoPresentation(vehicle, deltaTime) {
    if (!vehicle?._egoPresentation) return;
    renderPath(vehicle);
    updateLaneMeshVisibility(vehicle);
    vehicle.follower?.updateCamera(vehicle.sceneObject, deltaTime);
}

export function resetEgoPresentation(vehicle) {
    if (!vehicle?._egoPresentation) return;
    if (vehicle.path) renderPath(vehicle);
}
