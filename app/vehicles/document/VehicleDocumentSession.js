import { canonicalStringify } from "../../simulation/canonicalJson.js";
import { cloneJson } from "../../util/cloneJson.js";
import { normalizeVehicleManifest } from "../VehicleManifest.js";
import { VehicleDocument } from "./VehicleDocument.js";
import { VehicleSelection } from "./VehicleSelection.js";
import { applyAxlePatch, replaceManifest } from "./vehicleCommands.js";
import { applyLinkedWheelMotion, validateWheelLink } from "./wheelLink.js";

const VOLATILE = new Set(["revision", "definitionHash", "createdAt", "updatedAt"]);
const COALESCE_MS = 750;

function stripVolatile(manifest) {
    const copy = cloneJson(manifest);
    for (const key of VOLATILE) delete copy[key];
    return copy;
}

function sameManifest(left, right) {
    return canonicalStringify(stripVolatile(left)) === canonicalStringify(stripVolatile(right));
}

function cloneStage(ref) {
    return ref == null ? null : cloneJson(ref);
}

function sameStage(left, right) {
    return canonicalStringify(left ?? null) === canonicalStringify(right ?? null);
}

/**
 * Draft session for one vehicle. History, gestures, the wheel link, and
 * staged-resource references stay here; they are not written into the manifest.
 */
export class VehicleDocumentSession {
    constructor({
        manifest,
        revision = null,
        definitionHash = null,
        historyLimit = 100,
        normalizeOptions,
        resolveNormalizeOptions = null,
    } = {}) {
        this.resolveNormalizeOptions = resolveNormalizeOptions ?? (() => normalizeOptions);
        this.selection = new VehicleSelection();
        this.wheelLink = null;
        this.history = [];
        this.redoStack = [];
        this.gesture = null;
        this.stagedResources = null;
        this.saveCapture = null;
        this.historyLimit = Math.max(1, historyLimit);
        const normalized = normalizeVehicleManifest(manifest, this.normalizeOptions);
        this.baseline = { manifest: cloneJson(normalized), revision, definitionHash };
        this.draft = new VehicleDocument(normalized, this.normalizeOptions);
    }

    get normalizeOptions() {
        return this.resolveNormalizeOptions() ?? undefined;
    }

    get dirty() {
        return !sameManifest(this.draft.snapshot(), this.baseline.manifest);
    }

