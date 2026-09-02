import * as THREE from "three";
import { SCENARIO_DIAGNOSTIC_LAYER } from "../../scenarios/ScenarioDiagnostics.js";
import {
    createControlsPathRibbonGeometry,
    updateControlsPathRibbon,
} from "../../autonomy/ControlsPathArc.js";
import { rep103SteeringToThree } from "../../autonomy/ControlCommandAdapter.js";

export const AUTONOMY_OVERLAY_LAYER = SCENARIO_DIAGNOSTIC_LAYER;

const COLORS = Object.freeze({
    oracle: 0x34d399,
    candidate: 0x38bdf8,
    stale: 0xf59e0b,
    invalid: 0xfb7185,
    truth: 0xffffff,
    error: 0xfbbf24,
    commanded: 0xa78bfa,
    achieved: 0x22d3ee,
});

const BADGE_TEXTURE_CACHE = new Map();
const CONTROL_RIBBON_SEGMENTS = 20;

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

function cachedStatusBadge(text, color) {
    const cacheKey = `${text}:${color}`;
    if (BADGE_TEXTURE_CACHE.has(cacheKey)) {
        const sprite = disableRaycast(new THREE.Sprite(BADGE_TEXTURE_CACHE.get(cacheKey).clone()));
        sprite.scale.set(3.4, 0.85, 1);
        sprite.position.y = 2.2;
        const anchor = disableRaycast(new THREE.Object3D());
        anchor.add(sprite);
        return anchor;
    }
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
    BADGE_TEXTURE_CACHE.set(cacheKey, material);
    const sprite = disableRaycast(new THREE.Sprite(material.clone()));
    sprite.scale.set(3.4, 0.85, 1);
    sprite.position.y = 2.2;
    anchor.add(sprite);
    return anchor;
}

function hideExtra(group, count) {
    for (let index = count; index < group.children.length; index += 1) {
        group.children[index].visible = false;
    }
}

