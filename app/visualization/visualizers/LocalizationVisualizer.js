import * as THREE from "three";
import { Visualizer } from "../Visualizer.js";
import { rep103OrientationToThreeEuler, rep103ToThreeVector } from "../../autonomy/CoordinateFrames.js";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { cachedStatusBadge, disableRaycast, disposeObject } from "../../3d/overlay/overlayObjects.js";
import { PLAN_COLORS } from "../../spatial/planview/primitives.js";

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const ERROR_COLOR = 0xfbbf24;

function scenePosition(pose) {
    return pose?.threePosition ?? (pose?.position ? rep103ToThreeVector(pose.position) : null);
}

/** Runtime truth is already aligned to the estimate capture; never substitute current vehicle pose. */
export function localizationSnapshotInputs(localization = {}, metadata = {}) {
    const estimate = localization?.estimate;
    Object.assign(metadata, { ...estimate?.metadata, ...localization?.metadata, ...metadata });
    for (const key of ["runId", "captureTimeNs", "sequenceId", "frameId"]) {
        if (metadata[key] == null) {
            const value = localization?.[key] ?? estimate?.[key];
            if (value != null) metadata[key] = value;
        }
    }
    if (metadata.sequenceId == null && estimate?.sequence != null) metadata.sequenceId = estimate.sequence;
    return {
        ...(estimate ? { position: scenePosition(estimate) } : {}),
        active: Boolean(estimate),
        orientation: estimate?.orientation ? rep103OrientationToThreeEuler(estimate.orientation) : IDENTITY,
        covarianceEllipse: estimate?.covarianceEllipse ?? null,
        truthPosition: scenePosition(localization?.truth),
        error: localization?.error ?? null,
        status: localization?.status ?? "ok",
        estimateStatus: estimate?.status ?? null,
        ageNs: localization?.ageNs ?? null,
    };
}

function finitePosition(position) {
    return position && [position.x, position.y, position.z].every(Number.isFinite);
}

export class LocalizationVisualizer extends Visualizer {
    constructor({ createAppearanceClone = () => null, ...options } = {}) {
        super({ ...options, requiredInputs: ["position"], optionalInputs: {
            active: true, orientation: IDENTITY, covarianceEllipse: null, truthPosition: null,
            error: null, status: "ok", estimateStatus: null, ageNs: null,
        } });
        this.createAppearanceClone = createAppearanceClone;
        this.displayOnStatusChange = true;
        this.group = disableRaycast(new THREE.Group());
        this.group.name = "localization-visualizer";
        this.group.userData.nonColliding = true;
        this.markers = disableRaycast(new THREE.Group());
        this.group.add(this.markers);
        this.clone = null;
        this.ghost = null;
        this.ellipse = null;
        this.errorLine = null;
        this.badge = null;
        this.covariancePoints = null;
        this.covarianceRadii = null;
        this.mapCovariance = null;
        this.mapOutput = { primitives: [] };
    }

    validateInputs(inputs) {
        if (!finitePosition(inputs.position)) return "Localization position must have finite scene coordinates.";
        const orientation = inputs.orientation;
        if (!orientation || typeof orientation !== "object" || Array.isArray(orientation)
            || ![orientation.x ?? 0, orientation.y ?? 0, orientation.z ?? 0, orientation.w ?? 1].every(Number.isFinite)
            || !["XYZ", "YZX", "ZXY", "XZY", "YXZ", "ZYX"].includes(orientation.order ?? "XYZ")
            || (orientation.w != null && Math.hypot(orientation.x ?? 0, orientation.y ?? 0, orientation.z ?? 0, orientation.w) === 0)) return "Localization orientation must be finite and nonzero.";
        if (inputs.covarianceEllipse != null && ![inputs.covarianceEllipse.sigmaX, inputs.covarianceEllipse.sigmaY].every((value) => Number.isFinite(value) && value >= 0)) return "Localization covariance radii must be finite and nonnegative.";
        if (inputs.truthPosition != null && !finitePosition(inputs.truthPosition)) return "Localization truth position must have finite scene coordinates.";
        if (typeof inputs.active !== "boolean" || typeof inputs.status !== "string" || (inputs.estimateStatus != null && typeof inputs.estimateStatus !== "string")) return "Invalid localization display status.";
        if (inputs.ageNs != null && !(Number.isFinite(inputs.ageNs) && inputs.ageNs >= 0) && !(typeof inputs.ageNs === "bigint" && inputs.ageNs >= 0n)) return "Localization age must be nonnegative nanoseconds.";
        return true;
    }

