import * as THREE from "three";
import { Data } from "../data/Data";
import { LiDAR3d } from "../devices/LiDAR3d";
import { PhysicalVehicle, Vehicle } from "./Vehicle";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { lerp } from "three/src/math/MathUtils";
import Unit from "@/app/util/Unit";
import { CameraFollower } from "../tools/CameraFollower";

// ---------- constants ----------
const WHEELBASE = new Unit(49, Unit.Type.INCH).getValue(Unit.Type.METER);          // meters (set to your car)
const LOOKAHEAD = 15;           // meters of path to draw
const SEGMENTS  = 80;           // smoothness
const PATH_WIDTH = 1;         // meters
const PATH_Y = 0.02;            // lift above ground to avoid z-fighting

const UP = new THREE.Vector3(0, 1, 0);

function makePathGradientTexture({
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
function createPathRibbonMesh() {
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
function updatePathRibbonGeometry(geometry, carObject3D, steeringAngleRad) {
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
// in your update loop:
function update() {
  // steering angle MUST be radians
  // if you store degrees: const delta = THREE.MathUtils.degToRad(this.steeringAngleDeg);
  const delta = this.steeringAngle; // radians

  updatePathRibbonGeometry(pathMesh.geometry, carObject3D, delta);
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
    }

    setupDevices() {
        const lidar = new LiDAR3d(
            new THREE.Vector3(0, 1, 0), // position
            new THREE.Euler(0, 0, 0) // rotation
        );
        
        
        this.addDevice(lidar);
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

        this.follower.updateCamera(this.sceneObject, deltaTime);
    }

    renderPath() {
        if (!this.path) return;

        this.displaySteeringAngle = lerp(this.displaySteeringAngle, this.steeringAngle, 0.1);

        updatePathRibbonGeometry(this.path.geometry, this.sceneObject, this.displaySteeringAngle);
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
    }
}