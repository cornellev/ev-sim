'use client';

import { useState } from "react";

import { Button, DialogSurface, Field, NativeSelect, Textarea, TextInput } from "../../../ui";
import styles from "../MarketplaceWorkspace.module.css";

export default function PublisherProfileDialog({ open, onOpenChange, sources, profilesRevision, onCreate, busy = false }) {
    const [name, setName] = useState("");
    const [sourceId, setSourceId] = useState("");
    const [publisherId, setPublisherId] = useState("");
    const [writeToken, setWriteToken] = useState("");
    const [privateKeyPem, setPrivateKeyPem] = useState("");
    const clear = () => { setName(""); setSourceId(""); setPublisherId(""); setWriteToken(""); setPrivateKeyPem(""); };
    const changeOpen = (next) => { if (!next) clear(); onOpenChange(next); };
    const submit = async () => {
        await onCreate({ expectedRevision: profilesRevision, name, sourceId, publisherId, writeToken, privateKeyPem });
        clear();
    };
    const ready = name.trim() && sourceId && publisherId.trim() && writeToken && privateKeyPem.includes("PRIVATE KEY");
    return <DialogSurface
        open={open}
        onOpenChange={changeOpen}
        title="Add publisher profile"
        description="The write token and Ed25519 private key are imported once into owner-only backend storage. They are never returned to this browser."
        className={styles.publisherDialog}
        footer={<><Button onClick={() => changeOpen(false)}>Cancel</Button><Button variant="primary" disabled={!ready || busy} onClick={submit}>{busy ? "Verifying…" : "Verify & save"}</Button></>}
    >
        <div className={styles.dialogFields}>
            <Field label="Profile name"><TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Production publisher" /></Field>
            <Field label="Target source"><NativeSelect value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Select a verified source</option>{sources.filter((source) => source.enabled).map((source) => <option value={source.sourceId} key={source.sourceId}>{source.name}</option>)}</NativeSelect></Field>
            <Field label="Publisher ID"><TextInput value={publisherId} onChange={(event) => setPublisherId(event.target.value)} placeholder="com.example.publisher" /></Field>
            <Field label="Write bearer token"><TextInput type="password" autoComplete="off" value={writeToken} onChange={(event) => setWriteToken(event.target.value)} /></Field>
        </div>
        <Field label="Ed25519 PKCS#8 private key"><Textarea className={styles.keyTextarea} spellCheck={false} value={privateKeyPem} onChange={(event) => setPrivateKeyPem(event.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
    </DialogSurface>;
}
