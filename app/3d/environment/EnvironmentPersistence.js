import { storagePut } from "../../client/storageClient.js";

// How long to wait after the last edit before saving. Keeps rapid edits (e.g.
// dragging a road node) from firing a request on every frame.
const DEBOUNCE_MS = 1500;
// Hard cap so a long, continuous editing session still flushes periodically
// instead of never saving until the user pauses.
const MAX_WAIT_MS = 8000;

/**
 * EnvironmentPersistence keeps a single environment's edits saved on the server.
 *
 * Responsibilities:
 *   - attach(): watch the document / registry / editor / sky for changes and
 *               save the full manifest on a debounced schedule (off the hot path).
 *   - dispose(): flush a final save and detach all listeners.
 *
 * Saving serializes `environment.toManifest()`. EnvironmentLoader exclusively
 * owns loading and runtime application so there cannot be two competing paths.
 * Revision numbers advance only from a successful server response.
 */
export class EnvironmentPersistence {
    /**
     * @param {object} params
     * @param {import("../data/Data").Data} params.data
     * @param {THREE.Scene} params.scene
     * @param {number} [params.revision]
     * @param {typeof storagePut} [params.put]
     */
    constructor({ data, scene, revision = 0, put = storagePut }) {
        this.data = data;
        this.scene = scene;
        this.environmentId = data.environment().environmentId;
        this.resourcePath = `environments/${encodeURIComponent(this.environmentId)}`;
        this._put = put;
        data.environment().persistence = this;

        this._attached = false;
        this._unsubscribers = [];
        this._saveTimer = null;
        this._firstPendingAt = 0;
        this._inFlight = null;
        this._queued = false;
        this._queuedKeepalive = false;
        this._discarded = false;
        this._suspended = false;
        this._generation = 0;
        this._editGeneration = 0;
        this._acknowledgedEditGeneration = 0;
        this._acknowledgedRevision = Math.max(0, Number(revision) || 0);
        this._dirty = false;
        this._conflict = null;
        this._sending = false;
        this._saveThrowOnError = false;
        this._chain = Promise.resolve();

        this._flushForUnload = () => this.flush({ keepalive: true });
        this._flushOnHide = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                this.flush({ keepalive: true });
            }
        };
    }

    get acknowledgedRevision() {
        return this._acknowledgedRevision;
    }

    get conflict() {
        return this._conflict;
    }

    get isDirty() {
        return this._dirty;
    }

    attach() {
        this._discarded = false;
        this._suspended = false;
        const environment = this.data.environment();
        const onChange = () => this._handleChange();

        // ED-02: transient gesture frames and gesture cancels never reach the
        // save queue; only committed document changes do. Editor state marks
        // dirty only when its persisted subset changes (never on selection).
        let lastEditorKey;
        this._unsubscribers = [
            environment.getDocument().subscribe((snapshot, event) => {
                if (event?.transient === true || event?.source === "cancel") return;
                onChange();
            }),
            environment.objects().subscribe(onChange),
            environment.editor().subscribe((snapshot) => {
                const editor = environment.editor();
                const persisted = typeof editor?.persistedSnapshot === "function"
                    ? editor.persistedSnapshot()
                    : persistedEditorStateFromSnapshot(snapshot);
                const key = JSON.stringify(persisted);
                if (lastEditorKey !== undefined && key === lastEditorKey) return;
                lastEditorKey = key;
                onChange();
            }),
            environment.sky().subscribe(onChange),
        ];

        if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", this._flushForUnload);
            window.addEventListener("visibilitychange", this._flushOnHide);
        }

        this._attached = true;
    }

    async dispose({ flush = true } = {}) {
        this._attached = false;
        this._clearTimer();

        this._unsubscribers.forEach((unsubscribe) => unsubscribe?.());
        this._unsubscribers = [];

        if (typeof window !== "undefined") {
            window.removeEventListener("beforeunload", this._flushForUnload);
            window.removeEventListener("visibilitychange", this._flushOnHide);
        }

        if (this.data.environment().persistence === this) {
            this.data.environment().persistence = null;
        }
        if (flush && !this._discarded) await this.flush();
    }

    async discard() {
        this._discarded = true;
        this._queued = false;
        this._generation += 1;
        await this.dispose({ flush: false });
        try {
            await this._chain;
        } catch {
            // The normal save path already reports the error.
        }
    }

    /**
     * Temporarily stop autosaving so an external (MCP) apply does not get
     * overwritten by a stale local debounce. Pair with resumeAutosave().
     */
    async suspendAutosave() {
        this._attached = false;
        this._suspended = true;
        this._clearTimer();
        this._firstPendingAt = 0;
        this._queued = false;
        this._generation += 1;
        try {
            await this._chain;
        } catch {
            // Settled; conflict state is recorded by the save path.
        }
    }

    /** Resume watching for local edits after an external apply. */
    resumeAutosave() {
        if (this._discarded) return;
        this._suspended = false;
        this._attached = true;
        if (this._dirty && !this._conflict) this._saveNow();
    }

    /**
     * Adopt visual references and the committed revision after VIS-08 promotion.
     * Local metric dirtiness stays visible; this never overwrites a conflicted draft.
     */
    adoptPromotedVisualLayer(receipt) {
        const next = Number(receipt?.revision);
        if (!Number.isInteger(next) || next < this._acknowledgedRevision) return;
        if (receipt?.environmentId && receipt.environmentId !== this.environmentId) return;
        const environment = this.data.environment();
        if (!environment || environment.environmentId !== this.environmentId) return;
        this._acknowledgedRevision = next;
        environment.revision = next;
        if (Object.hasOwn(receipt ?? {}, "visualLayer")) {
            environment.visualLayer = receipt.visualLayer;
        } else if (Object.hasOwn(receipt?.manifest ?? {}, "visualLayer")) {
            environment.visualLayer = receipt.manifest.visualLayer;
        }
        if (Object.hasOwn(receipt?.manifest ?? {}, "evidence")) {
            environment.evidence = receipt.manifest.evidence;
        }
    }

    /**
     * Adopt a server revision after a successful response or a clean remote apply.
     * Never advances over a dirty/in-flight local draft.
     */
    adoptRevision(revision, { force = false } = {}) {
        const next = Number(revision);
        if (!Number.isInteger(next) || next < this._acknowledgedRevision) return;
        if (!force && (this._dirty || this._sending || this._conflict)) return;
        const environment = this.data.environment();
        if (!environment || environment.environmentId !== this.environmentId) return;
        this._acknowledgedRevision = next;
        environment.revision = next;
        if (force) {
            this._dirty = false;
            this._acknowledgedEditGeneration = this._editGeneration;
            this._conflict = null;
        }
    }

    /**
     * Decide whether an external document can replace the local draft.
     * Dirty or in-flight work is retained and exposed as a conflict.
     */
    async prepareExternalApply(remoteManifest) {
        await this.suspendAutosave();
        if (this._dirty || this._conflict) {
            this._conflict = {
                code: "ENVIRONMENT_REVISION_CONFLICT",
                currentRevision: this._acknowledgedRevision,
                remoteRevision: remoteManifest?.revision ?? null,
            };
            return { apply: false, conflict: this._conflict };
        }
        return { apply: true };
    }

    // --- Saving -------------------------------------------------------------

    _handleChange() {
        if (!this._attached) return;

        this._editGeneration += 1;
        this._dirty = true;
        const now = Date.now();
        if (!this._firstPendingAt) this._firstPendingAt = now;

        this._clearTimer();

        if (now - this._firstPendingAt >= MAX_WAIT_MS) {
            this._saveNow();
        } else if (typeof window !== "undefined") {
            this._saveTimer = window.setTimeout(() => this._saveNow(), DEBOUNCE_MS);
        }
    }

    _saveNow() {
        this._clearTimer();
        this._firstPendingAt = 0;
        this._save().catch(() => {
            // Strict flush callers observe the shared rejection. Autosave has
            // no awaiting caller and conflict/error state remains recorded.
        });
    }

    async _save({ keepalive = false, throwOnError = false } = {}) {
        if (this._discarded) return null;
        if (this._suspended) return this._chain;
        if (keepalive) this._queuedKeepalive = true;
        if (this._sending) {
            if (this._dirty) this._queued = true;
            if (throwOnError) this._saveThrowOnError = true;
            return this._chain;
        }

        const generation = this._generation;
        this._sending = true;
        this._saveThrowOnError = throwOnError;
        this._chain = (async () => {
            let last = null;
            try {
                do {
                    this._queued = false;
                    const useKeepalive = this._queuedKeepalive;
                    this._queuedKeepalive = false;
                    last = await this._sendLatest({ keepalive: useKeepalive, generation });
                } while (this._queued && !this._discarded && !this._conflict && generation === this._generation);
                return last;
            } catch (error) {
                if (!this._saveThrowOnError) console.warn("[environment] autosave failed:", error);
                if (this._saveThrowOnError) throw error;
                return null;
            } finally {
                this._sending = false;
                this._saveThrowOnError = false;
            }
        })();
        return this._chain;
    }

    async _sendLatest({ keepalive = false, generation }) {
        const expectedRevision = this._acknowledgedRevision;
        const editGeneration = this._editGeneration;
        const manifest = this.data.environment().toManifest();
        try {
            const stored = await this._put(
                this.resourcePath,
                { manifest, expectedRevision, detachStaleVisual: true },
                { keepalive },
            );
            if (this._discarded) return stored;
            if (stored?.environmentId && stored.environmentId !== this.environmentId) return stored;
            const storedRevision = Number(stored?.revision) || expectedRevision + 1;
            if (storedRevision < this._acknowledgedRevision) return stored;
            const environment = this.data.environment();
            if (!environment || environment.environmentId !== this.environmentId) return stored;
            this._acknowledgedRevision = storedRevision;
            environment.revision = storedRevision;
            if (Object.hasOwn(stored ?? {}, "visualLayer")) environment.visualLayer = stored.visualLayer;
            if (Object.hasOwn(stored ?? {}, "evidence")) environment.evidence = stored.evidence;
            this._acknowledgedEditGeneration = Math.max(this._acknowledgedEditGeneration, editGeneration);
            if (generation !== this._generation || this._editGeneration > editGeneration) {
                this._dirty = true;
                return stored;
            }
            this._dirty = this._queued;
            this._conflict = null;
            return stored;
        } catch (error) {
            if (isRevisionConflict(error)) {
                this._conflict = {
                    code: error.code || "ENVIRONMENT_REVISION_CONFLICT",
                    currentRevision: error.currentRevision ?? this._acknowledgedRevision,
                };
            }
            throw error;
        }
    }

    /**
     * Fire a save immediately (used on page unload). `keepalive` lets the
     * request outlive the page. Hide/unload traffic joins the same queue.
     */
    flush({ keepalive = false, throwOnError = false } = {}) {
        if (this._discarded) return Promise.resolve();
        if (this._suspended) {
            if (throwOnError && this._sending) this._saveThrowOnError = true;
            return this._chain;
        }
        if (!this._dirty && !this._sending && !this._queued) return Promise.resolve();
        this._clearTimer();
        this._firstPendingAt = 0;
        return this._save({ keepalive, throwOnError }).catch((error) => {
            console.warn("[environment] flush failed:", error);
            if (throwOnError) throw error;
        });
    }

    _clearTimer() {
        if (this._saveTimer && typeof window !== "undefined") {
            window.clearTimeout(this._saveTimer);
        }
        this._saveTimer = null;
    }
}

function persistedEditorStateFromSnapshot(snapshot) {
    if (!snapshot) return null;
    const map = snapshot.map ?? {};
    return {
        layers: snapshot.layers ?? null,
        hiddenEntityIds: [...(snapshot.hiddenEntityIds ?? [])].sort(),
        editorMode: snapshot.editorMode ?? null,
        map: {
            centerX: map.centerX,
            centerZ: map.centerZ,
            zoom: map.zoom,
            snapEnabled: map.snapEnabled,
            snapSize: map.snapSize,
            gridVisible: map.gridVisible,
        },
        earthImport: snapshot.earthImport ?? null,
    };
}

function isRevisionConflict(error) {
    return error?.status === 409
        || error?.statusCode === 409
        || error?.code === "ENVIRONMENT_REVISION_CONFLICT";
}
