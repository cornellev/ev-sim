import * as THREE from "three";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";

export const AUTONOMY_OVERLAY_LAYER = SCENARIO_DIAGNOSTIC_LAYER;

const COLORS = Object.freeze({
    oracle: 0x34d399,
    candidate: 0x38bdf8,
    stale: 0xf59e0b,
    invalid: 0xfb7185,
    truth: 0xffffff,
    error: 0xfbbf24,
});

function disableRaycast(object) {
    object.raycast = () => {};
    object.userData.autonomyOverlay = true;
    object.layers.set(AUTONOMY_OVERLAY_LAYER);
    return object;
}

function disposeObject(object) {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
        material?.map?.dispose?.();
        material?.dispose?.();
    }
}

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

function ellipseLine(sigmaX, sigmaY, segments = 48) {
    const points = [];
    for (let i = 0; i <= segments; i += 1) {
        const t = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(t) * sigmaX, 0.05, Math.sin(t) * sigmaY));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
}

function statusBadge(text, color) {
    const anchor = disableRaycast(new THREE.Object3D());
    if (typeof document === "undefined") return anchor;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return anchor;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(8,12,18,.85)";
    context.fillRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 3;
    context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    context.fillStyle = "#f5f7fa";
    context.font = "600 22px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const material = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = disableRaycast(new THREE.Sprite(material));
    sprite.scale.set(3.4, 0.85, 1);
    sprite.position.y = 2.2;
    anchor.add(sprite);
    return anchor;
}

/**
 * Operator-only 3D overlays for candidate/oracle perception and EKF estimate.
 * Mirrors ScenarioDiagnostics: layer 31, no raycast, never seen by sensors.
 */
export class AutonomyOverlay {
    constructor() {
        this.group = new THREE.Group();
        this.group.name = "autonomy-overlay";
        this.group.layers.set(AUTONOMY_OVERLAY_LAYER);
        this.group.visible = true;
        this.group.userData.nonColliding = true;
        this.layers = {
            oracle: true,
            candidate: true,
            ekf: true,
            lanes: true,
        };
        this._boxes = new THREE.Group();
        this._lanes = new THREE.Group();
        this._ekf = new THREE.Group();
        this.group.add(this._boxes, this._lanes, this._ekf);
    }

    attach(scene, operatorCamera = null) {
        if (!scene) return;
        operatorCamera?.layers?.enable?.(AUTONOMY_OVERLAY_LAYER);
        if (this.group.parent === scene) return;
        this.group.removeFromParent();
        scene.add(this.group);
    }

    setLayers(layers = {}) {
        this.layers = { ...this.layers, ...layers };
        this._boxes.visible = this.layers.oracle || this.layers.candidate;
        this._lanes.visible = this.layers.lanes;
        this._ekf.visible = this.layers.ekf;
    }

    clear() {
        for (const group of [this._boxes, this._lanes, this._ekf]) {
            for (const child of [...group.children]) {
                child.traverse(disposeObject);
                child.removeFromParent();
            }
        }
    }

    updateFromRuntime(runtime, layers = null) {
        if (layers) this.setLayers(layers);
        this.clear();
        if (!runtime) return;
        const perception = runtime.lastPerception || {};
        const localization = runtime.lastLocalization || {};

        if (this.layers.oracle) {
            this._drawBoxes(perception.oracle?.detections3d || [], "oracle");
            if (this.layers.lanes) this._drawLanes(perception.oracle?.lanes || [], "oracle");
        }
        if (this.layers.candidate) {
            this._drawBoxes(perception.detections3d || [], "candidate");
            if (this.layers.lanes) this._drawLanes(perception.lanes || [], "candidate");
        }
        if (this.layers.ekf) {
            this._drawEstimate(localization);
        }
    }

    updateFromSnapshot({ perception, localization } = {}, layers = null) {
        if (layers) this.setLayers(layers);
        this.clear();
        if (this.layers.oracle) {
            this._drawBoxes(perception?.oracle?.detections3d || [], "oracle");
            if (this.layers.lanes) this._drawLanes(perception?.oracle?.lanes || [], "oracle");
        }
        if (this.layers.candidate) {
            this._drawBoxes(perception?.detections3d || [], "candidate");
            if (this.layers.lanes) this._drawLanes(perception?.lanes || [], "candidate");
        }
        if (this.layers.ekf) {
            this._drawEstimate(localization || {});
        }
    }

