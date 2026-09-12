/**
 * CommandBus: the single mutation path for the environment editor.
 *
 * `execute(command)` runs a command inside one document transaction,
 * reconciles the live object overlay, validates the object graph, and either
 * commits exactly one change set to history or restores the document
 * byte-identically. Gestures capture the pristine records of their transform
 * closure; every `updateGesture(delta)` restores that capture and re-applies
 * the cumulative delta (idempotent), notifying with `transient: true`;
 * `commitGesture` publishes one non-transient change set; `cancelGesture`
 * restores the capture and never enters history. Undo and redo apply the
 * recorded before/after sides. Headless: no scene, registry, or React.
 */

import { applyChangeSet, isEmptyChangeSet } from "../document/ChangeSet.js";
import { objectTypeRegistry } from "../objects/ObjectTypeRegistry.js";
import { validateObjectRecords } from "../objects/objectGraph.js";
import { IDENTITY_DELTA, normalizeDelta } from "../objects/transformDelta.js";
import { COMMAND_ISSUE_CODES, commandFailure, commandIssue, errorIssues } from "./commandIssues.js";
import { captureRecords, capturesEqual, changeSetBetween, restoreRecords } from "./gestureCapture.js";
import { reconcileLiveOverlay } from "./liveOverlay.js";
import { applyPlanSteps } from "./planApply.js";
import { collectTransformClosure, planTransform } from "./transformPlanning.js";

export const DEFAULT_HISTORY_LIMIT = 200;

class CommandAbort extends Error {
    constructor(outcome) {
        super(outcome?.error ?? "Command aborted.");
        this.name = "CommandAbort";
        this.outcome = outcome;
    }
}

function asCommand(command) {
    if (!command || typeof command.run !== "function") {
        throw new TypeError("Commands must be objects with a run(context) method.");
    }
    return command;
}

