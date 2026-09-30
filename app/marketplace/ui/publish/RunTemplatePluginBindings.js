'use client';

import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import { Button, Field, NativeSelect } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

export default function RunTemplatePluginBindings({ draft, selection, drafts, releaseOptions = [], onChange }) {
    const [draftTarget, setDraftTarget] = useState("");
    const [releaseTarget, setReleaseTarget] = useState("");
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
    const addRelease = () => {
        const option = releaseOptions.find((entry) => entry.optionId === releaseTarget && entry.plugin?.packageHash);
        if (!option) return;
        onChange({
            ...selection,
            pluginBindings: [...selection.pluginBindings, {
                packageHash: option.plugin.packageHash,
                target: option.target,
            }],
        });
        setReleaseTarget("");
    };
    const remove = (index) => onChange({
        ...selection,
        pluginBindings: selection.pluginBindings.filter((_, current) => current !== index),
    });
    return <section className={styles.collectionComposer} aria-labelledby="run-template-plugin-bindings-heading">
        <h3 id="run-template-plugin-bindings-heading">Embedded plugin releases</h3>
        <p>Bind every packaged plugin hash to a local plugin draft or an exact release in this profile’s registry.</p>
        <ul className={styles.collectionMembers}>{selection.pluginBindings.map((binding, index) => <li key={binding.packageHash}>
            <div><strong>{binding.target.type === "draft" ? drafts.find((entry) => entry.draftId === binding.target.draftId)?.item.displayName ?? "Local plugin draft" : releaseOptions.find((entry) => entry.target.itemId === binding.target.itemId && entry.target.releaseVersion === binding.target.releaseVersion)?.displayName ?? binding.target.itemId}</strong><small>{binding.target.type === "draft" ? "Publishes with this item" : `Version ${binding.target.releaseVersion}`}</small></div>
            <Button size="compact" variant="danger" aria-label="Remove plugin release" onClick={() => remove(index)}><IconTrash size={13} /></Button>
        </li>)}</ul>
        <div className={`${styles.memberForm} ${styles.pluginBindingDraftForm}`}><Field label="Local plugin draft"><NativeSelect value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)}><option value="">Select a plugin draft</option>{candidates.map((entry) => <option value={entry.draftId} key={entry.draftId}>{entry.item.displayName} · {entry.localSelection.packageHash}</option>)}</NativeSelect></Field><Button size="compact" disabled={!draftTarget} onClick={addDraft}><IconPlus size={13} /> Bind draft</Button></div>
        <div className={`${styles.memberForm} ${styles.pluginBindingExactForm}`}><Field label="Verified plugin release"><NativeSelect value={releaseTarget} onChange={(event) => setReleaseTarget(event.target.value)}><option value="">Select a plugin release</option>{releaseOptions.filter((option) => option.plugin && !selection.pluginBindings.some((binding) => binding.packageHash === option.plugin.packageHash)).map((option) => <option value={option.optionId} key={option.optionId}>{option.displayName} · {option.releaseVersion}</option>)}</NativeSelect></Field><Button size="compact" disabled={!releaseTarget} onClick={addRelease}><IconPlus size={13} /> Bind release</Button></div>
    </section>;
}
