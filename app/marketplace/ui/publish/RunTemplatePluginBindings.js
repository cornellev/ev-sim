'use client';

import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import { Button, Field, NativeSelect, TextInput } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

export default function RunTemplatePluginBindings({ draft, selection, drafts, onChange }) {
    const [draftTarget, setDraftTarget] = useState("");
    const [packageHash, setPackageHash] = useState("");
    const [itemId, setItemId] = useState("");
    const [releaseVersion, setReleaseVersion] = useState("");
    const [artifactSha256, setArtifactSha256] = useState("");
    const candidates = drafts.filter((entry) => entry.contentKind === "plugin" && entry.profileId === draft.profileId
        && !selection.pluginBindings.some((binding) => binding.target.type === "draft" && binding.target.draftId === entry.draftId));
    const addDraft = () => {
        const candidate = candidates.find((entry) => entry.draftId === draftTarget);
        if (!candidate) return;
        onChange({
            ...selection,
            pluginBindings: [...selection.pluginBindings, {
                packageHash: candidate.localSelection.packageHash,
                target: { type: "draft", draftId: candidate.draftId },
            }],
        });
        setDraftTarget("");
    };
    const validExact = /^[a-f0-9]{64}$/u.test(packageHash) && itemId && releaseVersion && /^[a-f0-9]{64}$/u.test(artifactSha256);
    const addRelease = () => {
        if (!validExact) return;
        onChange({
            ...selection,
            pluginBindings: [...selection.pluginBindings, {
                packageHash,
                target: { type: "release", itemId, releaseVersion, artifactSha256 },
            }],
        });
        setPackageHash(""); setItemId(""); setReleaseVersion(""); setArtifactSha256("");
    };
    const remove = (index) => onChange({
        ...selection,
        pluginBindings: selection.pluginBindings.filter((_, current) => current !== index),
    });
    return <section className={styles.collectionComposer} aria-labelledby="run-template-plugin-bindings-heading">
        <h3 id="run-template-plugin-bindings-heading">Embedded plugin releases</h3>
        <p>Bind every packaged plugin hash to a local plugin draft or an exact release in this profile’s registry.</p>
        <ul className={styles.collectionMembers}>{selection.pluginBindings.map((binding, index) => <li key={binding.packageHash}>
            <div><strong>{binding.packageHash}</strong><small>{binding.target.type === "draft" ? `Local draft ${binding.target.draftId}` : `${binding.target.itemId}@${binding.target.releaseVersion}`}</small></div>
            <Button size="compact" variant="danger" aria-label={`Remove plugin binding ${binding.packageHash}`} onClick={() => remove(index)}><IconTrash size={13} /></Button>
        </li>)}</ul>
        <div className={`${styles.memberForm} ${styles.pluginBindingDraftForm}`}><Field label="Local plugin draft"><NativeSelect value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)}><option value="">Select a plugin draft</option>{candidates.map((entry) => <option value={entry.draftId} key={entry.draftId}>{entry.item.displayName} · {entry.localSelection.packageHash}</option>)}</NativeSelect></Field><Button size="compact" disabled={!draftTarget} onClick={addDraft}><IconPlus size={13} /> Bind draft</Button></div>
        <div className={`${styles.exactMemberForm} ${styles.pluginBindingExactForm}`}><Field label="Plugin package SHA-256"><TextInput value={packageHash} onChange={(event) => setPackageHash(event.target.value.trim().toLowerCase())} /></Field><Field label="Published item ID"><TextInput value={itemId} onChange={(event) => setItemId(event.target.value)} /></Field><Field label="Version"><TextInput value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} /></Field><Field label="Artifact SHA-256"><TextInput value={artifactSha256} onChange={(event) => setArtifactSha256(event.target.value.trim().toLowerCase())} /></Field><Button size="compact" disabled={!validExact} onClick={addRelease}><IconPlus size={13} /> Bind release</Button></div>
    </section>;
}
