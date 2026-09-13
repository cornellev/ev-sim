'use client';

import { useEffect, useState } from "react";
import { readAssetBinding } from "../../../editor-assets/AssetBackedObject.js";

export function AssetInstanceSection({ data, section }) {
    const [asset, setAsset] = useState(null);
    const [revisions, setRevisions] = useState([]);
    const [targetRevision, setTargetRevision] = useState(section.revision);
    const [scope, setScope] = useState("selected");
    const [open, setOpen] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [status, setStatus] = useState("loading");
    const [message, setMessage] = useState(null);
    const repository = data?.environment?.()?.assets?.()?.repository;
    const document = data?.environment?.()?.getDocument?.();
    const matchingSelected = (data?.selection?.()?.ids ?? []).filter((id) => {
        const record = document?.getObject?.(id);
        return readAssetBinding(record)?.assetId === section.assetId;
    });
    const allCount = document?.objects?.filter((record) => readAssetBinding(record)?.assetId === section.assetId).length ?? 0;

    useEffect(() => {
        const controller = new AbortController();
        const refresh = async (signal) => {
            try {
                const [catalogRecord, history] = await Promise.all([
                    repository.get(section.assetId, { signal }),
                    repository.listRevisions(section.assetId, { signal }),
                ]);
                setAsset(catalogRecord.asset);
                setRevisions(history.revisions);
                setTargetRevision((current) => history.revisions.some((entry) => entry.revision === current) ? current : catalogRecord.asset.latestRevision);
                setStatus("ready");
            } catch (error) {
                if (!signal?.aborted) { setStatus("unresolved"); setMessage(error.message); }
            }
        };
        void refresh(controller.signal);
        const unsubscribe = repository?.subscribe?.(() => void refresh(controller.signal));
        return () => { controller.abort(); unsubscribe?.(); };
    }, [repository, section.assetId]);

    const apply = async () => {
        setMessage(null);
        setUpdating(true);
        try {
            const assets = data.environment().assets();
            const objectIds = scope === "selected" ? matchingSelected : null;
            const command = await assets.instantiation.update({ assetId: section.assetId, targetRevision, objectIds });
            const result = data.commands().execute(command);
            if (!result.ok) throw new Error(result.error || result.issues?.[0]?.message || "Update failed.");
            setOpen(false);
            const count = result.result.objectIds.length;
            setMessage(`${count} instance${count === 1 ? "" : "s"} updated.`);
        } catch (error) {
            setMessage(error.message);
        } finally { setUpdating(false); }
    };

    return <div className="space-y-2 py-1 text-xs" data-asset-instance-section>
        <dl className="grid grid-cols-[72px_1fr] gap-1"><dt className="text-zinc-400">Pinned</dt><dd>r{section.revision}</dd><dt className="text-zinc-400">Latest</dt><dd>{asset ? `r${asset.latestRevision}` : "—"}</dd><dt className="text-zinc-400">Status</dt><dd>{status === "unresolved" ? "Unresolved" : asset?.archived ? "Archived" : status}</dd></dl>
        {asset?.latestRevision > section.revision && <p className="text-amber-300">Revision {asset.latestRevision} is available.</p>}
        <div className="flex gap-1"><button type="button" disabled={!asset} onClick={() => data.editor?.()?.openAssetTab?.({ id: section.assetId, revision: section.revision, name: asset?.name ?? section.assetId }, { pinned: true })} className="rounded border border-zinc-700 px-2 py-1">Open asset</button><button type="button" disabled={!asset || revisions.length === 0 || updating} onClick={() => { setTargetRevision(asset.latestRevision); setOpen(true); }} className="rounded border border-zinc-700 px-2 py-1">Update instances</button></div>
        {open && <div role="dialog" aria-label="Update asset instances" className="space-y-2 rounded border border-zinc-700 p-2"><label className="block">Target revision <select disabled={updating} value={targetRevision} onChange={(event) => setTargetRevision(Number(event.target.value))}>{revisions.map((entry) => <option key={entry.revision} value={entry.revision}>r{entry.revision}</option>)}</select></label><label className="block"><input type="radio" disabled={updating} checked={scope === "selected"} onChange={() => setScope("selected")} /> Selected matching ({matchingSelected.length})</label><label className="block"><input type="radio" disabled={updating} checked={scope === "all"} onChange={() => setScope("all")} /> All in this environment ({allCount})</label><div className="flex gap-1"><button type="button" disabled={updating || (scope === "selected" ? matchingSelected.length : allCount) === 0} onClick={apply}>{updating ? "Updating…" : `Update ${scope === "selected" ? matchingSelected.length : allCount}`}</button><button type="button" disabled={updating} onClick={() => setOpen(false)}>Cancel</button></div></div>}
        {message && <p role="status" className="text-amber-300">{message}</p>}
    </div>;
}
