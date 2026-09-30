'use client';

import { useState } from "react";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";

import { Button, Field, NativeSelect, TextInput } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

export default function CollectionComposer({ draft, drafts, onChange }) {
    const [draftTarget, setDraftTarget] = useState("");
    const [itemId, setItemId] = useState("");
    const [releaseVersion, setReleaseVersion] = useState("");
    const [artifactSha256, setArtifactSha256] = useState("");
    const [group, setGroup] = useState("");
    const candidates = drafts.filter((entry) => entry.draftId !== draft.draftId && entry.profileId === draft.profileId);
    const move = (index, direction) => {
        const members = [...draft.members];
        const target = index + direction;
        if (target < 0 || target >= members.length) return;
        [members[index], members[target]] = [members[target], members[index]];
        onChange(members);
    };
    const addDraft = () => {
        if (!draftTarget) return;
        onChange([...draft.members, { target: { type: "draft", draftId: draftTarget }, group: group.trim() || null }]);
        setDraftTarget(""); setGroup("");
    };
    const addRelease = () => {
        if (!itemId || !releaseVersion || !/^[a-f0-9]{64}$/u.test(artifactSha256)) return;
        onChange([...draft.members, { target: { type: "release", itemId, releaseVersion, artifactSha256 }, group: group.trim() || null }]);
        setItemId(""); setReleaseVersion(""); setArtifactSha256(""); setGroup("");
    };
    return <section className={styles.collectionComposer} aria-labelledby="collection-members-heading">
        <h3 id="collection-members-heading">Collection members</h3>
        <p>Members publish dependency-first. Exact releases must already exist on this profile’s target registry.</p>
        <ol className={styles.collectionMembers}>{draft.members.map((member, index) => <li key={member.target.type === "draft" ? member.target.draftId : `${member.target.itemId}:${member.target.releaseVersion}:${member.target.artifactSha256}`}>
            <div><strong>{member.target.type === "draft" ? drafts.find((entry) => entry.draftId === member.target.draftId)?.item.displayName ?? member.target.draftId : `${member.target.itemId}@${member.target.releaseVersion}`}</strong><small>{member.group || "Ungrouped"}</small></div>
            <div className={styles.memberActions}><Button size="compact" aria-label="Move member up" disabled={index === 0} onClick={() => move(index, -1)}><IconArrowUp size={13} /></Button><Button size="compact" aria-label="Move member down" disabled={index === draft.members.length - 1} onClick={() => move(index, 1)}><IconArrowDown size={13} /></Button><Button size="compact" variant="danger" aria-label="Remove member" onClick={() => onChange(draft.members.filter((_, current) => current !== index))}><IconTrash size={13} /></Button></div>
        </li>)}</ol>
        <div className={styles.memberForm}><Field label="Local draft"><NativeSelect value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)}><option value="">Select a draft</option>{candidates.map((entry) => <option value={entry.draftId} key={entry.draftId}>{entry.item.displayName} · {entry.contentKind}</option>)}</NativeSelect></Field><Field label="Group"><TextInput value={group} onChange={(event) => setGroup(event.target.value)} /></Field><Button size="compact" disabled={!draftTarget} onClick={addDraft}><IconPlus size={13} /> Add draft</Button></div>
        <div className={styles.exactMemberForm}><Field label="Published item ID"><TextInput value={itemId} onChange={(event) => setItemId(event.target.value)} /></Field><Field label="Version"><TextInput value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} /></Field><Field label="Artifact SHA-256"><TextInput value={artifactSha256} onChange={(event) => setArtifactSha256(event.target.value)} /></Field><Button size="compact" disabled={!itemId || !releaseVersion || !/^[a-f0-9]{64}$/u.test(artifactSha256)} onClick={addRelease}><IconPlus size={13} /> Add release</Button></div>
    </section>;
}

