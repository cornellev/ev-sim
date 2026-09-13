export class AssetPlacementController {
    constructor({ data, scene } = {}) {
        this.data = data;
        this.scene = scene;
        this.editor = data?.editor?.();
        this.environment = data?.environment?.();
        this.bus = data?.commands?.() ?? this.environment?.commands?.();
        this.selection = data?.selection?.() ?? this.environment?.selection?.();
        this.generation = 0;
        this.payload = null;
        this.lease = null;
        this.ghost = null;
        this.error = null;
        this.disposeEditor = this.editor?.subscribe?.((snapshot) => this._syncPlacement(snapshot.activePlacement));
    }

    _syncPlacement(payload) {
        const nextKey = payload?.kind === "catalog" ? `${payload.assetId}@${payload.revision}` : null;
        const currentKey = this.payload ? `${this.payload.assetId}@${this.payload.revision}` : null;
        if (!nextKey) {
            this.cancel();
            return;
        }
        if (nextKey !== currentKey) void this.begin(payload);
    }

    async begin(payload) {
        this.cancel();
        if (payload?.kind !== "catalog" || !Number.isInteger(payload.revision) || payload.revision <= 0) return null;
        const generation = ++this.generation;
        this.payload = { ...payload };
        this.error = null;
        const assets = this.environment?.assets?.();
        try {
            const revision = await assets.repository.getRevision(payload.assetId, payload.revision);
            const lease = await assets.models.acquire(revision.modelUseHash);
            if (generation !== this.generation || !this.payload) {
                lease.release();
                return null;
            }
            this.lease = lease;
            this.ghost = lease.root;
            this.ghost.name = "EditorAssetPlacementGhost";
            this.ghost.traverse?.((object) => { object.userData.skipEnvironmentSelection = true; });
            this.scene?.add?.(this.ghost);
            this.data?.simulation?.()?.render?.();
            return this.payload;
        } catch (error) {
            if (generation === this.generation) this.error = error;
            return null;
        }
    }

    _snap(point, map = false) {
        const snapshot = this.editor?.snapshot?.() ?? {};
        const config = map ? snapshot.map : snapshot.transformSnap;
        const enabled = map ? config?.snapEnabled : config?.enabled;
        const step = map ? config?.snapSize : config?.translation;
        if (!enabled || !Number.isFinite(step) || step <= 0) return { x: point.x, y: point.y ?? 0, z: point.z };
        return {
            x: Math.round(point.x / step) * step,
            y: map ? (point.y ?? 0) : Math.round((point.y ?? 0) / step) * step,
            z: Math.round(point.z / step) * step,
        };
    }

    updatePoint(point, { map = false } = {}) {
        if (!this.payload || !point) return null;
        const snapped = this._snap(point, map);
        if (this.ghost) {
            this.ghost.position.set(snapped.x, snapped.y, snapped.z);
            this.ghost.updateMatrixWorld(true);
            this.data?.simulation?.()?.render?.();
        }
        return snapped;
    }

    async commit(point, { map = false } = {}) {
        if (!this.payload || !point) return { ok: false };
        const payload = { ...this.payload };
        const snapped = this.updatePoint(point, { map });
        const assets = this.environment?.assets?.();
        try {
            const command = await assets.instantiation.place({
                assetId: payload.assetId, revision: payload.revision,
                position: snapped, name: payload.label ?? payload.assetId,
            });
            if (!this.payload || this.payload.assetId !== payload.assetId || this.payload.revision !== payload.revision) return { ok: false };
            const result = this.bus.execute(command);
            if (result.ok) this.selection?.select?.(result.result.objectId);
            return result;
        } catch (error) {
            this.error = error;
            return { ok: false, error: error.message, issues: [] };
        }
    }

    cancel() {
        this.generation += 1;
        this.ghost?.removeFromParent?.();
        this.lease?.release?.();
        this.ghost = null;
        this.lease = null;
        this.payload = null;
        this.data?.simulation?.()?.render?.();
    }

    dispose() {
        this.disposeEditor?.();
        this.disposeEditor = null;
        this.cancel();
    }
}
