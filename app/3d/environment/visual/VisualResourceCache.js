import {
    VISUAL_PREVIEW_ERROR_CODES,
    VisualPreviewError,
} from "../../../simulation/visual/VisualLayer.js";
import { getVisualScaleProfile } from "../../../simulation/visual/VisualScaleProfile.js";
import { VisualMemoryLedger, VISUAL_MEMORY_KINDS, VisualBudgetError } from "./VisualMemoryLedger.js";
import { VisualWorkQueue } from "./VisualWorkQueue.js";

const cachesByRenderer = new WeakMap();

export function visualResourceCacheForRenderer(renderer, options = {}) {
    if (!renderer) return new VisualResourceCache(options);
    const existing = cachesByRenderer.get(renderer);
    if (existing && !existing.dead) return existing;
    const created = new VisualResourceCache({ ...options, renderer });
    cachesByRenderer.set(renderer, created);
    return created;
}

export function disposeRendererVisualResourceCache(renderer) {
    const existing = renderer ? cachesByRenderer.get(renderer) : null;
    if (!existing) return;
    existing.dispose();
    cachesByRenderer.delete(renderer);
}

export class VisualResourceCache {
    constructor({
        renderer = null,
        profile = getVisualScaleProfile(),
        ledger = null,
        queue = null,
        rightsChecker = null,
        decoderProfile = "gltf-static-surface@1",
        rendererProfile = null,
        now = () => Date.now(),
    } = {}) {
        this.renderer = renderer;
        this.profile = profile;
        this.decoderProfile = decoderProfile;
        this.rendererProfile = rendererProfile ?? inferRendererProfile(renderer);
        this.ledger = ledger ?? new VisualMemoryLedger({ profile });
        this.queue = queue ?? new VisualWorkQueue({
            maxConcurrentFetches: profile.ceilings.maxConcurrentFetches,
            maxConcurrentDecodes: profile.ceilings.maxConcurrentDecodes,
        });
        this.rightsChecker = rightsChecker;
        this.now = now;
        this.dead = false;
        this._entries = new Map();
        this._inflight = new Map();
        this._attachments = new Set();
        this._disposals = 0;
        this._evictions = 0;
        this._generation = 0;
        this._contextLostHandler = null;
        this._bindRenderer(renderer);
    }

    snapshot() {
        const entries = [...this._entries.values()].map((entry) => ({
            key: entry.key,
            kind: entry.kind,
            digest: entry.digest,
            refs: entry.refs,
            bytes: entry.bytes,
        }));
        return {
            dead: this.dead,
            generation: this._generation,
            entryCount: this._entries.size,
            liveLeases: entries.reduce((sum, entry) => sum + entry.refs, 0),
            inflight: this._inflight.size,
            disposals: this._disposals,
            evictions: this._evictions,
            memory: this.ledger.snapshot(),
            queue: this.queue.snapshot(),
            entries,
        };
    }

    attach(owner) {
        this._assertLive();
        if (owner) this._attachments.add(owner);
        return () => this.detach(owner);
    }

    detach(owner) {
        if (owner) this._attachments.delete(owner);
    }

    async revalidateSourceRights(useHashes, {
        operations = ["display"],
        rightsChecker = this.rightsChecker,
    } = {}) {
        this._assertLive();
        const unique = [...new Set((useHashes ?? []).filter(Boolean))];
        if (!rightsChecker || unique.length === 0) return;
        const denied = [];
        for (const useHash of unique) {
            try {
                await rightsChecker({ useHash, operations: [...operations] });
                for (const entry of this._entries.values()) {
                    if (entry.useHash === useHash) entry.rightsEpoch = this._generation;
                }
            } catch (error) {
                denied.push(error);
                for (const entry of [...this._entries.values()]) {
                    if (entry.useHash !== useHash) continue;
                    if (entry.refs > 0) throw error;
                    this._disposeEntry(entry, { eviction: true });
                }
            }
        }
        if (denied.length > 0) throw denied[0];
    }

