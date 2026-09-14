import { AssetDocument, createAssetDocumentAdapter } from "../../../editor-assets/AssetDocument.js";
import { compileAssetDefinition, generateVoxelProxy } from "../../../editor-assets/AssetCompiler.js";
import { canonicalExactStringify } from "../../../simulation/visual/VisualLayer.js";
import { CommandBus } from "../commands/CommandBus.js";
import { assetStudioCommands } from "../commands/assetStudioCommands.js";
import { SelectionStore } from "../selection/SelectionStore.js";

export class AssetStudioSession {
    constructor({ assetId, revision, modelUseHash = null, definition, sourceGeometries = {}, resolvedChildren = {}, publish = null, publishAs = null } = {}) {
        this.assetId = String(assetId);
        this.publishedRevision = Number(revision);
        this.modelUseHash = modelUseHash;
        this.document = new AssetDocument(definition);
        this.selection = new SelectionStore();
        this.bus = new CommandBus({ document: this.document, selection: this.selection, documentAdapter: createAssetDocumentAdapter() });
        this.sourceGeometries = sourceGeometries;
        this.resolvedChildren = resolvedChildren;
        this.publishRevision = publish;
        this.publishNewAsset = publishAs;
        this.runtimeDependencyVersion = 0;
        this.compileCache = { key: null, value: null };
        this.snapshotKeyCache = { version: null, value: null };
        this.baseline = this.snapshotKey();
        this.saving = false;
        this.error = null;
        this.generation = 0;
        this.view = {
            showCollision: true, showLidar: true, includedPartIds: [],
            camera: null, expandedPartIds: [],
        };
        this.subscribers = new Set();
        this.notifyQueued = false;
        this.disposed = false;
        this.unsubscribeDocument = this.document.subscribe(() => {
            if (this.notifyQueued) return;
            this.notifyQueued = true;
            queueMicrotask(() => {
                this.notifyQueued = false;
                if (!this.disposed) this.notify();
            });
        });
    }

    snapshotKey() {
        if (this.snapshotKeyCache.version === this.document.version) return this.snapshotKeyCache.value;
        const value = canonicalExactStringify(this.document.snapshot());
        this.snapshotKeyCache = { version: this.document.version, value };
        return value;
    }
    invalidateCompile() { this.compileCache = { key: null, value: null }; }
    invalidateCaches() {
        this.invalidateCompile();
        this.snapshotKeyCache = { version: null, value: null };
    }
    get dirty() { return this.snapshotKey() !== this.baseline; }
    snapshot() {
        return { assetId: this.assetId, revision: this.publishedRevision, dirty: this.dirty, saving: this.saving, error: this.error, documentVersion: this.document.version, canUndo: this.bus.canUndo, canRedo: this.bus.canRedo, view: structuredClone(this.view) };
    }
    subscribe(callback) { this.subscribers.add(callback); callback(this.snapshot()); return () => this.subscribers.delete(callback); }
    notify() { const value = this.snapshot(); this.subscribers.forEach((callback) => callback(value)); }
    compile() {
        const key = `${this.document.version}:${this.runtimeDependencyVersion}`;
        if (this.compileCache.key === key) return this.compileCache.value;
        const value = compileAssetDefinition(this.document.snapshot(), { sourceGeometries: this.sourceGeometries, resolvedChildren: this.resolvedChildren });
        this.compileCache = { key, value };
        return value;
    }
    setView(patch = {}) {
        const next = { ...this.view, ...structuredClone(patch) };
        if (canonicalExactStringify(next) === canonicalExactStringify(this.view)) return this.snapshot();
        this.view = next;
        this.notify();
        return this.snapshot();
    }
    setResolvedChild(referenceKey, record) {
        this.resolvedChildren = { ...this.resolvedChildren, [String(referenceKey)]: record };
        this.runtimeDependencyVersion += 1;
        this.invalidateCompile();
        this.notify();
        return this.snapshot();
    }
    removeResolvedChild(referenceKey) {
        const next = { ...this.resolvedChildren };
        delete next[String(referenceKey)];
        this.resolvedChildren = next;
        this.runtimeDependencyVersion += 1;
        this.invalidateCompile();
        this.notify();
        return this.snapshot();
    }
    updateRuntime({ modelUseHash, sourceGeometries, resolvedChildren, publish, publishAs } = {}) {
        if (modelUseHash) this.modelUseHash = modelUseHash;
        if (sourceGeometries) this.sourceGeometries = sourceGeometries;
        if (resolvedChildren) this.resolvedChildren = resolvedChildren;
        if (typeof publish === "function") this.publishRevision = publish;
        if (typeof publishAs === "function") this.publishNewAsset = publishAs;
        this.runtimeDependencyVersion += 1;
        this.invalidateCaches();
    }

