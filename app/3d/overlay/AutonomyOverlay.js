import * as THREE from "three";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { AckermannVisualizer, controlsSnapshotInputs } from "../../visualization/visualizers/AckermannVisualizer.js";
import { PlannedTrajectoryVisualizer, plannedPathSnapshotInputs } from "../../visualization/visualizers/PlannedTrajectoryVisualizer.js";
import { TrajectoryPastVisualizer } from "../../visualization/visualizers/TrajectoryPastVisualizer.js";
import { trajectoryTimeNs } from "../../visualization/trajectoryHistory.js";
import { VisualizationManager } from "../../visualization/VisualizationManager.js";
import { cachedStatusBadge, disableRaycast, disposeObject } from "./overlayObjects.js";
import { LocalizationVisualizer, localizationSnapshotInputs } from "../../visualization/visualizers/LocalizationVisualizer.js";
import { OccupancyVisualizer } from "../../visualization/visualizers/OccupancyVisualizer.js";

export const AUTONOMY_OVERLAY_LAYER = SCENARIO_DIAGNOSTIC_LAYER;

const COLORS = Object.freeze({
    oracle: 0x34d399,
    candidate: 0x38bdf8,
    stale: 0xf59e0b,
    invalid: 0xfb7185,
});

function statusColor(status, source) {
    if (status === "stale") return COLORS.stale;
    if (status === "invalid" || status === "rejected" || status === "missing-frame") return COLORS.invalid;
    return source === "oracle" ? COLORS.oracle : COLORS.candidate;
}

function boxEdgesGeometry(size) {
    const sx = Math.max(0.05, Number(size?.x || 0.05)) / 2;
    const sy = Math.max(0.05, Number(size?.y || 0.05)) / 2;
    const sz = Math.max(0.05, Number(size?.z || 0.05)) / 2;
    const corners = [
        [-sx, -sy, -sz], [sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz],
        [sx, sy, -sz], [-sx, sy, -sz], [-sx, sy, -sz], [-sx, -sy, -sz],
        [-sx, -sy, sz], [sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz],
        [sx, sy, sz], [-sx, sy, sz], [-sx, sy, sz], [-sx, -sy, sz],
        [-sx, -sy, -sz], [-sx, -sy, sz], [sx, -sy, -sz], [sx, -sy, sz],
        [sx, sy, -sz], [sx, sy, sz], [-sx, sy, -sz], [-sx, sy, sz],
    ];
    const positions = new Float32Array(corners.flat());
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
}

function hideExtra(group, count) {
    for (let index = count; index < group.children.length; index += 1) {
        group.children[index].visible = false;
    }
}

function snapshotContentKey({ perception } = {}) {
    return [
        perception?.captureTimeNs ?? perception?.ageNs ?? "",
        perception?.oracle?.captureTimeNs ?? "",
        perception?.status ?? "",
    ].join("|");
}

/**
 * Operator-only 3D overlays for candidate/oracle perception and EKF estimate.
 * Mirrors ScenarioDiagnostics: layer 31, no raycast, never seen by sensors.
 */
export class AutonomyOverlay {
    constructor({ visualizationManager = null } = {}) {
        this.group = new THREE.Group();
        this.group.name = "autonomy-overlay";
        this.group.layers.set(AUTONOMY_OVERLAY_LAYER);
        this.group.visible = true;
        this.group.userData.nonColliding = true;
        this.layers = {
            oracle: true,
            candidate: true,
            ekf: true,
            estimateClone: true,
            lanes: true,
            controls: true,
        };
        this._estimateVehicle = null;
        this._boxes = new THREE.Group();
        this._lanes = new THREE.Group();
        this._ownsVisualizationManager = !visualizationManager;
        this.visualizationManager = visualizationManager ?? new VisualizationManager({
            tools: { ackermann: new AckermannVisualizer(), plannedTrajectory: new PlannedTrajectoryVisualizer(), trajectoryPast: new TrajectoryPastVisualizer(), localization: new LocalizationVisualizer({ createAppearanceClone: () => this._estimateVehicle?.cloneVisualBody?.() ?? null }), occupancy: new OccupancyVisualizer() },
            sceneContext: { scene: this.group },
        });
        this._controls = this.visualizationManager.tools.ackermann?.group ?? new THREE.Group();
        this._path = this.visualizationManager.tools.plannedTrajectory?.group ?? new THREE.Group();
        this._past = this.visualizationManager.tools.trajectoryPast?.group ?? new THREE.Group();
        this._localization = this.visualizationManager.tools.localization;
        this._ekf = this._localization?.markers ?? new THREE.Group();
        this.group.add(this._boxes, this._lanes, this._controls, this._path, this._past);
        if (this._localization) this.group.add(this._localization.group);
        this._contentKey = null;
        if (this._ownsVisualizationManager) {
            this.visualizationManager.configure({ ackermann: {
                data: [{ id: "snapshot-controls" }],
                pose: [{ id: "snapshot-pose" }],
                predictedPath: true,
            }, plannedTrajectory: {
                data: [{ id: "snapshot-path" }], pose: [{ id: "snapshot-pose" }],
            }, trajectoryPast: { pose: [{ id: "snapshot-history-pose" }] },
            localization: { data: [{ id: "snapshot-localization" }] },
            occupancy: { data: [{ id: "snapshot-occupancy" }], pose: [{ id: "snapshot-pose" }] } });
            this.visualizationManager.setSource({
                subscribe: (_bindings, emit) => { this._emitControls = emit; return () => { this._emitControls = null; }; },
                dispose() {},
            });
        }
    }

