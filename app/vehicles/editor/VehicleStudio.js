import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { TriangleOptimizer } from "../../optimization/TriangleOptimizer.js";
import { applyModelPlacement } from "../../3d/vehicles/ManifestVehicle.js";

const COLORS = {
    background: 0x09090b,
    grid: 0x27272a,
    gridCenter: 0x3f3f46,
    wheel: 0x18181b,
    wheelSteerable: 0x0c4a6e,
    sensorLidar: 0x38bdf8,
    sensorCamera: 0xf59e0b,
    boundingBox: 0x38bdf8,
    egoCenter: 0x34d399,
    zone: 0x34d399,
    selection: 0xe0f2fe,
};

/**
 * Standalone three.js studio scene for the vehicle editor: grid, lighting,
 * orbit controls, a transform gizmo, and in-place synchronization from a
 * vehicle manifest draft. Owns no React state; the page drives it.
 */
export class VehicleStudio {
    /**
     * @param {HTMLElement} container
     * @param {{
     *   onTransform?: (selection: {kind: string, id: string|null}, transform: {position: {x,y,z}, rotation: {x,y,z}}) => void,
     *   onSelect?: (selection: {kind: string, id: string|null} | null) => void,
     * }} callbacks
     */
    constructor(container, { onTransform, onSelect } = {}) {
        this.container = container;
        this.onTransform = onTransform;
        this.onSelect = onSelect;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);
        this.scene.fog = new THREE.Fog(COLORS.background, 30, 80);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
        this.camera.position.set(4.5, 3, 4.5);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(this.renderer.domElement);

        const grid = new THREE.GridHelper(40, 40, COLORS.gridCenter, COLORS.grid);
        grid.material.transparent = true;
        grid.material.opacity = 0.6;
        this.scene.add(grid);
        this.scene.add(new THREE.AxesHelper(0.75));

