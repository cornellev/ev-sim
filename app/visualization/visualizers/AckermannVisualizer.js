import * as THREE from "three";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import { Visualizer } from "../Visualizer.js";
import {
    applyControlsPathRibbonPose,
    createControlsPathRibbonGeometry,
    sampleAckermannCenterline,
    updateControlsPathRibbon,
} from "../../autonomy/ControlsPathArc.js";
import { cachedStatusBadge, disableRaycast, disposeObject } from "../../3d/overlay/overlayObjects.js";
import { PLAN_COLORS } from "../../spatial/planview/primitives.js";

const ARC_OPTIONS = Object.freeze({ lookahead: 7, segments: 20, pathWidth: 0.28 });
const CONTROL_FLAGS = { timedOut: "TIMEOUT", saturated: "SAT", fallbackActive: "FALLBACK", rateLimited: "RATE" };
const EMPTY_FLAGS = Object.freeze({});

/** The existing controls snapshot uses positive-left steering in both frames. */
export function controlsSnapshotInputs(snapshot = {}) {
    return {
        steeringRad: snapshot.applied?.steeringRad ?? snapshot.achieved?.steeringRad ?? 0,
        commanded: snapshot.applied != null,
        achievedSteeringRad: snapshot.achieved?.steeringRad ?? null,
        wheelbase: snapshot.wheelbase ?? 1.5,
        velocity: snapshot.achieved?.speedMps ?? snapshot.applied?.speedMps ?? null,
        flags: snapshot.flags ?? EMPTY_FLAGS,
    };
}

/** One owned set of local arcs; movement changes placement, never the arc buffers. */
export class AckermannVisualizer extends Visualizer {
    constructor(options = {}) {
        super({
            ...options,
            requiredInputs: ["steeringRad"],
            optionalInputs: { achievedSteeringRad: null, wheelbase: 1.5, velocity: null, flags: EMPTY_FLAGS, commanded: true },
        });
        this.group = disableRaycast(new THREE.Group());
        this.group.name = "ackermann-visualizer";
        this.group.userData.nonColliding = true;
        this.arcs = [null, null];
        this.meshes = [null, null];
        this.badge = null;
        this.mapOutput = { primitives: [] };
    }

    validateInputs(inputs) {
        if (!Number.isFinite(inputs.steeringRad)) return "Ackermann steeringRad must be finite.";
        if (inputs.achievedSteeringRad != null && !Number.isFinite(inputs.achievedSteeringRad)) return "Ackermann achieved steering must be finite.";
        if (!Number.isFinite(inputs.wheelbase) || inputs.wheelbase <= 0) return "Ackermann wheelbase must be positive.";
        if (inputs.velocity != null && !Number.isFinite(inputs.velocity)) return "Ackermann velocity must be finite.";
        if (typeof inputs.commanded !== "boolean") return "Ackermann commanded visibility must be boolean.";
        if (!inputs.flags || typeof inputs.flags !== "object" || Array.isArray(inputs.flags)) return "Ackermann flags must be an object.";
        if (Object.keys(CONTROL_FLAGS).some((key) => inputs.flags[key] != null && typeof inputs.flags[key] !== "boolean")) return "Ackermann control flags must be boolean.";
        return true;
    }

    _centerlines() {
        const steerings = [this.inputs.commanded ? this.inputs.steeringRad : null, this.inputs.achievedSteeringRad];
        for (let index = 0; index < steerings.length; index += 1) {
            const steeringRad = steerings[index];
            const previous = this.arcs[index];
            if (steeringRad == null) continue;
            if (previous?.steeringRad === steeringRad && previous.wheelbase === this.inputs.wheelbase) continue;
            this.arcs[index] = {
                steeringRad,
                wheelbase: this.inputs.wheelbase,
                points: sampleAckermannCenterline(steeringRad, { ...ARC_OPTIONS, wheelbase: this.inputs.wheelbase }),
            };
        }
    }

    _arcVisible(index) { return index === 0 ? this.inputs.commanded : this.inputs.achievedSteeringRad != null; }

    _badges() {
        return Object.entries(CONTROL_FLAGS).filter(([key]) => this.inputs.flags[key]).map(([, label]) => label).join(" · ");
    }

    _badgeColor() { return this.inputs.flags.timedOut ? 0xfb7185 : 0xf59e0b; }

