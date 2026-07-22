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
 */
export class EnvironmentPersistence {
    /**
     * @param {object} params
     * @param {import("../data/Data").Data} params.data
     * @param {THREE.Scene} params.scene
     */
    constructor({ data, scene, clientRevision = 0 }) {
        this.data = data;
        this.scene = scene;
        this.environmentId = data.environment().environmentId;
        this.resourcePath = `environments/${encodeURIComponent(this.environmentId)}`;
        data.environment().persistence = this;

        this._attached = false;
        this._unsubscribers = [];
        this._saveTimer = null;
        this._firstPendingAt = 0;
        this._saving = false;
        this._saveQueued = false;
        this._discarded = false;
        this._currentSave = null;
        this._writeChain = Promise.resolve();
        this._clientRevision = Math.max(Date.now(), Number(clientRevision) || 0);

        // Bound so we can add/remove them as event listeners.
        this._flushForUnload = () => this.flush({ keepalive: true });
        this._flushOnHide = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                this.flush({ keepalive: true });
            }
        };
    }

    /**
     * Start watching for edits. The subscribe() calls below fire once
     * immediately with the current state; those initial callbacks are ignored
     * because `_attached` is still false until this method finishes.
     */
    attach() {
        this._discarded = false;
        const environment = this.data.environment();
        const onChange = () => this._handleChange();

        this._unsubscribers = [
            environment.getDocument().subscribe(onChange),
            environment.objects().subscribe(onChange),
            environment.editor().subscribe(onChange),
            environment.sky().subscribe(onChange),
        ];

        if (typeof window !== "undefined") {
            window.addEventListener("beforeunload", this._flushForUnload);
            window.addEventListener("visibilitychange", this._flushOnHide);
        }

        this._attached = true;
    }

    /** Cancel pending work, optionally save one last time, and detach listeners. */
    dispose({ flush = true } = {}) {
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
        if (flush && !this._discarded) this.flush();
    }

    /** Detach without recreating a manifest that was intentionally deleted. */
    async discard() {
        this._discarded = true;
        this._saveQueued = false;
        this.dispose({ flush: false });
        try {
            await this._writeChain;
        } catch {
            // The normal save path already reports the error.
        }
    }

    /**
     * Temporarily stop autosaving so an external (MCP) apply does not get
     * overwritten by a stale local debounce. Pair with resumeAutosave().
     */
    suspendAutosave() {
        this._attached = false;
        this._clearTimer();
        this._firstPendingAt = 0;
        this._saveQueued = false;
    }

    /** Resume watching for local edits after an external apply. */
    resumeAutosave() {
        if (this._discarded) return;
        this._attached = true;
    }

    /**
     * Adopt the server's clientRevision after an MCP write so the next local
     * save is ordered after the agent's revision.
     * @param {number} revision
     */
    adoptClientRevision(revision) {
        const next = Number(revision) || 0;
        this._clientRevision = Math.max(this._clientRevision, next);
    }

    // --- Saving -------------------------------------------------------------

    _handleChange() {
        if (!this._attached) return; // Ignore the immediate subscribe() callbacks.

        const now = Date.now();
        if (!this._firstPendingAt) this._firstPendingAt = now;

        this._clearTimer();

        // If edits have been streaming in past the cap, save now; otherwise wait
        // for the edits to settle.
        if (now - this._firstPendingAt >= MAX_WAIT_MS) {
            this._saveNow();
        } else if (typeof window !== "undefined") {
            this._saveTimer = window.setTimeout(() => this._saveNow(), DEBOUNCE_MS);
        }
    }

    _saveNow() {
        this._clearTimer();
        this._firstPendingAt = 0;
        this._save();
    }

    /** Serialize the current manifest and PUT it. Never overlaps two requests. */
    async _save() {
        if (this._saving) {
            this._saveQueued = true; // A change arrived mid-save; save again after.
            return;
        }

        this._saving = true;
        let request = null;
        try {
            request = this._queueWrite();
            this._currentSave = request;
            await request;
        } catch (error) {
            console.warn("[environment] autosave failed:", error);
        } finally {
            this._saving = false;
            if (this._currentSave === request) this._currentSave = null;
            if (this._saveQueued && !this._discarded) {
                this._saveQueued = false;
                this._save();
            }
        }
    }

    /**
     * Fire a save immediately (used on page unload). `keepalive` lets the
     * request outlive the page.
     */
    flush({ keepalive = false, throwOnError = false } = {}) {
        if (this._discarded) return Promise.resolve();
        this._clearTimer();
        this._firstPendingAt = 0;
        this._saveQueued = false;
        if (keepalive) {
            // Start unload traffic immediately; server-side clientRevision
            // ordering prevents an older in-flight save from overwriting it.
            return storagePut(this.resourcePath, this._buildManifest(), { keepalive })
                .catch((error) => {
                    console.warn("[environment] flush failed:", error);
                    if (throwOnError) throw error;
                });
        }
        return this._queueWrite({ keepalive }).catch((error) => {
            console.warn("[environment] flush failed:", error);
            if (throwOnError) throw error;
        });
    }

    _queueWrite({ keepalive = false } = {}) {
        const manifest = this._buildManifest();
        const request = this._writeChain
            .catch(() => {})
            .then(() => {
                if (this._discarded) return null;
                return storagePut(this.resourcePath, manifest, { keepalive });
            });
        this._writeChain = request;
        return request;
    }

    _buildManifest() {
        this._clientRevision = Math.max(Date.now(), this._clientRevision + 1);
        return {
            ...this.data.environment().toManifest(),
            clientRevision: this._clientRevision,
        };
    }

    _clearTimer() {
        if (this._saveTimer && typeof window !== "undefined") {
            window.clearTimeout(this._saveTimer);
        }
        this._saveTimer = null;
    }
}