export class CommandBus {
    /**
     * @param {{ document: import("../document/EnvironmentDocument.js").EnvironmentDocument,
     *   registry?: import("../objects/ObjectTypeRegistry.js").ObjectTypeRegistry,
     *   sky?: object|null|(() => object|null),
     *   selection?: { prune(ids: Set<string>): void }|null,
     *   historyLimit?: number }} options
     */
    constructor({ document, registry = objectTypeRegistry, sky = null, selection = null, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
        if (!document || typeof document.transaction !== "function") {
            throw new TypeError("CommandBus requires an EnvironmentDocument.");
        }
        this.document = document;
        this.registry = registry;
        this.skySource = sky;
        this.selection = selection;
        this.historyLimit = Math.max(1, Math.trunc(historyLimit) || DEFAULT_HISTORY_LIMIT);
        /** @type {object[]} */
        this.history = [];
        /** @type {object[]} */
        this.redoStack = [];
        this.gesture = null;
        this.gestureCounter = 0;
        this.commandCounter = 0;
        this.lastCommit = null;
        this.subscribers = new Set();
    }

    get sky() {
        return typeof this.skySource === "function" ? (this.skySource() ?? null) : (this.skySource ?? null);
    }

    get canUndo() {
        return this.history.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get activeGesture() {
        if (!this.gesture) return null;
        const { id, label, objectIds, sub } = this.gesture;
        return { id, label, objectIds: [...objectIds], sub: sub ? { ...sub } : null };
    }

    snapshot() {
        return {
            canUndo: this.canUndo,
            canRedo: this.canRedo,
            historyLength: this.history.length,
            redoLength: this.redoStack.length,
            activeGesture: this.activeGesture,
            lastCommit: this.lastCommit ? { ...this.lastCommit } : null,
            history: this.history.map((entry) => entry.meta?.label ?? entry.meta?.source ?? "change"),
        };
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot());
        return () => {
            this.subscribers.delete(callback);
        };
    }

    _notify() {
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot));
    }

    /** Context handed to `command.run`. */
    context() {
        return {
            document: this.document,
            registry: this.registry,
            sky: this.sky,
            selection: this.selection,
            bus: this,
            issue: commandIssue,
            index: () => this.document.index(),
        };
    }

    /**
     * Execute one command as one history entry.
     * @returns {{ ok: boolean, issues: object[], result?: object, changeSet: object|null, error?: string }}
     */
    execute(command, { source = null } = {}) {
        const resolved = asCommand(command);
        if (this.gesture) this.cancelGesture(this.gesture.id);
        if (this.document.inTransaction) {
            // Nested inside bus.transaction(): the outer transaction commits.
            const outcome = this._runGuarded(resolved);
            if (!outcome.ok) throw new CommandAbort(outcome);
            return { ok: true, issues: [], result: outcome.result, changeSet: null };
        }
        this.commandCounter += 1;
        let outcome = null;
        const { changeSet } = this.document.transaction(() => {
            outcome = this._runGuarded(resolved);
        }, {
            source: source ?? resolved.source ?? "command",
            label: resolved.label ?? resolved.id ?? "Command",
            commandId: resolved.id ?? `command-${this.commandCounter}`,
        });
        if (!outcome?.ok) {
            return { ok: false, issues: outcome?.issues ?? [], error: outcome?.error, changeSet: null };
        }
        this._commit(changeSet);
        return { ok: true, issues: [], result: outcome.result, changeSet };
    }

    /**
     * Run several commands as one history entry. `fn(run)` receives a runner
     * that executes a command or aborts the whole transaction on failure.
     */
    transaction(label, fn, { source = "command" } = {}) {
        if (typeof fn !== "function") throw new TypeError("transaction(label, fn) requires a function.");
        if (this.gesture) this.cancelGesture(this.gesture.id);
        this.commandCounter += 1;
        let outcome = null;
        const { changeSet } = this.document.transaction((document) => {
            const before = document.snapshot();
            const results = [];
            const run = (command) => {
                const result = this._runGuarded(asCommand(command));
                results.push(result);
                if (!result.ok) throw new CommandAbort(result);
                return result;
            };
            try {
                outcome = { ok: true, result: fn(run, this.context()), results };
            } catch (error) {
                document.restoreSnapshot(before, { notify: false });
                outcome = error instanceof CommandAbort
                    ? error.outcome
                    : commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, error?.message ?? String(error)));
            }
        }, { source, label, commandId: `transaction-${this.commandCounter}` });
        if (!outcome?.ok) {
            return { ok: false, issues: outcome?.issues ?? [], error: outcome?.error, changeSet: null };
        }
        this._commit(changeSet);
        return { ok: true, issues: [], result: outcome.result, changeSet };
    }

    _runGuarded(command) {
        const document = this.document;
        const before = document.snapshot();
        let outcome;
        try {
            outcome = command.run(this.context());
        } catch (error) {
            if (error instanceof CommandAbort) {
                document.restoreSnapshot(before, { notify: false });
                return error.outcome;
            }
            outcome = commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, error?.message ?? String(error)));
        }
        if (!outcome || outcome.ok !== true) {
            document.restoreSnapshot(before, { notify: false });
            return outcome?.ok === false
                ? outcome
                : commandFailure(commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, "Command returned no result."));
        }
        reconcileLiveOverlay(document, this.registry, this.sky);
        const validation = validateObjectRecords(document.objects, document.index(), this.registry, { sky: this.sky });
        if (!validation.ok) {
            document.restoreSnapshot(before, { notify: false });
            return commandFailure(errorIssues(validation.issues));
        }
        return outcome;
    }

    _commit(changeSet) {
        if (changeSet && !isEmptyChangeSet(changeSet)) {
            this.history.push(changeSet);
            if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
            this.redoStack = [];
            this.lastCommit = {
                label: changeSet.meta?.label ?? null,
                source: changeSet.meta?.source ?? "command",
                version: this.document.version,
            };
        }
        this._pruneSelection();
        this._notify();
    }

    _pruneSelection() {
        if (!this.selection?.prune || this.document.objects.length === 0) return;
        this.selection.prune(new Set(this.document.objects.map((record) => String(record.id))));
    }

    // ------------------------------------------------------------------ gestures

    /**
     * @param {{ objectIds: string[], sub?: { kind: "road-node", id: string }|null, label?: string }} input
     */
    beginGesture({ objectIds = [], sub = null, label = "Transform" } = {}) {
        if (this.gesture) this.cancelGesture(this.gesture.id);
        const closure = collectTransformClosure(this.document, this.registry, objectIds, sub);
        if (closure.issues.length > 0) {
            return { ok: false, gestureId: null, issues: closure.issues, closure };
        }
        if (closure.leaves.size === 0 && closure.groups.size === 0 && closure.nodeIds.size === 0) {
            return {
                ok: false,
                gestureId: null,
                issues: [commandIssue(COMMAND_ISSUE_CODES.SELECTION_EMPTY, "Nothing to transform.")],
                closure,
            };
        }
        this.gestureCounter += 1;
        const id = `gesture-${this.gestureCounter}`;
        const before = captureRecords(this.document, closure);
        this.gesture = {
            id,
            label,
            objectIds: [...objectIds].map(String),
            sub: sub ? { ...sub } : null,
            closure,
            before,
            lastCapture: before,
            lastDelta: IDENTITY_DELTA,
            lastOk: true,
        };
        this._notify();
        return { ok: true, gestureId: id, issues: [], closure };
    }

    /** `delta` is cumulative since `beginGesture`. */
    updateGesture(gestureId, delta) {
        const gesture = this.gesture;
        if (!gesture || gesture.id !== gestureId) {
            return { ok: false, issues: [commandIssue(COMMAND_ISSUE_CODES.GESTURE_INACTIVE, "No active gesture.")], changeSet: null };
        }
        const normalized = normalizeDelta(delta);
        restoreRecords(this.document, gesture.before);
        const plan = planTransform(this.document, this.registry, gesture.objectIds, normalized, { sub: gesture.sub, closure: gesture.closure });
        let issues = [];
        if (plan.ok) {
            const applied = applyPlanSteps(this.document, plan.steps, { notify: false });
            if (!applied.ok) {
                restoreRecords(this.document, gesture.before);
                issues = [commandIssue(COMMAND_ISSUE_CODES.MUTATION_FAILED, applied.error)];
            }
        } else {
            issues = plan.issues;
        }
        gesture.lastDelta = normalized;
        gesture.lastOk = issues.length === 0;
        const now = captureRecords(this.document, gesture.closure);
        const changeSet = changeSetBetween(gesture.lastCapture, now, {
            source: "gesture",
            transient: true,
            gestureId,
            label: gesture.label,
            delta: normalized,
        });
        gesture.lastCapture = now;
        this.document.notify({ transient: true, source: "gesture", changeSet: isEmptyChangeSet(changeSet) ? null : changeSet });
        return { ok: issues.length === 0, issues, changeSet: isEmptyChangeSet(changeSet) ? null : changeSet };
    }

    commitGesture(gestureId) {
        const gesture = this.gesture;
        if (!gesture || gesture.id !== gestureId) {
            return { ok: false, issues: [commandIssue(COMMAND_ISSUE_CODES.GESTURE_INACTIVE, "No active gesture.")], changeSet: null };
        }
        this.gesture = null;
        if (!gesture.lastOk) {
            // The last frame was rejected and the document already sits at the capture.
            restoreRecords(this.document, gesture.before);
            this._notify();
            return { ok: false, issues: [commandIssue(COMMAND_ISSUE_CODES.GESTURE_UNSUPPORTED, "The gesture was rejected; nothing was committed.")], changeSet: null };
        }
        const after = captureRecords(this.document, gesture.closure);
        if (capturesEqual(gesture.before, after)) {
            this._notify();
            return { ok: true, issues: [], changeSet: null };
        }
        if (gesture.closure.groups.size > 0) {
            const validation = validateObjectRecords(this.document.objects, this.document.index(), this.registry, { sky: this.sky });
            if (!validation.ok) {
                restoreRecords(this.document, gesture.before);
                this.document.notify({ transient: false, source: "cancel", changeSet: changeSetBetween(after, gesture.before, { source: "cancel", transient: false, gestureId }) });
                this._notify();
                return { ok: false, issues: errorIssues(validation.issues), changeSet: null };
            }
        }
        reconcileLiveOverlay(this.document, this.registry, this.sky);
        const changeSet = changeSetBetween(gesture.before, after, {
            source: "gesture",
            transient: false,
            gestureId,
            label: gesture.label,
            delta: gesture.lastDelta,
        });
        this.history.push(changeSet);
        if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
        this.redoStack = [];
        this.document.notify({ transient: false, source: "gesture", changeSet });
        this.lastCommit = { label: gesture.label, source: "gesture", version: this.document.version };
        this._notify();
        return { ok: true, issues: [], changeSet };
    }

    cancelGesture(gestureId = null) {
        const gesture = this.gesture;
        if (!gesture || (gestureId !== null && gesture.id !== gestureId)) return { ok: false, changeSet: null };
        this.gesture = null;
        const current = captureRecords(this.document, gesture.closure);
        restoreRecords(this.document, gesture.before);
        const changeSet = changeSetBetween(current, gesture.before, { source: "cancel", transient: false, gestureId: gesture.id, label: gesture.label });
        this.document.notify({ transient: false, source: "cancel", changeSet: isEmptyChangeSet(changeSet) ? null : changeSet });
        this._notify();
        return { ok: true, changeSet: isEmptyChangeSet(changeSet) ? null : changeSet };
    }

    // ------------------------------------------------------------------- history

    undo() {
        if (this.gesture) this.cancelGesture(this.gesture.id);
        const changeSet = this.history.pop();
        if (!changeSet) {
            return { ok: false, issues: [commandIssue(COMMAND_ISSUE_CODES.NOTHING_TO_UNDO, "Nothing to undo.")], changeSet: null };
        }
        applyChangeSet(this.document, changeSet, "before", { label: changeSet.meta?.label ?? "Undo" });
        this.redoStack.push(changeSet);
        this.lastCommit = { label: changeSet.meta?.label ?? null, source: "undo", version: this.document.version };
        this._pruneSelection();
        this._notify();
        return { ok: true, issues: [], changeSet };
    }

    redo() {
        if (this.gesture) this.cancelGesture(this.gesture.id);
        const changeSet = this.redoStack.pop();
        if (!changeSet) {
            return { ok: false, issues: [commandIssue(COMMAND_ISSUE_CODES.NOTHING_TO_UNDO, "Nothing to redo.")], changeSet: null };
        }
        applyChangeSet(this.document, changeSet, "after", { label: changeSet.meta?.label ?? "Redo" });
        this.history.push(changeSet);
        this.lastCommit = { label: changeSet.meta?.label ?? null, source: "redo", version: this.document.version };
        this._pruneSelection();
        this._notify();
        return { ok: true, issues: [], changeSet };
    }

    /** Forget history and any gesture (after a load or reload). */
    reset() {
        if (this.gesture) {
            this.gesture = null;
        }
        this.history = [];
        this.redoStack = [];
        this.lastCommit = null;
        this._notify();
    }
}
