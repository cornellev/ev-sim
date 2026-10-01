'use client';

import { useCallback, useEffect, useState } from "react";
import { IconBox, IconRefresh } from "@tabler/icons-react";

import {
    cancelMarketplacePublishJob,
    commitMarketplacePublishJob,
    createResolvedMarketplacePublicationDraft,
    getMarketplacePublisherReadiness,
    listMarketplacePublicationDrafts,
    listMarketplacePublicationInventory,
    listMarketplacePublicationReleaseOptions,
    listMarketplacePublisherProfiles,
    MarketplaceApiError,
    marketplaceApiErrorMessage,
    prepareMarketplacePublication,
    removeMarketplacePublicationDraft,
    removeMarketplacePublicationPreview,
    replanMarketplacePublishJob,
    resumeMarketplacePublishJob,
    subscribeMarketplacePublishJob,
    updateMarketplacePublicationDraft,
    uploadMarketplacePublicationPreview,
} from "../../MarketplaceClient.js";
import { AsyncState, Button, DialogSurface, NativeSelect, StatusMessage } from "../../../ui";
import LocalContentBrowser from "./LocalContentBrowser.js";
import PublicationDraftEditor from "./PublicationDraftEditorStreamlined.js";
import PublicationReviewDialog from "./PublicationReviewDialogStreamlined.js";
import { displayKind, draftStateLabel } from "../presentation.js";
import styles from "../MarketplaceWorkspace.module.css";

const INITIAL_QUERY = Object.freeze({ q: "", contentKind: "", status: "all", sort: "name", direction: "asc", offset: 0, limit: 50 });