    attach(scene, operatorCamera = null) {
        if (!scene) return;
        operatorCamera?.layers?.enable?.(AUTONOMY_OVERLAY_LAYER);
        if (this.group.parent === scene) return;
        this.group.removeFromParent();
        scene.add(this.group);
    }

    setLayers(layers = {}) {
        const controlsChanged = layers.controls !== undefined && layers.controls !== this.layers.controls;
        const candidateChanged = layers.candidate !== undefined && layers.candidate !== this.layers.candidate;
        const localizationChanged = ["ekf", "estimateClone"].filter((layer) => layers[layer] !== undefined && layers[layer] !== this.layers[layer]);
        this.layers = { ...this.layers, ...layers };
        this._boxes.visible = this.layers.oracle || this.layers.candidate;
        this._lanes.visible = this.layers.lanes;
        if (this.visualizationManager.entries.has("localization")) {
            for (const layer of localizationChanged) this.visualizationManager.setLayerVisible("localization", layer, "scene", this.layers[layer] !== false);
        }
        if (controlsChanged && this.visualizationManager.entries.has("ackermann")) {
            this.visualizationManager.setVisible("ackermann", "scene", this.layers.controls !== false);
        }
        if (candidateChanged && this.visualizationManager.entries.has("plannedTrajectory")) {
            this.visualizationManager.setVisible("plannedTrajectory", "scene", this.layers.candidate !== false);
        }
    }

    /** Hide the steering prediction ribbons while a vehicle camera fills the view. */
    setPredictedPathHidden(hidden) {
        this._predictedPathHidden = Boolean(hidden);
        this.visualizationManager.setPredictedPathHidden(this._predictedPathHidden);
    }

    clear() {
        this.disposeEstimateClone();
        for (const group of [this._boxes, this._lanes]) {
            for (const child of [...group.children]) {
                child.traverse(disposeObject);
                child.removeFromParent();
            }
        }
        if (this._ownsVisualizationManager) this.visualizationManager.reset();
        this._contentKey = null;
    }

    updateFromRuntime(runtime, layers = null, { controlRuntime = null, vehiclePose = null, estimateVehicle = null } = {}) {
        if (layers) this.setLayers(layers);
        if (!runtime && !controlRuntime) {
            if (this._ownsVisualizationManager) this.clear();
            else this._syncSnapshotContent({});
            return;
        }
        const perception = runtime?.lastPerception || {};
        const localization = runtime?.lastLocalization || {};
        this._contentKey = null;
        if (this._ownsVisualizationManager) {
            this._syncControls(controlRuntime?.getSnapshot?.() ?? {}, vehiclePose);
            this._syncPlannedPath(runtime?.lastPath);
            this._syncLocalization(localization, estimateVehicle);
            this._syncOccupancy(runtime?.lastOccupancy);
            this.visualizationManager.flush();
        }
        this._syncSnapshotContent({ perception });
    }

    updateFromSnapshot({ perception, localization, controls, path, occupancy, vehiclePose, estimateVehicle } = {}, layers = null) {
        if (layers) this.setLayers(layers);
        this._syncControls(controls ?? {}, vehiclePose);
        this._syncPlannedPath(path, vehiclePose);
        this._syncLocalization(localization, estimateVehicle);
        if (occupancy !== undefined) this._syncOccupancy(occupancy, vehiclePose);
        if (this._ownsVisualizationManager) this.visualizationManager.flush();
        const nextKey = snapshotContentKey({ perception });
        if (nextKey === this._contentKey) return;
        this._contentKey = nextKey;
        this._syncSnapshotContent({ perception });
    }

