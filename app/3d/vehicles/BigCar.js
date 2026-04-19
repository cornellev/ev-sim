import * as THREE from "three";
import { Data } from "../data/Data";
import { LiDAR3d } from "../devices/LiDAR3d";
import { StereoCamera } from "../devices/StereoCamera";
import { PhysicalVehicle, Vehicle } from "./Vehicle";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { lerp } from "three/src/math/MathUtils";
import Unit from "@/app/util/Unit";
import { CameraFollower } from "../tools/CameraFollower";
import { wait, waitFor } from "@/app/util/Wait";
import { StopSign } from "../city/objects/StopSign";
import { Barrel } from "../city/objects/Barrel";

// ---------- constants ----------
const WHEELBASE = new Unit(49, Unit.Type.INCH).getValue(Unit.Type.METER);          // meters (set to your car)
const LOOKAHEAD = 15;           // meters of path to draw
const SEGMENTS  = 80;           // smoothness
const PATH_WIDTH = 1;         // meters
const PATH_Y = 0.02;            // lift above ground to avoid z-fighting

const STOP_SIGN_RADIUS_M = 30;
const STOP_SIGN_PUBLISH_PERIOD_S = 0.05;

const OBSTACLE_RADIUS_M = 30;
const OBSTACLE_PUBLISH_PERIOD_S = 0.05;

const UP = new THREE.Vector3(0, 1, 0);

function hashStringToInt32(str) {
    const s = String(str ?? "");
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
}

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

