'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { IconPhotoPlus, IconTrash } from "@tabler/icons-react";

import { Button, Field, NativeSelect, StatusMessage, Textarea, TextInput } from "../../../ui";
import { publicationPreviewUrl } from "../../MarketplaceClient.js";
import { displayKind } from "../presentation.js";
import CollectionComposer from "./CollectionComposer.js";
import RunTemplatePluginBindings from "./RunTemplatePluginBindings.js";
import styles from "../MarketplaceWorkspace.module.css";

function ChipInput({ label, values, onChange }) {
    const [value, setValue] = useState("");
    const add = () => {
        const normalized = value.trim().toLowerCase();
        if (normalized && !values.includes(normalized)) onChange([...values, normalized]);
        setValue("");
    };
    return <Field label={label}><div className={styles.chipInput}><div className={styles.chips}>{values.map((entry) => <button type="button" key={entry} aria-label={`Remove ${entry}`} onClick={() => onChange(values.filter((candidate) => candidate !== entry))}>{entry}<span aria-hidden="true">×</span></button>)}</div><TextInput value={value} onChange={(event) => setValue(event.target.value)} onBlur={add} onKeyDown={(event) => { if (["Enter", ","].includes(event.key)) { event.preventDefault(); add(); } }} placeholder="Type and press Enter" /></div></Field>;
}

