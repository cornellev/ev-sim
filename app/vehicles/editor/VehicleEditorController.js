import { cloneJson } from "../../util/cloneJson.js";
import { validateVehicleManifest } from "../VehicleManifest.js";
import { createVehicleOperationId } from "../VehicleManifestClient.js";
import { publishVehicleDraft } from "../document/publishVehicleDraft.js";
import { VehicleDocumentSession } from "../document/VehicleDocumentSession.js";
import {
    applyModelReplacement,
    applyReviewedUrdfImport,
    editManifestFields,
    replaceManifest,
} from "../document/vehicleCommands.js";
import { resolveMotionLink } from "../document/wheelLink.js";

const STAGE_CODES = new Set(["VEHICLE_STAGE_CONFLICT", "VEHICLE_STAGE_EXPIRED", "VEHICLE_STAGE_NOT_FOUND"]);

function setPath(manifest, path, value) {
    if (!path.length) return cloneJson(value);
    const next = cloneJson(manifest);
    let cursor = next;
    for (const part of path.slice(0, -1)) {
        if (cursor[part] == null || typeof cursor[part] !== "object") cursor[part] = {};
        cursor = cursor[part];
    }
    cursor[path.at(-1)] = value;
    return next;
}

function getPath(manifest, path) {
    return path.reduce((value, part) => value?.[part], manifest);
}

function readOnlyResult() {
    return { ok: false, issues: [{ code: "vehicle.editor.readonly", path: "", message: "Built-in vehicles are read only." }] };
}

function classifySaveError(error) {
    if (STAGE_CODES.has(error?.code) || /does not match the server digest/i.test(error?.message ?? "")) return "expired-stage";
    if (/revision conflict/i.test(error?.message ?? "")) return "conflict";
    return "error";
}

/**
 * Editor-facing owner of one vehicle document session. React state, pane
 * layout, and catalog dialogs stay outside this class.
 */