export function makePathGradientTexture({
  width = 256,
  height = 4,
  color = 0xff0000,
  startAlpha = 0.7,
  fadeStart = 0.6, // 0..1 (where fade begins along length)
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
    grad.addColorStop(0.0,      `rgba(${r},${g},${b},${startAlpha})`);
    grad.addColorStop(fadeStart,`rgba(${r},${g},${b},${startAlpha})`);
    grad.addColorStop(1.0,      `rgba(${r},${g},${b},${endAlpha})`);

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    // if ("colorSpace" in tex) tex.colorSpace = THREE.SRGBColorSpace; // for three.js r152+

    tex.needsUpdate = true;
    return tex;
}

// ---------- create a reusable ribbon mesh ----------
export function createPathRibbonMesh() {
    const vertCount = (SEGMENTS + 1) * 2; // left+right per sample
    const positions = new Float32Array(vertCount * 3);
    const uvs       = new Float32Array(vertCount * 2);

    // Build UVs: u increases along the path, v is across width (0/1)
    for (let i = 0; i <= SEGMENTS; i++) {
        const u = i / SEGMENTS;

        // left vertex (v=0), right vertex (v=1)
        const uvBase = i * 2 * 2;
        uvs[uvBase + 0] = u; uvs[uvBase + 1] = 0;
        uvs[uvBase + 2] = u; uvs[uvBase + 3] = 1;
    }

    // indices: 2 triangles per segment
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
    mesh.renderOrder = 999; // draw on top if needed
    return mesh;
}

// ---------- update geometry each frame ----------
export function updatePathRibbonGeometry(geometry, carObject3D, steeringAngleRad) {
  // Ackermann/bicycle curvature (centerline)
  // k = tan(delta) / L
  const curvature = Math.tan(steeringAngleRad) / WHEELBASE;

  // starting pose
  const pos = new THREE.Vector3();// carObject3D.getWorldPosition(new THREE.Vector3());
  pos.y = PATH_Y;

  // three.js "forward" from Object3D is its -Z axis
  const heading = new THREE.Vector3(0,0,1);
//   carObject3D.getWorldDirection(heading);
  heading.y = 0;
  heading.normalize();

  const ds = LOOKAHEAD / SEGMENTS;

  const positionAttr = geometry.getAttribute("position");
  const arr = positionAttr.array;

  // temp vectors to avoid allocations
  const tangent = new THREE.Vector3();
  const leftN = new THREE.Vector3();
  const p = new THREE.Vector3().copy(pos);

  for (let i = 0; i <= SEGMENTS; i++) {
    // tangent = current heading (XZ)
    tangent.copy(heading);

    // left normal in XZ plane
    leftN.set(-tangent.z, 0, tangent.x).normalize();

    const halfW = PATH_WIDTH * 0.5;

    const leftP  = new THREE.Vector3().copy(p).addScaledVector(leftN, +halfW);
    const rightP = new THREE.Vector3().copy(p).addScaledVector(leftN, -halfW);

    // write left/right verts
    const base = i * 2 * 3;
    arr[base + 0] = leftP.x;  arr[base + 1] = leftP.y;  arr[base + 2] = leftP.z;
    arr[base + 3] = rightP.x; arr[base + 4] = rightP.y; arr[base + 5] = rightP.z;

    // integrate forward by arc-length ds
    p.addScaledVector(heading, ds);

    // rotate heading by dYaw = curvature * ds around Y
    // (sign might need flipping depending on your steering convention)
    heading.applyAxisAngle(UP, curvature * ds).normalize();
  }

  positionAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

export class BigCar extends PhysicalVehicle {
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler()) {
        super(db, position, rotation);

        this.steeringAngle = 0; // in radians
        this.displaySteeringAngle = 0; // for smooth visual interpolation

        this.path = null; // to be set up by subclasses

        this.offset = new THREE.Vector3(0, 0.15, 0); // intrinsic model offset
        this.cameraFocusOffset = new THREE.Vector3();

        this.follower = new CameraFollower();
        this.follower.cameraOffset.set(-5, 4, 0); // default offset behind and above the car

        this.controlsEnabled = true; // whether user can control the car

        this.laneBoundsTopic = "bigcar/lane_bounds";
        this.laneBoundsType = "sensor_fusion_msgs/LaneBounds";
        this.lastPublishedLaneKey = null;
        this.lastPublishedLaneBoundsHash = null;

        this.carSizeTopic = "bigcar/size";
        this.carSizeType = "sensor_fusion_msgs/CarSize";
        this.lastPublishedCarSizeHash = null;

        this.stopSignsTopic = "bigcar/stop_signs";
        this.stopSignsType = "sensor_fusion_msgs/StopSigns";
        this._stopSignsPublishTimer = 0;
        this.lastPublishedStopSignsHash = null;

        this.obstaclesTopic = "bigcar/obstacles";
        this.obstaclesType = "sensor_fusion_msgs/Boxes";
        this._obstaclesPublishTimer = 0;
        this.lastPublishedObstaclesHash = null;
    }

    setupDevices() {
        const lidar = new LiDAR3d(
            new THREE.Vector3(0.35, 0.8, 0), // position
            new THREE.Euler(0, 0, 0) // rotation
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

        // lidar.debug = true;
        
        this.addDevice(lidar);
        this.addDevice(stereoCamera);
    }

    disableControls() {
        this.controlsEnabled = false;
        this.path.visible = false;
    }

    async update(deltaTime) {
        // Planar bicycle / Ackermann kinematics.
        // State: (x,z,yaw). Control: forward speed v and steering angle delta.
        // yawRate = v/L * tan(delta)
        // posDot  = v * heading

        // IMPORTANT: `this.velocity` and `this.acceleration` are treated as
        // *vehicle-local* vectors (relative to the car frame), not world-space.
        // Convention: vehicle forward is -Z in local space (three.js default).

        // Integrate local velocity from local acceleration (does NOT depend on heading).
        this.velocity.addScaledVector(this.acceleration, deltaTime);

        // Forward speed (meters/sec). Forward is -Z.
        const v = this.velocity.x;

        // Clamp steering away from +/- 90deg to avoid tan() blow-ups.
        const maxSteer = Math.PI * 0.49;
        const delta = THREE.MathUtils.clamp(this.steeringAngle, -maxSteer, +maxSteer);

        const yawRate = (v / WHEELBASE) * Math.tan(delta);

        // Vehicle forward in world space (heading) from yaw.
        const heading = new THREE.Vector3(1, 0, 0).applyEuler(this.rotation);
        heading.y = 0;
        const headingLen = heading.length();
        if (headingLen > 0) heading.multiplyScalar(1 / headingLen);

        // Integrate pose (explicit Euler)
        this.position.addScaledVector(heading, v * deltaTime);
        this.rotation.y += yawRate * deltaTime;

        // Push pose to scene and notify devices.
        this.updatePosition(this.position);
        this.updateRotation(this.rotation);

        this.renderPath();

        this.updateLaneMeshVisibility();

        this.publishNearbyStopSigns(deltaTime);

        this.publishNearbyObstacles(deltaTime);

        this.follower.updateCamera(this.sceneObject, deltaTime);

        // closest road update
    }

    publishNearbyStopSigns(deltaTime) {
        this._stopSignsPublishTimer = (this._stopSignsPublishTimer ?? 0) + (deltaTime ?? 0);

        const data = this.db?.getParent?.();
        const objectsDb = data?.objects?.();
        const allObjects = objectsDb?.getAll?.();
        if (!Array.isArray(allObjects) || allObjects.length === 0) return;

        const carOrigin = this.position;
        const radiusSq = STOP_SIGN_RADIUS_M * STOP_SIGN_RADIUS_M;

        const nearby = [];
        for (const obj of allObjects) {
            if (!(obj instanceof StopSign)) continue;
            const dx = obj.position.x - carOrigin.x;
            const dz = obj.position.z - carOrigin.z;
            const distSq = dx * dx + dz * dz;
            if (distSq <= radiusSq) nearby.push(obj);
        }

        // Throttle publish rate and avoid republishing identical payloads.
        if (this._stopSignsPublishTimer < STOP_SIGN_PUBLISH_PERIOD_S) return;

        nearby.sort((a, b) => (a._uuid || "").localeCompare(b._uuid || ""));

        const forwardWorld = new THREE.Vector3(1, 0, 0).applyEuler(this.rotation);
        forwardWorld.y = 0;
        const fLen = forwardWorld.length();
        if (fLen > 0) forwardWorld.multiplyScalar(1 / fLen);
        else forwardWorld.set(1, 0, 0);

        const upWorld = new THREE.Vector3(0, 1, 0);
        const rightWorld = new THREE.Vector3().crossVectors(upWorld, forwardWorld).normalize();

        const delta = new THREE.Vector3();
        const localPoint = new THREE.Vector3();

        const positions = [];
        const directions = [];
        const ids = [];

        for (const sign of nearby) {
            delta.copy(sign.position).sub(carOrigin);
            // Publish in car-local frame: +x right, +y forward, +z up
            localPoint.set(delta.dot(rightWorld), delta.dot(forwardWorld), delta.dot(upWorld));
            positions.push({ x: localPoint.x, y: localPoint.y, z: localPoint.z });

            // StopSign.dir: 0:+X, 1:+Z, 2:-X, 3:-Z (world axes)
            const dRaw = Number.isFinite(sign.dir) ? Math.trunc(sign.dir) : 0;
            const d = ((dRaw % 4) + 4) % 4;
            const signForwardWorld =
                d === 0
                    ? new THREE.Vector3(1, 0, 0)
                    : d === 1
                      ? new THREE.Vector3(0, 0, 1)
                      : d === 2
                        ? new THREE.Vector3(-1, 0, 0)
                        : new THREE.Vector3(0, 0, -1);

            const localDir = new THREE.Vector3(
                signForwardWorld.dot(rightWorld),
                signForwardWorld.dot(forwardWorld),
                signForwardWorld.dot(upWorld)
            ).normalize();
            directions.push({ x: localDir.x, y: localDir.y, z: localDir.z });
            ids.push(sign.id);
        }

        const hash = `${positions.length}|${positions
            .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`)
            .join(";")}|${directions.map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`).join(";")}|${ids.join(";")}`;

        if (hash === this.lastPublishedStopSignsHash) {
            this._stopSignsPublishTimer = 0;
            return;
        }

        const client = data?.client?.()?.get?.();
        if (!client) {
            this._stopSignsPublishTimer = 0;
            return;
        }
        if (typeof client.isOpen === "function" && !client.isOpen()) {
            this._stopSignsPublishTimer = 0;
            return;
        }

        const payload = { positions, directions, ids };
        client
            .publish(this.stopSignsTopic, this.stopSignsType, payload)
            .then(() => {
                this.lastPublishedStopSignsHash = hash;
                this._stopSignsPublishTimer = 0;
            })
            .catch((err) => {
                this._stopSignsPublishTimer = 0;
                console.warn("failed to publish stop signs:", err?.message || err);
            });
    }

    publishNearbyObstacles(deltaTime) {
        this._obstaclesPublishTimer = (this._obstaclesPublishTimer ?? 0) + (deltaTime ?? 0);

        const data = this.db?.getParent?.();
        const objectsDb = data?.objects?.();
        const allObjects = objectsDb?.getAll?.();
        if (!Array.isArray(allObjects) || allObjects.length === 0) return;

        const carOrigin = this.position;
        const radiusSq = OBSTACLE_RADIUS_M * OBSTACLE_RADIUS_M;

        const nearby = [];
        for (const obj of allObjects) {
            if (!(obj instanceof Barrel)) continue;
            if (!obj.position) continue;
            const dx = obj.position.x - carOrigin.x;
            const dz = obj.position.z - carOrigin.z;
            const distSq = dx * dx + dz * dz;
            if (distSq <= radiusSq) nearby.push(obj);
        }

        // Throttle publish rate and avoid republishing identical payloads.
        if (this._obstaclesPublishTimer < OBSTACLE_PUBLISH_PERIOD_S) return;

        nearby.sort((a, b) => (a._uuid || "").localeCompare(b._uuid || ""));

        const forwardWorld = new THREE.Vector3(1, 0, 0).applyEuler(this.rotation);
        forwardWorld.y = 0;
        const fLen = forwardWorld.length();
        if (fLen > 0) forwardWorld.multiplyScalar(1 / fLen);
        else forwardWorld.set(1, 0, 0);

        const upWorld = new THREE.Vector3(0, 1, 0);
        const rightWorld = new THREE.Vector3().crossVectors(upWorld, forwardWorld).normalize();

        const delta = new THREE.Vector3();
        const localCenter = new THREE.Vector3();

        const worldQuat = new THREE.Quaternion();
        const worldEuler = new THREE.Euler();

        const boxes = [];

        for (const barrel of nearby) {
            delta.copy(barrel.position).sub(carOrigin);
            // Publish in car-local frame: +x right, +y forward, +z up
            localCenter.set(delta.dot(rightWorld), delta.dot(forwardWorld), delta.dot(upWorld));

            const size = barrel.scale ?? new THREE.Vector3();

            // Barrels currently don't store a logical rotation, but if a mesh exists,
            // include its yaw relative to the car as a best-effort.
            let relYaw = 0;
            if (barrel._mesh && typeof barrel._mesh.getWorldQuaternion === "function") {
                barrel._mesh.getWorldQuaternion(worldQuat);
                worldEuler.setFromQuaternion(worldQuat, "YXZ");
                relYaw = worldEuler.y - (this.rotation?.y ?? 0);
                // wrap to [-pi, pi]
                relYaw = ((relYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
            }

            const id = Number.isInteger(barrel.id) ? (barrel.id | 0) : hashStringToInt32(barrel._uuid);

            boxes.push({
                id,
                center: { x: localCenter.x, y: localCenter.y, z: localCenter.z },
                size: { x: size.x ?? 0, y: size.y ?? 0, z: size.z ?? 0 },
                rotation: { x: 0, y: 0, z: relYaw },
            });
        }

        const hash = `${boxes.length}|${boxes
            .map((b) =>
                `${b.id}|${b.center.x.toFixed(2)},${b.center.y.toFixed(2)},${b.center.z.toFixed(2)}|${b.size.x.toFixed(
                    2
                )},${b.size.y.toFixed(2)},${b.size.z.toFixed(2)}|${b.rotation.x.toFixed(3)},${b.rotation.y.toFixed(
                    3
                )},${b.rotation.z.toFixed(3)}`
            )
            .join(";")}`;

        if (hash === this.lastPublishedObstaclesHash) {
            this._obstaclesPublishTimer = 0;
            return;
        }

        const client = data?.client?.()?.get?.();
        if (!client) {
            this._obstaclesPublishTimer = 0;
            return;
        }
        if (typeof client.isOpen === "function" && !client.isOpen()) {
            this._obstaclesPublishTimer = 0;
            return;
        }

        const payload = { boxes };
        client
            .publish(this.obstaclesTopic, this.obstaclesType, payload)
            .then(() => {
                this.lastPublishedObstaclesHash = hash;
                this._obstaclesPublishTimer = 0;
            })
            .catch((err) => {
                this._obstaclesPublishTimer = 0;
                console.warn("failed to publish obstacles:", err?.message || err);
            });
    }

    renderPath() {
        if (!this.path) return;

        this.displaySteeringAngle = lerp(this.displaySteeringAngle, this.steeringAngle, 0.1);

        updatePathRibbonGeometry(this.path.geometry, this.sceneObject, this.displaySteeringAngle);
    }

    updateLaneMeshVisibility() {
        const roads = this.db?.getParent?.()?.city?.()?.roads;
        if (!roads || roads.length === 0) return;

        const carPosition = this.sceneObject
            ? this.sceneObject.getWorldPosition(new THREE.Vector3())
            : this.position;

        let activeLane = null;

        for (let roadIndex = 0; roadIndex < roads.length; roadIndex++) {
            const road = roads[roadIndex];
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

                if (overLane && !activeLane) {
                    activeLane = {
                        road,
                        roadIndex,
                        laneIndex,
                        lanePoints,
                        laneWidth,
                        laneCount,
                    };
                }
            }
        }

        this.publishLaneBounds(activeLane);
    }

    publishLaneBounds(activeLane) {
        if (!activeLane?.lanePoints?.length) {
            this.lastPublishedLaneKey = null;
            this.lastPublishedLaneBoundsHash = null;

            //publish empty bounds to indicate no active lane
            const data = this.db?.getParent?.();
            const client = data?.client?.()?.get?.();
            if (client && typeof client.isOpen === "function" && client.isOpen()) {
                client
                    .publish(this.laneBoundsTopic, this.laneBoundsType, { laneIndex: -1, leftBoundary: null, rightBoundary: null })
                    .catch((err) => {
                        console.warn("failed to publish lane bounds:", err?.message || err);
                    });
            }
            return;
        }

        const carOrigin = this.position;
        const localPoint = new THREE.Vector3();
        const delta = new THREE.Vector3();
        const forwardWorld = new THREE.Vector3(1, 0, 0).applyEuler(this.rotation).normalize();
        const upWorld = new THREE.Vector3(0, 1, 0).applyEuler(this.rotation).normalize();
        const rightWorld = new THREE.Vector3().crossVectors(upWorld, forwardWorld).normalize();
        const tangent = new THREE.Vector3();
        const leftNormal = new THREE.Vector3();

        const points = activeLane.lanePoints;
        const halfWidth = (activeLane.laneWidth ?? 0) * 0.5;

        const laneCount = Math.max(
            1,
            Math.round(
                Number.isFinite(activeLane.laneCount)
                    ? activeLane.laneCount
                    : (activeLane.road?.options?.laneCount ?? activeLane.road?.lanes?.length ?? 1)
            )
        );

        // lane0/lane1 correspond to the +/- leftNormal boundaries of the active lane.
        // In this codebase, lane index 0 is the first generated lane offset from one road edge.
        // That makes lane0 the outer edge boundary for laneIndex==0, and lane1 the outer edge
        // boundary for laneIndex==laneCount-1.
        const is_edge0 = (laneCount === 1 ? true : activeLane.laneIndex === 0);
        const is_edge1 = (laneCount === 1 ? true : activeLane.laneIndex === laneCount - 1);

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;

        const lane0 = [];
        const lane1 = [];

        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            if (!point) continue;
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;

            const prev = points[Math.max(0, i - 1)] ?? point;
            const next = points[Math.min(points.length - 1, i + 1)] ?? point;

            tangent.set(next.x - prev.x, 0, next.z - prev.z);
            const tLen = tangent.length();
            if (tLen > 0) tangent.multiplyScalar(1 / tLen);
            else tangent.set(1, 0, 0);

            leftNormal.set(-tangent.z, 0, tangent.x);

            // World-space boundary points (left/right of lane centerline)
            const worldLeftX = point.x + leftNormal.x * halfWidth;
            const worldLeftY = point.y;
            const worldLeftZ = point.z + leftNormal.z * halfWidth;

            const worldRightX = point.x - leftNormal.x * halfWidth;
            const worldRightY = point.y;
            const worldRightZ = point.z - leftNormal.z * halfWidth;

            // Transform each boundary point into car-local frame with axes:
            // +x right, +y forward, +z up
            delta.set(worldLeftX, worldLeftY, worldLeftZ).sub(carOrigin);
            localPoint.set(delta.dot(rightWorld), delta.dot(forwardWorld), delta.dot(upWorld));
            lane0.push({ x: localPoint.x, y: localPoint.y, z: localPoint.z });
            if (localPoint.x < minX) minX = localPoint.x;
            if (localPoint.y < minY) minY = localPoint.y;
            if (localPoint.z < minZ) minZ = localPoint.z;
            if (localPoint.x > maxX) maxX = localPoint.x;
            if (localPoint.y > maxY) maxY = localPoint.y;
            if (localPoint.z > maxZ) maxZ = localPoint.z;

            delta.set(worldRightX, worldRightY, worldRightZ).sub(carOrigin);
            localPoint.set(delta.dot(rightWorld), delta.dot(forwardWorld), delta.dot(upWorld));
            lane1.push({ x: localPoint.x, y: localPoint.y, z: localPoint.z });
            if (localPoint.x < minX) minX = localPoint.x;
            if (localPoint.y < minY) minY = localPoint.y;
            if (localPoint.z < minZ) minZ = localPoint.z;
            if (localPoint.x > maxX) maxX = localPoint.x;
            if (localPoint.y > maxY) maxY = localPoint.y;
            if (localPoint.z > maxZ) maxZ = localPoint.z;
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

        const relMinX = minX;
        const relMinY = minY;
        const relMinZ = minZ;
        const relMaxX = maxX;
        const relMaxY = maxY;
        const relMaxZ = maxZ;

        const laneKey = `${activeLane.roadIndex}:${activeLane.laneIndex}`;
        const boundsHash = [
            relMinX,
            relMinY,
            relMinZ,
            relMaxX,
            relMaxY,
            relMaxZ,
            is_edge0 ? 1 : 0,
            is_edge1 ? 1 : 0,
        ]
            .map((value) => (Number.isFinite(value) ? value.toFixed(3) : String(value)))
            .join(",");
        if (laneKey === this.lastPublishedLaneKey && boundsHash === this.lastPublishedLaneBoundsHash) {
            return;
        }

        const client = this.db?.getParent?.()?.client?.()?.get?.();
        if (!client) return;

        if (typeof client.isOpen === "function" && !client.isOpen()) return;

        const payload = {
            road: `road_${activeLane.roadIndex}:lane_${activeLane.laneIndex}`,
            lane0,
            lane1,
            is_edge0,
            is_edge1,
        };


        client
            .publish(this.laneBoundsTopic, this.laneBoundsType, payload)
            .then(() => {
                this.lastPublishedLaneKey = laneKey;
                this.lastPublishedLaneBoundsHash = boundsHash;
            })
            .catch(err => console.warn("failed to publish lane bounds:", err?.message || err));
    }
    

    async addToScene(scene) {
        console.log("Loading BigCar model...");
        // gltf loader to load a car model
        const loader = new GLTFLoader();
        
        const gltf = await loader.loadAsync("/shell/shell.gltf");

        gltf.scene.children[0].position.copy(this.offset);

        // scale down by 100x
        gltf.scene.scale.set(0.0015, 0.0015, 0.0015);

        gltf.scene.position.copy(this.position);
        gltf.scene.rotation.copy(this.rotation);

        // rotate it -90
        gltf.scene.rotateX(-Math.PI / 2);
        gltf.scene.rotateZ(Math.PI);
        // translate the object along the y axis by -0.5 units


        this.sceneObject = new THREE.Group();
        this.sceneObject.add(gltf.scene);
        scene.add(this.sceneObject);

        const boundingBox = new THREE.Box3().setFromObject(gltf.scene);
        const size = new THREE.Vector3();
        boundingBox.getSize(size);

        const actualScale = {
            width: new Unit(49, Unit.Type.INCH),
            length: new Unit(106, Unit.Type.INCH),
        }

        // use the bounding box size to determine the scale factor to match the actual car dimensions
        const scaleX = actualScale.length.getValue(Unit.Type.METER) / size.x;
        const scaleY = actualScale.width.getValue(Unit.Type.METER) / size.z; // width is along Z in the model
        const scale = Math.min(scaleX, scaleY);

        this.sceneObject.scale.set(scale, scale, scale);
        this.sceneObject.updateMatrixWorld(true);

        const worldBounds = new THREE.Box3().setFromObject(this.sceneObject);
        const worldCenter = worldBounds.getCenter(new THREE.Vector3());
        const worldSize = worldBounds.getSize(new THREE.Vector3());
        const sceneWorldPosition = this.sceneObject.getWorldPosition(new THREE.Vector3());

        this.cameraFocusOffset.copy(worldCenter).sub(sceneWorldPosition);
        this.cameraFocusOffset.y += worldSize.y * 0.2;
        this.follower.lookAtOffset.copy(this.cameraFocusOffset);

        console.log("BigCar added to scene");
        
        const curve = createPathRibbonMesh();
        // rotate curve 90 degrees to align with car's forward direction
        curve.rotation.y = Math.PI / 2;
        // curve.position.x = 0.2;
        
        this.sceneObject.add(curve);

        this.path = curve;

        // publish car size for sensor fusion purposes
        const publish_size = async () => {
            console.log("Waiting for client to publish car size...");
            while (!this.db.getParent().client().hasClient()) {
                await wait(100);
            }

            const client = this.db.getParent().client().get();

            console.log("Client available, waiting for connection...");

            while (Object.keys(client).includes("isOpen") && !client.isOpen()) {
                await wait(100);
            }

            console.log("Publishing car size:", worldSize);

            const sizePayload = {// width is along Z in the model
                width: worldSize.z,
                length: worldSize.x,
                height: worldSize.y,
            };
            const sizeHash = [sizePayload.width, sizePayload.length, sizePayload.height].map(value => value.toFixed(3)).join(",");
            if (sizeHash === this.lastPublishedCarSizeHash) return;

            client
                .publish(this.carSizeTopic, this.carSizeType, sizePayload)
                .then(() => {
                    this.lastPublishedCarSizeHash = sizeHash;
                })
                .catch(err => console.warn("failed to publish car size:", err?.message || err));
        }

        publish_size().catch(err => console.warn("failed to publish car size:", err?.message || err));
    }
}