        this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x18181b, 1.4));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(5, 8, 3);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0xbae6fd, 0.5);
        fill.position.set(-6, 4, -4);
        this.scene.add(fill);

        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.target.set(0, 0.6, 0);
        this.orbit.enableDamping = true;
        this.orbit.dampingFactor = 0.08;
        this.orbit.maxPolarAngle = Math.PI * 0.52;
        this.orbit.minDistance = 0.5;
        this.orbit.maxDistance = 60;

        this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
        this.gizmo.setSize(0.8);
        this.gizmo.addEventListener("dragging-changed", (event) => {
            this.orbit.enabled = !event.value;
        });
        this.gizmo.addEventListener("objectChange", () => this._emitTransform());
        this.scene.add(this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo);

        // Manifest-driven groups, all in the vehicle-local frame at the origin.
        this.modelRoot = new THREE.Group();
        this.wheelsGroup = new THREE.Group();
        this.sensorsGroup = new THREE.Group();
        this.zoneGroup = new THREE.Group();
        this.scene.add(this.modelRoot, this.wheelsGroup, this.sensorsGroup, this.zoneGroup);

        this.bboxMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: COLORS.boundingBox, transparent: true, opacity: 0.08, depthWrite: false }),
        );
        this.bboxMesh.userData.pick = { kind: "body", id: null };
        this.bboxEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({ color: COLORS.boundingBox, transparent: true, opacity: 0.55 }),
        );
        this.bboxMesh.add(this.bboxEdges);
        this.scene.add(this.bboxMesh);

        this.egoMarker = new THREE.Group();
        const egoSphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.07, 16, 16),
            new THREE.MeshBasicMaterial({ color: COLORS.egoCenter }),
        );
        egoSphere.userData.pick = { kind: "ego", id: null };
        this.egoMarker.add(egoSphere, new THREE.AxesHelper(0.45));
        this.scene.add(this.egoMarker);

        this._selection = null;
        this._zoneSignature = null;
        this._modelUrl = null;
        this._modelObject = null;
        this._loadToken = 0;
        this._disposed = false;

        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._pointerDown = null;
        this._onPointerDown = (event) => {
            this._pointerDown = { x: event.clientX, y: event.clientY };
        };
        this._onPointerUp = (event) => {
            const start = this._pointerDown;
            this._pointerDown = null;
            if (!start || this.gizmo.dragging) return;
            // Treat as a click only when the pointer barely moved (not an orbit).
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
            this._handleClick(event);
        };
        this.renderer.domElement.addEventListener("pointerdown", this._onPointerDown);
        this.renderer.domElement.addEventListener("pointerup", this._onPointerUp);

        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(container);
        this._resize();

        const animate = () => {
            if (this._disposed) return;
            this._frame = requestAnimationFrame(animate);
            this.orbit.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();
    }

    dispose() {
        this._disposed = true;
        cancelAnimationFrame(this._frame);
        this._resizeObserver.disconnect();
        this.renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);
        this.renderer.domElement.removeEventListener("pointerup", this._onPointerUp);
        this.gizmo.detach();
        this.gizmo.dispose?.();
        this.orbit.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    _resize() {
        const width = this.container.clientWidth || 1;
        const height = this.container.clientHeight || 1;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    // --- Manifest synchronization -------------------------------------------

    /**
     * Bring the studio scene in line with a manifest draft.
     * @param {object} manifest normalized `cev-sim.vehicle` document
     * @param {string|null} modelUrl resolved asset URL, or null when no model
     */
    setManifest(manifest, modelUrl) {
        this._syncModel(manifest.model, modelUrl, manifest.boundingBox);
        this._syncWheels(manifest.wheels);
        this._syncSensors(manifest.sensors);
        this._syncBody(manifest);
        this._syncZone(manifest.lidarZone);
    }

    _syncModel(model, modelUrl, boundingBox) {
        if (modelUrl !== this._modelUrl) {
            this._modelUrl = modelUrl;
            this.modelRoot.clear();
            this._modelObject = null;
            this._placeholder = null;
            if (modelUrl) {
                const token = ++this._loadToken;
                new GLTFLoader().loadAsync(modelUrl).then((gltf) => {
                    if (this._disposed || token !== this._loadToken) return;
                    this.modelRoot.clear();
                    this._placeholder = null;
                    this._modelObject = gltf.scene;
                    applyModelPlacement(this._modelObject, this._pendingModel ?? model);
                    this.modelRoot.add(this._modelObject);
                    if (this._selection?.kind === "model") this.setSelection(this._selection);
                }).catch((error) => {
                    console.warn("Vehicle editor could not load model:", error);
                    if (this._disposed || token !== this._loadToken) return;
                    this._syncPlaceholder(boundingBox);
                });
            } else {
                this._syncPlaceholder(boundingBox);
            }
        } else if (!modelUrl) {
            this._syncPlaceholder(boundingBox);
        }
        this._pendingModel = model;
        if (this._modelObject && !this._isDragging(this._modelObject)) {
            applyModelPlacement(this._modelObject, model);
        }
    }

    /** Solid body used when a vehicle has no GLTF (built-in IGVC / Scenario, or detach). */
    _syncPlaceholder(boundingBox) {
        const { size, center } = boundingBox ?? { size: { x: 1, y: 1, z: 1 }, center: { x: 0, y: 0.5, z: 0 } };
        if (!this._placeholder) {
            this.modelRoot.clear();
            this._modelObject = null;
            this._placeholder = new THREE.Mesh(
                new THREE.BoxGeometry(1, 1, 1),
                new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.7, metalness: 0.15 }),
            );
            this._placeholder.userData.pick = { kind: "model", id: null };
            this.modelRoot.add(this._placeholder);
        }
        this._placeholder.position.set(center.x, center.y, center.z);
        this._placeholder.scale.set(size.x, size.y, size.z);
    }

    _syncWheels(wheels) {
        this._syncMarkerGroup(this.wheelsGroup, wheels, "wheel", (wheel) => {
            const geometry = new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 24);
            geometry.rotateX(Math.PI / 2);
            const mesh = new THREE.Mesh(
                geometry,
                new THREE.MeshStandardMaterial({
                    color: wheel.steerable ? COLORS.wheelSteerable : COLORS.wheel,
                    roughness: 0.8,
                }),
            );
            return mesh;
        }, (object, wheel) => {
            object.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
            // Radius or width changes require new geometry; encode in signature.
            return `${wheel.radius}:${wheel.width}:${wheel.steerable}`;
        });
    }

    _syncSensors(sensors) {
        this._syncMarkerGroup(this.sensorsGroup, sensors, "sensor", (sensor) => {
            if (sensor.type === "camera") {
                const holder = new THREE.Group();
                holder.add(buildCameraFrustum(sensor.config), new THREE.Mesh(
                    new THREE.BoxGeometry(0.08, 0.08, 0.12),
                    new THREE.MeshStandardMaterial({ color: COLORS.sensorCamera, roughness: 0.4 }),
                ));
                return holder;
            }
            const holder = new THREE.Group();
            holder.add(
                new THREE.Mesh(
                    new THREE.CylinderGeometry(0.07, 0.07, 0.09, 20),
                    new THREE.MeshStandardMaterial({ color: COLORS.sensorLidar, roughness: 0.35 }),
                ),
                new THREE.Mesh(
                    new THREE.SphereGeometry(0.16, 12, 8),
                    new THREE.MeshBasicMaterial({ color: COLORS.sensorLidar, wireframe: true, transparent: true, opacity: 0.35 }),
                ),
            );
            return holder;
        }, (object, sensor) => {
            object.position.set(sensor.pose.position.x, sensor.pose.position.y, sensor.pose.position.z);
            object.rotation.set(
                sensor.pose.rotation.x,
                sensor.pose.rotation.y,
                sensor.pose.rotation.z,
            );
            if (sensor.pose.rotation.order) object.rotation.order = sensor.pose.rotation.order;
            if (sensor.type !== "camera") return sensor.type;
            const { fov, width, height } = sensor.config;
            return `camera:${fov}:${width}:${height}`;
        });
    }

    /**
     * Reconcile a group of pickable marker objects against manifest entries.
     * Rebuilds an entry's object only when its build signature changes.
     */
    _syncMarkerGroup(group, entries, kind, build, place) {
        const existing = new Map(group.children.map((child) => [child.userData.pick.id, child]));
        const keep = new Set();
        for (const entry of entries) {
            keep.add(entry.id);
            let object = existing.get(entry.id);
            const signature = object ? place(object, entry) : null;
            if (object && object.userData.signature !== signature) {
                if (this._isDragging(object)) continue;
                this._detachIfAttached(object);
                group.remove(object);
                object = null;
            }
            if (!object) {
                object = build(entry);
                object.userData.pick = { kind, id: entry.id };
                object.userData.signature = place(object, entry);
                object.traverse((child) => { child.userData.pick = object.userData.pick; });
                group.add(object);
                if (this._selection?.kind === kind && this._selection?.id === entry.id) {
                    this.gizmo.attach(object);
                }
            } else if (this._isDragging(object)) {
                // The gizmo owns this object's transform mid-drag.
            }
        }
        for (const [id, object] of existing) {
            if (keep.has(id)) continue;
            this._detachIfAttached(object);
            group.remove(object);
        }
    }

    _syncBody(manifest) {
        const { size, center } = manifest.boundingBox;
        if (!this._isDragging(this.bboxMesh)) {
            this.bboxMesh.position.set(center.x, center.y, center.z);
        }
        this.bboxMesh.scale.set(size.x, size.y, size.z);
        if (!this._isDragging(this.egoMarker)) {
            this.egoMarker.position.set(manifest.egoCenter.x, manifest.egoCenter.y, manifest.egoCenter.z);
        }
    }

    _syncZone(lidarZone) {
        const signature = zoneSignature(lidarZone);
        if (signature === this._zoneSignature) return;
        this._zoneSignature = signature;
        this.zoneGroup.clear();
        if (!lidarZone.vertices.length || !lidarZone.triangles.length) return;

        const positions = new Float32Array(lidarZone.vertices.length * 3);
        lidarZone.vertices.forEach(([x, y, z], index) => {
            positions[index * 3] = x;
            positions[index * 3 + 1] = y;
            positions[index * 3 + 2] = z;
        });
        const indices = new Uint32Array(lidarZone.triangles.flat());
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({ color: COLORS.zone, wireframe: true, transparent: true, opacity: 0.65 }),
        );
        this.zoneGroup.add(mesh);
    }

    setZoneVisible(visible) {
        this.zoneGroup.visible = visible;
    }

    setModelVisible(visible) {
        this.modelRoot.visible = visible;
    }

    // --- Selection and the gizmo --------------------------------------------

    /** @param {{kind: string, id: string|null} | null} selection */
    setSelection(selection) {
        this._selection = selection;
        this.gizmo.detach();
        const target = this._objectForSelection(selection);
        if (target) this.gizmo.attach(target);
    }

    setGizmoMode(mode) {
        this.gizmo.setMode(mode === "rotate" ? "rotate" : "translate");
    }

    _objectForSelection(selection) {
        if (!selection) return null;
        if (selection.kind === "body") return this.bboxMesh;
        if (selection.kind === "ego") return this.egoMarker;
        if (selection.kind === "model") return this._modelObject;
        const group = selection.kind === "wheel" ? this.wheelsGroup : this.sensorsGroup;
        return group.children.find((child) => child.userData.pick.id === selection.id) ?? null;
    }

    _isDragging(object) {
        return Boolean(this.gizmo.dragging && this.gizmo.object === object);
    }

    _detachIfAttached(object) {
        if (this.gizmo.object === object) this.gizmo.detach();
    }

    _emitTransform() {
        const object = this.gizmo.object;
        if (!object || !this._selection || !this.onTransform) return;
        this.onTransform(this._selection, {
            position: { x: object.position.x, y: object.position.y, z: object.position.z },
            rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
        });
    }

    _handleClick(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this._pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this._raycaster.setFromCamera(this._pointer, this.camera);
        const pickables = [...this.wheelsGroup.children, ...this.sensorsGroup.children, this.egoMarker];
        const hits = this._raycaster.intersectObjects(pickables, true);
        const pick = hits.find((hit) => hit.object.userData.pick)?.object.userData.pick
            ?? hits[0]?.object.parent?.userData.pick
            ?? null;
        if (pick) this.onSelect?.({ ...pick });
    }

    // --- Editor utilities ----------------------------------------------------

    /**
     * Bounds of the placed model in the vehicle-local frame.
     * @returns {{ size: {x,y,z}, center: {x,y,z} } | null}
     */
    getModelBounds() {
        if (!this._modelObject) return null;
        this.modelRoot.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(this.modelRoot);
        if (bounds.isEmpty()) return null;
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        return {
            size: { x: size.x, y: size.y, z: size.z },
            center: { x: center.x, y: center.y, z: center.z },
        };
    }

    /**
     * Run the voxel-clustering simplifier over the placed model and return
     * bakeable lidar zone arrays.
     */
    generateLidarZone(voxelSize) {
        if (!this._modelObject) {
            throw new Error("Import and place a model before generating the LiDAR zone.");
        }
        const optimizer = TriangleOptimizer.fromObject(this.modelRoot);
        if (optimizer.vertices.length === 0) {
            throw new Error("The model contains no mesh geometry.");
        }
        optimizer.optimize(voxelSize);
        const round = (value) => Math.round(value * 10000) / 10000;
        return {
            params: { voxelSize },
            vertices: optimizer.vertices.map((vertex) => [round(vertex.x), round(vertex.y), round(vertex.z)]),
            triangles: optimizer.triangles.map(([a, b, c]) => [a, b, c]),
        };
    }
}

