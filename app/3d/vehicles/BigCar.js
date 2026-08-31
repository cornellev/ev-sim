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
import { applyModelPlacement } from "./ModelPlacement.js";
import { getBuiltInVehicleManifest } from "../../vehicles/BuiltInVehicleManifests.js";
import { attachVehiclePlant, resetVehiclePlant, stepVehiclePlant } from "./VehiclePlantAdapter.js";

// ---------- constants ----------
const WHEELBASE = new Unit(49, Unit.Type.INCH).getValue(Unit.Type.METER);          // meters (set to your car)
const LOOKAHEAD = 15;           // meters of path to draw
const SEGMENTS  = 80;           // smoothness
const PATH_WIDTH = 1;         // meters
const PATH_Y = 0.02;            // lift above ground to avoid z-fighting

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
// TODO: export to a generalized "path ribbon" module that can be used for trajectories, etc.
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
    constructor(db, position=new THREE.Vector3(), rotation=new THREE.Euler(), options = {}) {
        super(db, position, rotation);

        this.steeringAngle = 0; // in radians
        this.displaySteeringAngle = 0; // for smooth visual interpolation

        this.path = null; // to be set up by subclasses

        // Kinematic pose lives on sceneObject; model offset is applied via placement only.
        this.offset = new THREE.Vector3(0, 0, 0);
        this.modelUrl = options.modelUrl || "/shell/shell.gltf";
        this.cameraFocusOffset = new THREE.Vector3(0, 0.7, 0);

        this.follower = new CameraFollower();
        this.follower.cameraOffset.set(-5, 4, 0); // default offset behind and above the car

        this.controlsEnabled = true; // whether user can control the car
        attachVehiclePlant(this, {
            id: this.telemetryId || "big-car",
            type: "big-car",
            pose: { position: this.position, rotation: this.rotation },
        }, { manifest: getBuiltInVehicleManifest("big-car") });
    }

    resetPose() {
        this.basePositionOffset.copy(this.position);
        this.baseRotationOffset.copy(this.rotation);
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

    update(deltaTime) {
        stepVehiclePlant(this, deltaTime);

        this.renderPath();

        this.updateLaneMeshVisibility();

        this.follower.updateCamera(this.sceneObject, deltaTime);

        // closest road update
    }

    resetRunState(entry = {}) {
        super.resetRunState(entry);
        resetVehiclePlant(this, entry);
        this.displaySteeringAngle = Number(entry.steeringAngle) || 0;
        if (this.path) this.renderPath();
    }

    renderPath() {
        if (!this.path) return;

        this.displaySteeringAngle = lerp(this.displaySteeringAngle, this.steeringAngle, 0.1);

        updatePathRibbonGeometry(this.path.geometry, this.sceneObject, this.displaySteeringAngle);
    }

    /**
     * @deprecated Removing soon to a generalized method
     */
    updateLaneMeshVisibility() {
        const city = this.db?.getParent?.()?.city?.();
        const roads = city?.roads ?? [];
        const intersections = city?.intersections ?? [];
        const laneObjects = roads.concat(intersections);
        if (laneObjects.length === 0) return;

        const carPosition = this.sceneObject
            ? this.sceneObject.getWorldPosition(new THREE.Vector3())
            : this.position;

        let activeLanes = [];

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
                        in_road: overLane
                    });
                }
            }
        }

    }

    async addToScene(scene) {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(this.modelUrl);
        const model = gltf.scene;

        // Kinematic pose belongs on sceneObject only — never double-apply onto the GLTF.
        this.sceneObject = new THREE.Group();
        this.sceneObject.position.copy(this.position);
        this.sceneObject.rotation.copy(this.rotation);
        scene.add(this.sceneObject);

        // Place while unparented so AABB math is in local space, then attach.
        const modelRotation = { x: -Math.PI / 2, y: 0, z: Math.PI, order: "XYZ" };
        const baseScale = 0.0015;
        model.scale.setScalar(baseScale);
        model.rotation.set(modelRotation.x, modelRotation.y, modelRotation.z);
        model.rotation.order = modelRotation.order;
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);

        const measured = new THREE.Box3().setFromObject(model);
        const size = measured.getSize(new THREE.Vector3());
        const targetLength = new Unit(106, Unit.Type.INCH).getValue(Unit.Type.METER);
        const targetWidth = new Unit(49, Unit.Type.INCH).getValue(Unit.Type.METER);
        const fitScale = Math.min(targetLength / Math.max(size.x, 1e-9), targetWidth / Math.max(size.z, 1e-9));
        const bodyCenter = { x: 0, y: 0.7, z: 0 };

        applyModelPlacement(model, {
            scale: baseScale * fitScale,
            rotation: modelRotation,
            offset: { x: 0, y: 0, z: 0 },
        }, { center: bodyCenter });

        this.sceneObject.add(model);
        this.offset.set(0, 0, 0);

        // Debug: bright plate at the kinematic origin (vehicle local 0,0,0).
        const originMarker = new THREE.Mesh(
            new THREE.BoxGeometry(0.35, 0.04, 0.35),
            new THREE.MeshBasicMaterial({ color: 0xff2d55, depthTest: false }),
        );
        originMarker.position.set(0, 0.02, 0);
        originMarker.renderOrder = 10;
        originMarker.name = "vehicle-origin-debug";
        this.sceneObject.add(originMarker);
        this._originDebugMarker = originMarker;

        this.sceneObject.updateMatrixWorld(true);
        const alignedSize = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
        this.cameraFocusOffset.set(bodyCenter.x, bodyCenter.y + alignedSize.y * 0.2, bodyCenter.z);
        this.follower.lookAtOffset.copy(this.cameraFocusOffset);

        const curve = createPathRibbonMesh();
        // Sibling of the model so fit-scale does not shrink the path ribbon.
        curve.rotation.y = Math.PI / 2;
        this.sceneObject.add(curve);
        this.path = curve;

        window.getPositionAndRotationOfBigCar = () => {
            const pos = this.position.clone();
            const rot = this.rotation.clone();
            return { position: pos, rotation: rot };
        };
    }
}