    async acquireEncoded({
        digest,
        useHash,
        bytes,
        mediaType,
        sizeBytes,
        loader,
        signal,
        operations = ["display"],
        rightsChecker = this.rightsChecker,
    } = {}) {
        const payloadBytes = sizeBytes ?? (bytes?.byteLength ?? 0);
        return this._acquire({
            key: encodedKey(digest),
            kind: "encoded",
            digest,
            useHash,
            mediaType,
            bytes: payloadBytes,
            memoryKind: VISUAL_MEMORY_KINDS.encodedCpu,
            queueKind: "fetch",
            signal,
            operations,
            rightsChecker,
            loader: async () => {
                const value = bytes ?? await loader();
                return { value, bytes: value?.byteLength ?? payloadBytes };
            },
        });
    }

    async acquireParsed({
        digest,
        decoderProfile = this.decoderProfile,
        useHash,
        bytes,
        loader,
        signal,
        operations = ["display"],
        rightsChecker = this.rightsChecker,
    } = {}) {
        return this._acquire({
            key: parsedKey(digest, decoderProfile),
            kind: "parsed",
            digest,
            useHash,
            bytes,
            memoryKind: VISUAL_MEMORY_KINDS.decodedCpu,
            queueKind: "decode",
            signal,
            operations,
            rightsChecker,
            loader,
        });
    }

    async acquireTexture({
        digest,
        rendererProfile = this.rendererProfile,
        useHash,
        bytes,
        loader,
        signal,
        gpuBytes = 0,
        operations = ["display"],
        rightsChecker = this.rightsChecker,
    } = {}) {
        const handle = await this._acquire({
            key: textureKey(digest, rendererProfile),
            kind: "texture",
            digest,
            useHash,
            bytes,
            memoryKind: VISUAL_MEMORY_KINDS.decodedCpu,
            queueKind: "decode",
            signal,
            operations,
            rightsChecker,
            loader,
        });
        if (gpuBytes > 0 && handle.entry && handle.entry.gpuReservationId == null) {
            try {
                handle.entry.gpuReservationId = this._reserveWithEviction(VISUAL_MEMORY_KINDS.gpu, gpuBytes);
                handle.entry.gpuBytes = gpuBytes;
            } catch (error) {
                handle.release();
                throw error;
            }
        }
        return handle;
    }

    reserveTransient(bytes, label = "transient") {
        this._assertLive();
        return this._reserveWithEviction(VISUAL_MEMORY_KINDS.transient, bytes, label);
    }

    releaseReservation(id) {
        return this.ledger.release(id);
    }

    handleContextLost(reason = "The WebGL renderer context was lost.") {
        this.dead = true;
        this._generation += 1;
        this.queue.rejectAll(reason);
        this._inflight.clear();
        this._disposeEntries();
        this.ledger.releaseAll();
        this._unbindRenderer();
        if (this.renderer && cachesByRenderer.get(this.renderer) === this) {
            cachesByRenderer.delete(this.renderer);
        }
    }

    recreate(options = {}) {
        this.handleContextLost(options.reason ?? "Visual resource cache was recreated.");
        const next = new VisualResourceCache({
            renderer: this.renderer,
            profile: this.profile,
            rightsChecker: this.rightsChecker,
            decoderProfile: this.decoderProfile,
            rendererProfile: this.rendererProfile,
            now: this.now,
            ...options,
        });
        if (this.renderer) cachesByRenderer.set(this.renderer, next);
        return next;
    }

    dispose() {
        this.handleContextLost("Visual resource cache was disposed.");
        this._attachments.clear();
    }

    _bindRenderer(renderer) {
        const element = renderer?.domElement;
        if (!element?.addEventListener) return;
        this._contextLostHandler = (event) => {
            event.preventDefault?.();
            this.handleContextLost();
        };
        element.addEventListener("webglcontextlost", this._contextLostHandler, false);
    }

    _unbindRenderer() {
        const element = this.renderer?.domElement;
        if (element?.removeEventListener && this._contextLostHandler) {
            element.removeEventListener("webglcontextlost", this._contextLostHandler, false);
        }
        this._contextLostHandler = null;
    }

