'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { createEnvironment, getEnvironmentManifest, isValidEnvironmentId } from "../../environment/EnvironmentCatalogClient";
import { boundsCenter, normalizeEarthImportEditorState, validateBounds } from "../../earth/EarthImportConfig";
import { createGeoFrame } from "../../earth/GeoFrame";
import { createBlankInitialManifest, createGltfInitialManifest, createGoogleInitialManifest } from "../../environment/EnvironmentCreation";
import { EarthImportMapPicker } from "../earth/EarthImportMapPicker";
import { OVERPASS_HIGHWAY_CLASSES } from "../../earth/roads/OverpassRoadProvider";

const SOURCES = ["blank", "google", "gltf"];

function portableAssetId() {
    return `asset-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function filesForImport(fileList) {
    return Promise.all([...fileList].map(async (file) => ({
        path: String(file.webkitRelativePath || file.name).replaceAll("\\", "/"),
        bytes: new Uint8Array(await file.arrayBuffer()),
    })));
}

function thumbnailUrl(asset) {
    const useHash = asset?.thumbnails?.[String(asset.latestRevision)]?.useHash;
    return useHash ? `/api/storage/visual-assets/uses/sha256/${encodeURIComponent(useHash)}/content` : null;
}

export function EnvironmentCreationDialog({ data, initialId, onCancel, onCreated }) {
    const [source, setSource] = useState("blank");
    const [name, setName] = useState("Untitled Environment");
    const [environmentId, setEnvironmentId] = useState(initialId);
    const [earth, setEarth] = useState(() => normalizeEarthImportEditorState({ includeRoads: true, importMode: "replace" }));
    const [preview, setPreview] = useState(null);
    const [assets, setAssets] = useState([]);
    const [catalogRevision, setCatalogRevision] = useState(0);
    const [selectedAssetId, setSelectedAssetId] = useState("");
    const [selectedRevision, setSelectedRevision] = useState(null);
    const [capabilities, setCapabilities] = useState({ sources: [] });
    const [transform, setTransform] = useState({ x: 0, y: 0, z: 0, rotationY: 0, scale: 1 });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const fileRef = useRef(null);
    const uploadAbortRef = useRef(null);
    const repository = data?.environment?.()?.assets?.()?.repository;
    const controller = data?.earthImportController?.();

    useEffect(() => {
        window.__fusionEnvironmentDialogConsumesEscape = true;
        return () => { window.__fusionEnvironmentDialogConsumesEscape = false; };
    }, []);

    useEffect(() => {
        if (!repository) return;
        const abort = new AbortController();
        Promise.all([repository.list({ archived: false }, { signal: abort.signal }), repository.capabilities({ signal: abort.signal })])
            .then(([catalog, nextCapabilities]) => {
                setAssets((catalog.assets ?? []).filter((entry) => !entry.archived));
                setCatalogRevision(catalog.catalogRevision ?? 0);
                setCapabilities(nextCapabilities);
                setSelectedAssetId((current) => current || catalog.assets?.find((entry) => !entry.archived)?.id || "");
            }).catch((loadError) => { if (!abort.signal.aborted) setError(loadError.message); });
        return () => abort.abort();
    }, [repository]);

    useEffect(() => () => {
        uploadAbortRef.current?.abort();
        controller?.cancelPreview?.();
    }, [controller]);

    const selectedAsset = useMemo(
        () => assets.find((entry) => entry.id === selectedAssetId) ?? null,
        [assets, selectedAssetId],
    );

    useEffect(() => {
        setSelectedRevision(null);
        if (source !== "gltf" || !repository || !selectedAsset) return undefined;
        const abort = new AbortController();
        repository.getRevision(selectedAsset.id, selectedAsset.latestRevision, { signal: abort.signal })
            .then(setSelectedRevision)
            .catch((loadError) => { if (!abort.signal.aborted) setError(loadError.message); });
        return () => abort.abort();
    }, [repository, selectedAsset, source]);

    const bounds = useMemo(() => ({
        north: earth.boundsNorth, south: earth.boundsSouth, east: earth.boundsEast, west: earth.boundsWest,
    }), [earth]);
    const boundsValidation = validateBounds(bounds);
    const patchEarth = (patch) => {
        const next = normalizeEarthImportEditorState({ ...earth, ...patch });
        setEarth(next);
        data.editor?.()?.patchEarthImport?.(next);
        setPreview(null);
        controller?.cancelPreview?.({ resetStatus: false });
    };

    const runGooglePreview = async () => {
        if (!boundsValidation.ok) throw new Error(boundsValidation.error);
        data.editor().patchEarthImport(earth);
        const center = boundsCenter(bounds);
        const geoFrame = createGeoFrame({ origin: { ...center, height: 0 } });
        const result = await controller.preview({ includeRoads: earth.includeRoads, geoFrame, targetEnvironmentId: environmentId });
        setPreview({ ...result, geoFrame });
        return { ...result, geoFrame };
    };

    const upload = async (fileList, signal) => {
        const sourceId = capabilities.sources?.[0]?.id;
        if (!sourceId) throw new Error("No asset upload source is configured.");
        const files = await filesForImport(fileList);
        const entryPath = files.find((entry) => /\.(gltf|glb)$/i.test(entry.path))?.path;
        if (!entryPath) throw new Error("Choose a GLTF or GLB model.");
        const imported = await repository.import(files, sourceId, signal, { entryPath });
        if (signal.aborted) throw signal.reason ?? new DOMException("Import cancelled.", "AbortError");
        const assetId = portableAssetId();
        const published = await repository.publish({
            assetId, name: imported.suggestedName, folderId: null, tags: ["tile"],
            publicationId: imported.publicationId, modelUseHash: imported.modelUseHash,
        }, catalogRevision, { signal });
        if (signal.aborted) throw signal.reason ?? new DOMException("Import cancelled.", "AbortError");
        await repository.generateThumbnail(
            assetId,
            published.revision.revision,
            published.catalogRevision,
            data.environment().assets().previews,
            { signal },
        ).catch(() => null);
        const catalog = await repository.list({ archived: false });
        setAssets(catalog.assets ?? []);
        setCatalogRevision(catalog.catalogRevision ?? published.catalogRevision ?? catalogRevision);
        setSelectedAssetId(assetId);
    };

    const prepareManifest = async () => {
        if (source === "blank") return createBlankInitialManifest(environmentId);
        if (source === "google") {
            const staged = preview ?? await runGooglePreview();
            if (earth.includeRoads && staged.session.roadStatus !== "ready" && !staged.session.tilesOnlyAccepted) {
                throw new Error("Roads are not ready. Retry roads or choose Continue with tiles only.");
            }
            const includeRoads = earth.includeRoads && staged.session.roadStatus === "ready" && !staged.session.tilesOnlyAccepted;
            return createGoogleInitialManifest(environmentId, {
                geoFrame: staged.geoFrame,
                source: staged.session.source,
                draft: staged.draft,
                includeRoads,
            });
        }
        const asset = selectedAsset;
        if (!asset) throw new Error("Choose an immutable catalog revision.");
        const publishedRevision = await repository.getRevision(asset.id, asset.latestRevision);
        return createGltfInitialManifest(environmentId, {
            assetId: asset.id, revision: asset.latestRevision, publishedRevision,
            position: { x: transform.x, y: transform.y, z: transform.z }, rotationY: transform.rotationY,
            scale: { x: transform.scale, y: transform.scale, z: transform.scale },
        });
    };

    const create = async () => {
        if (!isValidEnvironmentId(environmentId)) { setError("Use lowercase letters, numbers, and single hyphens for the ID."); return; }
        setBusy(true);
        setError(null);
        try {
            const initialManifest = await prepareManifest();
            await data?.environment?.()?.persistence?.flush?.({ throwOnError: true });
            try {
                await createEnvironment({ id: environmentId, name, templateId: "blank", initialManifest });
            } catch (createError) {
                const recovered = await getEnvironmentManifest(environmentId).catch(() => null);
                if (!recovered) throw createError;
            }
            controller?.cancelPreview?.();
            onCreated(environmentId);
        } catch (createError) {
            setError(createError.message);
        } finally {
            setBusy(false);
        }
    };

    const cancel = () => {
        uploadAbortRef.current?.abort();
        uploadAbortRef.current = null;
        controller?.cancelPreview?.();
        onCancel();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-6" role="dialog" aria-modal="true" aria-label="Create environment" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
            <div className="grid max-h-[680px] w-full max-w-4xl grid-cols-[280px_1fr] overflow-hidden rounded border border-zinc-700 bg-zinc-950 text-zinc-100 shadow-2xl">
                <aside className="border-r border-zinc-800 p-4">
                    <h2 className="text-base font-semibold">Create environment</h2>
                    <p className="mt-1 text-xs text-zinc-500">Revision 1 is written atomically after the source preview passes.</p>
                    <label htmlFor="environment-creation-name" className="mt-5 block text-[11px] uppercase tracking-wider text-zinc-500">Name</label>
                    <input id="environment-creation-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
                    <label htmlFor="environment-creation-id" className="mt-3 block text-[11px] uppercase tracking-wider text-zinc-500">Environment ID</label>
                    <input id="environment-creation-id" value={environmentId} onChange={(event) => setEnvironmentId(event.target.value.toLowerCase())} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm" />
                    <div className="mt-5 grid gap-1">
                        {SOURCES.map((entry) => <button type="button" key={entry} onClick={() => { setSource(entry); setError(null); }} className={`rounded px-3 py-2 text-left text-sm capitalize ${source === entry ? "bg-sky-500/20 text-sky-100" : "hover:bg-zinc-900"}`}>{entry === "google" ? "Google Earth" : entry === "gltf" ? "GLTF Tile" : "Blank"}</button>)}
                    </div>
                </aside>
                <main className="min-h-0 overflow-y-auto p-5">
                    {source === "blank" && <div><h3 className="font-medium">Blank environment</h3><p className="mt-2 text-sm text-zinc-400">Creates empty roads, buildings, features, and a Skybox.</p></div>}
                    {source === "google" && <div className="space-y-4">
                        <div><h3 className="font-medium">Google Earth source</h3><p className="text-xs text-zinc-500">Draw a bounded area, configure roads, then preview.</p></div>
                        <div className="h-64 overflow-hidden rounded border border-zinc-700"><EarthImportMapPicker earthImport={earth} onPatch={patchEarth} /></div>
                        <div className="flex gap-5 text-sm"><label><input type="checkbox" checked={earth.includeRoads} onChange={(event) => patchEarth({ includeRoads: event.target.checked })} /> <span className="ml-1">Import roads</span></label><label>Quality <input type="number" min="1" value={earth.maxScreenSpaceError} onChange={(event) => patchEarth({ maxScreenSpaceError: Number(event.target.value) })} className="ml-1 w-16 rounded bg-zinc-900 px-1" /></label></div>
                        {earth.includeRoads && <fieldset><legend className="text-[11px] uppercase tracking-wider text-zinc-500">Highway classes</legend><div className="mt-2 grid grid-cols-3 gap-1 text-xs">{OVERPASS_HIGHWAY_CLASSES.map((highwayClass) => {
                            const selected = earth.highwayClasses.length === 0 || earth.highwayClasses.includes(highwayClass);
                            return <label key={highwayClass} className="truncate"><input type="checkbox" checked={selected} onChange={(event) => {
                                const current = earth.highwayClasses.length === 0 ? [...OVERPASS_HIGHWAY_CLASSES] : earth.highwayClasses;
                                patchEarth({ highwayClasses: event.target.checked ? [...new Set([...current, highwayClass])] : current.filter((entry) => entry !== highwayClass) });
                            }} /> <span className="ml-1">{highwayClass}</span></label>;
                        })}</div></fieldset>}
                        <p className={`text-xs ${boundsValidation.ok ? "text-zinc-500" : "text-red-300"}`}>{boundsValidation.ok ? `${Math.abs(bounds.north - bounds.south).toFixed(5)}° × ${Math.abs(bounds.east - bounds.west).toFixed(5)}°` : boundsValidation.error}</p>
                        <div className="flex gap-2"><button type="button" disabled={busy || !boundsValidation.ok} onClick={() => { setBusy(true); setError(null); runGooglePreview().catch((e) => setError(e.message)).finally(() => setBusy(false)); }} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Preview</button>
                        {controller?.session?.roadStatus === "error" && <><button type="button" onClick={() => controller.retryRoads().then(() => setPreview((value) => value && ({ ...value, draft: controller.session.draft }))).catch((e) => setError(e.message))} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Retry roads</button><button type="button" onClick={() => { controller.continueWithTilesOnly(); setPreview((value) => value && ({ ...value })); }} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Continue with tiles only</button></>}</div>
                        {preview && <p className="text-sm text-emerald-300">Preview ready: {preview.draft?.statistics?.edgeCount ?? 0} road segments.</p>}
                    </div>}
                    {source === "gltf" && <div className="space-y-4">
                        <div><h3 className="font-medium">GLTF Tile</h3><p className="text-xs text-zinc-500">Select a published immutable revision or upload a GLTF/GLB and its dependencies.</p></div>
                        <select aria-label="Catalog revision" value={selectedAssetId} onChange={(event) => setSelectedAssetId(event.target.value)} className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm"><option value="">Choose catalog asset</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} · r{asset.latestRevision}</option>)}</select>
                        <input ref={fileRef} type="file" multiple accept=".gltf,.glb,.bin,image/*" className="hidden" onChange={(event) => {
                            uploadAbortRef.current?.abort();
                            const abort = new AbortController();
                            uploadAbortRef.current = abort;
                            setBusy(true);
                            upload(event.target.files, abort.signal)
                                .catch((e) => { if (!abort.signal.aborted) setError(e.message); })
                                .finally(() => { if (uploadAbortRef.current === abort) uploadAbortRef.current = null; setBusy(false); });
                        }} />
                        <button type="button" onClick={() => fileRef.current?.click()} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Upload model</button>
                        <div className="grid grid-cols-5 gap-2">{["x", "y", "z", "rotationY", "scale"].map((key) => <label key={key} className="text-[11px] uppercase text-zinc-500">{key}<input type="number" step="0.1" min={key === "scale" ? "0.001" : undefined} value={transform[key]} onChange={(event) => setTransform((current) => ({ ...current, [key]: Number(event.target.value) }))} className="mt-1 w-full rounded bg-zinc-900 px-1.5 py-1 text-zinc-100" /></label>)}</div>
                        {selectedAsset && <div aria-label="GLTF Tile preview" className="flex min-h-32 items-center gap-4 rounded border border-zinc-800 bg-zinc-900/60 p-3">
                            {thumbnailUrl(selectedAsset)
                                // Use-scoped thumbnails are authenticated API resources.
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <img src={thumbnailUrl(selectedAsset)} alt="" className="h-28 w-28 shrink-0 rounded object-cover" />
                                : <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded border border-dashed border-zinc-700 text-xs text-zinc-500">Model preview</div>}
                            <div className="min-w-0 text-xs text-zinc-400">
                                <strong className="block truncate text-sm text-zinc-100">{selectedAsset.name} · r{selectedAsset.latestRevision}</strong>
                                <p className="mt-2">Position {transform.x}, {transform.y}, {transform.z}</p>
                                <p>Yaw {transform.rotationY} rad · Scale {transform.scale}</p>
                                {selectedRevision?.version === 2 && <p className="mt-2">Normalization {selectedRevision.definition?.normalization?.metersPerUnit ?? 1} m/unit with the published pivot and orientation.</p>}
                                {selectedRevision?.version === 1 && <p className="mt-2">Raw revision: visual-only until an explicit metric revision is published.</p>}
                            </div>
                        </div>}
                    </div>}
                    {error && <p role="alert" className="mt-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}
                    <footer className="mt-6 flex justify-end gap-2 border-t border-zinc-800 pt-4"><button type="button" disabled={busy} onClick={cancel} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900">Cancel</button><button type="button" disabled={busy} onClick={create} className="rounded bg-sky-600 px-4 py-1.5 text-sm font-medium disabled:opacity-50">{busy ? "Working…" : "Create"}</button></footer>
                </main>
            </div>
        </div>
    );
}
