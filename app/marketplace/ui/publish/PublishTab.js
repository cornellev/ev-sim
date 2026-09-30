'use client';

import { useCallback, useEffect, useState } from "react";
import { IconBox, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";

import {
    cancelMarketplacePublishJob,
    commitMarketplacePublishJob,
    createMarketplacePublicationDraft,
    createMarketplacePublicationPlan,
    createMarketplacePublisherProfile,
    listMarketplacePublicationDrafts,
    listMarketplacePublicationInventory,
    listMarketplacePublisherProfiles,
    listMarketplaceSources,
    marketplaceApiErrorMessage,
    removeMarketplacePublicationDraft,
    removeMarketplacePublicationPreview,
    replanMarketplacePublishJob,
    resumeMarketplacePublishJob,
    startMarketplacePublishJob,
    subscribeMarketplacePublishJob,
    updateMarketplacePublicationDraft,
    uploadMarketplacePublicationPreview,
} from "../../MarketplaceClient.js";
import { AsyncState, Button, NativeSelect, StatusMessage } from "../../../ui";
import LocalContentBrowser from "./LocalContentBrowser.js";
import PublicationDraftEditor from "./PublicationDraftEditor.js";
import PublicationReviewDialog from "./PublicationReviewDialog.js";
import PublisherProfileDialog from "./PublisherProfileDialog.js";
import styles from "../MarketplaceWorkspace.module.css";

const INITIAL_QUERY = Object.freeze({ q: "", contentKind: "", status: "all", sort: "name", direction: "asc", offset: 0, limit: 50 });

export default function PublishTab({ onOpenPublished }) {
    const [query, setQuery] = useState(INITIAL_QUERY);
    const [inventory, setInventory] = useState(null);
    const [draftsDocument, setDraftsDocument] = useState(null);
    const [profilesDocument, setProfilesDocument] = useState(null);
    const [sources, setSources] = useState([]);
    const [profileId, setProfileId] = useState("");
    const [selectedDraftId, setSelectedDraftId] = useState(null);
    const [profileDialog, setProfileDialog] = useState(false);
    const [plan, setPlan] = useState(null);
    const [job, setJob] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const publishJobId = job?.job?.jobId ?? null;
    const publishJobPhase = job?.job?.phase ?? null;

    const loadContext = useCallback(async () => {
        try {
            const [nextProfiles, nextDrafts, sourceDocument] = await Promise.all([
                listMarketplacePublisherProfiles(), listMarketplacePublicationDrafts(), listMarketplaceSources(),
            ]);
            setProfilesDocument(nextProfiles); setDraftsDocument(nextDrafts); setSources(sourceDocument.sources); setError(null);
            setProfileId((current) => nextProfiles.profiles.some((entry) => entry.profileId === current) ? current : nextProfiles.profiles[0]?.profileId ?? "");
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
        if (!publishJobId || ["complete", "cancelled", "failed", "needs-attention"].includes(publishJobPhase)) return undefined;
        return subscribeMarketplacePublishJob(publishJobId, { onJob: setJob, onError: () => {} });
    }, [publishJobId, publishJobPhase]);
    useEffect(() => {
        if (publishJobPhase !== "complete") return undefined;
        const timer = setTimeout(loadContext, 0);
        return () => clearTimeout(timer);
    }, [loadContext, publishJobPhase]);

    const run = async (operation) => {
        setBusy(true); setError(null);
        try { return await operation(); } catch (caught) { setError(marketplaceApiErrorMessage(caught)); return null; }
        finally { setBusy(false); }
    };
    const createDraft = async (entry, mode = "create-item") => {
        if (!profileId) { setProfileDialog(true); return; }
        let itemId;
        if (mode === "new-release") {
            itemId = window.prompt(
                "Exact existing Marketplace item ID:",
                entry.contentKind === "plugin" ? entry.identity.pluginId : "",
            )?.trim();
            if (!itemId) return;
        }
        const result = await run(() => createMarketplacePublicationDraft({
            expectedRevision: draftsDocument.revision,
            profileId,
            contentKind: entry.contentKind,
            localSelection: entry.localSelection,
            mode,
            ...(itemId ? { itemId } : {}),
        }));
        if (result) { setDraftsDocument(result.document); setSelectedDraftId(result.draft.draftId); }
    };
    const createCollection = () => createDraft({ contentKind: "collection", localSelection: { kind: "collection" } });
    const saveDraft = async (draftId, input) => {
        const result = await run(() => updateMarketplacePublicationDraft(draftId, input));
        if (result) setDraftsDocument(result.document);
    };
    const updateAssetRoots = async (draft, roots, catalogRevision = draft.localSelection.catalogRevision) => {
        const result = await run(() => updateMarketplacePublicationDraft(draft.draftId, {
            expectedRevision: draft.revision,
            localSelection: { kind: "asset-pack", roots, catalogRevision },
        }));
        if (result) setDraftsDocument(result.document);
    };
    const addAssetRoot = (draft, entry) => updateAssetRoots(draft, [...draft.localSelection.roots, entry.localSelection.roots[0]], entry.localSelection.catalogRevision);
    const removeAssetRoot = (draft, assetId) => updateAssetRoots(draft, draft.localSelection.roots.filter((root) => root.assetId !== assetId));
    const deleteDraft = async (draft) => {
        if (!window.confirm(`Delete publication draft “${draft.item.displayName}”? This removes only the local draft.`)) return;
        const result = await run(() => removeMarketplacePublicationDraft(draft.draftId, draftsDocument.revision));
        if (result) { setDraftsDocument(result.document); setSelectedDraftId(result.document.drafts[0]?.draftId ?? null); }
    };
    const uploadPreview = async (draft, file) => {
        const alt = window.prompt("Alternative text for this listing image:", `${draft.item.displayName} preview`);
        if (!alt) return;
        const result = await run(() => uploadMarketplacePublicationPreview(draft.draftId, file, alt, draft.revision));
        if (result) setDraftsDocument(result.document);
    };
    const removePreview = async (draft, digest) => {
        const preview = draft.item.previews.find((entry) => entry.sha256 === digest);
        if (!window.confirm(`Remove listing image “${preview?.alt ?? digest}” from this draft?`)) return;
        const result = await run(() => removeMarketplacePublicationPreview(draft.draftId, digest, draft.revision));
        if (result) setDraftsDocument(result.document);
    };
    const prepare = async (draft) => {
        const result = await run(() => createMarketplacePublicationPlan(draft.draftId, draft.revision));
        if (result) { setPlan(result); setJob(null); }
    };
    const start = async () => { const result = await run(() => startMarketplacePublishJob(plan.planHash)); if (result) setJob(result); };
    const commit = async (current) => { const result = await run(() => commitMarketplacePublishJob(current.jobId, current.revision, current.finalPlanHash)); if (result) setJob(result); };
    const cancel = async (current) => {
        if (!window.confirm("Cancel this uncommitted publication job? No registry writes have occurred.")) return;
        const result = await run(() => cancelMarketplacePublishJob(current.jobId, current.revision));
        if (result) setJob(result);
    };
    const resume = async (current) => { const result = await run(() => resumeMarketplacePublishJob(current.jobId, current.revision)); if (result) setJob(result); };
    const replan = async (current) => { const result = await run(() => replanMarketplacePublishJob(current.jobId, current.revision)); if (result) { setJob({ job: result.job }); setPlan(result.plan); } };
    const addProfile = async (input) => {
        const result = await run(() => createMarketplacePublisherProfile(input));
        if (result) { setProfilesDocument(result.document); setProfileId(result.profile.profileId); setProfileDialog(false); }
    };
    if (!profilesDocument || !draftsDocument) return <AsyncState title="Loading publisher workspace" />;
    const selected = draftsDocument.drafts.find((entry) => entry.draftId === selectedDraftId) ?? null;
    return <div className={styles.publishWorkspace}>
        {error && <div className={styles.publishGlobalStatus}><StatusMessage tone="danger" title="Publisher operation failed">{error}</StatusMessage></div>}
        <LocalContentBrowser inventory={inventory} query={query} onQueryChange={setQuery} onCreate={createDraft} assetPackDraft={selected?.contentKind === "asset-pack" ? selected : null} onAddToAssetPack={addAssetRoot} disabled={!profileId || busy} />
        <section className={`${styles.publishColumn} ${styles.publishQueueColumn}`} aria-labelledby="publication-drafts-heading">
            <header className={styles.publishColumnHeader}><div><h2 id="publication-drafts-heading">Publication drafts</h2><p>Durable local queue · revision {draftsDocument.revision}</p></div><Button size="compact" onClick={loadContext}><IconRefresh size={14} /></Button></header>
            <div className={styles.publishProfileBar}><NativeSelect aria-label="Active publisher profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">No publisher profile</option>{profilesDocument.profiles.map((profile) => <option value={profile.profileId} key={profile.profileId}>{profile.name}</option>)}</NativeSelect><Button size="compact" onClick={() => setProfileDialog(true)}><IconPlus size={14} /> Profile</Button></div>
            <div className={styles.publishQueueActions}><Button size="compact" disabled={!profileId} onClick={createCollection}><IconBox size={14} /> New collection</Button></div>
            <div className={styles.publishList}>{profilesDocument.profiles.map((profile) => {
                const grouped = draftsDocument.drafts.filter((draft) => draft.profileId === profile.profileId);
                if (!grouped.length) return null;
                return <section className={styles.draftGroup} key={profile.profileId} aria-label={`${profile.name} publication drafts`}><header><strong>{profile.name}</strong><small>{profile.registryId} · {profile.publisherId}</small></header>{grouped.map((draft) => <button type="button" className={styles.draftButton} data-selected={selectedDraftId === draft.draftId || undefined} key={draft.draftId} onClick={() => setSelectedDraftId(draft.draftId)}><span className={styles.kindLabel}>{draft.contentKind}</span><strong>{draft.item.displayName}</strong><small>{draft.item.itemId}@{draft.release.releaseVersion}</small><span className={styles.draftState}>{draft.state}</span></button>)}</section>;
            })}{draftsDocument.drafts.length === 0 ? <div className={styles.publishEmptyState}><IconTrash size={22} /><p>Select local content to start a durable publication draft.</p></div> : null}</div>
        </section>
        <PublicationDraftEditor key={selected ? `${selected.draftId}:${selected.revision}` : "empty"} draft={selected} drafts={draftsDocument.drafts} profiles={profilesDocument.profiles} onSave={saveDraft} onDelete={deleteDraft} onPrepare={prepare} onUploadPreview={uploadPreview} onRemovePreview={removePreview} onRemoveAssetRoot={removeAssetRoot} busy={busy} error={null} />
        <PublisherProfileDialog open={profileDialog} onOpenChange={setProfileDialog} sources={sources} profilesRevision={profilesDocument.revision} onCreate={addProfile} busy={busy} />
        <PublicationReviewDialog plan={plan} job={job} open={Boolean(plan)} onOpenChange={(open) => !open && setPlan(null)} onStart={start} onCommit={commit} onCancel={cancel} onResume={resume} onReplan={replan} onOpenPublished={onOpenPublished} busy={busy} />
    </div>;
}
