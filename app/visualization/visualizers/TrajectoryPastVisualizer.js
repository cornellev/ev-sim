import * as THREE from "three";
import { Visualizer } from "../Visualizer.js";
import { appendPlanTrails, clipTrail, historyWindowNs, pruneTrajectoryHistory, trajectoryTimeNs, TRAJECTORY_RETENTION_NS } from "../trajectoryHistory.js";
import { disableRaycast, disposeObject } from "../../3d/overlay/overlayObjects.js";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { PLAN_COLORS } from "../../spatial/planview/primitives.js";
import { planActorId } from "../../spatial/planview/selection.js";

const TRAIL_COLORS = [PLAN_COLORS.trail, PLAN_COLORS.cyclist, PLAN_COLORS.goal, PLAN_COLORS.collision, PLAN_COLORS.commanded, PLAN_COLORS.achieved];

export class TrajectoryPastVisualizer extends Visualizer {
    constructor(options = {}) {
        super(options);
        this.group = disableRaycast(new THREE.Group());
        this.group.name = "trajectory-past-visualizer";
        this.group.userData.nonColliding = true;
        this.history = new Map();
        this.anchors = new Map();
        this.actors = new Map();
        this.lines = new Map();
        this.timeNs = 0;
        this.historyMode = "10s";
        this._revision = 0;
        this._preparedRevision = -1;
        this._nextExpiryNs = null;
        this.mapOutput = { primitives: [] };
    }

    validateInputs(inputs) {
        if (inputs.actors != null && !Array.isArray(inputs.actors)) return "Trajectory actors must be an array.";
        if ((inputs.actors ?? []).some((actor) => !actor?.position || ![actor.position.x, actor.position.y ?? 0, actor.position.z].every(Number.isFinite))) return "Trajectory positions must be finite scene coordinates.";
        if (inputs.timeNs != null) trajectoryTimeNs(inputs.timeNs);
        return true;
    }

    validatePose(pose) {
        return pose.position && [pose.position.x, pose.position.y ?? 0, pose.position.z].every(Number.isFinite) ? true : "Trajectory pose must have a finite position.";
    }

    acceptDataUpdate(inputs, changedKeys, metadata = {}) {
        const revision = this._revision;
        const dirty = Object.fromEntries(["scene", "map"].map((target) => [target, this.dirty[target].geometry]));
        const accepted = super.acceptDataUpdate(inputs, changedKeys, metadata);
        if (this._revision === revision) for (const target of ["scene", "map"]) this.dirty[target].geometry = dirty[target];
        return accepted;
    }

    onDataUpdate(inputs, _changedKeys, metadata) {
        const actors = inputs.actors ?? [];
        let changed = appendPlanTrails(this.history, actors, inputs.timeNs ?? metadata.captureTimeNs ?? this.timeNs, this.anchors);
        const next = new Map(actors.map((actor, index) => [planActorId(actor, index), { role: actor.role ?? (planActorId(actor, index) === "ego" ? "ego" : "actor"), index }]));
        for (const [id, actor] of next) if (actor.role !== this.actors.get(id)?.role || actor.index !== this.actors.get(id)?.index) changed = true;
        this.actors = next;
        if (changed) { this._revision += 1; this.invalidate("geometry"); }
    }

    acceptVehicleMove(pose, metadata = {}) {
        const revision = this._revision;
        const dirty = Object.fromEntries(["scene", "map"].map((target) => [target, this.dirty[target].placement]));
        const accepted = super.acceptVehicleMove(pose, metadata);
        // Past samples are world-fixed; placement invalidation is only needed for a new sample.
        if (revision === this._revision) for (const target of ["scene", "map"]) this.dirty[target].placement = dirty[target];
        return accepted;
    }

    onVehicleMove(pose, metadata) {
        const id = String(metadata.actorId ?? pose.actorId ?? "ego");
        const actors = [...this.anchors].map(([actorId, position]) => ({ id: actorId, position: actorId === id ? pose.position : position, role: this.actors.get(actorId)?.role }));
        if (!this.anchors.has(id)) actors.push({ id, position: pose.position });
        this.onDataUpdate({ actors, timeNs: metadata.captureTimeNs ?? this.timeNs }, [], metadata);
    }

    onTimeAdvance(timeNs) {
        timeNs = trajectoryTimeNs(timeNs);
        if (timeNs < this.timeNs) { this.reset(); }
        this.timeNs = timeNs;
        pruneTrajectoryHistory(this.history, timeNs);
        if (this._nextExpiryNs != null && timeNs > this._nextExpiryNs) {
            this._revision += 1;
            this.invalidate("geometry");
            this._nextExpiryNs = null;
        }
    }

    setHistoryMode(mode) {
        historyWindowNs(mode);
        if (mode === this.historyMode) return;
        this.historyMode = mode;
        this._revision += 1;
        this.invalidate("geometry");
    }

    _prepare() {
        if (this._preparedRevision === this._revision) return;
        const windowNs = historyWindowNs(this.historyMode) ?? TRAJECTORY_RETENTION_NS;
        this._nextExpiryNs = null;
        const primitives = [];
        for (const [id, samples] of this.history) {
            const points = clipTrail(samples, this.timeNs, this.historyMode);
            if (points.length) {
                const expires = BigInt(points[0].timeNs) + BigInt(windowNs);
                if (this._nextExpiryNs == null || expires < this._nextExpiryNs) this._nextExpiryNs = expires;
            }
            if (points.length < 2) continue;
            const actor = this.actors.get(id);
            primitives.push({ kind: "polyline", points, stroke: actor?.role === "ego" ? PLAN_COLORS.ego : TRAIL_COLORS[(actor?.index ?? 0) % TRAIL_COLORS.length], strokeWidth: actor?.role === "ego" ? 2.5 : 2, opacity: 0.9, historyActorId: id });
        }
        this.mapOutput = { primitives };
        this._preparedRevision = this._revision;
    }

    display({ scene, camera } = {}) {
        camera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (scene && !this.group.parent) scene.add(this.group);
        this._prepare();
        for (const [id, line] of this.lines) {
            if (this.history.has(id)) { line.visible = false; continue; }
            disposeObject(line);
            line.removeFromParent();
            this.lines.delete(id);
        }
        for (const primitive of this.mapOutput.primitives) {
            const id = primitive.historyActorId;
            let line = this.lines.get(id);
            if (!line) {
                line = disableRaycast(new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })));
                line.renderOrder = 1100;
                this.lines.set(id, line);
                this.group.add(line);
            }
            const positions = primitive.points.flatMap((point) => [point.x, point.y + 0.05, point.z]);
            let attribute = line.geometry.getAttribute("position");
            if (attribute?.array.length !== positions.length) line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
            else { attribute.array.set(positions); attribute.needsUpdate = true; }
            line.geometry.computeBoundingSphere();
            line.material.color.set(primitive.stroke);
            line.visible = true;
        }
        this.group.visible = this.visible.scene;
        return this.group;
    }

    displayMap() { this._prepare(); return this.mapOutput; }
    onVisibilityChange(target, visible) { if (target === "scene") this.group.visible = visible && this.ready; }

    reset() {
        super.reset();
        this.history.clear();
        this.anchors.clear();
        this.actors.clear();
        for (const line of this.lines.values()) { disposeObject(line); line.removeFromParent(); }
        this.lines.clear();
        this.timeNs = 0;
        this._revision += 1;
        this._nextExpiryNs = null;
        this.group.visible = false;
        this.mapOutput = { primitives: [] };
    }

    dispose() { this.reset(); this.group.removeFromParent(); super.dispose(); }
}
