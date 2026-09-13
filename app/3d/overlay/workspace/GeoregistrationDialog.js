'use client';

import { useEffect, useMemo, useState } from "react";
import { planGeoregistration, migrateGeoregistration } from "../../editor/commands/georegistrationCommands";
import { createGeoFrame } from "../../earth/GeoFrame";

export function GeoregistrationDialog({ data, onClose }) {
    const document = data.environment().getDocument();
    const anchor = document.earth?.anchor ?? { lat: 0, lng: 0 };
    const [scope, setScope] = useState("roads");
    const [origin, setOrigin] = useState({ lat: anchor.lat, lng: anchor.lng, height: 0 });
    const [error, setError] = useState(null);
    useEffect(() => {
        window.__fusionEnvironmentDialogConsumesEscape = true;
        return () => { window.__fusionEnvironmentDialogConsumesEscape = false; };
    }, []);
    const plan = useMemo(() => {
        try {
            return planGeoregistration(document, { targetFrame: createGeoFrame({ origin }), scope });
        } catch (planningError) {
            return { issues: [{ severity: "error", message: planningError.message }], after: null };
        }
    }, [document, origin, scope]);
    const blocked = !plan.after || plan.issues?.some((entry) => entry.severity === "error");
    const apply = () => {
        const result = data.environment().commands().execute(migrateGeoregistration({ expectedDocumentVersion: document.version, plan }));
        if (!result.ok) { setError(result.error); return; }
        onClose();
    };
    return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" role="dialog" aria-modal="true" aria-label="Correct georegistration" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
        <div className="w-full max-w-lg rounded border border-zinc-700 bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
            <h2 className="text-base font-semibold">Correct georegistration</h2>
            <p className="mt-1 text-sm text-zinc-400">Preview the explicit legacy Mercator conversion before committing it as one undoable edit.</p>
            <fieldset className="mt-4 grid grid-cols-2 gap-2"><legend className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Migration scope</legend>
                <label className={`rounded border p-3 text-sm ${scope === "roads" ? "border-sky-500 bg-sky-500/10" : "border-zinc-700"}`}><input type="radio" name="scope" value="roads" checked={scope === "roads"} onChange={() => setScope("roads")} /> <span className="ml-1">Roads only</span></label>
                <label className={`rounded border p-3 text-sm ${scope === "environment" ? "border-sky-500 bg-sky-500/10" : "border-zinc-700"}`}><input type="radio" name="scope" value="environment" checked={scope === "environment"} onChange={() => setScope("environment")} /> <span className="ml-1">Whole environment</span></label>
            </fieldset>
            <div className="mt-4 grid grid-cols-3 gap-2">{["lat", "lng", "height"].map((key) => <label key={key} className="text-[11px] uppercase text-zinc-500">Origin {key}<input autoFocus={key === "lat"} type="number" step="0.000001" value={origin[key]} onChange={(event) => setOrigin((current) => ({ ...current, [key]: Number(event.target.value) }))} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" /></label>)}</div>
            {plan.statistics && <div className="mt-4 rounded bg-zinc-900 p-3 text-xs text-zinc-300"><p>{plan.statistics.roadNodes} road nodes · {plan.statistics.roadEdges} road edges</p><p>{plan.statistics.convertedCurves} curves will become explicit polylines</p>{scope === "environment" && <p>{plan.statistics.buildings} buildings · {plan.statistics.features} features · {plan.statistics.rigidObjects} rigid objects</p>}</div>}
            {(plan.issues ?? []).map((issue, index) => <p key={index} className="mt-2 text-sm text-red-300">{issue.objectId ? `${issue.objectId}: ` : ""}{issue.message}</p>)}
            {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-400">Cancel</button><button type="button" disabled={blocked} onClick={apply} className="rounded bg-sky-600 px-4 py-1.5 text-sm font-medium disabled:opacity-40">Apply correction</button></div>
        </div>
    </div>;
}