function snapshotContentKey({ perception, localization, controls } = {}) {
    return [
        perception?.captureTimeNs ?? perception?.ageNs ?? "",
        perception?.oracle?.captureTimeNs ?? "",
        localization?.captureTimeNs ?? localization?.ageNs ?? "",
        localization?.estimate?.captureTimeNs ?? "",
        controls?.applyTimeNs ?? controls?.captureTimeNs ?? "",
        perception?.status ?? "",
        localization?.status ?? "",
    ].join("|");
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
            controls: true,
        };
        this._boxes = new THREE.Group();
        this._lanes = new THREE.Group();
        this._ekf = new THREE.Group();
        this._controls = new THREE.Group();
        this.group.add(this._boxes, this._lanes, this._ekf, this._controls);
        this._contentKey = null;
        this._controlArcGeometries = [
            createControlsPathRibbonGeometry(CONTROL_RIBBON_SEGMENTS),
            createControlsPathRibbonGeometry(CONTROL_RIBBON_SEGMENTS),
        ];
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
        this._controls.visible = this.layers.controls !== false;
    }

    clear() {
        for (const group of [this._boxes, this._lanes, this._ekf, this._controls]) {
            for (const child of [...group.children]) {
                child.traverse(disposeObject);
                child.removeFromParent();
            }
        }
        this._contentKey = null;
    }

    updateFromRuntime(runtime, layers = null, { controlRuntime = null, vehiclePose = null } = {}) {
        if (layers) this.setLayers(layers);
        if (!runtime && !controlRuntime) {
            this.clear();
            return;
        }
        const perception = runtime?.lastPerception || {};
        const localization = runtime?.lastLocalization || {};
        this._contentKey = null;
        this._syncSnapshotContent({
            perception,
            localization,
            controls: controlRuntime?.getSnapshot?.() || null,
        }, vehiclePose);
    }

    updateFromSnapshot({ perception, localization, controls, vehiclePose } = {}, layers = null) {
        if (layers) this.setLayers(layers);
        const nextKey = snapshotContentKey({ perception, localization, controls });
        if (nextKey === this._contentKey) {
            if (this.layers.controls !== false && controls) {
                this._syncControls(controls, vehiclePose);
            }
            return;
        }
        this._contentKey = nextKey;
        this._syncSnapshotContent({ perception, localization, controls }, vehiclePose);
    }

    _syncSnapshotContent({ perception, localization, controls }, vehiclePose = null) {
        this._clearGroup(this._boxes);
        this._clearGroup(this._lanes);
        this._clearGroup(this._ekf);
        this._clearGroup(this._controls);

        if (this.layers.oracle) {
            this._syncBoxes(perception?.oracle?.detections3d || [], "oracle");
            if (this.layers.lanes) this._syncLanes(perception?.oracle?.lanes || [], "oracle");
        }
        if (this.layers.candidate) {
            this._syncBoxes(perception?.detections3d || [], "candidate");
            if (this.layers.lanes) this._syncLanes(perception?.lanes || [], "candidate");
        }
        if (this.layers.ekf) {
            this._syncEstimate(localization || {});
        }
        if (this.layers.controls !== false && controls) {
            this._syncControls(controls, vehiclePose);
        }
    }

    _clearGroup(group) {
        for (const child of group.children) {
            child.visible = false;
        }
    }

    _syncControls(snapshot, vehiclePose = null) {
        if (!snapshot) return;
        const pose = vehiclePose || {
            position: { x: 0, y: 0, z: 0 },
            yaw: 0,
        };
        const wheelbase = Number(snapshot.wheelbase) || 1.5;
        let meshIndex = 0;
        if (snapshot.applied) {
            this._ensureControlArc(meshIndex, pose, rep103SteeringToThree(snapshot.applied.steeringRad), COLORS.commanded, wheelbase, 0.45);
            meshIndex += 1;
        }
        if (snapshot.achieved) {
            this._ensureControlArc(meshIndex, pose, rep103SteeringToThree(snapshot.achieved.steeringRad), COLORS.achieved, wheelbase, 0.25);
            meshIndex += 1;
        }
        hideExtra(this._controls, meshIndex);

        const badges = [];
        if (snapshot.flags?.timedOut) badges.push("TIMEOUT");
        if (snapshot.flags?.saturated) badges.push("SAT");
        if (snapshot.flags?.fallbackActive) badges.push("FALLBACK");
        if (snapshot.flags?.rateLimited) badges.push("RATE");
        if (badges.length) {
            const color = snapshot.flags.timedOut ? COLORS.invalid : COLORS.stale;
            const badge = this._ensureBadge(meshIndex, badges.join(" · "), color);
            badge.position.set(pose.position?.x || 0, (pose.position?.y || 0) + 2.4, pose.position?.z || 0);
            meshIndex += 1;
        }
        hideExtra(this._controls, meshIndex);
    }

    _ensureControlArc(index, pose, steeringRadThree, color, wheelbase, opacity) {
        let mesh = this._controls.children[index];
        if (!mesh || !mesh.isMesh) {
            const geometry = this._controlArcGeometries[index] || createControlsPathRibbonGeometry(CONTROL_RIBBON_SEGMENTS);
            if (!this._controlArcGeometries[index]) this._controlArcGeometries[index] = geometry;
            mesh = disableRaycast(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                depthTest: false,
                side: THREE.DoubleSide,
            })));
            this._controls.add(mesh);
        }
        mesh.visible = true;
        mesh.material.color.setHex(color);
        mesh.material.opacity = opacity;
        updateControlsPathRibbon(mesh.geometry, pose, steeringRadThree, {
            wheelbase,
            lookahead: 7,
            segments: CONTROL_RIBBON_SEGMENTS,
            pathWidth: 0.28,
        });
    }

    _ensureBadge(index, text, color) {
        let badge = this._controls.children[index];
        if (!badge || badge.userData.badgeLabel !== text || badge.userData.badgeColor !== color) {
            if (badge) {
                badge.traverse(disposeObject);
                badge.removeFromParent();
            }
            badge = cachedStatusBadge(text, color);
            badge.userData.badgeLabel = text;
            badge.userData.badgeColor = color;
            this._controls.add(badge);
        }
        badge.visible = true;
        return badge;
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

    _ensureLaneLine(index, points, color) {
        let line = this._lanes.children[index];
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
            this._lanes.add(line);
        } else {
            line.visible = true;
            line.geometry.dispose();
            line.geometry = new THREE.BufferGeometry().setFromPoints(points);
            line.material.color.setHex(color);
        }
        return line;
    }

    _syncEstimate(localization) {
        const estimate = localization.estimate;
        if (!estimate) {
            hideExtra(this._ekf, 0);
            return;
        }
        const color = statusColor(estimate.status || localization.status, "candidate");
        const pos = estimate.threePosition || {
            x: estimate.position?.x || 0,
            y: estimate.position?.z || 0,
            z: estimate.position?.y || 0,
        };
        let index = 0;
        const ghost = this._ensureEkfGhost(index, color);
        ghost.position.set(pos.x, pos.y + 0.35, pos.z);
        index += 1;

        const sigmaX = Math.max(0.05, Number(estimate.covarianceEllipse?.sigmaX || 0.05));
        const sigmaY = Math.max(0.05, Number(estimate.covarianceEllipse?.sigmaY || 0.05));
        const ellipse = this._ensureEkfEllipse(index, sigmaX, sigmaY, color);
        ellipse.position.set(pos.x, pos.y, pos.z);
        index += 1;

        if (localization.error && localization.truth) {
            const truthPos = localization.truth.threePosition || {
                x: localization.truth.position?.x || 0,
                y: localization.truth.position?.z || 0,
                z: localization.truth.position?.y || 0,
            };
            const errorLine = this._ensureEkfErrorLine(index);
            errorLine.geometry.dispose();
            errorLine.geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(pos.x, pos.y + 0.2, pos.z),
                new THREE.Vector3(truthPos.x, truthPos.y + 0.2, truthPos.z),
            ]);
            index += 1;
        }

        if (localization.status && localization.status !== "ok") {
            const ageMs = Number.isFinite(localization.ageNs) ? (localization.ageNs / 1e6).toFixed(0) : "?";
            const badge = this._ensureEkfBadge(index, `${localization.status} ${ageMs}ms`, color);
            badge.position.set(pos.x, pos.y, pos.z);
            index += 1;
        }
        hideExtra(this._ekf, index);
    }

    _ensureEkfGhost(index, color) {
        let ghost = this._ekf.children[index];
        if (!ghost || !ghost.isMesh) {
            ghost = disableRaycast(new THREE.Mesh(
                new THREE.BoxGeometry(1.8, 0.7, 0.9),
                new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity: 0.28,
                    depthTest: false,
                }),
            ));
            ghost.renderOrder = 1100;
            this._ekf.add(ghost);
        } else {
            ghost.visible = true;
            ghost.material.color.setHex(color);
        }
        return ghost;
    }

    _ensureEkfEllipse(index, sigmaX, sigmaY, color) {
        let ellipse = this._ekf.children[index];
        if (!ellipse || !ellipse.isLine) {
            ellipse = disableRaycast(new THREE.Line(
                ellipseLine(sigmaX, sigmaY),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }),
            ));
            ellipse.renderOrder = 1100;
            this._ekf.add(ellipse);
        } else {
            ellipse.visible = true;
            ellipse.geometry.dispose();
            ellipse.geometry = ellipseLine(sigmaX, sigmaY);
            ellipse.material.color.setHex(color);
        }
        return ellipse;
    }

    _ensureEkfErrorLine(index) {
        let errorLine = this._ekf.children[index];
        if (!errorLine || !errorLine.isLine) {
            errorLine = disableRaycast(new THREE.Line(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color: COLORS.error, transparent: true, opacity: 0.9, depthTest: false }),
            ));
            errorLine.renderOrder = 1100;
            this._ekf.add(errorLine);
        } else {
            errorLine.visible = true;
        }
        return errorLine;
    }

    _ensureEkfBadge(index, text, color) {
        let badge = this._ekf.children[index];
        if (!badge || badge.userData.badgeLabel !== text || badge.userData.badgeColor !== color) {
            if (badge) {
                badge.traverse(disposeObject);
                badge.removeFromParent();
            }
            badge = cachedStatusBadge(text, color);
            badge.userData.badgeLabel = text;
            badge.userData.badgeColor = color;
            this._ekf.add(badge);
        }
        badge.visible = true;
        return badge;
    }

    dispose() {
        this.clear();
        for (const geometry of this._controlArcGeometries) geometry?.dispose?.();
        this._controlArcGeometries = [];
        this.group.removeFromParent();
    }
}
