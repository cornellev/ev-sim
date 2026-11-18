import * as THREE from "three";
import Unit from "@/app/util/Unit";
import { CameraFollower } from "../tools/CameraFollower";
import { LiDAR3d } from "../devices/LiDAR3d";
import { StereoCamera } from "../devices/StereoCamera";

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
 * Playground-only presentation: chase camera, WASD gate, and the
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

    vehicle.disableControls = function disableControls() {
        this.controlsEnabled = false;
    };

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
    updateLaneMeshVisibility(vehicle);
    vehicle.follower?.updateCamera(vehicle.sceneObject, deltaTime);
}
