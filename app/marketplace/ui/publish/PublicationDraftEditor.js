'use client';

import { useState } from "react";
import { IconPhotoPlus, IconTrash } from "@tabler/icons-react";

import { Button, Field, NativeSelect, StatusMessage, Textarea, TextInput } from "../../../ui";
import CollectionComposer from "./CollectionComposer.js";
import RunTemplatePluginBindings from "./RunTemplatePluginBindings.js";
import styles from "../MarketplaceWorkspace.module.css";

function commaList(value) {
    return value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

export default function PublicationDraftEditor({ draft, drafts, profiles, onSave, onDelete, onPrepare, onUploadPreview, onRemovePreview, onRemoveAssetRoot, busy, error }) {
    const [item, setItem] = useState(draft?.item ?? null);
    const [release, setRelease] = useState(draft?.release ?? null);
    const [members, setMembers] = useState(draft?.members ?? []);
    const [localSelection, setLocalSelection] = useState(draft?.localSelection ?? null);
    const [profileId, setProfileId] = useState(draft?.profileId ?? "");
    if (!draft || !item || !release || !localSelection) return <section className={`${styles.publishColumn} ${styles.publishInspector}`}><div className={styles.publishEmptyState}><h2>Select a publication draft</h2><p>Edit listing metadata, inspect exact content, and prepare a registry write plan here.</p></div></section>;
    const dirty = JSON.stringify(item) !== JSON.stringify(draft.item) || JSON.stringify(release) !== JSON.stringify(draft.release)
        || JSON.stringify(members) !== JSON.stringify(draft.members) || JSON.stringify(localSelection) !== JSON.stringify(draft.localSelection)
        || profileId !== draft.profileId;
    const save = () => onSave(draft.draftId, { expectedRevision: draft.revision, profileId, localSelection, item, release, members });
    const updateItem = (field, value) => setItem((current) => ({ ...current, [field]: value }));
    const updateRelease = (field, value) => setRelease((current) => ({ ...current, [field]: value }));
    return <section className={`${styles.publishColumn} ${styles.publishInspector}`} aria-labelledby="publication-editor-heading">
        <header className={styles.publishColumnHeader}><div><span className={styles.kindLabel}>{draft.contentKind}</span><h2 id="publication-editor-heading">{item.displayName}</h2><p>Draft revision {draft.revision} · {draft.state}</p></div><Button size="compact" variant="danger" onClick={() => onDelete(draft)}><IconTrash size={14} /> Delete</Button></header>
        <div className={styles.publishEditorBody}>
            {error && <StatusMessage tone="danger" title="Publication draft operation failed">{error}</StatusMessage>}
            <div className={styles.publisherMetadataBanner}><strong>Immutable local selection</strong><code>{JSON.stringify(draft.localSelection)}</code></div>
            <div className={styles.publisherMetadataBanner}><strong>{draft.mode === "new-release" ? "New immutable release" : "New marketplace item"}</strong><span>{draft.mode === "new-release" ? "The existing publisher and content kind are locked to the verified registry item." : "Preparation requires this item ID to be absent from the verified registry snapshot."}</span></div>
            {draft.contentKind === "asset-pack" ? <section className={styles.assetPackBasket}><h3>Asset-pack basket</h3><p>Add assets from the Local catalog. The exact root revisions below are pinned during preparation.</p><ul>{draft.localSelection.roots.map((root) => <li key={`${root.assetId}:${root.revision}`}><code>{root.assetId}@{root.revision}</code><Button size="compact" variant="danger" disabled={busy || draft.localSelection.roots.length === 1} aria-label={`Remove ${root.assetId} from asset pack`} onClick={() => onRemoveAssetRoot(draft, root.assetId)}><IconTrash size={13} /></Button></li>)}</ul></section> : null}
            <div className={styles.publishFormGrid}>
                <Field label="Publisher profile"><NativeSelect value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.profileId} key={profile.profileId}>{profile.name} · {profile.publisherId}</option>)}</NativeSelect></Field>
                <Field label="Item ID"><TextInput disabled={draft.contentKind === "plugin" || draft.mode === "new-release"} value={item.itemId} onChange={(event) => updateItem("itemId", event.target.value)} /></Field>
                <Field label="Display name"><TextInput value={item.displayName} onChange={(event) => updateItem("displayName", event.target.value)} /></Field>
                <Field label="Summary"><TextInput value={item.summary} onChange={(event) => updateItem("summary", event.target.value)} /></Field>
                <Field label="Categories (comma separated)"><TextInput value={item.categories.join(", ")} onChange={(event) => updateItem("categories", commaList(event.target.value))} /></Field>
                <Field label="Tags (comma separated)"><TextInput value={item.tags.join(", ")} onChange={(event) => updateItem("tags", commaList(event.target.value))} /></Field>
            </div>
            <Field label="Description"><Textarea value={item.description} onChange={(event) => updateItem("description", event.target.value)} /></Field>
            <div className={styles.publishFormGrid}>
                <Field label="Release version"><TextInput value={release.releaseVersion} onChange={(event) => updateRelease("releaseVersion", event.target.value)} /></Field>
                <Field label="License expression"><TextInput value={release.licenseExpression} onChange={(event) => updateRelease("licenseExpression", event.target.value)} /></Field>
                <Field label="Track"><NativeSelect value={release.track ?? ""} onChange={(event) => updateRelease("track", event.target.value || null)}><option value="">No track move</option><option value="stable">Stable</option><option value="beta">Beta</option></NativeSelect></Field>
                <Field label="cev-sim compatibility"><TextInput value={release.compatibility.cevSim} onChange={(event) => updateRelease("compatibility", { ...release.compatibility, cevSim: event.target.value })} /></Field>
            </div>
            <Field label="Changelog"><Textarea value={release.changelog} onChange={(event) => updateRelease("changelog", event.target.value)} /></Field>
            {draft.contentKind === "collection" ? <CollectionComposer draft={{ ...draft, members }} drafts={drafts} onChange={setMembers} /> : null}
            {draft.contentKind === "run-template" ? <RunTemplatePluginBindings draft={{ ...draft, profileId }} selection={localSelection} drafts={drafts} onChange={setLocalSelection} /> : null}
            <section className={styles.previewEditor}><header><div><h3>Listing images</h3><p>Optional bounded PNG, JPEG, or WebP files. Images publish before the item document.</p></div><label className={styles.fileButton}><IconPhotoPlus size={14} /> Add image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadPreview(draft, file); event.target.value = ""; }} /></label></header>{item.previews.length ? <ul>{item.previews.map((preview) => <li key={preview.sha256}><span>{preview.alt}</span><code>{preview.sha256}</code><Button size="compact" variant="danger" disabled={busy} aria-label={`Remove ${preview.alt}`} onClick={() => onRemovePreview(draft, preview.sha256)}><IconTrash size={13} /></Button></li>)}</ul> : <p className={styles.muted}>No listing images attached.</p>}</section>
        </div>
        <footer className={styles.publishEditorFooter}><Button disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save draft"}</Button><Button variant="primary" disabled={dirty || busy || (draft.contentKind === "collection" && !members.length)} onClick={() => onPrepare(draft)}>Prepare & inspect</Button></footer>
    </section>;
}