    async _acquire({
        key,
        kind,
        digest,
        useHash,
        bytes,
        memoryKind,
        queueKind,
        loader,
        signal,
        operations,
        rightsChecker,
    }) {
        this._assertLive();
        this._throwIfAborted(signal);
        const existing = this._entries.get(key);
        if (existing) {
            await this._assertReusable(existing, { useHash, operations, rightsChecker });
            existing.refs += 1;
            existing.lastUsed = this.now();
            return this._handle(existing);
        }
        if (this._inflight.has(key)) {
            const shared = this._inflight.get(key);
            const entry = await shared;
            this._assertLive();
            this._throwIfAborted(signal);
            await this._assertReusable(entry, { useHash, operations, rightsChecker });
            entry.refs += 1;
            entry.lastUsed = this.now();
            return this._handle(entry);
        }

        const pending = (async () => {
            await this._authorize(useHash, operations, rightsChecker);
            return this._loadEntry({
                key,
                kind,
                digest,
                useHash,
                bytes,
                memoryKind,
                queueKind,
                loader,
                signal,
            });
        })();
        this._inflight.set(key, pending);
        try {
            const entry = await pending;
            entry.refs += 1;
            return this._handle(entry);
        } finally {
            this._inflight.delete(key);
        }
    }

    async _loadEntry({ key, kind, digest, useHash, bytes, memoryKind, queueKind, loader, signal }) {
        const estimated = Number(bytes) || 0;
        const reservationId = this._reserveWithEviction(memoryKind, estimated, kind);
        const run = queueKind === "decode"
            ? (work) => this.queue.runDecode(work)
            : (work) => this.queue.runFetch(work);
        try {
            this._throwIfAborted(signal);
            const loaded = await run(async () => {
                this._assertLive();
                this._throwIfAborted(signal);
                const result = await loader();
                this._throwIfAborted(signal);
                if (result && typeof result === "object" && "value" in result) return result;
                return { value: result, bytes: estimated };
            });
            const actualBytes = Number(loaded.bytes) || estimated;
            if (actualBytes !== estimated) {
                this.ledger.release(reservationId);
                const adjusted = this._reserveWithEviction(memoryKind, actualBytes, kind);
                const entry = this._storeEntry({
                    key,
                    kind,
                    digest,
                    useHash,
                    value: loaded.value,
                    bytes: actualBytes,
                    memoryKind,
                    reservationId: adjusted,
                    dispose: loaded.dispose,
                });
                return entry;
            }
            return this._storeEntry({
                key,
                kind,
                digest,
                useHash,
                value: loaded.value,
                bytes: actualBytes,
                memoryKind,
                reservationId,
                dispose: loaded.dispose,
            });
        } catch (error) {
            this.ledger.release(reservationId);
            if (error instanceof VisualPreviewError) throw error;
            throw new VisualPreviewError(
                error?.code && Object.values(VISUAL_PREVIEW_ERROR_CODES).includes(error.code)
                    ? error.code
                    : VISUAL_PREVIEW_ERROR_CODES.DECODER_FAILED,
                error?.message || "Visual resource load failed.",
            );
        }
    }

    _storeEntry(fields) {
        const entry = {
            ...fields,
            refs: 0,
            lastUsed: this.now(),
            gpuReservationId: null,
            gpuBytes: 0,
            rightsEpoch: this._generation,
            disposed: false,
        };
        this._entries.set(entry.key, entry);
        return entry;
    }

    _handle(entry) {
        let released = false;
        return {
            key: entry.key,
            kind: entry.kind,
            digest: entry.digest,
            value: entry.value,
            entry,
            release: () => {
                if (released) return;
                released = true;
                this._releaseEntry(entry);
            },
        };
    }

    _releaseEntry(entry) {
        if (entry.disposed) return;
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsed = this.now();
    }

