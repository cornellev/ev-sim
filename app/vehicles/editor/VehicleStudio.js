import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { TriangleOptimizer } from "../../optimization/TriangleOptimizer.js";
import { applyModelPlacement } from "../../3d/vehicles/ModelPlacement.js";
import {
    applyMeasuredPlacement,
    captureModelRest,
    clearPresentedWheels,
    presentBoundWheels,
    restoreModelRest,
} from "../../3d/vehicles/presentBoundWheels.js";
import { VehicleModelLoader, publishedVehicleModelSource, stagedVehicleModelSource } from "../../3d/vehicles/VehicleModelLoader.js";
import { sensorRuntimeRegistry } from "../../3d/devices/SensorRuntimeRegistry.js";
import { measurePlacedVehicleModel } from "../model/measurePlacedVehicle.js";
import { visualWheelYaws } from "../plan/turnGeometry.js";
import {
    ORBIT_ALIGN_MS,
    ORBIT_FREE_POLAR_ANGLE,
    alignProgress,
    orbitPoseForAxis,
    slerpDirection,
} from "./alignOrbitAxis.js";

const COLORS = {
    background: 0x09090b,
    grid: 0x27272a,
    gridCenter: 0x3f3f46,
    wheel: 0x18181b,
    wheelSteerable: 0x0c4a6e,
    wheelLink: 0x38bdf8,
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
     *   onPlacementCommit?: (selection: {kind: string, id: string|null}, transform: {position: {x,y,z}, rotation: {x,y,z}}) => void,
     *   onWheelDragStart?: (selection: {kind: "wheel", id: string}) => void,
     *   onWheelDragEnd?: (selection: {kind: "wheel", id: string}) => void,
     *   onWheelDragCancel?: () => void,
     * }} callbacks
     */
    constructor(container, { onTransform, onSelect, onPlacementCommit, onWheelDragStart, onWheelDragEnd, onWheelDragCancel, onModelLease, sensorRuntime = sensorRuntimeRegistry, modelLoader = null } = {}) {
        this.container = container;
        this.onTransform = onTransform;
        this.onSelect = onSelect;
        this.onPlacementCommit = onPlacementCommit;
        this.onWheelDragStart = onWheelDragStart;
        this.onWheelDragEnd = onWheelDragEnd;
        this.onWheelDragCancel = onWheelDragCancel;
        this.onModelLease = onModelLease;
        this.sensorRuntime = sensorRuntime;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);
        this.scene.fog = new THREE.Fog(COLORS.background, 30, 80);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
        this.camera.position.set(4.5, 3, 4.5);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(this.renderer.domElement);
        this.modelLoader = modelLoader ?? new VehicleModelLoader({ THREE, renderer: this.renderer });
        this._ownsModelLoader = modelLoader == null;

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
        this.orbit.maxPolarAngle = ORBIT_FREE_POLAR_ANGLE;
        this.orbit.minDistance = 0.5;
        this.orbit.maxDistance = 60;
        this._align = null;
        this._cameraListeners = new Set();
        this._onOrbitStart = () => {
            this._align = null;
            this.camera.up.set(0, 1, 0);
        };
        this.orbit.addEventListener("start", this._onOrbitStart);

        this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
        this.gizmo.setSize(0.8);
        this.gizmo.addEventListener("dragging-changed", (event) => {
            this.orbit.enabled = !event.value;
        });
        this.gizmo.addEventListener("mouseDown", () => {
            this.orbit.enabled = false;
            this._beginPlacementDrag();
            this._beginWheelDrag();
        });
        this.gizmo.addEventListener("mouseUp", () => {
            this.orbit.enabled = true;
            const selectedWheel = this._selection?.kind === "wheel"
                ? this._manifest?.wheels?.find((wheel) => wheel.id === this._selection.id)
                : null;
            const snapBoundWheel = selectedWheel?.visual?.kind === "model-node" && !this._placementDrag;
            this._finishPlacementDrag();
            this._finishWheelDrag();
            if (snapBoundWheel) {
                queueMicrotask(() => {
                    if (!this._disposed && this._manifest) this.setManifest(this._manifest, this._modelUrl, this._stagedResources);
                });
            }
        });
        this.gizmo.addEventListener("objectChange", () => this._onGizmoChange());
        this.scene.add(this.gizmo.getHelper ? this.gizmo.getHelper() : this.gizmo);

        // Manifest-driven groups, all in the vehicle-local frame at the origin.
        this.modelRoot = new THREE.Group();
        this.wheelsGroup = new THREE.Group();
        this.sensorsGroup = new THREE.Group();
        this.zoneGroup = new THREE.Group();
        this.scene.add(this.modelRoot, this.wheelsGroup, this.sensorsGroup, this.zoneGroup);
        this._steeringPreview = 0;

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
        this._modelKey = "";
        this._modelLease = null;
        this._modelAbort = null;
        this._modelObject = null;
        this._modelAlignment = { x: 0, y: 0, z: 0 };
        this._pendingBoundingBox = null;
        this._pendingModel = null;
        this._manifest = null;
        this._modelUrl = null;
        this._canonical = false;
        this._modelRest = null;
        this._presentationSuspended = false;
        this._placementDrag = null;
        this._wheelDrag = null;
        this._cancelWheelDrag = false;
        this._linkedWheelId = null;
        this._loadToken = 0;
        this._disposed = false;

        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._pointerDown = null;
        this._onPointerDown = (event) => {
            this._pointerDown = { x: event.clientX, y: event.clientY };
        };
        this._onPointerUp = (event) => {
            // TransformControls only emits mouseUp while an axis is set. A preview that
            // cleared the axis would otherwise leave the wheel gesture open.
            const pendingWheelDrag = this._wheelDrag;
            if (pendingWheelDrag) this._finishWheelDrag();
            const start = this._pointerDown;
            this._pointerDown = null;
            if (pendingWheelDrag || !start || this.gizmo.dragging) return;
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
            this._stepAlign();
            this.orbit.update();
            this._publishCamera();
            this.renderer.render(this.scene, this.camera);
        };
        animate();
    }

    dispose() {
        this._disposed = true;
        this._modelAbort?.abort();
        this._modelLease?.dispose();
        this._modelLease = null;
        if (this._ownsModelLoader) this.modelLoader.dispose();
        cancelAnimationFrame(this._frame);
        this._cameraListeners.clear();
        this.orbit.removeEventListener("start", this._onOrbitStart);
        this._resizeObserver.disconnect();
        this.renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);
        this.renderer.domElement.removeEventListener("pointerup", this._onPointerUp);
        this.gizmo.detach();
        this.gizmo.dispose?.();
        this.orbit.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    /**
     * Ease the orbit camera onto a vehicle axis, keeping the current target and distance.
     * A later call replaces an alignment that is still running.
     * @param {"+x"|"-x"|"+y"|"-y"|"+z"|"-z"} axisId
     */
    alignToAxis(axisId) {
        const target = { x: this.orbit.target.x, y: this.orbit.target.y, z: this.orbit.target.z };
        const from = {
            x: this.camera.position.x - target.x,
            y: this.camera.position.y - target.y,
            z: this.camera.position.z - target.z,
        };
        const raw = Math.hypot(from.x, from.y, from.z);
        const distance = Math.min(this.orbit.maxDistance, Math.max(this.orbit.minDistance, raw || 1));
        const pose = orbitPoseForAxis({ axis: axisId, target, distance });
        if (!pose) return;
        // Open the limit before a bottom turn. A tighter limit waits until the
        // ease finishes so orbit.update() does not clamp the path.
        if (pose.maxPolarAngle > this.orbit.maxPolarAngle) this.orbit.maxPolarAngle = pose.maxPolarAngle;
        this.camera.up.set(pose.up.x, pose.up.y, pose.up.z);
        this._align = {
            from,
            to: {
                x: pose.position.x - target.x,
                y: pose.position.y - target.y,
                z: pose.position.z - target.z,
            },
            target,
            distance,
            up: pose.up,
            maxPolarAngle: pose.maxPolarAngle,
            started: performance.now(),
        };
    }

    /** @param {(quaternion: {x:number,y:number,z:number,w:number}) => void} listener */
    onCameraFrame(listener) {
        this._cameraListeners.add(listener);
        listener(this._quaternionSnapshot());
        return () => { this._cameraListeners.delete(listener); };
    }

    _stepAlign() {
        if (!this._align) return;
        const elapsed = performance.now() - this._align.started;
        const direction = slerpDirection(this._align.from, this._align.to, alignProgress(elapsed));
        const { target, distance, up, maxPolarAngle } = this._align;
        this.camera.up.set(up.x, up.y, up.z);
        this.camera.position.set(
            target.x + direction.x * distance,
            target.y + direction.y * distance,
            target.z + direction.z * distance,
        );
        if (elapsed >= ORBIT_ALIGN_MS) {
            this.orbit.maxPolarAngle = maxPolarAngle;
            this._align = null;
        }
    }

    _publishCamera() {
        if (this._cameraListeners.size === 0) return;
        const quaternion = this._quaternionSnapshot();
        for (const listener of this._cameraListeners) listener(quaternion);
    }

    _quaternionSnapshot() {
        const { x, y, z, w } = this.camera.quaternion;
        return { x, y, z, w };
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
    setManifest(manifest, modelUrl, stagedResources = undefined) {
        this._manifest = manifest;
        this._modelUrl = modelUrl;
        if (stagedResources !== undefined) this._stagedResources = stagedResources;
        if (this._presentationSuspended && !this._placementDrag) this._presentationSuspended = false;
        this._syncModel(manifest, modelUrl, this._stagedResources ?? null);
        if (!this._canonical || this._presentationSuspended) this._syncWheels(manifest.wheels);
        this._applyWheelLinkTint();
        this._syncSensors(manifest.sensors);
        this._syncBody(manifest);
        this._syncZone(manifest.lidarZone);
        this._applySteeringPreview();
    }

    setSteeringPreview(angle) {
        this._steeringPreview = Number(angle) || 0;
        this._applySteeringPreview();
    }

    _applySteeringPreview() {
        if (!this._manifest || !this.wheelsGroup) return;
        const yaws = visualWheelYaws(this._manifest, this._steeringPreview);
        const byId = new Map(yaws.map((entry) => [entry.wheelId, entry.yaw]));
        for (const child of this.wheelsGroup.children) {
            const id = child.userData?.pick?.id;
            if (!id || !byId.has(id) || this._isDragging(child)) continue;
            child.rotation.y = byId.get(id);
        }
    }

    getModelLease() {
        return this._modelLease;
    }

    _syncModel(manifest, modelUrl, stagedResources = null) {
        const model = manifest.model;
        const boundingBox = manifest.boundingBox;
        const source = stagedVehicleModelSource(manifest, stagedResources)
            ?? (modelUrl ? publishedVehicleModelSource(manifest, modelUrl) : null);
        const sourceKey = source?.asset
            ? JSON.stringify([source.asset.url, ...(source.dependencies ?? []).map((entry) => entry.url)])
            : (source?.url ?? "");
        this._pendingBoundingBox = boundingBox;
        if (sourceKey !== this._modelKey) {
            this._modelKey = sourceKey;
            this._modelAbort?.abort();
            this._modelLease?.dispose();
            this._modelLease = null;
            this._canonical = false;
            this._modelRest = null;
            this._presentationSuspended = false;
            this.modelRoot.clear();
            this._modelObject = null;
            this._placeholder = null;
            this.onModelLease?.(null);
            if (source) {
                const token = ++this._loadToken;
                this._modelAbort = new AbortController();
                this.modelLoader.load({
                    slotId: "studio",
                    source,
                    model,
                    boundingBox,
                }, { signal: this._modelAbort.signal }).then((lease) => {
                    if (this._disposed || token !== this._loadToken) {
                        lease?.dispose?.();
                        return;
                    }
                    if (!lease?.root || lease.stale || lease.aborted) {
                        lease?.dispose?.();
                        if (!lease?.stale && !lease?.aborted) this._syncPlaceholder(this._pendingBoundingBox);
                        return;
                    }
                    this.modelRoot.clear();
                    this._placeholder = null;
                    this._modelLease = lease;
                    this._modelObject = lease.root;
                    this.modelRoot.add(this._modelObject);
                    this.onModelLease?.(lease);
                    if (this._manifest?.version === 3 && lease.glbBytes) {
                        this._presentCanonical(this._manifest);
                    } else {
                        this._canonical = false;
                        this._modelAlignment = applyModelPlacement(
                            this._modelObject,
                            this._pendingModel ?? model,
                            this._pendingBoundingBox,
                        );
                        if (this._manifest) this._syncWheels(this._manifest.wheels);
                        this._applyWheelLinkTint();
                    }
                    if (this._selection) this.setSelection(this._selection);
                }).catch((error) => {
                    console.warn("Vehicle editor could not load model:", error);
                    if (this._disposed || token !== this._loadToken) return;
                    this.onModelLease?.(null);
                    this._syncPlaceholder(this._pendingBoundingBox);
                });
            } else {
                this._syncPlaceholder(boundingBox);
            }
        } else if (!source) {
            this._syncPlaceholder(boundingBox);
        }
        this._pendingModel = model;
        if (this._modelObject && !this._isDragging(this._modelObject) && !this._presentationSuspended) {
            if (this._canonical) this._presentCanonical(manifest);
            else {
                this._modelAlignment = applyModelPlacement(
                    this._modelObject,
                    model,
                    this._pendingBoundingBox,
                );
            }
        }
    }

    _presentCanonical(manifest) {
        const lease = this._modelLease;
        if (!lease?.glbBytes || !this._modelObject || manifest?.version !== 3) {
            this._canonical = false;
            return;
        }
        try {
            this._presentMeasured(manifest, lease);
        } catch (error) {
            console.warn("Vehicle editor could not present bound wheels:", error);
            this._canonical = false;
            this._modelAlignment = applyModelPlacement(
                this._modelObject,
                manifest.model,
                manifest.boundingBox,
            );
        }
    }

    _presentMeasured(manifest, lease) {
        if (this._modelRest) restoreModelRest(this._modelRest);
        const measurement = measurePlacedVehicleModel({
            glbBytes: lease.glbBytes,
            model: manifest.model,
            boundingBox: manifest.boundingBox,
            hiddenNodeIndices: manifest.model?.hiddenNodeIndices ?? [],
        });
        applyMeasuredPlacement(this._modelObject, measurement.placement);
        this._modelAlignment = { ...(measurement.placement.alignment ?? { x: 0, y: 0, z: 0 }) };
        this._modelRest = captureModelRest(this._modelObject, lease.nodeMappings);
        this._clearMarkerWheels();
        presentBoundWheels({
            root: this._modelObject,
            wheelsGroup: this.wheelsGroup,
            manifest,
            nodeMappings: lease.nodeMappings,
            THREE,
        });
        this._canonical = true;
        this._presentationSuspended = false;
        this._applySteeringPreview();
        this._applyWheelLinkTint();
    }

    _suspendPresentation() {
        if (!this._canonical || this._presentationSuspended) return;
        restoreModelRest(this._modelRest ?? []);
        clearPresentedWheels(this.wheelsGroup);
        this._presentationSuspended = true;
    }

    _clearMarkerWheels() {
        for (const child of [...this.wheelsGroup.children]) {
            if (child.userData?.presentedWheel) continue;
            this._detachIfAttached(child);
            child.traverse((object) => {
                object.geometry?.dispose?.();
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                materials.forEach((material) => material?.dispose?.());
            });
            this.wheelsGroup.remove(child);
        }
    }

    _hasBoundWheels() {
        return (this._manifest?.wheels ?? []).some((wheel) => wheel.visual?.kind === "model-node");
    }

    _beginWheelDrag() {
        if (this.gizmo.mode !== "translate" || this._selection?.kind !== "wheel") return;
        const wheel = this._manifest?.wheels?.find((entry) => entry.id === this._selection.id);
        if (!wheel || wheel.visual?.kind === "model-node") return;
        this._wheelDrag = { kind: "wheel", id: wheel.id };
        this.onWheelDragStart?.(this._wheelDrag);
    }

    _finishWheelDrag() {
        const drag = this._wheelDrag;
        this._wheelDrag = null;
        if (!drag) return;
        if (this._cancelWheelDrag) this.onWheelDragCancel?.();
        else this.onWheelDragEnd?.(drag);
    }

    /** End a wheel-gizmo drag without committing it. */
    cancelDrag() {
        this._cancelWheelDrag = true;
        if (this.gizmo.dragging && this.gizmo.object) {
            this.gizmo.reset();
            this.gizmo.pointerUp(null);
        }
        if (this._wheelDrag) this._finishWheelDrag();
        this._cancelWheelDrag = false;
        this.orbit.enabled = true;
    }

    setLinkedWheel(id) {
        this._linkedWheelId = id || null;
        this._applyWheelLinkTint();
    }

    _applyWheelLinkTint() {
        const linkedId = this._linkedWheelId;
        for (const child of this.wheelsGroup?.children ?? []) {
            const mesh = child.isMesh ? child : child.children?.find((entry) => entry.isMesh);
            const material = mesh?.material;
            if (!material?.emissive) continue;
            const linked = child.userData.pick?.id === linkedId;
            material.emissive.setHex(linked ? COLORS.wheelLink : 0x000000);
            material.emissiveIntensity = linked ? 0.55 : 0;
        }
    }

    _beginPlacementDrag() {
        const kind = this._selection?.kind;
        if (!this._canonical || !this._hasBoundWheels() || (kind !== "model" && kind !== "body")) return;
        this._suspendPresentation();
        this._placementDrag = {
            kind,
            modelPosition: this._modelObject ? this._modelObject.position.clone() : null,
            center: {
                x: this._manifest?.boundingBox?.center?.x || 0,
                y: this._manifest?.boundingBox?.center?.y || 0,
                z: this._manifest?.boundingBox?.center?.z || 0,
            },
        };
    }

    _onGizmoChange() {
        if (this._cancelWheelDrag) return;
        const drag = this._placementDrag;
        if (drag?.kind === "body" && this._modelObject && drag.modelPosition) {
            this._modelObject.position.set(
                drag.modelPosition.x + (this.bboxMesh.position.x - drag.center.x),
                drag.modelPosition.y + (this.bboxMesh.position.y - drag.center.y),
                drag.modelPosition.z + (this.bboxMesh.position.z - drag.center.z),
            );
            return;
        }
        if (drag?.kind === "model") return;
        this._emitTransform();
    }

    _finishPlacementDrag() {
        const drag = this._placementDrag;
        this._placementDrag = null;
        if (!drag) return;
        const object = drag.kind === "body" ? this.bboxMesh : this._modelObject;
        if (!object) return;
        const transform = {
            position: { x: object.position.x, y: object.position.y, z: object.position.z },
            rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
        };
        const selection = this._selection ? { ...this._selection } : { kind: drag.kind, id: null };
        queueMicrotask(() => {
            if (this._disposed) return;
            if (this.onPlacementCommit) this.onPlacementCommit(selection, transform);
            else if (this._manifest) this.setManifest(this._manifest, this._modelUrl, this._stagedResources);
        });
    }

    /** AABB alignment used by the last applyModelPlacement (before model.offset). */
    getModelAlignment() {
        return this._modelAlignment ? { ...this._modelAlignment } : { x: 0, y: 0, z: 0 };
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
            if (!this._isDragging(object)) {
                object.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
            }
            // Radius or width changes require new geometry; encode in signature.
            return `${wheel.radius}:${wheel.width}:${wheel.steerable}`;
        });
    }

    _syncSensors(sensors) {
        this._syncMarkerGroup(this.sensorsGroup, sensors, "sensor", (sensor) => (
            this.sensorRuntime.createPreview(sensor)
        ), (object, sensor) => {
            object.position.set(sensor.pose.position.x, sensor.pose.position.y, sensor.pose.position.z);
            object.rotation.set(
                sensor.pose.rotation.x,
                sensor.pose.rotation.y,
                sensor.pose.rotation.z,
            );
            if (sensor.pose.rotation.order) object.rotation.order = sensor.pose.rotation.order;
            return this.sensorRuntime.previewSignature(sensor);
        });
    }

    setSensorRuntime(sensorRuntime) {
        this.sensorRuntime = sensorRuntime || sensorRuntimeRegistry;
        if (this._manifest) this._syncSensors(this._manifest.sensors ?? []);
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
        const next = selection?.kind ? selection : null;
        const target = this._objectForSelection(next);
        const current = this._selection?.kind ? this._selection : null;
        const same = current?.kind === next?.kind && (current?.id ?? null) === (next?.id ?? null);
        if (same && this.gizmo.object === target) {
            this._selection = next;
            return;
        }
        this._selection = next;
        this.gizmo.detach();
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
        const resume = this._canonical && !this._presentationSuspended;
        if (resume) this._suspendPresentation();
        this.modelRoot.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(this.modelRoot);
        if (resume && this._manifest) this._presentCanonical(this._manifest);
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
