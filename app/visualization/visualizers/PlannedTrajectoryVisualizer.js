import * as THREE from "three";
import { Visualizer } from "../Visualizer.js";
import { applyControlsPathRibbonPose } from "../../autonomy/ControlsPathArc.js";
import { disableRaycast, disposeObject } from "../../3d/overlay/overlayObjects.js";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { PLAN_COLORS } from "../../spatial/planview/primitives.js";

const EMPTY_POINTS = Object.freeze([]);

/** Normalized replay .three points are capture-world coordinates; frameId remains metadata. */
export function plannedPathSnapshotInputs(path) {
    return {
        points: path?.status === "ok" ? path.points ?? EMPTY_POINTS : EMPTY_POINTS,
        vehicleRelative: path?.vehicleRelative === true,
    };
}

export class PlannedTrajectoryVisualizer extends Visualizer {
    constructor(options = {}) {
        super({ ...options, requiredInputs: ["points"], optionalInputs: { vehicleRelative: false } });
        this.group = disableRaycast(new THREE.Group());
        this.group.name = "planned-trajectory-visualizer";
        this.group.userData.nonColliding = true;
        this.line = disableRaycast(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
            color: PLAN_COLORS.candidate, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false,
        })));
        this.line.renderOrder = 1100;
        this.group.add(this.line);
        this.points = [];
        this._pointsRevision = 0;
        this._sceneRevision = -1;
        this.mapOutput = { primitives: [] };
    }

    validateInputs(inputs) {
        if (!Array.isArray(inputs.points)) return "Planned trajectory points must be an array.";
        if (typeof inputs.vehicleRelative !== "boolean") return "Planned trajectory placement must be boolean.";
        if (inputs.points !== this.inputs.points && inputs.points.some((point) => {
            const position = point?.three ?? point;
            return !position || ![position.x, position.y ?? 0, position.z].every(Number.isFinite);
        })) return "Planned trajectory points must be finite scene coordinates.";
        return true;
    }

    validatePose(pose) {
        if (!pose.position || ![pose.position.x, pose.position.y ?? 0, pose.position.z].every(Number.isFinite)) return "Planned trajectory pose must have a finite position.";
        if (pose.yaw != null && !Number.isFinite(pose.yaw)) return "Planned trajectory yaw must be finite.";
        if (pose.rotation != null && (typeof pose.rotation !== "object" || Array.isArray(pose.rotation)
            || ![pose.rotation.x ?? 0, pose.rotation.y ?? 0, pose.rotation.z ?? 0].every(Number.isFinite)
            || !["XYZ", "YZX", "ZXY", "XZY", "YXZ", "ZYX"].includes(pose.rotation.order ?? "XYZ"))) return "Planned trajectory rotation must be a finite Euler rotation.";
        return true;
    }

    onDataUpdate(inputs, changedKeys) {
        if (!changedKeys.includes("points") && this.ready) return;
        this.points = inputs.points.map((point) => {
            const position = point.three ?? point;
            return { x: position.x, y: position.y ?? 0, z: position.z };
        });
        this._pointsRevision += 1;
    }

    acceptVehicleMove(pose, metadata) {
        const dirty = Object.fromEntries(["scene", "map"].map((target) => [target, this.dirty[target].placement]));
        const accepted = super.acceptVehicleMove(pose, metadata);
        if (!this.inputs.vehicleRelative) for (const target of ["scene", "map"]) this.dirty[target].placement = dirty[target];
        return accepted;
    }

    _placeRoot() {
        applyControlsPathRibbonPose(this.group, this.inputs.vehicleRelative ? this.pose : null);
        this.group.updateMatrix();
    }

    display({ scene, camera } = {}) {
        camera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (scene && !this.group.parent) scene.add(this.group);
        if (this._sceneRevision !== this._pointsRevision) {
            const positions = this.points.flatMap((point) => [point.x, point.y + 0.05, point.z]);
            let attribute = this.line.geometry.getAttribute("position");
            if (attribute?.array.length !== positions.length) {
                attribute = new THREE.Float32BufferAttribute(positions, 3);
                this.line.geometry.setAttribute("position", attribute);
            } else { attribute.array.set(positions); attribute.needsUpdate = true; }
            this.line.geometry.computeBoundingSphere();
            this._sceneRevision = this._pointsRevision;
        }
        this._placeRoot();
        this.line.visible = this.points.length > 1;
        this.group.visible = this.visible.scene;
        return this.group;
    }

    displayMap() {
        this._placeRoot();
        const points = this.points.map((point) => {
            const world = new THREE.Vector3(point.x, point.y + 0.05, point.z).applyMatrix4(this.group.matrix);
            return { x: world.x, y: world.y, z: world.z };
        });
        this.mapOutput = { primitives: points.length > 1 ? [{ kind: "polyline", points, stroke: PLAN_COLORS.candidate, strokeWidth: 2, opacity: 0.9 }] : [] };
        return this.mapOutput;
    }

    onVisibilityChange(target, visible) { if (target === "scene") this.group.visible = visible && this.ready; }

    reset() {
        super.reset();
        this.points = [];
        this._pointsRevision += 1;
        this.group.visible = false;
        this.line.visible = false;
        this.mapOutput = { primitives: [] };
    }

    dispose() {
        this.group.traverse(disposeObject);
        this.group.removeFromParent();
        this.line?.geometry.deleteAttribute("position");
        this.group.clear();
        this.line = null;
        this.points = [];
        this.mapOutput = { primitives: [] };
        super.dispose();
    }
}