    _drawBoxes(detections, source) {
        for (const det of detections) {
            const color = statusColor(det.status, source);
            const dashed = det.status === "stale" || det.status === "invalid" || det.status === "rejected";
            const geometry = boxEdgesGeometry(det.box3d?.threeSize || det.box3d?.size);
            const material = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: dashed ? 0.55 : 0.95,
                depthTest: false,
            });
            const lines = disableRaycast(new THREE.LineSegments(geometry, material));
            const center = det.box3d?.threeCenter || {
                x: det.box3d?.center?.x || 0,
                y: det.box3d?.center?.z || 0,
                z: det.box3d?.center?.y || 0,
            };
            lines.position.set(center.x, center.y, center.z);
            lines.renderOrder = 1100;
            this._boxes.add(lines);
            if (det.status && det.status !== "ok") {
                const badge = statusBadge(`${det.status}${det.statusCode ? `:${det.statusCode}` : ""}`, color);
                badge.position.copy(lines.position);
                this._boxes.add(badge);
            }
        }
    }

    _drawLanes(lanes, source) {
        for (const lane of lanes) {
            const points = (lane.points || []).map((point) => new THREE.Vector3(
                Number(point.three?.x ?? point.x ?? 0),
                Number(point.three?.y ?? point.z ?? 0) + 0.05,
                Number(point.three?.z ?? point.y ?? 0),
            ));
            if (points.length < 2) continue;
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({
                color: statusColor(lane.status, source),
                transparent: true,
                opacity: 0.9,
                depthTest: false,
            });
            const line = disableRaycast(new THREE.Line(geometry, material));
            line.renderOrder = 1100;
            this._lanes.add(line);
        }
    }

    _drawEstimate(localization) {
        const estimate = localization.estimate;
        if (!estimate) return;
        const color = statusColor(estimate.status || localization.status, "candidate");
        const pos = estimate.threePosition || {
            x: estimate.position?.x || 0,
            y: estimate.position?.z || 0,
            z: estimate.position?.y || 0,
        };

        const ghost = disableRaycast(new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 0.7, 0.9),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.28,
                depthTest: false,
            }),
        ));
        ghost.position.set(pos.x, pos.y + 0.35, pos.z);
        ghost.renderOrder = 1100;
        this._ekf.add(ghost);

        const sigmaX = Math.max(0.05, Number(estimate.covarianceEllipse?.sigmaX || 0.05));
        const sigmaY = Math.max(0.05, Number(estimate.covarianceEllipse?.sigmaY || 0.05));
        const ellipse = disableRaycast(new THREE.Line(
            ellipseLine(sigmaX, sigmaY),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
        ));
        ellipse.position.set(pos.x, pos.y, pos.z);
        ellipse.renderOrder = 1100;
        this._ekf.add(ellipse);

        if (localization.error && localization.truth) {
            const truthPos = localization.truth.threePosition || {
                x: localization.truth.position?.x || 0,
                y: localization.truth.position?.z || 0,
                z: localization.truth.position?.y || 0,
            };
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(pos.x, pos.y + 0.2, pos.z),
                new THREE.Vector3(truthPos.x, truthPos.y + 0.2, truthPos.z),
            ]);
            const errorLine = disableRaycast(new THREE.Line(
                geometry,
                new THREE.LineBasicMaterial({ color: COLORS.error, transparent: true, opacity: 0.9, depthTest: false }),
            ));
            errorLine.renderOrder = 1100;
            this._ekf.add(errorLine);
        }

        if (localization.status && localization.status !== "ok") {
            const ageMs = Number.isFinite(localization.ageNs) ? (localization.ageNs / 1e6).toFixed(0) : "?";
            const badge = statusBadge(`${localization.status} ${ageMs}ms`, color);
            badge.position.set(pos.x, pos.y, pos.z);
            this._ekf.add(badge);
        }
    }

    dispose() {
        this.clear();
        this.group.removeFromParent();
    }
}