export default function PublicationDraftEditorStreamlined({ draft, drafts, releaseOptions, onSave, onDelete, onPrepare, onUploadPreview, onRemovePreview, onRemoveAssetRoot, busy, error }) {
    const [item, setItem] = useState(draft?.item ?? null);
    const [release, setRelease] = useState(draft?.release ?? null);
    const [members, setMembers] = useState(draft?.members ?? []);
    const [localSelection, setLocalSelection] = useState(draft?.localSelection ?? null);
    const [saveState, setSaveState] = useState("saved");
    const saveGeneration = useRef(0);
    const serverPreviews = draft?.item.previews ?? null;
    const serverAssetSelection = draft?.contentKind === "asset-pack" ? draft.localSelection : null;
    useEffect(() => {
        if (!serverPreviews) return undefined;
        const timer = setTimeout(() => {
            setItem((current) => current ? { ...current, previews: serverPreviews } : current);
        }, 0);
        return () => clearTimeout(timer);
    }, [serverPreviews]);
    useEffect(() => {
        if (!serverAssetSelection) return undefined;
        const timer = setTimeout(() => {
            setLocalSelection((current) => current ? { ...current, ...serverAssetSelection } : current);
        }, 0);
        return () => clearTimeout(timer);
    }, [serverAssetSelection]);
    const payload = useMemo(() => draft && item && release && localSelection ? {
        expectedRevision: draft.revision,
        localSelection,
        item,
        release,
        members,
    } : null, [draft, item, localSelection, members, release]);
    const dirty = Boolean(payload) && (JSON.stringify(item) !== JSON.stringify(draft.item)
        || JSON.stringify(release) !== JSON.stringify(draft.release)
        || JSON.stringify(members) !== JSON.stringify(draft.members)
        || JSON.stringify(localSelection) !== JSON.stringify(draft.localSelection));

    useEffect(() => {
        if (!dirty || busy || !payload) return undefined;
        const generation = saveGeneration.current + 1;
        saveGeneration.current = generation;
        const timer = setTimeout(async () => {
            if (saveGeneration.current !== generation) return;
            setSaveState("saving");
            const result = await onSave(draft.draftId, payload, { quiet: true });
            setSaveState(result ? "saved" : "error");
        }, 500);
        return () => clearTimeout(timer);
    }, [busy, dirty, draft?.draftId, onSave, payload]);

    if (!draft || !item || !release || !localSelection) return <section className={`${styles.publishColumn} ${styles.publishInspector}`}><div className={styles.publishEmptyState}><h2>Select content to publish</h2><p>Choose an authored item. Marketplace will determine whether it is new or an update.</p></div></section>;
    const updateItem = (field, value) => setItem((current) => ({ ...current, [field]: value }));
    const updateRelease = (field, value) => setRelease((current) => ({ ...current, [field]: value }));
    const visibleSaveState = dirty && saveState === "saved" ? "pending" : saveState;
    const review = async () => {
        let current = draft;
        if (dirty) {
            const result = await onSave(draft.draftId, payload);
            if (!result) return;
            current = result.draft;
        }
        await onPrepare(current);
    };
    const saveOnExit = () => {
        if (!dirty || !payload || busy) return;
        saveGeneration.current += 1;
        setSaveState("saving");
        onSave(draft.draftId, payload, { quiet: true }).then((result) => setSaveState(result ? "saved" : "error"));
    };
    return <section className={`${styles.publishColumn} ${styles.publishInspector}`} aria-labelledby="publication-editor-heading" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) saveOnExit(); }}>
        <header className={styles.publishColumnHeader}><div><span className={styles.kindLabel}>{displayKind(draft.contentKind)}</span><h2 id="publication-editor-heading">{item.displayName}</h2><p>{visibleSaveState === "saved" ? "Saved" : visibleSaveState === "saving" ? "Saving…" : visibleSaveState === "error" ? "Save failed" : "Unsaved changes"}</p></div><Button size="compact" variant="danger" onClick={() => onDelete(draft)}><IconTrash size={14} /> Delete</Button></header>
        <div className={styles.publishEditorBody}>
            {error && <StatusMessage tone="danger" title="Publication draft operation failed">{error}</StatusMessage>}
            <div className={styles.publishFormGrid}>
                <Field label="Display name"><TextInput value={item.displayName} onChange={(event) => updateItem("displayName", event.target.value)} /></Field>
                <Field label="Summary"><TextInput value={item.summary} onChange={(event) => updateItem("summary", event.target.value)} /></Field>
            </div>
            <Field label="Description"><Textarea value={item.description} onChange={(event) => updateItem("description", event.target.value)} /></Field>
            <Field label="What changed"><Textarea value={release.changelog} onChange={(event) => updateRelease("changelog", event.target.value)} /></Field>
            {draft.contentKind === "asset-pack" ? <section className={styles.assetPackBasket}><h3>Included assets</h3><p>Add assets from the local catalog. Exact revisions are pinned automatically.</p><ul>{draft.localSelection.roots.map((root) => <li key={`${root.assetId}:${root.revision}`}><code>{root.assetId}</code><Button size="compact" variant="danger" disabled={busy || draft.localSelection.roots.length === 1} aria-label={`Remove ${root.assetId} from asset pack`} onClick={() => onRemoveAssetRoot(draft, root.assetId)}><IconTrash size={13} /></Button></li>)}</ul></section> : null}
            {draft.contentKind === "collection" ? <CollectionComposer draft={{ ...draft, members, releaseOptions }} drafts={drafts} onChange={setMembers} /> : null}
            {draft.contentKind === "run-template" ? <RunTemplatePluginBindings draft={draft} selection={localSelection} drafts={drafts} releaseOptions={releaseOptions.filter((option) => option.contentKind === "plugin")} onChange={setLocalSelection} /> : null}
            <div className={styles.publishFormGrid}>
                <ChipInput label="Categories" values={item.categories} onChange={(value) => updateItem("categories", value)} />
                <ChipInput label="Tags" values={item.tags} onChange={(value) => updateItem("tags", value)} />
                <Field label="Release version"><TextInput disabled={draft.contentKind === "plugin"} value={release.releaseVersion} onChange={(event) => updateRelease("releaseVersion", event.target.value)} /></Field>
                <Field label="License"><TextInput value={release.licenseExpression} onChange={(event) => updateRelease("licenseExpression", event.target.value)} /></Field>
                <Field label="Track"><NativeSelect value={release.track ?? ""} onChange={(event) => updateRelease("track", event.target.value || null)}><option value="stable">Stable</option><option value="beta">Beta</option><option value="">No track move</option></NativeSelect></Field>
            </div>
            <section className={styles.previewEditor}><header><div><h3>Listing images</h3><p>Optional PNG, JPEG, or WebP previews.</p></div><label className={styles.fileButton}><IconPhotoPlus size={14} /> Add image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadPreview(draft, file); event.target.value = ""; }} /></label></header>{item.previews.length ? <ul>{item.previews.map((preview) => (
                <li key={preview.sha256}>
                    {/* Draft bytes are served by the local preview route. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className={styles.listingThumb} src={publicationPreviewUrl(draft.draftId, preview.sha256)} alt={preview.alt} />
                    <span>{preview.alt}</span>
                    <Button size="compact" variant="danger" disabled={busy} aria-label={`Remove ${preview.alt}`} onClick={() => onRemovePreview(draft, preview.sha256)}><IconTrash size={13} /></Button>
                </li>
            ))}</ul> : <p className={styles.muted}>No listing images attached.</p>}</section>
            <details className={styles.technicalDetails}>
                <summary>Technical details</summary>
                <dl className={styles.metadata}><div><dt>Marketplace item</dt><dd>{item.itemId}</dd></div><div><dt>Publication type</dt><dd>{draft.mode === "new-release" ? "Update existing item" : "Create item"}</dd></div><div><dt>Compatibility</dt><dd>{release.compatibility.cevSim}</dd></div></dl>
                <details><summary>Local selection</summary><code>{JSON.stringify(localSelection)}</code></details>
            </details>
        </div>
        <footer className={styles.publishEditorFooter}><span className={styles.muted}>Changes save automatically.</span><Button variant="primary" disabled={busy || (draft.contentKind === "collection" && !members.length)} onClick={review}>Review publication</Button></footer>
    </section>;
}
