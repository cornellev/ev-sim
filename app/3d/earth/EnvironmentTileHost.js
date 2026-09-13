function identityKey(source, geoFrame) {
    if (!source) return null;
    return JSON.stringify({ provider: source.tileProvider, bounds: source.bounds, frame: geoFrame ?? source.anchor ?? null });
}

/** Browser-only owner for the environment's live tile provider session. */
export class EnvironmentTileHost {
    constructor({ createSession, invalidate = () => {} } = {}) {
        if (typeof createSession !== "function") throw new TypeError("EnvironmentTileHost requires createSession(config, context).");
        this.createSession = createSession;
        this.invalidate = invalidate;
        this.active = null;
        this.previews = new Set();
        this.generation = 0;
        this.visible = true;
        this.status = "idle";
        this.error = null;
        this.requested = null;
        this.armedPreview = null;
    }

    get group() { return this.active?.session?.group ?? null; }
    get attributions() { return this.active?.session?.attributions ?? []; }
    get diagnostics() { return this.active?.session?.diagnostics ?? { status: this.status }; }

    async _open(source, geoFrame, context = {}) {
        const session = this.createSession(source, { ...context, geoFrame });
        if (!session || typeof session.load !== "function") throw new TypeError("Tile providers must create a loadable session.");
        try {
            await session.load({
                ...(geoFrame?.origin ?? source.anchor), source, geoFrame, bounds: source.bounds,
                maxScreenSpaceError: source.quality?.maxScreenSpaceError ?? 1, signal: context.signal,
            });
        } catch (error) {
            session.dispose?.();
            throw error;
        }
        session.setVisible?.(this.visible);
        return session;
    }

    async prepare(source, geoFrame, context = {}) {
        const session = await this._open(source, geoFrame, context);
        if (context.signal?.aborted) {
            session.dispose?.();
            throw Object.assign(new Error("Tile preview was cancelled."), { name: "AbortError" });
        }
        this.previews.add(session);
        return session;
    }

    commitPreview(session, source, geoFrame) {
        const key = identityKey(source, geoFrame);
        if (this.active?.session === session && this.active.key === key) return true;
        if (!this.previews.has(session)) return false;
        this.previews.delete(session);
        if (this.active?.session !== session) this.active?.session?.dispose?.();
        const committedSource = structuredClone(source);
        const committedFrame = geoFrame ? structuredClone(geoFrame) : null;
        this.active = { key, source: committedSource, geoFrame: committedFrame, session };
        this.requested = {
            key,
            source: structuredClone(committedSource),
            geoFrame: committedFrame ? structuredClone(committedFrame) : null,
        };
        this.status = session.status ?? "ready";
        this.error = session.error ?? null;
        this.invalidate();
        return true;
    }

    armPreviewCommit(session, source, geoFrame) {
        if (!this.previews.has(session)) return false;
        this.armedPreview = { session, source: structuredClone(source), geoFrame: geoFrame ? structuredClone(geoFrame) : null, key: identityKey(source, geoFrame) };
        return true;
    }

    disarmPreviewCommit(session = null) {
        if (!this.armedPreview || (session && this.armedPreview.session !== session)) return false;
        this.armedPreview = null;
        return true;
    }

    cancelPreview(session) {
        if (!this.previews.delete(session)) return false;
        session.dispose?.();
        this.invalidate();
        return true;
    }

    async reconcile(source, geoFrame) {
        const generation = ++this.generation;
        if (!source) {
            this.active?.session?.dispose?.();
            this.active = null;
            this.status = "idle";
            this.error = null;
            this.requested = null;
            this.invalidate();
            return null;
        }
        const key = identityKey(source, geoFrame);
        if (this.armedPreview?.key === key && this.previews.has(this.armedPreview.session)) {
            const armed = this.armedPreview;
            this.armedPreview = null;
            this.commitPreview(armed.session, source, geoFrame);
            return armed.session;
        }
        this.requested = {
            key,
            source: structuredClone(source),
            geoFrame: geoFrame ? structuredClone(geoFrame) : null,
        };
        if (this.active?.key === key) {
            this.active.source = structuredClone(source);
            this.active.session.setMaxScreenSpaceError?.(source.quality?.maxScreenSpaceError ?? 1);
            this.active.session.setCacheLimits?.(source.quality ?? {});
            this.active.session.setVisible?.(this.visible);
            return this.active.session;
        }
        this.status = "loading";
        this.error = null;
        try {
            const session = await this._open(source, geoFrame, { generation });
            if (generation !== this.generation) { session.dispose?.(); return null; }
            this.active?.session?.dispose?.();
            this.active = { key, source: structuredClone(source), geoFrame: geoFrame ? structuredClone(geoFrame) : null, session };
            this.status = session.status ?? "ready";
            this.invalidate();
            return session;
        } catch (error) {
            if (generation !== this.generation) return null;
            this.status = "error";
            this.error = error instanceof Error ? error.message : String(error);
            this.invalidate();
            throw error;
        }
    }

    retry() {
        if (!this.requested) return null;
        const requested = structuredClone(this.requested);
        if (this.active?.key === requested.key) {
            this.active.session.dispose?.();
            this.active = null;
        }
        return this.reconcile(requested.source, requested.geoFrame);
    }

    update(camera, viewport) { this.active?.session?.update?.(camera, viewport); }
    setVisible(visible) {
        this.visible = Boolean(visible);
        this.active?.session?.setVisible?.(this.visible);
        for (const preview of this.previews) preview.setVisible?.(this.visible);
    }
    setMaxScreenSpaceError(value) { this.active?.session?.setMaxScreenSpaceError?.(value); }
    getAttributions() { return this.active?.session?.getAttributions?.() ?? this.attributions; }

    dispose() {
        this.generation += 1;
        this.active?.session?.dispose?.();
        this.active = null;
        for (const preview of this.previews) preview.dispose?.();
        this.previews.clear();
        this.requested = null;
        this.armedPreview = null;
        this.status = "idle";
    }
}
