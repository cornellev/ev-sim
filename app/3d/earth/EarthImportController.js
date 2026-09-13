import { EDITOR_MODES } from "../editor/EditorState.js";
import { applyRoadImport } from "../editor/commands/importCommands.js";
import { createEnvironmentCommandService } from "../editor/commands/EnvironmentCommandService.js";
import { EnvironmentDocument } from "../editor/document/EnvironmentDocument.js";
import { createGeoFrame } from "./GeoFrame.js";
import { boundsCenter, EARTH_IMPORT_STATUS, validateBounds } from "./EarthImportConfig.js";
import { RoadImportService } from "./roads/RoadImportService.js";

function message(error, fallback) {
    return error instanceof Error ? error.message : fallback;
}

function legacyFrame(anchor) {
    return { anchor: { lat: anchor.lat, lng: anchor.lng } };
}

function sourceFor({ document, bounds, state, roadsReady, importedAt }) {
    const importedLayerIds = ["google-earth-tiles"];
    if (roadsReady) importedLayerIds.push(`roads:${state.roadProvider}`);
    if (!document.geoFrame) {
        return {
            anchor: boundsCenter(bounds),
            bounds,
            tileProvider: state.tileProvider,
            roadProvider: roadsReady ? state.roadProvider : null,
            importedLayerIds,
            importedAt,
        };
    }
    return {
        version: 2,
        tileProvider: state.tileProvider,
        bounds,
        quality: {
            maxScreenSpaceError: state.maxScreenSpaceError,
            maxCachedTiles: 2000,
            maxCacheBytes: 1073741824,
        },
        roadProvider: roadsReady ? state.roadProvider : null,
        roadFilters: { highwayClasses: [...(state.highwayClasses ?? [])] },
        importedLayerIds,
        importedAt,
    };
}

/** A detached, generation-guarded Earth source/import session. */
export class EarthImportController {
    constructor(data, earthTilesManager, {
        roadImportService = null,
        tileHost = null,
        createPreviewRuntime = null,
        now = () => new Date().toISOString(),
    } = {}) {
        this.data = data;
        this.earthTilesManager = earthTilesManager;
        this.tileHost = tileHost;
        this.roadImportService = roadImportService ?? new RoadImportService();
        this.createPreviewRuntime = createPreviewRuntime;
        this.now = now;
        this.generation = 0;
        this.session = null;
    }

    get editor() { return this.data.editor(); }
    get environment() { return this.data.environment(); }
    get document() { return this.environment.getDocument(); }

    getEarthImportBounds() {
        const state = this.editor.snapshot().earthImport;
        return { north: state.boundsNorth, south: state.boundsSouth, east: state.boundsEast, west: state.boundsWest };
    }

    hasPreviewBackup() { return Boolean(this.session?.draft || this.session?.tileSession); }

    onEnterMode() {
        const earth = this.document.earth;
        if (!earth) return;
        const origin = this.document.geoFrame?.origin ?? earth.anchor;
        this.editor.patchEarthImport({
            anchorLat: origin.lat,
            anchorLng: origin.lng,
            boundsNorth: earth.bounds.north,
            boundsSouth: earth.bounds.south,
            boundsEast: earth.bounds.east,
            boundsWest: earth.bounds.west,
            tileProvider: earth.tileProvider,
            roadProvider: earth.roadProvider ?? "overpass",
            maxScreenSpaceError: earth.quality?.maxScreenSpaceError ?? 1,
        });
    }

    onExitMode() { this.cancelPreview(); }

    _newSession(bounds, { geoFrame = undefined, targetEnvironmentId = null } = {}) {
        this._cancelPending({ disposePreview: true, resetStatus: false });
        const generation = ++this.generation;
        const abortController = new AbortController();
        const environmentId = String(this.document.environmentId);
        const session = {
            generation,
            abortController,
            environmentId,
            targetEnvironmentId: targetEnvironmentId ? String(targetEnvironmentId) : environmentId,
            expectedDocumentVersion: this.document.version,
            bounds: structuredClone(bounds),
            draft: null,
            source: null,
            geoFrame: geoFrame === undefined
                ? (this.document.geoFrame ? createGeoFrame(this.document.geoFrame) : null)
                : (geoFrame ? createGeoFrame(geoFrame) : null),
            roadStatus: "pending",
            roadError: null,
            tileStatus: "pending",
            tileSession: null,
            tilesOnlyAccepted: false,
            previewDocument: null,
            previewCommands: null,
            previewRuntime: null,
            previewResult: null,
        };
        this.session = session;
        return session;
    }

    _isCurrent(session) {
        return this.session === session
            && session.generation === this.generation
            && String(this.document.environmentId) === session.environmentId;
    }

    _assertCurrent(session) {
        if (!this._isCurrent(session) || session.abortController.signal.aborted) {
            const error = new Error("Earth import preview was cancelled.");
            error.name = "AbortError";
            throw error;
        }
    }

