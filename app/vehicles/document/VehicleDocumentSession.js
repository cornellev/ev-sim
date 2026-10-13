import { canonicalStringify } from "../../simulation/canonicalJson.js";
import { cloneJson } from "../../util/cloneJson.js";
import { normalizeVehicleManifest } from "../VehicleManifest.js";
import { VehicleDocument } from "./VehicleDocument.js";
import { VehicleSelection } from "./VehicleSelection.js";
import { applyAxlePatch, replaceManifest } from "./vehicleCommands.js";

const VOLATILE = new Set(["revision", "definitionHash", "createdAt", "updatedAt"]);

function stripVolatile(manifest) {
    const copy = cloneJson(manifest);
    for (const key of VOLATILE) delete copy[key];
    return copy;
}

function sameManifest(left, right) {
    return canonicalStringify(stripVolatile(left)) === canonicalStringify(stripVolatile(right));
}

/**
 * Draft session for one vehicle. History, gestures, and staged-resource
 * references stay here; they are not written into the manifest.
 */
export class VehicleDocumentSession {
    constructor({ manifest, revision = null, definitionHash = null, historyLimit = 100 } = {}) {
        const normalized = normalizeVehicleManifest(manifest);
        this.baseline = { manifest: cloneJson(normalized), revision, definitionHash };
        this.draft = new VehicleDocument(normalized);
        this.selection = new VehicleSelection();
        this.history = [];
        this.redoStack = [];
        this.gesture = null;
        this.stagedResources = null;
        this.saveCapture = null;
        this.historyLimit = Math.max(1, historyLimit);
    }

    get dirty() {
        return !sameManifest(this.draft.snapshot(), this.baseline.manifest);
    }

    execute(command) {
        if (this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Finish the active gesture before running another command." }] };
        }
        if (!command || typeof command.run !== "function") {
            return { ok: false, issues: [{ code: "vehicle.session.command", path: "", message: "Commands must provide run(context)." }] };
        }
        const before = this.draft.snapshot();
        const box = { manifest: cloneJson(before) };
        let staged = this.stagedResources;
        let stagedTouched = false;
        const issues = [];
        const context = {
            get manifest() { return box.manifest; },
            setManifest(next) { box.manifest = normalizeVehicleManifest(next); },
            issue(code, path, message) { issues.push({ code, path, message }); },
            selection: this.selection.snapshot(),
            get stagedResources() { return staged; },
            setStagedResources(ref) {
                staged = ref;
                stagedTouched = true;
            },
        };
        let result;
        try {
            result = command.run(context);
        } catch (error) {
            return { ok: false, issues: [{ code: error.code ?? "vehicle.session.command", path: "", message: error.message }], error };
        }
        if (issues.length > 0 || result?.ok === false) {
            return {
                ok: false,
                issues: issues.length > 0 ? issues : (result?.issues ?? []),
                review: result?.review,
            };
        }
        if (stagedTouched) this.stagedResources = staged == null ? null : cloneJson(staged);
        if (result?.history === false || sameManifest(before, box.manifest)) {
            return { ok: true, manifest: this.draft.snapshot(), issues: [], review: result?.review };
        }
        this.draft.commit(box.manifest);
        this.history.push({ label: command.label ?? "Edit", before, after: this.draft.snapshot() });
        this.redoStack = [];
        this.trimHistory();
        this.selection.prune(this.draft.snapshot());
        return { ok: true, manifest: this.draft.snapshot(), issues: [], review: result?.review };
    }

    undo() {
        if (this.gesture) return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Cancel the gesture before undoing." }] };
        const entry = this.history.pop();
        if (!entry) return { ok: false, issues: [{ code: "vehicle.session.history", path: "", message: "Nothing to undo." }] };
        this.redoStack.push(entry);
        this.draft.restore(entry.before);
        this.selection.prune(this.draft.snapshot());
        return { ok: true, manifest: this.draft.snapshot() };
    }

    redo() {
        if (this.gesture) return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Cancel the gesture before redoing." }] };
        const entry = this.redoStack.pop();
        if (!entry) return { ok: false, issues: [{ code: "vehicle.session.history", path: "", message: "Nothing to redo." }] };
        this.history.push(entry);
        this.trimHistory();
        this.draft.restore(entry.after);
        this.selection.prune(this.draft.snapshot());
        return { ok: true, manifest: this.draft.snapshot() };
    }

