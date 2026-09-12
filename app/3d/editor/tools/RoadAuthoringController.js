import { createRoad } from "../commands/roadCommands.js";
import { deltaFromTranslation } from "../objects/transformDelta.js";

function point3(value) {
    return { x: Number(value?.x) || 0, y: Number(value?.y) || 0, z: Number(value?.z) || 0 };
}

function samePoint(left, right) {
    return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= 1e-9;
}

/** One authoring model shared by the Scene and Map pointer adapters. */
export class RoadAuthoringController {
    constructor({ data }) {
        this.data = data;
        this.editor = data.editor();
        this.bus = data.commands?.() ?? data.environment?.()?.commands?.();
        this.selection = data.selection?.() ?? data.environment?.()?.selection?.();
        this.subDrag = null;
    }

    beginStroke(point, snapTarget = null) {
        const value = point3(snapTarget?.position ?? point);
        this.editor.setRoadDraft({ type: "road-stroke", kind: "cubic-bezier", points: [value], cursor: value, startNodeId: snapTarget?.nodeId ?? null, endNodeId: null });
        return this.editor.snapshot().roadDraft;
    }

    appendStrokePoint(point, snapTarget = null) {
        const draft = this.editor.snapshot().roadDraft;
        if (draft?.type !== "road-stroke") return this.beginStroke(point, snapTarget);
        const value = point3(snapTarget?.position ?? point);
        const points = [...draft.points];
        if (!samePoint(points.at(-1), value)) points.push(value);
        this.editor.setRoadDraft({ ...draft, points, cursor: value, endNodeId: snapTarget?.nodeId ?? null });
        if (snapTarget?.nodeId && points.length > 1 && snapTarget.nodeId !== draft.startNodeId) return this.finishStroke();
        return this.editor.snapshot().roadDraft;
    }

    updateStrokeCursor(point) {
        const draft = this.editor.snapshot().roadDraft;
        if (draft?.type !== "road-stroke") return false;
        this.editor.setRoadDraft({ ...draft, cursor: point3(point) });
        return true;
    }

    finishStroke() {
        const draft = this.editor.snapshot().roadDraft;
        if (draft?.type !== "road-stroke") return { ok: false };
        if ((draft.points?.length ?? 0) < 2) {
            this.cancelStroke();
            return { ok: false };
        }
        const result = this.bus.execute(createRoad({ points: draft.points, kind: draft.kind ?? "cubic-bezier", startNodeId: draft.startNodeId, endNodeId: draft.endNodeId }));
        if (result.ok) {
            this.editor.clearRoadDraft();
            this.selection?.select?.(result.result.edge.id);
            this.data.simulation?.()?.render?.();
        }
        return result;
    }

    cancelStroke() {
        this.editor.clearRoadDraft();
        this.data.simulation?.()?.render?.();
        return true;
    }

    beginSubDrag(sub) {
        const begun = this.bus.beginGesture({ objectIds: [], sub, label: sub?.kind === "road-handle" ? "Move road handle" : "Move road knot" });
        if (begun.ok) this.subDrag = { gestureId: begun.gestureId, sub };
        return begun;
    }

    updateSubDrag(delta) {
        if (!this.subDrag) return { ok: false };
        const value = delta?.translation ? delta : deltaFromTranslation(delta);
        return this.bus.updateGesture(this.subDrag.gestureId, value);
    }

    finishSubDrag() {
        if (!this.subDrag) return { ok: false };
        const result = this.bus.commitGesture(this.subDrag.gestureId);
        this.subDrag = null;
        return result;
    }

    cancelSubDrag() {
        if (!this.subDrag) return false;
        this.bus.cancelGesture(this.subDrag.gestureId);
        this.subDrag = null;
        return true;
    }
}
