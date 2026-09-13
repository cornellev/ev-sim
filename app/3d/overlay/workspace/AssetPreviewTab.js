'use client';

import { useEffect, useState } from "react";

/** Read-only catalog preview. The active tab owns the sole preview lease. */
export function AssetPreviewTab({ data, tab }) {
    const [state, setState] = useState({ status: "loading", url: null, error: null });

    useEffect(() => {
        const controller = new AbortController();
        let lease = null;
        let objectUrl = null;
        const assets = data?.environment?.()?.assets?.();
        void (async () => {
            try {
                const revision = await assets.repository.getRevision(tab.assetId, tab.revision, { signal: controller.signal });
                lease = await assets.models.acquire(revision.modelUseHash, { signal: controller.signal });
                const blob = await assets.previews.render(lease, { signal: controller.signal });
                objectUrl = URL.createObjectURL(blob);
                setState({ status: "ready", url: objectUrl, error: null });
            } catch (error) {
                if (!controller.signal.aborted) setState({ status: "error", url: null, error: error.message });
            }
        })();
        return () => {
            controller.abort();
            lease?.release?.();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [data, tab.assetId, tab.revision]);

    return (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-zinc-950" data-asset-preview-tab={tab.id}>
            {state.status === "loading" && <p role="status" className="text-sm text-zinc-400">Loading asset preview…</p>}
            {state.status === "error" && <p role="alert" className="max-w-md text-sm text-red-300">{state.error}</p>}
            {/* Blob URLs are generated locally by the fixed preview renderer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {state.url && <img src={state.url} alt={`${tab.name} revision ${tab.revision}`} className="max-h-[80%] max-w-[80%] image-render-auto" />}
        </div>
    );
}

export function AssetCatalogInspector({ data, tab }) {
    const [asset, setAsset] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        const controller = new AbortController();
        const repository = data?.environment?.()?.assets?.()?.repository;
        void repository?.get(tab.assetId, { signal: controller.signal }).then((result) => setAsset(result.asset)).catch((failure) => {
            if (!controller.signal.aborted) setError(failure.message);
        });
        return () => controller.abort();
    }, [data, tab.assetId]);
    return (
        <div className="space-y-3 p-3 text-xs" data-asset-catalog-inspector>
            <h3 className="text-sm font-medium text-zinc-100">{asset?.name ?? tab.name}</h3>
            <dl className="grid grid-cols-[80px_1fr] gap-2 text-zinc-400">
                <dt>Asset</dt><dd className="break-all text-zinc-200">{tab.assetId}</dd>
                <dt>Revision</dt><dd className="text-zinc-200">{tab.revision}</dd>
                <dt>Latest</dt><dd className="text-zinc-200">{asset?.latestRevision ?? "—"}</dd>
                <dt>Status</dt><dd className="text-zinc-200">{asset?.archived ? "Archived" : "Active"}</dd>
                <dt>Tags</dt><dd className="text-zinc-200">{asset?.tags?.join(", ") || "—"}</dd>
            </dl>
            {error && <p role="alert" className="text-red-300">{error}</p>}
        </div>
    );
}