    _syncSnapshotContent({ perception }) {
        this._clearGroup(this._boxes);
        this._clearGroup(this._lanes);

        if (this.layers.oracle) {
            this._syncBoxes(perception?.oracle?.detections3d || [], "oracle");
            if (this.layers.lanes) this._syncLanes(perception?.oracle?.lanes || [], "oracle");
        }
        if (this.layers.candidate) {
            this._syncBoxes(perception?.detections3d || [], "candidate");
            if (this.layers.lanes) this._syncLanes(perception?.lanes || [], "candidate");
        }
    }

    _clearGroup(group) {
        for (const child of group.children) {
            child.visible = false;
        }
    }

    _syncControls(snapshot, vehiclePose = null) {
        if (!snapshot) return;
        const pose = vehiclePose || { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
        const dataMetadata = { ...snapshot.metadata };
        const poseMetadata = { ...pose.metadata };
        for (const [sample, metadata] of [[snapshot, dataMetadata], [pose, poseMetadata]]) {
            for (const key of ["runId", "captureTimeNs", "sequenceId", "frameId"]) {
                if (metadata[key] == null && sample[key] != null) metadata[key] = sample[key];
            }
            if (metadata.sequenceId == null && sample.sequence != null) metadata.sequenceId = sample.sequence;
        }
        if (this._ownsVisualizationManager) {
            this._emitControls?.({ type: "data", bindingId: "snapshot-controls", inputs: controlsSnapshotInputs(snapshot), metadata: dataMetadata });
            this._emitControls?.({ type: "pose", bindingId: "snapshot-pose", pose, metadata: poseMetadata });
            if (vehiclePose) this._emitControls?.({ type: "pose", bindingId: "snapshot-history-pose", pose, metadata: poseMetadata });
            const timeNs = snapshot.applyTimeNs ?? poseMetadata.captureTimeNs ?? dataMetadata.captureTimeNs;
            if (timeNs != null) {
                try { this._emitControls?.({ type: "clock", timeNs: trajectoryTimeNs(timeNs) }); }
                catch { /* Invalid replay timestamps do not interrupt rendering. */ }
            }
        } else {
            const tool = this.visualizationManager.tools.ackermann;
            if (!tool || !this.visualizationManager.entries.has("ackermann")) return;
            try {
                tool.acceptDataUpdate(controlsSnapshotInputs(snapshot), [], dataMetadata);
                tool.acceptVehicleMove(pose, poseMetadata);
            } catch (error) { tool.setStatus("error", error.message); }
            this.visualizationManager._schedule();
        }
    }

    _syncPlannedPath(path, vehiclePose = null) {
        const metadata = { ...path?.metadata };
        for (const key of ["runId", "captureTimeNs", "sequenceId", "frameId"]) {
            if (metadata[key] == null && path?.[key] != null) metadata[key] = path[key];
        }
        if (this._ownsVisualizationManager) {
            this._emitControls?.({ type: "data", bindingId: "snapshot-path", inputs: plannedPathSnapshotInputs(path), metadata });
        } else {
            const tool = this.visualizationManager.tools.plannedTrajectory;
            if (!tool || !this.visualizationManager.entries.has("plannedTrajectory")) return;
            try {
                tool.acceptDataUpdate(plannedPathSnapshotInputs(path), [], metadata);
                if (vehiclePose) tool.acceptVehicleMove(vehiclePose, vehiclePose.metadata);
            }
            catch (error) { tool.setStatus("error", error.message); }
            this.visualizationManager._schedule();
        }
    }

    _syncBoxes(detections, source) {
        let index = 0;
        for (const det of detections) {
            const color = statusColor(det.status, source);
            const dashed = det.status === "stale" || det.status === "invalid" || det.status === "rejected";
            const center = det.box3d?.threeCenter || {
                x: det.box3d?.center?.x || 0,
                y: det.box3d?.center?.z || 0,
                z: det.box3d?.center?.y || 0,
            };
            const rotation = det.box3d?.threeRotation;
            const lines = this._ensureBoxLine(index, det.box3d?.threeSize || det.box3d?.size, color, dashed);
            lines.position.set(center.x, center.y, center.z);
            if (rotation) {
                lines.rotation.set(
                    Number(rotation.x || 0),
                    Number(rotation.y || 0),
                    Number(rotation.z || 0),
                    rotation.order || "XYZ",
                );
            } else {
                lines.rotation.set(0, 0, 0);
            }
            index += 1;
            if (det.status && det.status !== "ok") {
                const badge = this._ensureBoxBadge(index, `${det.status}${det.statusCode ? `:${det.statusCode}` : ""}`, color);
                badge.position.copy(lines.position);
                index += 1;
            }
        }
        hideExtra(this._boxes, index);
    }

    _ensureBoxLine(index, size, color, dashed) {
        let lines = this._boxes.children[index];
        if (!lines || !lines.isLineSegments) {
            lines = disableRaycast(new THREE.LineSegments(
                boxEdgesGeometry(size),
                new THREE.LineBasicMaterial({
                    color,
                    transparent: true,
                    opacity: dashed ? 0.55 : 0.95,
                    depthTest: false,
                }),
            ));
            lines.renderOrder = 1100;
            this._boxes.add(lines);
        } else {
            lines.visible = true;
            lines.geometry.dispose();
            lines.geometry = boxEdgesGeometry(size);
            lines.material.color.setHex(color);
            lines.material.opacity = dashed ? 0.55 : 0.95;
        }
        return lines;
    }

    _ensureBoxBadge(index, text, color) {
        let badge = this._boxes.children[index];
        if (!badge || badge.userData.badgeLabel !== text || badge.userData.badgeColor !== color) {
            if (badge) {
                badge.traverse(disposeObject);
                badge.removeFromParent();
            }
            badge = cachedStatusBadge(text, color);
            badge.userData.badgeLabel = text;
            badge.userData.badgeColor = color;
            this._boxes.add(badge);
        }
        badge.visible = true;
        return badge;
    }

    _syncLanes(lanes, source) {
        let index = 0;
        for (const lane of lanes) {
            const points = (lane.points || []).map((point) => new THREE.Vector3(
                Number(point.three?.x ?? point.x ?? 0),
                Number(point.three?.y ?? point.z ?? 0) + 0.05,
                Number(point.three?.z ?? point.y ?? 0),
            ));
            if (points.length < 2) continue;
            const line = this._ensureLaneLine(index, points, statusColor(lane.status, source));
            line.renderOrder = 1100;
            index += 1;
        }
        hideExtra(this._lanes, index);
    }

    _ensureLaneLine(index, points, color, group = this._lanes) {
        let line = group.children[index];
        if (!line || !line.isLine) {
            line = disableRaycast(new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(points),
                new THREE.LineBasicMaterial({
                    color,
                    transparent: true,
                    opacity: 0.9,
                    depthTest: false,
                }),
            ));
            group.add(line);
        } else {
            line.visible = true;
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry().setFromPoints(points);
            line.material.color.setHex(color);
        }
        return line;
    }