export class VehicleEditorController {
    constructor({
        client = null,
        normalizeOptions,
        resolveNormalizeOptions = null,
        historyLimit = 100,
        now = () => Date.now(),
        createOperationId = createVehicleOperationId,
    } = {}) {
        this.client = client;
        this.resolveNormalizeOptions = resolveNormalizeOptions ?? (() => normalizeOptions);
        this.historyLimit = historyLimit;
        this.now = now;
        this.createOperationId = createOperationId;
        this.session = null;
        this.readOnly = false;
        this.fieldBuffers = new Map();
        this.rawOverride = null;
        this.rawError = null;
        this.validation = null;
        this.saveState = "idle";
        this.saveMessage = null;
        this.introducedStages = new Set();
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    get snapshot() {
        const manifest = this.session ? this.session.draft.snapshot() : null;
        const selection = this.session ? this.session.selection.snapshot() : { kind: null, id: null };
        return {
            manifest,
            raw: this.rawOverride ?? (manifest ? JSON.stringify(manifest, null, 2) : ""),
            rawError: this.rawError,
            dirty: this.session ? this.session.dirty : false,
            readOnly: this.readOnly,
            selection,
            canUndo: Boolean(this.session && this.session.history.length > 0 && !this.session.gesture),
            canRedo: Boolean(this.session && this.session.redoStack.length > 0 && !this.session.gesture),
            revision: this.session?.baseline.revision ?? null,
            definitionHash: this.session?.baseline.definitionHash ?? null,
            stagedResources: this.session?.stagedResources ?? null,
            saveState: this.saveState,
            saveMessage: this.saveMessage,
            validation: this.validation,
            gesture: this.session?.gesture
                ? { kind: this.session.gesture.kind, axle: this.session.gesture.axle, label: this.session.gesture.label }
                : null,
            wheelLink: this.session?.wheelLinkSnapshot() ?? null,
        };
    }

    close() {
        this.#abandonIntroduced();
        this.session = null;
        this.readOnly = false;
        this.fieldBuffers.clear();
        this.rawOverride = null;
        this.rawError = null;
        this.validation = null;
        this.saveState = "idle";
        this.saveMessage = null;
        this.#emit();
    }

    open(stored, { readOnly = false } = {}) {
        this.#abandonIntroduced();
        this.readOnly = readOnly === true;
        this.session = new VehicleDocumentSession({
            manifest: stored,
            revision: stored?.revision ?? null,
            definitionHash: stored?.definitionHash ?? null,
            historyLimit: this.historyLimit,
            resolveNormalizeOptions: () => this.resolveNormalizeOptions(),
        });
        this.fieldBuffers.clear();
        this.rawOverride = null;
        this.rawError = null;
        this.validation = null;
        this.saveState = "idle";
        this.saveMessage = null;
        this.#emit();
        return this.snapshot;
    }

    fieldValue(path) {
        const key = path.join(".");
        if (this.fieldBuffers.has(key)) return this.fieldBuffers.get(key);
        return getPath(this.snapshot.manifest, path);
    }

    editField(path, value, { coalesceKey, coalesce = true } = {}) {
        if (!this.session) return { ok: false, issues: [{ code: "vehicle.editor.closed", path: "", message: "No vehicle is open." }] };
        if (this.readOnly) return readOnlyResult();
        const key = coalesceKey ?? (path.join(".") || "document");
        if (typeof value === "string") this.fieldBuffers.set(key, value);
        const next = setPath(this.session.draft.snapshot(), path, value);
        const command = editManifestFields(next, key);
        const result = coalesce
            ? this.session.executeCoalesced(command, { key, now: this.now() })
            : this.session.execute(command);
        if (result.ok) {
            this.rawOverride = null;
            this.rawError = null;
            this.validation = null;
        } else {
            this.validation = { ok: false, issues: result.issues ?? [] };
        }
        this.#emit();
        return result;
    }

    commitField(path) {
        const key = path.join(".");
        if (!this.fieldBuffers.has(key)) return { ok: true };
        const value = this.fieldBuffers.get(key);
        const result = this.editField(path, value, { coalesceKey: key });
        this.fieldBuffers.delete(key);
        this.#emit();
        return result;
    }

    execute(command, { coalesceKey = null } = {}) {
        if (!this.session) return { ok: false, issues: [{ code: "vehicle.editor.closed", path: "", message: "No vehicle is open." }] };
        if (this.readOnly) return readOnlyResult();
        const result = coalesceKey
            ? this.session.executeCoalesced(command, { key: coalesceKey, now: this.now() })
            : this.session.execute(command);
        if (result.ok) {
            this.rawOverride = null;
            this.rawError = null;
            this.validation = null;
        }
        this.#emit();
        return result;
    }

    replaceStagedModel({ model, stagedResources }) {
        if (stagedResources?.stageId) this.introducedStages.add(stagedResources.stageId);
        return this.execute({
            label: "Replace model",
            run(context) {
                if (stagedResources !== undefined) context.setStagedResources(stagedResources);
                return applyModelReplacement({ model }).run(context);
            },
        });
    }

    applyUrdf({ patch, stagedResources }) {
        if (stagedResources?.stageId) this.introducedStages.add(stagedResources.stageId);
        return this.execute(applyReviewedUrdfImport({ patch, stagedResources }));
    }

    applyRaw(text) {
        if (!this.session) return { ok: false, issues: [{ code: "vehicle.editor.closed", path: "", message: "No vehicle is open." }] };
        if (this.readOnly) return readOnlyResult();
        this.rawOverride = text;
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            this.rawError = error.message;
            this.#emit();
            return { ok: false, issues: [{ code: "vehicle.manifest.json", path: "", message: error.message }] };
        }
        const result = this.session.executeCoalesced(replaceManifest(parsed, this.session.normalizeOptions), {
            key: "raw-json",
            now: this.now(),
        });
        this.rawError = result.ok ? null : (result.issues ?? []).map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("\n");
        if (result.ok) this.validation = null;
        this.#emit();
        return result;
    }

    select(kind, id = null) {
        if (!this.session) return;
        if (this.readOnly || !kind) this.session.selection.clear();
        else this.session.selection.select(kind, id);
        this.#emit();
    }

    setWheelLink(link) {
        if (!this.session) return { ok: false, issues: [{ code: "vehicle.editor.closed", path: "", message: "No vehicle is open." }] };
        if (this.readOnly) return readOnlyResult();
        const result = this.session.setWheelLink(link);
        this.#emit();
        return result;
    }

    beginWheel(drivenId) {
        if (!this.session) return { ok: false, issues: [{ code: "vehicle.editor.closed", path: "", message: "No vehicle is open." }] };
        if (this.readOnly) return readOnlyResult();
        if (this.session.gesture?.kind === "wheel-link" && this.session.gesture.drivenId === drivenId) return { ok: true };
        if (this.session.gesture) this.commitAxle();
        const link = resolveMotionLink(this.session.draft.snapshot().wheels, drivenId, this.session.wheelLink);
        if (!link) {
            return { ok: false, issues: [{ code: "vehicle.wheel.link", path: "wheels", message: "That wheel has no linked partner." }] };
        }
        const result = this.session.beginGesture({ kind: "wheel-link", label: "Move wheels", drivenId, link });
        this.#emit();
        return result;
    }

    previewWheel(drivenId, position) {
        if (!this.session?.gesture || this.session.gesture.kind !== "wheel-link" || this.session.gesture.drivenId !== drivenId) {
            const begun = this.beginWheel(drivenId);
            if (!begun.ok) return begun;
        }
        const result = this.session.previewGesture({ drivenId, position });
        this.#emit();
        return result;
    }