export default function PublishTabStreamlined({ onOpenPublished }) {
    const [query, setQuery] = useState(INITIAL_QUERY);
    const [inventory, setInventory] = useState(null);
    const [draftsDocument, setDraftsDocument] = useState(null);
    const [profilesDocument, setProfilesDocument] = useState(null);
    const [readiness, setReadiness] = useState(null);
    const [releaseOptions, setReleaseOptions] = useState([]);
    const [profileId, setProfileId] = useState("");
    const [selectedDraftId, setSelectedDraftId] = useState(null);
    const [plan, setPlan] = useState(null);
    const [job, setJob] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const publishJobId = job?.job?.jobId ?? null;
    const publishJobPhase = job?.job?.phase ?? null;

    const loadContext = useCallback(async () => {
        try {
            const [nextProfiles, nextDrafts, nextReadiness] = await Promise.all([
                listMarketplacePublisherProfiles(), listMarketplacePublicationDrafts(), getMarketplacePublisherReadiness(),
            ]);
            setProfilesDocument(nextProfiles);
            setDraftsDocument(nextDrafts);
            setReadiness(nextReadiness);
            setError(null);
            setProfileId((current) => {
                const readyIds = new Set(nextReadiness.identities.filter((entry) => entry.status === "ready").map((entry) => entry.profileId));
                if (readyIds.has(current)) return current;
                return nextReadiness.defaultProfileId ?? [...readyIds][0] ?? "";
            });
            setSelectedDraftId((current) => nextDrafts.drafts.some((entry) => entry.draftId === current) ? current : nextDrafts.drafts[0]?.draftId ?? null);
        } catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    }, []);

    const loadInventory = useCallback(async () => {
        try { setInventory(await listMarketplacePublicationInventory(query)); }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); }
    }, [query]);

    useEffect(() => { const timer = setTimeout(loadContext, 0); return () => clearTimeout(timer); }, [loadContext]);
    useEffect(() => { const timer = setTimeout(loadInventory, 0); return () => clearTimeout(timer); }, [loadInventory]);
    useEffect(() => {
        if (!profileId) { setReleaseOptions([]); return undefined; }
        let active = true;
        listMarketplacePublicationReleaseOptions({ profileId })
            .then((result) => { if (active) setReleaseOptions(result.options); })
            .catch((caught) => { if (active) setError(marketplaceApiErrorMessage(caught)); });
        return () => { active = false; };
    }, [profileId]);
    useEffect(() => {
        if (!publishJobId || ["complete", "cancelled", "failed", "needs-attention"].includes(publishJobPhase)) return undefined;
        return subscribeMarketplacePublishJob(publishJobId, { onJob: setJob, onError: () => {} });
    }, [publishJobId, publishJobPhase]);
    useEffect(() => {
        if (publishJobPhase !== "complete") return undefined;
        const timer = setTimeout(() => { loadContext(); loadInventory(); }, 0);
        return () => clearTimeout(timer);
    }, [loadContext, loadInventory, publishJobPhase]);

    const run = async (operation, { quiet = false } = {}) => {
        if (!quiet) setBusy(true);
        setError(null);
        try { return await operation(); }
        catch (caught) { setError(marketplaceApiErrorMessage(caught)); return null; }
        finally { if (!quiet) setBusy(false); }
    };

    const createDraft = async (entry) => {
        if (!profileId) return;
        const result = await run(() => createResolvedMarketplacePublicationDraft({
            expectedRevision: draftsDocument.revision,
            profileId,
            contentKind: entry.contentKind,
            localSelection: entry.localSelection,
        }));
        if (result) { setDraftsDocument(result.document); setSelectedDraftId(result.draft.draftId); }
    };
    const createCollection = () => createDraft({ contentKind: "collection", localSelection: { kind: "collection" } });
    const saveDraft = useCallback(async (draftId, input, { quiet = false } = {}) => {
        if (!quiet) setBusy(true);
        setError(null);
        try {
            const result = await updateMarketplacePublicationDraft(draftId, input);
            setDraftsDocument(result.document);
            return result;
        } catch (caught) {
            if (caught instanceof MarketplaceApiError && caught.code === "CONFLICT") {
                const latest = await listMarketplacePublicationDrafts().catch(() => null);
                if (latest) setDraftsDocument(latest);
                setError("This draft changed elsewhere. Your unsaved values are preserved and will be applied to the latest revision.");
            } else setError(marketplaceApiErrorMessage(caught));
            return null;
        } finally { if (!quiet) setBusy(false); }
    }, []);
    const updateAssetRoots = async (draft, roots, catalogRevision = draft.localSelection.catalogRevision) => saveDraft(draft.draftId, {
        expectedRevision: draft.revision,
        localSelection: {
            kind: "asset-pack",
            roots,
            catalogRevision,
            ...(draft.localSelection.publicationProjectId ? { publicationProjectId: draft.localSelection.publicationProjectId } : {}),
        },
    });
    const addAssetRoot = (draft, entry) => updateAssetRoots(draft, [...draft.localSelection.roots, entry.localSelection.roots[0]], entry.localSelection.catalogRevision);
    const removeAssetRoot = (draft, assetId) => updateAssetRoots(draft, draft.localSelection.roots.filter((root) => root.assetId !== assetId));
    const deleteDraft = async () => {
        const result = await run(() => removeMarketplacePublicationDraft(deleteTarget.draftId, draftsDocument.revision));
        if (result) {
            setDraftsDocument(result.document);
            setSelectedDraftId(result.document.drafts[0]?.draftId ?? null);
            setDeleteTarget(null);
        }
    };
    const uploadPreview = async (draft, file) => {
        const result = await run(() => uploadMarketplacePublicationPreview(draft.draftId, file, `${draft.item.displayName} preview`, draft.revision));
        if (result) setDraftsDocument(result.document);
    };
    const removePreview = async (draft, digest) => {
        const result = await run(() => removeMarketplacePublicationPreview(draft.draftId, digest, draft.revision));
        if (result) setDraftsDocument(result.document);
    };
    const prepare = async (draft) => {
        const result = await run(() => prepareMarketplacePublication(draft.draftId, draft.revision));
        if (result) {
            setPlan(result.plan);
            setJob({ job: result.job });
            const latest = await listMarketplacePublicationDrafts().catch(() => null);
            if (latest) setDraftsDocument(latest);
        }
    };
    const commit = async (current) => { const result = await run(() => commitMarketplacePublishJob(current.jobId, current.revision, current.finalPlanHash)); if (result) setJob(result); };
    const cancel = async (current) => { const result = await run(() => cancelMarketplacePublishJob(current.jobId, current.revision)); if (result) { setJob(result); await loadContext(); } };
    const resume = async (current) => { const result = await run(() => resumeMarketplacePublishJob(current.jobId, current.revision)); if (result) setJob(result); };
    const replan = async (current) => { const result = await run(() => replanMarketplacePublishJob(current.jobId, current.revision)); if (result) { setJob({ job: result.job }); setPlan(result.plan); await loadContext(); } };

    if (!profilesDocument || !draftsDocument || !readiness) return <AsyncState title="Loading publisher workspace" />;
    const selected = draftsDocument.drafts.find((entry) => entry.draftId === selectedDraftId) ?? null;
    const readyIdentities = readiness.identities.filter((entry) => entry.status === "ready");
    return <div className={styles.publishWorkspace}>
        {(error || !readiness.ready) && <div className={styles.publishGlobalStatus}>
            {error && <StatusMessage tone="danger" title="Publisher operation failed">{error}</StatusMessage>}
            {!readiness.ready && <StatusMessage tone="warning" title="Publishing is not configured">Connect a backend-configured source or ask the Marketplace operator to provision a publishing identity.</StatusMessage>}
        </div>}
        <div className={styles.publishWorkspaceBody}>
        <LocalContentBrowser inventory={inventory} query={query} onQueryChange={setQuery} onCreate={createDraft} assetPackDraft={selected?.contentKind === "asset-pack" ? selected : null} onAddToAssetPack={addAssetRoot} disabled={!profileId || busy} />
        <section className={`${styles.publishColumn} ${styles.publishQueueColumn}`} aria-labelledby="publication-drafts-heading">
            <header className={styles.publishColumnHeader}><div><h2 id="publication-drafts-heading">Drafts</h2><p>Saved automatically</p></div><Button size="compact" onClick={loadContext} aria-label="Refresh publication drafts"><IconRefresh size={14} /></Button></header>
            {readyIdentities.length > 1 && <div className={styles.publishProfileBar}><NativeSelect aria-label="Publish to" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{readyIdentities.map((identity) => <option value={identity.profileId} key={identity.profileId}>{identity.name} · {identity.sourceName}</option>)}</NativeSelect></div>}
            <div className={styles.publishQueueActions}><Button size="compact" disabled={!profileId} onClick={createCollection}><IconBox size={14} /> New collection</Button></div>
            <div className={styles.publishList}>{draftsDocument.drafts.map((draft) => <button type="button" className={styles.draftButton} data-selected={selectedDraftId === draft.draftId || undefined} key={draft.draftId} onClick={() => setSelectedDraftId(draft.draftId)}><span className={styles.kindLabel}>{displayKind(draft.contentKind)}</span><strong>{draft.item.displayName}</strong><small>{draft.release.releaseVersion}</small><span className={styles.draftState}>{draftStateLabel(draft.state)}</span></button>)}{draftsDocument.drafts.length === 0 ? <div className={styles.publishEmptyState}><IconBox size={22} /><p>Select local content to start a publication.</p></div> : null}</div>
        </section>
        <PublicationDraftEditor key={selected?.draftId ?? "empty"} draft={selected} drafts={draftsDocument.drafts} releaseOptions={releaseOptions} onSave={saveDraft} onDelete={setDeleteTarget} onPrepare={prepare} onUploadPreview={uploadPreview} onRemovePreview={removePreview} onRemoveAssetRoot={removeAssetRoot} busy={busy} error={null} />
        <PublicationReviewDialog plan={plan} job={job} open={Boolean(plan)} onOpenChange={(open) => !open && setPlan(null)} onCommit={commit} onCancel={cancel} onResume={resume} onReplan={replan} onOpenPublished={onOpenPublished} busy={busy} />
        </div>
        <DialogSurface open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)} title="Delete publication draft" description="This removes only the local draft. Published content is unchanged." footer={<><Button onClick={() => setDeleteTarget(null)}>Keep draft</Button><Button variant="danger" onClick={deleteDraft}>Delete draft</Button></>}><p>{deleteTarget?.item.displayName}</p></DialogSurface>
    </div>;
}
