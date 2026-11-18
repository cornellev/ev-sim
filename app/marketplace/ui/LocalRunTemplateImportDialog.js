'use client';

import { useEffect, useRef, useState } from "react";
import { Button, DialogSurface, StatusMessage } from "../../ui";
import { cancelLocalRunTemplateImport, commitLocalRunTemplateImport, createLocalRunTemplateImport, getLocalRunTemplateImport, replanLocalRunTemplateImport, resumeLocalRunTemplateImport } from "../MarketplaceClient.js";
import styles from "./MarketplaceWorkspace.module.css";

export default function LocalRunTemplateImportDialog({ initialImport, onClose, onOpenRunConfig }) {
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const upload = useRef(null);
    const id = view?.importId;
    const phase = view?.phase;
    const locked = phase === "commit";

    useEffect(() => {
        const controller = new AbortController();
        if (initialImport) getLocalRunTemplateImport(initialImport.importId, { signal: controller.signal }).then(setView).catch((caught) => {
            if (caught.name !== "AbortError") setError(caught.message);
        });
        return () => { controller.abort(); upload.current?.abort(); };
    }, [initialImport]);
    useEffect(() => {
        if (!id || phase !== "commit") return;
        const controller = new AbortController();
        let timer;
        const poll = async () => {
            try { setView(await getLocalRunTemplateImport(id, { signal: controller.signal })); setError(null); }
            catch (caught) { if (caught.name !== "AbortError") setError(caught.message); }
            if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
        };
        timer = setTimeout(poll, 1000);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [id, phase]);

    const choose = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        upload.current?.abort();
        const controller = new AbortController();
        upload.current = controller;
        setBusy(true); setError(null); setView(null);
        try { setView(await createLocalRunTemplateImport(file, { signal: controller.signal })); }
        catch (caught) { if (caught.name !== "AbortError") setError(caught.message); }
        finally { if (upload.current === controller) setBusy(false); }
    };
    const act = async (operation) => {
        setBusy(true); setError(null);
        try { setView(await operation()); }
        catch (caught) { setError(caught.message); }
        finally { setBusy(false); }
    };
    const close = async () => {
        if (locked) return;
        upload.current?.abort();
        if (phase === "awaiting-confirmation") {
            setBusy(true);
            try { await cancelLocalRunTemplateImport(id, view.revision); }
            catch (caught) { setError(caught.message); setBusy(false); return; }
        }
        onClose();
    };
    const footer = <>
        <Button disabled={locked || busy && Boolean(view)} onClick={close}>{view ? "Close" : "Cancel"}</Button>
        {phase === "awaiting-confirmation" && <Button variant="primary" loading={busy} disabled={!view.review.committable} onClick={() => act(() => commitLocalRunTemplateImport(id, view.revision, view.planHash))}>Import</Button>}
        {phase === "needs-attention" && <><Button loading={busy} onClick={() => act(() => replanLocalRunTemplateImport(id, view.revision))}>Replan</Button><Button variant="primary" loading={busy} onClick={() => act(() => resumeLocalRunTemplateImport(id, view.revision))}>Resume</Button></>}
        {phase === "complete" && <Button variant="primary" onClick={() => onOpenRunConfig?.(view.destinationManifestId)}>Open in Run Configuration</Button>}
    </>;
    return <DialogSurface open onOpenChange={(open) => { if (!open) close(); }} title="Import package" description="Review a run template shared as a file before creating editable content." className={styles.installDialog} footer={footer}>
        <div className={styles.installFlow}>
            <StatusMessage tone="warning" title="Unverified file">This file is not registry-signed. Its contents are checked locally. Import does not run plugins.</StatusMessage>
            {!view && <label>Run-template tar<input type="file" accept=".tar" aria-label="Run-template tar" disabled={busy} onChange={choose} /></label>}
            <div role="status" aria-live="polite">{busy && !view ? "Uploading and verifying package…" : phase === "commit" ? "Importing editable content…" : phase === "complete" ? "Import complete" : ""}</div>
            {error && <StatusMessage tone="danger" title="Import failed">{error}</StatusMessage>}
            {view && <>
                <section><h3>{view.review.name}</h3><p>{view.review.sourceManifestId} → {view.review.destinationManifestId}</p>
                    {view.review.blockingIssues.length > 0 && <StatusMessage tone="danger" title="Import is blocked">{view.review.blockingIssues.join(" · ")}</StatusMessage>}
                    <ul className={styles.plainList}>{view.review.mappings.map((mapping, index) => <li key={index}>{mapping.resourceKind}: {mapping.sourceId} → {mapping.localId} · {mapping.action}{mapping.renamed ? " · renamed to preserve local content" : ""}</li>)}</ul>
                    <p>Frozen bindings: {view.review.bindingCount}. Requested capabilities: {view.review.capabilities.join(", ") || "None"}.</p>
                    {view.review.plugins.map((plugin) => <p key={plugin.packageHash}>Plugin: {plugin.pluginId}@{plugin.version}</p>)}
                    {view.review.protobufInterface && <p>{view.archive.packageVersion === 2 ? "Includes the pinned Protobuf interface." : "Uses the exact Protobuf interface already stored locally."}</p>}
                    {view.review.rights.length > 0 && <ul className={styles.plainList}>{view.review.rights.map((right) => <li key={right.id}>{right.sourceId}: {right.right} · {right.allowed ? "allowed" : "denied"}</li>)}</ul>}
                    {view.review.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                </section>
                {phase !== "awaiting-confirmation" && <section><progress aria-label="Import operation progress" max={Math.max(1, view.progress.totalOperations)} value={view.progress.completedOperations} /><p>{view.progress.completedOperations}/{view.progress.totalOperations} operations completed</p></section>}
                {phase === "needs-attention" && <StatusMessage tone="warning" title="Import needs attention">{view.error?.message} Completed content is retained. Replan creates a new review before continuing.</StatusMessage>}
                <details className={styles.technicalDetails}><summary>Technical details</summary><p>Archive SHA-256: {view.importId}</p><p>Plan hash: {view.planHash}</p></details>
            </>}
        </div>
    </DialogSurface>;
}