    async _loadTiles(session, source) {
        if (this.tileHost?.prepare) {
            session.tileSession = await this.tileHost.prepare(source, session.geoFrame, {
                signal: session.abortController.signal,
                generation: session.generation,
            });
        } else {
            const origin = session.geoFrame?.origin ?? source.anchor;
            await this.earthTilesManager.load({
                ...origin,
                source,
                geoFrame: session.geoFrame,
                bounds: source.bounds,
                maxScreenSpaceError: source.quality?.maxScreenSpaceError ?? 1,
                signal: session.abortController.signal,
            });
            session.tileSession = this.earthTilesManager;
        }
        this._assertCurrent(session);
        session.tileStatus = "ready";
    }

    async _loadRoads(session, state) {
        try {
            const network = await this.roadImportService.fetch(
                session.bounds,
                { providerId: state.roadProvider, highwayClasses: state.highwayClasses ?? [] },
                session.abortController.signal,
            );
            this._assertCurrent(session);
            const clipped = this.roadImportService.clipToArea(network, session.bounds);
            session.draft = this.roadImportService.buildDraft(
                clipped,
                session.geoFrame ?? legacyFrame(boundsCenter(session.bounds)),
            );
            this._assertCurrent(session);
            session.roadStatus = session.draft.issues?.some((entry) => entry.severity === "error") ? "invalid" : "ready";
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            session.roadStatus = "error";
            session.roadError = message(error, "Road network fetch failed.");
        }
    }

    _stageDocumentPreview(session, { includeRoads }) {
        this._disposeDocumentPreview(session);
        const previewDocument = new EnvironmentDocument(this.document.snapshot());
        const previewCommands = createEnvironmentCommandService({ document: previewDocument });
        const previewRuntime = this.createPreviewRuntime?.({
            data: this.data,
            document: previewDocument,
            commands: previewCommands,
        }) ?? null;
        let previewResult;
        try {
            previewResult = previewCommands.bus.execute(applyRoadImport({
                expectedDocumentVersion: previewDocument.version,
                draft: session.draft,
                mode: this.editor.snapshot().earthImport.importMode ?? "add",
                includeRoads,
                allowEmptyReplace: false,
                source: session.source,
                geoFrame: session.geoFrame ?? undefined,
            }), { source: "earth-import-preview" });
        } catch (error) {
            previewRuntime?.dispose?.();
            throw error;
        }
        if (!previewResult.ok) {
            previewRuntime?.dispose?.();
            const error = new Error(previewResult.error ?? "The Earth import preview could not be prepared.");
            error.issues = previewResult.issues;
            throw error;
        }
        if (previewRuntime?.projector?.errors?.length) {
            const failure = previewRuntime.projector.errors[0].error;
            previewRuntime.dispose?.();
            throw failure;
        }
        session.previewDocument = previewDocument;
        session.previewCommands = previewCommands;
        session.previewRuntime = previewRuntime;
        session.previewResult = previewResult;
        return previewResult;
    }

    _disposeDocumentPreview(session) {
        session?.previewRuntime?.dispose?.();
        if (!session) return;
        session.previewRuntime = null;
        session.previewDocument = null;
        session.previewCommands = null;
        session.previewResult = null;
    }

