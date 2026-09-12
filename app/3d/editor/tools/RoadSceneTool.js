import * as THREE from "three";
import { EDITOR_MODES, EDITOR_TOOLS } from "../EditorState.js";
import { findNearestNode } from "../document/documentMutations.js";
import { getGroundPointFromEvent, isOverlayEvent } from "../editorPointerUtils.js";

export class RoadSceneTool {
    constructor({ data, scene, camera, renderer, controller }) {
        this.data = data;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controller = controller;
        this.editor = data.editor();
        this.line = null;
        this.disposeMove = data.mouse()?.registerMove?.((event) => this.handleMove(event));
        this.disposeClick = data.mouse()?.registerClick?.((event) => this.handleClick(event));
        this.disposeEditor = this.editor.subscribe((snapshot) => this.syncDraft(snapshot));
    }

    active(snapshot = this.editor.snapshot()) {
        return snapshot.editorMode === EDITOR_MODES.SCENE && snapshot.activeTool === EDITOR_TOOLS.ROAD_PEN;
    }

    point(event) {
        return getGroundPointFromEvent(event, this.camera, this.renderer);
    }

    snapTarget(point) {
        const node = findNearestNode(point, this.data.environment().getDocument().roads.nodes, 2);
        return node ? { nodeId: node.id, position: node } : null;
    }

    handleMove(event) {
        if (!this.active() || isOverlayEvent(event)) return;
        const point = this.point(event);
        if (point) this.controller.updateStrokeCursor(point);
    }

    handleClick(event) {
        if (!this.active() || isOverlayEvent(event)) return;
        const point = this.point(event);
        if (!point) return;
        const snapTarget = this.snapTarget(point);
        if (this.editor.snapshot().roadDraft) this.controller.appendStrokePoint(point, snapTarget);
        else this.controller.beginStroke(point, snapTarget);
        if (event.detail >= 2 && this.editor.snapshot().roadDraft) this.controller.finishStroke();
    }

    syncDraft(snapshot) {
        const draft = this.active(snapshot) ? snapshot.roadDraft : null;
        const points = draft?.type === "road-stroke" ? [...draft.points, draft.cursor].filter(Boolean) : [];
        if (points.length < 2) {
            if (this.line) this.line.visible = false;
            return;
        }
        if (!this.line) {
            this.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x38bdf8, depthTest: false }));
            this.line.renderOrder = 1000;
            this.line.userData.skipEnvironmentSelection = true;
            this.scene.add(this.line);
        }
        this.line.geometry.dispose();
        this.line.geometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(point.x, point.y + 0.05, point.z)));
        this.line.visible = true;
        this.data.simulation()?.render?.();
    }

    dispose() {
        this.disposeMove?.();
        this.disposeClick?.();
        this.disposeEditor?.();
        if (this.line) {
            this.scene.remove(this.line);
            this.line.geometry.dispose();
            this.line.material.dispose();
        }
    }
}