    commitWheel() {
        if (!this.session?.gesture) return { ok: true, empty: true, manifest: this.snapshot.manifest };
        if (this.session.gesture.kind !== "wheel-link") {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-unsupported", path: "", message: "The active gesture is not a wheel link." }] };
        }
        const result = this.session.commitGesture();
        this.rawOverride = null;
        this.#emit();
        return result;
    }

    cancelWheel() {
        if (!this.session?.gesture) return { ok: true, empty: true };
        if (this.session.gesture.kind !== "wheel-link") {
            return { ok: false, issues: [{ code: "vehicle.session.gesture-unsupported", path: "", message: "The active gesture is not a wheel link." }] };
        }
        const result = this.session.cancelGesture();
        this.#emit();
        return result;
    }

    beginAxle(axle) {
        if (!this.session || this.readOnly) return readOnlyResult();
        if (this.session.gesture?.axle === axle) return { ok: true };
        if (this.session.gesture) this.commitAxle();
        const result = this.session.beginGesture({ kind: "axle", axle, label: `${axle} axle` });
        this.#emit();
        return result;
    }

    previewAxle(axle, patch) {
        if (!this.session?.gesture || this.session.gesture.axle !== axle) {
            const begun = this.beginAxle(axle);
            if (!begun.ok) return begun;
        }
        const result = this.session.previewGesture(patch);
        this.#emit();
        return result;
    }

    commitAxle() {
        if (!this.session?.gesture) return { ok: true, empty: true, manifest: this.snapshot.manifest };
        const result = this.session.commitGesture();
        this.rawOverride = null;
        this.#emit();
        return result;
    }

    cancelAxle() {
        if (!this.session?.gesture) return { ok: true, empty: true };
        const result = this.session.cancelGesture();
        this.#emit();
        return result;
    }

    undo() {
        if (!this.session) return { ok: false };
        if (this.session.gesture?.kind === "wheel-link") return this.cancelWheel();
        if (this.session.gesture) return this.cancelAxle();
        const result = this.session.undo();
        this.rawOverride = null;
        this.fieldBuffers.clear();
        this.#emit();
        return result;
    }

    redo() {
        if (!this.session) return { ok: false };
        if (this.session.gesture?.kind === "wheel-link") return this.cancelWheel();
        if (this.session.gesture) return this.cancelAxle();
        const result = this.session.redo();
        this.rawOverride = null;
        this.fieldBuffers.clear();
        this.#emit();
        return result;
    }

    discard() {
        if (!this.session) return { ok: true, dirty: false };
        const stages = [...this.introducedStages];
        this.session.discard();
        this.introducedStages.clear();
        this.fieldBuffers.clear();
        this.rawOverride = null;
        this.rawError = null;
        this.validation = null;
        this.saveState = "idle";
        this.saveMessage = null;
        this.#emit();
        this.#abandon(stages);
        return { ok: true, dirty: this.session.dirty };
    }

    async save() {
        if (!this.session) throw new Error("No vehicle is open.");
        if (this.readOnly) throw new Error("Built-in vehicles are read only.");
        if (this.session.gesture) this.commitAxle();
        for (const path of [...this.fieldBuffers.keys()]) this.commitField(path.split("."));
        const local = validateVehicleManifest(this.session.draft.snapshot(), this.session.normalizeOptions);
        if (!local.ok) {
            this.validation = local;
            this.saveState = "error";
            this.saveMessage = "Fix validation errors before saving.";
            this.#emit();
            throw new Error(this.saveMessage);
        }
        if (!this.session.dirty && !this.session.stagedResources) {
            this.saveState = "idle";
            this.#emit();
            return { ok: true, dirty: false, stored: null };
        }
        this.saveState = "saving";
        this.saveMessage = null;
        this.#emit();
        try {
            const result = await publishVehicleDraft(this.session, this.client, { operationId: this.createOperationId() });
            this.introducedStages.clear();
            this.saveState = "idle";
            this.saveMessage = null;
            this.rawOverride = null;
            this.#emit();
            return result;
        } catch (error) {
            this.saveState = classifySaveError(error);
            this.saveMessage = error.message;
            this.#emit();
            throw error;
        }
    }

    #abandonIntroduced() {
        const stages = [...this.introducedStages];
        this.introducedStages.clear();
        this.#abandon(stages);
    }

    #abandon(stages) {
        for (const stageId of stages) {
            Promise.resolve(this.client?.abandonVehicleStage?.(stageId)).catch(() => {});
        }
    }

    #emit() {
        const snapshot = this.snapshot;
        for (const listener of this.listeners) listener(snapshot);
    }
}