    async runImport({ preview = true, includeRoads, geoFrame, targetEnvironmentId = null } = {}) {
        const bounds = this.getEarthImportBounds();
        const validity = validateBounds(bounds);
        if (!validity.ok) {
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.ERROR, validity.error);
            throw new Error(validity.error);
        }
        const state = this.editor.snapshot().earthImport;
        const roadsRequested = includeRoads ?? state.includeRoads ?? true;
        const anchor = boundsCenter(bounds);
        this.editor.patchEarthImport({ anchorLat: anchor.lat, anchorLng: anchor.lng, previewActive: preview });
        const session = this._newSession(bounds, { geoFrame, targetEnvironmentId });
        this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.LOADING_TILES, "Loading Google Earth tiles…");
        const sourceDocument = { geoFrame: session.geoFrame };
        const provisionalSource = sourceFor({ document: sourceDocument, bounds, state, roadsReady: roadsRequested, importedAt: this.now() });
        try {
            await this._loadTiles(session, provisionalSource);
            if (roadsRequested) {
                this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.LOADING_ROADS, "Fetching and clipping road network…");
                await this._loadRoads(session, state);
            } else {
                session.roadStatus = "skipped";
            }
            this._assertCurrent(session);
            const roadsReady = session.roadStatus === "ready";
            session.source = sourceFor({ document: sourceDocument, bounds, state, roadsReady, importedAt: this.now() });
            this._stageDocumentPreview(session, { includeRoads: roadsReady });
            const count = session.draft?.statistics?.edgeCount ?? 0;
            const statusMessage = session.roadStatus === "error"
                ? `Tile preview ready; roads failed: ${session.roadError}. Retry roads or continue with tiles only.`
                : session.roadStatus === "invalid"
                    ? "Preview contains road issues that must be resolved before applying."
                    : roadsReady ? `Preview ready (${count} road segments staged)` : "Tile preview ready";
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.PREVIEW, statusMessage);
            this.data.simulation()?.render?.();
            return { session, draft: session.draft, warning: session.roadError, stats: session.draft?.statistics ?? { edgeCount: 0 } };
        } catch (error) {
            if (this._isCurrent(session)) this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.ERROR, message(error, "Earth import failed."));
            throw error;
        }
    }

    preview(options = {}) { return this.runImport({ ...options, preview: true }); }

    async retryRoads() {
        const session = this.session;
        if (!session) throw new Error("There is no open Earth import preview.");
        session.roadStatus = "pending";
        session.roadError = null;
        session.tilesOnlyAccepted = false;
        this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.LOADING_ROADS, "Retrying road network…");
        await this._loadRoads(session, this.editor.snapshot().earthImport);
        this._assertCurrent(session);
        if (session.roadStatus !== "ready") {
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.PREVIEW, `Road retry failed: ${session.roadError ?? "Draft has blocking issues."}`);
        } else {
            const state = this.editor.snapshot().earthImport;
            session.source = sourceFor({ document: { geoFrame: session.geoFrame }, bounds: session.bounds, state, roadsReady: true, importedAt: this.now() });
            this._stageDocumentPreview(session, { includeRoads: true });
            this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.PREVIEW, `Preview ready (${session.draft.statistics.edgeCount} road segments staged)`);
        }
        return session.draft;
    }

    continueWithTilesOnly() {
        if (!this.session) throw new Error("There is no open Earth import preview.");
        this.session.tilesOnlyAccepted = true;
        const state = this.editor.snapshot().earthImport;
        this.session.source = sourceFor({ document: { geoFrame: this.session.geoFrame }, bounds: this.session.bounds, state, roadsReady: false, importedAt: this.now() });
        this._stageDocumentPreview(this.session, { includeRoads: false });
        this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.PREVIEW, "Tiles-only import ready to apply; authored roads will be retained.");
    }

    async apply({ mode, includeRoads, allowEmptyReplace = false } = {}) {
        if (!this.session) await this.preview({ includeRoads });
        const session = this.session;
        this._assertCurrent(session);
        const state = this.editor.snapshot().earthImport;
        const selectedMode = mode ?? state.importMode ?? "add";
        const roadsRequested = includeRoads ?? state.includeRoads ?? true;
        if (roadsRequested && session.roadStatus !== "ready" && !session.tilesOnlyAccepted) {
            throw new Error("Roads are not ready. Retry roads or explicitly continue with tiles only.");
        }
        const commitRoads = roadsRequested && session.roadStatus === "ready" && !session.tilesOnlyAccepted;
        const command = applyRoadImport({
            expectedDocumentVersion: session.expectedDocumentVersion,
            draft: session.draft,
            mode: selectedMode,
            includeRoads: commitRoads,
            allowEmptyReplace,
            source: session.source,
            geoFrame: session.geoFrame ?? undefined,
        });
        this.tileHost?.armPreviewCommit?.(session.tileSession, session.source, session.geoFrame);
        const result = this.environment.commands().execute(command, { source: "earth-import" });
        if (!result.ok) {
            this.tileHost?.disarmPreviewCommit?.(session.tileSession);
            const error = new Error(result.error ?? "Earth import could not be applied.");
            error.issues = result.issues;
            throw error;
        }
        this.tileHost?.commitPreview?.(session.tileSession, session.source, session.geoFrame);
        this._disposeDocumentPreview(session);
        this.session = null;
        this.editor.patchEarthImport({ previewActive: false });
        this.editor.setEarthImportStatus(EARTH_IMPORT_STATUS.APPLIED, commitRoads
            ? `Imported ${result.result.importedEdges} road segments`
            : "Applied Earth tiles; authored roads were retained");
        if (this.editor.snapshot().editorMode === EDITOR_MODES.EARTH_IMPORT) this.editor.setEditorMode(EDITOR_MODES.SCENE);
        this.data.simulation()?.render?.();
        return result;
    }

    _cancelPending({ disposePreview = true, resetStatus = true } = {}) {
        const session = this.session;
        session?.abortController?.abort?.();
        this._disposeDocumentPreview(session);
        if (disposePreview && session?.tileSession) {
            if (this.tileHost?.cancelPreview) this.tileHost.cancelPreview(session.tileSession);
            else if (session.tileSession === this.earthTilesManager) this.earthTilesManager.disposeTiles?.();
            else session.tileSession.dispose?.();
        }
        this.session = null;
        if (resetStatus) this.editor.patchEarthImport({
            previewActive: false,
            status: EARTH_IMPORT_STATUS.IDLE,
            statusMessage: null,
        });
    }

    cancelPreview(options = {}) {
        this.generation += 1;
        this._cancelPending({ disposePreview: true, resetStatus: options.resetStatus !== false });
        this.data.simulation()?.render?.();
    }

    restorePreviewDocument() { this.cancelPreview(); }
    dispose() { this.cancelPreview(); }
}