    beginGesture({ kind, label = "Gesture", axle = null } = {}) {
        if (this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "A gesture is already active." }] };
        }
        this.gesture = {
            id: `gesture-${this.history.length + 1}`,
            kind,
            label,
            axle,
            capture: this.draft.snapshot(),
            dirty: false,
        };
        return { ok: true, gesture: { ...this.gesture, capture: undefined } };
    }

    previewGesture(patch = {}) {
        if (!this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-inactive", path: "", message: "No gesture is active." }] };
        }
        if (this.gesture.kind !== "axle") {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-unsupported", path: "", message: `Gesture "${this.gesture.kind}" cannot be previewed.` }] };
        }
        const applied = applyAxlePatch(this.gesture.capture, { axle: this.gesture.axle, patch });
        if (!applied.ok) {
            this.draft.preview(this.gesture.capture);
            this.gesture.dirty = false;
            return applied;
        }
        this.draft.preview(applied.manifest);
        this.gesture.dirty = true;
        return { ok: true, manifest: this.draft.snapshot(), issues: [] };
    }

    commitGesture() {
        if (!this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-inactive", path: "", message: "No gesture is active." }] };
        }
        const { capture, label } = this.gesture;
        const after = this.draft.snapshot();
        this.gesture = null;
        if (sameManifest(capture, after)) return { ok: true, empty: true, manifest: after };
        this.history.push({ label, before: capture, after });
        this.redoStack = [];
        this.trimHistory();
        this.draft.generation += 1;
        this.selection.prune(after);
        return { ok: true, manifest: after };
    }

    cancelGesture() {
        if (!this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-inactive", path: "", message: "No gesture is active." }] };
        }
        const capture = this.gesture.capture;
        this.gesture = null;
        this.draft.preview(capture);
        return { ok: true, manifest: this.draft.snapshot() };
    }

    beginSave() {
        this.saveCapture = { generation: this.draft.generation, manifest: this.draft.snapshot() };
        return cloneJson(this.saveCapture);
    }

    acknowledgeSave({ generation, revision, definitionHash } = {}) {
        if (!this.saveCapture || this.saveCapture.generation !== generation) {
            return { ok: false, code: "vehicle.session.stale-save", dirty: this.dirty };
        }
        const draftMoved = this.draft.generation !== generation;
        this.baseline = {
            manifest: cloneJson(this.saveCapture.manifest),
            revision: revision ?? null,
            definitionHash: definitionHash ?? null,
        };
        this.saveCapture = null;
        return { ok: true, dirty: this.dirty, draftMoved };
    }

    failSave() {
        this.saveCapture = null;
        return { ok: true, dirty: this.dirty, stagedResources: this.stagedResources };
    }

    replaceBaseline(stored) {
        if (this.dirty || this.gesture || this.saveCapture) {
            return { ok: false, code: "vehicle.session.dirty" };
        }
        const normalized = normalizeVehicleManifest(stored);
        this.baseline = {
            manifest: cloneJson(normalized),
            revision: stored?.revision ?? null,
            definitionHash: stored?.definitionHash ?? null,
        };
        this.draft = new VehicleDocument(normalized);
        this.history = [];
        this.redoStack = [];
        this.selection.prune(normalized);
        return { ok: true, dirty: this.dirty };
    }

    discard() {
        this.draft.restore(this.baseline.manifest);
        this.history = [];
        this.redoStack = [];
        this.gesture = null;
        this.selection.clear();
        this.stagedResources = null;
        this.saveCapture = null;
        return { ok: true, dirty: this.dirty };
    }

    replaceFromText(json) {
        let parsed;
        try {
            parsed = JSON.parse(json);
        } catch (error) {
            return { ok: false, issues: [{ code: "vehicle.manifest.json", path: "", message: error.message }] };
        }
        return this.execute(replaceManifest(parsed));
    }

    trimHistory() {
        while (this.history.length > this.historyLimit) this.history.shift();
    }
}