const CAMERA_FRUSTUM_DEPTH = 0.26;

/**
 * View frustum for a camera sensor: apex at the sensor origin, opening along
 * +X (vehicle forward) with the vertical extent from `fov` and the horizontal
 * extent from the image aspect ratio.
 */
function buildCameraFrustum({ fov, width, height }) {
    const halfHeight = CAMERA_FRUSTUM_DEPTH * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    // A 4-segment cone is a pyramid; the quarter-turn theta start puts its faces
    // on the up and lateral axes instead of on the diagonals.
    const geometry = new THREE.ConeGeometry(
        halfHeight * Math.SQRT2,
        CAMERA_FRUSTUM_DEPTH,
        4,
        1,
        true,
        Math.PI / 4,
    );
    geometry.rotateZ(Math.PI / 2);
    geometry.translate(CAMERA_FRUSTUM_DEPTH / 2, 0, 0);
    const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: COLORS.sensorCamera, wireframe: true }),
    );
    mesh.scale.z = width / height;
    return mesh;
}

function zoneSignature(lidarZone) {
    const first = lidarZone.vertices[0] ?? [];
    const last = lidarZone.vertices.at(-1) ?? [];
    return [
        lidarZone.vertices.length,
        lidarZone.triangles.length,
        lidarZone.params.voxelSize,
        ...first,
        ...last,
    ].join(":");
}