    _syncLocalization(localization, estimateVehicle) {
        this._estimateVehicle = estimateVehicle ?? null;
        const metadata = {};
        const inputs = localizationSnapshotInputs(localization, metadata);
        if (this._ownsVisualizationManager) {
            this._emitControls?.({ type: "data", bindingId: "snapshot-localization", inputs, metadata });
        } else if (this._localization && this.visualizationManager.entries.has("localization")) {
            try { this._localization.acceptDataUpdate(inputs, [], metadata); }
            catch (error) { this._localization.setStatus("error", error.message); }
            this.visualizationManager._schedule();
        }
    }

    _syncOccupancy(occupancy, vehiclePose = null) {
        const inputs = { stack: occupancy?.status === "ok" || (occupancy && !occupancy.status) ? occupancy : null,
            stackMessage: occupancy?.status && occupancy.status !== "ok" ? occupancy.message ?? occupancy.status : "" };
        const metadata = { ...occupancy?.metadata };
        for (const key of ["runId", "captureTimeNs", "sequenceId", "frameId"]) {
            if (metadata[key] == null && occupancy?.[key] != null) metadata[key] = occupancy[key];
        }
        if (this._ownsVisualizationManager) this._emitControls?.({ type: "data", bindingId: "snapshot-occupancy", inputs, metadata });
        else {
            const tool = this.visualizationManager.tools.occupancy;
            if (!tool || !this.visualizationManager.entries.has("occupancy")) return;
            try { tool.acceptDataUpdate(inputs, [], metadata); if (vehiclePose) tool.acceptVehicleMove(vehiclePose, vehiclePose.metadata); }
            catch (error) { tool.setStatus("error", error.message); }
            this.visualizationManager._schedule();
        }
    }

    disposeEstimateClone() {
        this._localization?.disposeEstimateClone();
    }

    dispose() {
        this.clear();
        if (this._ownsVisualizationManager) this.visualizationManager.dispose();
        this.group.removeFromParent();
    }
}