    async _assertReusable(entry, {
        useHash = entry.useHash,
        operations = ["display"],
        rightsChecker = this.rightsChecker,
    } = {}) {
        if (entry.disposed) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
                `Visual cache entry ${entry.key} was disposed.`,
            );
        }
        // Cache identity is byte-based, not authorization-based. Every lease
        // rechecks the requesting source use and operation set, even when the
        // same bytes were already decoded for preview.
        if (rightsChecker && useHash) {
            await rightsChecker({ useHash, operations: [...operations] });
            entry.rightsEpoch = this._generation;
        }
    }

    async _authorize(useHash, operations, rightsChecker) {
        if (!rightsChecker || !useHash) return;
        await rightsChecker({ useHash, operations: [...operations] });
    }

    _reserveWithEviction(kind, bytes, label = kind) {
        if (bytes === 0) return this.ledger.reserve(kind, 0, { label });
        if (this.ledger.canReserve(kind, bytes)) {
            return this.ledger.reserve(kind, bytes, { label });
        }
        this.evictUntil(kind, bytes);
        return this.ledger.reserve(kind, bytes, { label });
    }

    evictUntil(kind, bytes) {
        const zeroRef = [...this._entries.values()]
            .filter((entry) => entry.refs === 0 && !entry.disposed)
            .sort((left, right) => left.lastUsed - right.lastUsed || left.key.localeCompare(right.key));
        for (const entry of zeroRef) {
            if (this.ledger.canReserve(kind, bytes)) break;
            this._disposeEntry(entry, { eviction: true });
        }
        if (!this.ledger.canReserve(kind, bytes)) {
            throw new VisualBudgetError(
                `Unable to reserve ${bytes} ${kind} bytes after evicting unused visual cache entries.`,
                {
                    kind,
                    requestedBytes: bytes,
                    usedBytes: this.ledger.used[kind],
                    ceilingBytes: this.ledger.ceilings[kind],
                },
            );
        }
    }

    _disposeEntry(entry, { eviction = false } = {}) {
        if (entry.disposed) return;
        if (entry.refs > 0) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED,
                `Cannot dispose visual cache entry ${entry.key} while ${entry.refs} leases are live.`,
            );
        }
        entry.disposed = true;
        this._entries.delete(entry.key);
        this.ledger.release(entry.reservationId);
        this.ledger.release(entry.gpuReservationId);
        try {
            entry.dispose?.(entry.value);
        } catch {
            // disposal of GPU/CPU resources is best-effort and counted below
        }
        disposeCachedValue(entry);
        this._disposals += 1;
        if (eviction) this._evictions += 1;
    }

    _disposeEntries() {
        for (const entry of [...this._entries.values()]) {
            entry.refs = 0;
            this._disposeEntry(entry);
        }
    }

    _assertLive() {
        if (this.dead) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.CONTEXT_LOST,
                "Visual resource cache is unavailable after renderer or context death.",
            );
        }
    }

    _throwIfAborted(signal) {
        if (signal?.aborted) {
            throw new VisualPreviewError(
                VISUAL_PREVIEW_ERROR_CODES.SUPERSEDED,
                "Visual resource load was cancelled.",
            );
        }
    }
}

function encodedKey(digest) {
    return `encoded:${digest}`;
}

function parsedKey(digest, decoderProfile) {
    return `parsed:${digest}:${decoderProfile}`;
}

function textureKey(digest, rendererProfile) {
    return `texture:${digest}:${rendererProfile}`;
}

function inferRendererProfile(renderer) {
    if (!renderer) return "cpu";
    const gl = renderer.getContext?.();
    const debug = gl?.getExtension?.("WEBGL_debug_renderer_info");
    const vendor = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : renderer.constructor?.name;
    return `webgl2:${vendor || "unknown"}`;
}

function disposeCachedValue(entry) {
    const value = entry.value;
    if (!value) return;
    if (typeof value.dispose === "function") {
        value.dispose();
        return;
    }
    if (value.scene) {
        value.scene.traverse?.((object) => {
            object.geometry?.dispose?.();
        });
    }
    if (value.isTexture) value.dispose?.();
}