    display({ scene, camera } = {}) {
        camera?.layers?.enable?.(SCENARIO_DIAGNOSTIC_LAYER);
        if (scene && !this.group.parent) scene.add(this.group);
        this._centerlines();
        for (let index = 0; index < this.arcs.length; index += 1) {
            const arc = this.arcs[index];
            let mesh = this.meshes[index];
            if (!arc || !this._arcVisible(index)) { if (mesh) mesh.visible = false; continue; }
            if (!mesh) {
                mesh = disableRaycast(new THREE.Mesh(createControlsPathRibbonGeometry(ARC_OPTIONS.segments), new THREE.MeshBasicMaterial({
                    color: index === 0 ? PLAN_COLORS.commanded : PLAN_COLORS.achieved,
                    transparent: true,
                    opacity: index === 0 ? 0.45 : 0.25,
                    depthTest: false,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                })));
                mesh.renderOrder = 1100;
                this.meshes[index] = mesh;
                this.group.add(mesh);
            }
            if (mesh.userData.arc !== arc) {
                updateControlsPathRibbon(mesh.geometry, null, arc.steeringRad, { ...ARC_OPTIONS, wheelbase: arc.wheelbase, centerline: arc.points });
                mesh.userData.arc = arc;
            }
            mesh.visible = this.visible.scene;
        }
        const label = this._badges();
        const color = this._badgeColor();
        if (label && (this.badge?.userData.badgeLabel !== label || this.badge?.userData.badgeColor !== color)) {
            this._disposeBadge();
            this.badge = cachedStatusBadge(label, color);
            Object.assign(this.badge.userData, { badgeLabel: label, badgeColor: color });
            this.group.add(this.badge);
        }
        applyControlsPathRibbonPose(this.group, this.pose);
        if (this.badge) { this.badge.position.y = 2.4; this.badge.visible = Boolean(label) && this.visible.scene; }
        this.group.visible = this.visible.scene;
        return this.group;
    }

    displayMap() {
        this._centerlines();
        const pose = this.pose ?? {};
        const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(pose.position?.x ?? 0, pose.position?.y ?? 0, pose.position?.z ?? 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.rotation?.x ?? 0, pose.rotation?.y ?? pose.yaw ?? 0, pose.rotation?.z ?? 0, pose.rotation?.order ?? "XYZ")),
            new THREE.Vector3(1, 1, 1),
        );
        const primitives = this.arcs.flatMap((arc, index) => arc && this._arcVisible(index) ? [{
            kind: "polyline",
            points: arc.points.map(({ x, z }) => {
                const world = new THREE.Vector3(x, 0.05, z).applyMatrix4(matrix);
                return { x: world.x, z: world.z };
            }),
            stroke: index === 0 ? PLAN_COLORS.commanded : PLAN_COLORS.achieved,
            strokeWidth: 2,
            dash: index === 0 ? "5 4" : null,
            opacity: 0.9,
        }] : []);
        const label = this._badges();
        if (label) primitives.push({ kind: "label", anchor: { x: pose.position?.x ?? 0, z: pose.position?.z ?? 0 }, text: label, fill: `#${this._badgeColor().toString(16)}` });
        this.mapOutput = { primitives };
        return this.mapOutput;
    }

    onVisibilityChange(target, visible) {
        if (target !== "scene") return;
        this.group.visible = visible && this.ready;
        this.meshes.forEach((mesh, index) => { if (mesh) mesh.visible = visible && Boolean(this.arcs[index]) && this._arcVisible(index); });
        if (this.badge) this.badge.visible = visible && Boolean(this._badges());
    }

    _disposeBadge() {
        this.badge?.traverse(disposeObject);
        this.badge?.removeFromParent();
        this.badge = null;
    }

    reset() {
        super.reset();
        this.arcs = [null, null];
        this.group.visible = false;
        for (const mesh of this.meshes) if (mesh) { mesh.visible = false; mesh.userData.arc = null; }
        this._disposeBadge();
        this.mapOutput = { primitives: [] };
    }

    dispose() {
        this.group.traverse(disposeObject);
        this.group.removeFromParent();
        this.group.clear();
        this.arcs = [null, null];
        this.meshes = [null, null];
        this.badge = null;
        this.mapOutput = { primitives: [] };
        super.dispose();
    }
}