    _status() { return this.status === "ready" ? this.inputs.status : this.status; }
    _color() {
        const status = this.status === "ready" ? this.inputs.estimateStatus ?? this.inputs.status : this.status;
        if (status === "stale") return 0xf59e0b;
        if (["invalid", "rejected", "missing-frame", "error"].includes(status)) return 0xfb7185;
        return 0x38bdf8;
    }
    _badgeLabel() {
        const status = this._status();
        if (status === "ok" || status === "ready") return "";
        const age = this.inputs.ageNs;
        return `${status} ${age == null ? "?" : (Number(age) / 1e6).toFixed(0)}ms`;
    }

    _line(color, opacity) {
        const line = disableRaycast(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false })));
        line.renderOrder = 1100;
        this.markers.add(line);
        return line;
    }

    _covariancePoints() {
        const covariance = this.inputs.covarianceEllipse;
        if (!covariance) return null;
        const sigmaX = Math.max(0.05, covariance.sigmaX);
        const sigmaY = Math.max(0.05, covariance.sigmaY);
        if (this.covarianceRadii?.sigmaX !== sigmaX || this.covarianceRadii?.sigmaY !== sigmaY) {
            this.covarianceRadii = { sigmaX, sigmaY };
            this.covariancePoints = Array.from({ length: 49 }, (_, index) => new THREE.Vector3(Math.cos(index / 48 * Math.PI * 2) * sigmaX, 0.05, Math.sin(index / 48 * Math.PI * 2) * sigmaY));
        }
        return this.covariancePoints;
    }

    display({ scene, camera } = {}) {
        camera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (scene && !this.group.parent) scene.add(this.group);
        if (!this.inputs.active) { this._visibility(); return this.group; }
        const pos = this.inputs.position;
        if (!this.clone && this.layerVisibility.scene.estimateClone !== false) {
            try {
                const clone = this.createAppearanceClone();
                if (clone && !clone.isObject3D) throw new TypeError("Localization appearance factory must return an owned Object3D.");
                if (clone) {
                    clone.traverse(disableRaycast);
                    this.clone = clone;
                    this.group.add(clone);
                }
            } catch (error) { this.setStatus("error", error.message); }
        }
        const color = this._color();
        if (this.clone) {
            this.clone.position.set(pos.x, pos.y, pos.z);
            const orientation = this.inputs.orientation;
            if (orientation.w != null) this.clone.quaternion.set(orientation.x ?? 0, orientation.y ?? 0, orientation.z ?? 0, orientation.w).normalize();
            else this.clone.rotation.set(orientation.x ?? 0, orientation.y ?? 0, orientation.z ?? 0, orientation.order ?? "XYZ");
        }
        if (!this.ghost) {
            this.ghost = disableRaycast(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 0.9), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false })));
            this.ghost.renderOrder = 1100;
            this.markers.add(this.ghost);
        }
        this.ghost.position.set(pos.x, pos.y + 0.35, pos.z);
        this.ghost.material.color.setHex(color);
        const covariance = this.inputs.covarianceEllipse;
        if (covariance) {
            this.ellipse ??= this._line(color, 0.85);
            const points = this._covariancePoints();
            if (this.ellipse.userData.points !== points) {
                this.ellipse.geometry.setFromPoints(points);
                this.ellipse.userData.points = points;
            }
            this.ellipse.position.set(pos.x, pos.y, pos.z);
            this.ellipse.material.color.setHex(color);
        }
        if (this.inputs.error && this.inputs.truthPosition) {
            this.errorLine ??= this._line(ERROR_COLOR, 0.9);
            const truth = this.inputs.truthPosition;
            const delta = [truth.x - pos.x, truth.y - pos.y, truth.z - pos.z];
            if (!this.errorLine.userData.delta || delta.some((value, index) => value !== this.errorLine.userData.delta[index])) {
                this.errorLine.geometry.setFromPoints([new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(delta[0], delta[1] + 0.2, delta[2])]);
                this.errorLine.userData.delta = delta;
            }
            this.errorLine.position.set(pos.x, pos.y, pos.z);
        }
        const label = this._badgeLabel();
        if (label && (this.badge?.userData.badgeLabel !== label || this.badge?.userData.badgeColor !== color)) {
            this._disposeBadge();
            // Age labels vary indefinitely; only this tool's current texture is retained.
            this.badge = cachedStatusBadge(label, color, { cache: false });
            Object.assign(this.badge.userData, { badgeLabel: label, badgeColor: color });
            this.markers.add(this.badge);
        }
        if (this.badge) this.badge.position.set(pos.x, pos.y, pos.z);
        this._visibility();
        return this.group;
    }

    displayMap() {
        const primitives = [];
        if (this.inputs.active && this.layerVisibility.map.ekf !== false) {
            const pos = this.inputs.position;
            const center = { x: pos.x, z: pos.z };
            const color = `#${this._color().toString(16).padStart(6, "0")}`;
            if (this.inputs.error && this.inputs.truthPosition) primitives.push({ kind: "polyline", points: [this.inputs.truthPosition, center], stroke: PLAN_COLORS.error, strokeWidth: 1.5, dash: "4 3" });
            primitives.push({ kind: "circle", center, radiusPx: 5, fill: "none", stroke: color, strokeWidth: 2 });
            const points = this._covariancePoints();
            if (points) {
                if (this.mapCovariance?.source !== points || this.mapCovariance.x !== pos.x || this.mapCovariance.z !== pos.z) {
                    this.mapCovariance = { source: points, x: pos.x, z: pos.z, points: points.map((point) => ({ x: pos.x + point.x, z: pos.z + point.z })) };
                }
                primitives.push({ kind: "polyline", points: this.mapCovariance.points, stroke: color, strokeWidth: 1, opacity: 0.85 });
            }
            const label = this._badgeLabel();
            if (label) primitives.push({ kind: "label", anchor: center, text: label, fill: color });
        }
        this.mapOutput = { primitives };
        return this.mapOutput;
    }

    _visibility() {
        const active = this.ready && this.inputs.active;
        this.group.visible = this.visible.scene && active;
        this.markers.visible = this.layerVisibility.scene.ekf !== false;
        if (this.clone) { this.clone.visible = this.visible.scene && active && this.layerVisibility.scene.estimateClone !== false; this.clone.userData.estimateCurrent = active; }
        if (this.ghost) this.ghost.visible = !this.clone?.visible;
        if (this.ellipse) this.ellipse.visible = Boolean(this.inputs.covarianceEllipse);
        if (this.errorLine) this.errorLine.visible = Boolean(this.inputs.error && this.inputs.truthPosition);
        if (this.badge) this.badge.visible = Boolean(this._badgeLabel());
    }
    onVisibilityChange(target) { if (target === "scene") this._visibility(); }
    onLayerVisibilityChange(_layerId, target) { if (target === "scene") this._visibility(); }
    disposeEstimateClone() {
        this.clone?.traverse(disposeObject);
        this.clone?.removeFromParent();
        this.clone = null;
        this._visibility();
    }
    _disposeBadge() { this.badge?.traverse(disposeObject); this.badge?.removeFromParent(); this.badge = null; }
    reset() {
        this.disposeEstimateClone();
        this._disposeBadge();
        super.reset();
        this._visibility();
        this.mapOutput = { primitives: [] };
    }
    dispose() {
        this.disposeEstimateClone();
        this.group.traverse(disposeObject);
        this.group.removeFromParent();
        this.markers.clear();
        this.group.clear();
        this.ghost = this.ellipse = this.errorLine = this.badge = null;
        this.covariancePoints = this.covarianceRadii = this.mapCovariance = null;
        this.mapOutput = { primitives: [] };
        super.dispose();
    }
}