    execute(command, options = {}) {
        if (this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Finish the active gesture before running another command." }] };
        }
        if (!command || typeof command.run !== "function") {
            return { ok: false, issues: [{ code: "vehicle.session.command", path: "", message: "Commands must provide run(context)." }] };
        }
        const normalizeOptions = this.normalizeOptions;
        const before = this.draft.snapshot();
        const stagedBefore = cloneStage(this.stagedResources);
        const box = { manifest: cloneJson(before) };
        let staged = this.stagedResources;
        let stagedTouched = false;
        const issues = [];
        const context = {
            get manifest() { return box.manifest; },
            setManifest(next) { box.manifest = normalizeVehicleManifest(next, normalizeOptions); },
            issue(code, path, message) { issues.push({ code, path, message }); },
            selection: this.selection.snapshot(),
            normalizeOptions,
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
        if (stagedTouched) this.stagedResources = cloneStage(staged);
        if (result?.history === false || sameManifest(before, box.manifest)) {
            return { ok: true, manifest: this.draft.snapshot(), issues: [], review: result?.review };
        }
        this.draft.commit(box.manifest);
        const now = options.now ?? Date.now();
        const after = this.draft.snapshot();
        const stagedAfter = cloneStage(this.stagedResources);
        const last = this.history.at(-1);
        const withinMs = options.withinMs ?? COALESCE_MS;
        const coalesce = Boolean(options.coalesceKey)
            && last?.coalesceKey === options.coalesceKey
            && Number.isFinite(last.at)
            && now - last.at <= withinMs;
        if (coalesce) {
            if (sameManifest(last.before, after) && sameStage(last.stagedBefore, stagedAfter)) {
                this.history.pop();
            } else {
                last.after = after;
                last.stagedAfter = stagedAfter;
                last.at = now;
                last.label = command.label ?? last.label;
            }
        } else {
            this.history.push({
                label: command.label ?? "Edit",
                coalesceKey: options.coalesceKey ?? null,
                at: now,
                before,
                after,
                stagedBefore,
                stagedAfter,
            });
            this.redoStack = [];
            this.trimHistory();
        }
        this.selection.prune(after);
        this.pruneWheelLink();
        return { ok: true, manifest: after, issues: [], review: result?.review };
    }

    executeCoalesced(command, { key, withinMs = COALESCE_MS, now = Date.now() } = {}) {
        return this.execute(command, { coalesceKey: key, withinMs, now });
    }

    undo() {
        if (this.gesture) return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Cancel the gesture before undoing." }] };
        const entry = this.history.pop();
        if (!entry) return { ok: false, issues: [{ code: "vehicle.session.history", path: "", message: "Nothing to undo." }] };
        this.redoStack.push(entry);
        this.draft.restore(entry.before);
        this.#restoreStage(entry, "stagedBefore");
        this.selection.prune(this.draft.snapshot());
        this.pruneWheelLink();
        return { ok: true, manifest: this.draft.snapshot() };
    }

    redo() {
        if (this.gesture) return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Cancel the gesture before redoing." }] };
        const entry = this.redoStack.pop();
        if (!entry) return { ok: false, issues: [{ code: "vehicle.session.history", path: "", message: "Nothing to redo." }] };
        this.history.push(entry);
        this.trimHistory();
        this.draft.restore(entry.after);
        this.#restoreStage(entry, "stagedAfter");
        this.selection.prune(this.draft.snapshot());
        this.pruneWheelLink();
        return { ok: true, manifest: this.draft.snapshot() };
    }

    /** @returns {{ ids: string[], mode: "together" | "mirror" } | null} */
    wheelLinkSnapshot() {
        if (!this.wheelLink) return null;
        return { ids: [...this.wheelLink.ids], mode: this.wheelLink.mode };
    }

    setWheelLink(link) {
        if (this.gesture) {
            return { ok: false, link: this.wheelLinkSnapshot(), issues: [{ code: "vehicle.session.gesture-active", path: "", message: "Finish the active gesture before changing the wheel link." }] };
        }
        const result = validateWheelLink(this.draft.snapshot().wheels, link);
        if (!result.ok) return result;
        this.wheelLink = result.link;
        return { ok: true, link: this.wheelLinkSnapshot(), issues: [] };
    }

    pruneWheelLink() {
        if (!this.wheelLink) return;
        const result = validateWheelLink(this.draft.snapshot().wheels, this.wheelLink);
        this.wheelLink = result.ok ? result.link : null;
    }

    beginGesture({ kind, label = "Gesture", axle = null, drivenId = null, link = null } = {}) {
        if (this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-active", path: "", message: "A gesture is already active." }] };
        }
        this.gesture = {
            id: `gesture-${this.history.length + 1}`,
            kind,
            label,
            axle,
            drivenId,
            link: link ? { ids: [...link.ids], mode: link.mode } : null,
            capture: this.draft.snapshot(),
            stagedBefore: cloneStage(this.stagedResources),
            dirty: false,
        };
        return { ok: true, gesture: { id: this.gesture.id, kind, label, axle } };
    }

    previewGesture(patch = {}) {
        if (!this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-inactive", path: "", message: "No gesture is active." }] };
        }
        let applied = null;
        if (this.gesture.kind === "axle") {
            applied = applyAxlePatch(this.gesture.capture, {
                axle: this.gesture.axle,
                patch,
                normalizeOptions: this.normalizeOptions,
            });
        } else if (this.gesture.kind === "wheel-link") {
            applied = applyLinkedWheelMotion(this.gesture.capture, {
                drivenId: patch.drivenId ?? this.gesture.drivenId,
                position: patch.position,
                link: this.gesture.link,
                normalizeOptions: this.normalizeOptions,
            });
        } else {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-unsupported", path: "", message: `Gesture "${this.gesture.kind}" cannot be previewed.` }] };
        }
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
        const { capture, label, stagedBefore } = this.gesture;
        const after = this.draft.snapshot();
        this.gesture = null;
        if (sameManifest(capture, after)) return { ok: true, empty: true, manifest: after };
        this.history.push({
            label,
            before: capture,
            after,
            stagedBefore,
            stagedAfter: cloneStage(this.stagedResources),
            at: Date.now(),
        });
        this.redoStack = [];
        this.trimHistory();
        this.draft.generation += 1;
        this.selection.prune(after);
        this.pruneWheelLink();
        return { ok: true, manifest: after };
    }

    cancelGesture() {
        if (!this.gesture) {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-inactive", path: "", message: "No gesture is active." }] };
        }
        const capture = this.gesture.capture;
        this.gesture = null;
        this.draft.preview(capture);
        this.pruneWheelLink();
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
        const normalized = normalizeVehicleManifest(stored, this.normalizeOptions);
        this.baseline = {
            manifest: cloneJson(normalized),
            revision: stored?.revision ?? null,
            definitionHash: stored?.definitionHash ?? null,
        };
        this.draft = new VehicleDocument(normalized, this.normalizeOptions);
        this.history = [];
        this.redoStack = [];
        this.selection.prune(normalized);
        this.pruneWheelLink();
        return { ok: true, dirty: this.dirty };
    }

    discard() {
        this.draft.restore(this.baseline.manifest);
        this.history = [];
        this.redoStack = [];
        this.gesture = null;
        this.wheelLink = null;
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
        return this.execute(replaceManifest(parsed, this.normalizeOptions));
    }

    trimHistory() {
        while (this.history.length > this.historyLimit) this.history.shift();
    }

    #restoreStage(entry, key) {
        if (!entry || !Object.hasOwn(entry, key)) return;
        this.stagedResources = cloneStage(entry[key]);
    }
}