    async generateProxy(options) {
        const token = ++this.generation;
        const expectedDocumentVersion = this.document.version;
        const proxy = await Promise.resolve().then(() => generateVoxelProxy(this.document.snapshot(), { ...options, sourceGeometries: this.sourceGeometries, resolvedChildren: this.resolvedChildren }));
        if (token !== this.generation) return { ok: false, stale: true };
        return this.bus.execute(assetStudioCommands.replaceGeneratedProxy({
            channel: options.channel,
            proxy,
            expectedDocumentVersion,
            expectedInputGeometryHash: proxy.generated.inputGeometryHash,
        }));
    }

    async save(input = {}) {
        if (typeof this.publishRevision !== "function") throw new Error("Asset studio session has no publication transport.");
        const captured = this.document.snapshot();
        const capturedKey = this.snapshotKey();
        let compiled;
        try {
            compiled = this.compile();
            if (compiled.staleProxyIds.length) {
                throw Object.assign(new Error(`Regenerate or disable stale proxies: ${compiled.staleProxyIds.join(", ")}.`), { code: "ASSET_PROXY_STALE", staleProxyIds: compiled.staleProxyIds });
            }
        } catch (error) {
            this.error = error;
            this.notify();
            throw error;
        }
        this.saving = true; this.error = null; this.notify();
        try {
            const result = await this.publishRevision({
                ...input, assetId: this.assetId, expectedAssetRevision: this.publishedRevision,
                modelUseHash: input.modelUseHash ?? this.modelUseHash,
                definition: captured, metric: compiled.metric, metricHash: compiled.metricHash,
                appearance: compiled.materials,
                geometryFingerprints: Object.fromEntries(compiled.geometryFingerprints),
            });
            this.publishedRevision = result.revision?.revision ?? result.asset?.latestRevision ?? this.publishedRevision;
            this.modelUseHash = result.revision?.modelUseHash ?? this.modelUseHash;
            this.baseline = capturedKey;
            if (this.snapshotKey() === capturedKey) this.bus.reset();
            return result;
        } catch (error) { this.error = error; throw error; }
        finally { this.saving = false; this.notify(); }
    }

    async saveAs({ assetId, name, publicationId } = {}) {
        if (typeof this.publishNewAsset !== "function") throw new Error("Asset studio session has no Save As transport.");
        const captured = this.document.snapshot();
        const compiled = this.compile();
        if (compiled.staleProxyIds.length) throw new Error(`Regenerate or disable stale proxies: ${compiled.staleProxyIds.join(", ")}.`);
        return this.publishNewAsset({
            assetId, name, publicationId, expectedAssetRevision: 0,
            modelUseHash: this.modelUseHash, definition: captured,
            metric: compiled.metric, metricHash: compiled.metricHash, appearance: compiled.materials,
        });
    }

    discard(definition, revision = this.publishedRevision) {
        this.generation += 1;
        this.document.restoreSnapshot(definition, { notify: true });
        this.publishedRevision = revision;
        this.invalidateCaches();
        this.baseline = this.snapshotKey();
        this.bus.reset(); this.error = null; this.notify();
    }
    reload({ definition, revision, modelUseHash, sourceGeometries, resolvedChildren }) {
        this.sourceGeometries = sourceGeometries;
        this.resolvedChildren = resolvedChildren;
        this.modelUseHash = modelUseHash;
        this.runtimeDependencyVersion += 1;
        this.invalidateCaches();
        this.discard(definition, revision);
    }
    dispose() { this.disposed = true; this.generation += 1; this.unsubscribeDocument?.(); this.subscribers.clear(); }
}

export class AssetStudioSessionRegistry {
    constructor() { this.sessions = new Map(); this.subscribers = new Set(); }
    get(tabId) { return this.sessions.get(String(tabId)) ?? null; }
    subscribe(callback) { this.subscribers.add(callback); callback(this.sessions); return () => this.subscribers.delete(callback); }
    notify() { this.subscribers.forEach((callback) => callback(this.sessions)); }
    open(tabId, options) { const id = String(tabId); let session = this.sessions.get(id); if (!session) { session = new AssetStudioSession(options); this.sessions.set(id, session); this.notify(); } else session.updateRuntime(options); return session; }
    close(tabId, { discard = false } = {}) { const session = this.get(tabId); if (!session || (session.dirty && !discard)) return false; session.dispose(); this.sessions.delete(String(tabId)); this.notify(); return true; }
    dispose() { for (const session of this.sessions.values()) session.dispose(); this.sessions.clear(); this.notify(); this.subscribers.clear(); }
}
