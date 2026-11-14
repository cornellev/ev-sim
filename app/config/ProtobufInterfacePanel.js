'use client';

import { useId } from "react";
import { Button, Field, StatusMessage } from "../ui";
import { uploadedDescriptorSource, uploadedProtoSource } from "./protobufInterfaceAuthoring.js";

const paths = (text) => text.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);

export default function ProtobufInterfacePanel({ session, state, draft, blocked, onRoutes, onAdopt, onEnable, onMigration }) {
    const id = useId();
    const run = (operation) => {
        const epoch = session.epoch;
        Promise.resolve().then(() => epoch === session.epoch ? operation() : undefined)
            .catch((error) => { if (epoch === session.epoch) session.set({ error: error.message }); });
    };
    const field = (key, label, placeholder = "") => <Field label={label}><input className="sf-input" value={state.fields[key]} placeholder={placeholder} disabled={blocked || state.busy}
        onChange={(event) => session.set({ fields: { ...state.fields, [key]: event.target.value } })} /></Field>;
    const source = async (files = []) => {
        const { fields } = state;
        if (fields.kind === "github") return { kind: "github", url: fields.url, ref: fields.ref, entryFiles: paths(fields.entryFiles), includeDirs: paths(fields.includeDirs) };
        if (fields.kind === "descriptor") return uploadedDescriptorSource(files[0]);
        return uploadedProtoSource(files, paths(fields.entryFiles), paths(fields.includeDirs));
    };
    const importFiles = (files) => run(async () => {
        const epoch = session.epoch;
        if (state.fields.kind === "interface") {
            if (!files[0] || files[0].size > 16 * 1024 * 1024) throw new Error("Interface JSON exceeds 16 MiB.");
            await session.work(async (current) => { const result = await session.request("", { document: JSON.parse(await files[0].text()) });
                if (current()) onAdopt(session.adopt(result)); });
        } else {
            const uploaded = await source(files);
            if (epoch !== session.epoch) return;
            const resource = await session.importSource(uploaded); if (resource) onAdopt(resource);
        }
    });
    const selectedSource = state.source?.schemaSources.find((item) => item.schemaId === state.fields.schemaId);
    const unavailable = blocked || state.busy;
    return <section aria-label="Protobuf interface" className="min-w-0 space-y-4 rounded-[var(--radius)] border border-[var(--slate-border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">Protobuf interface</h2>
            <Button size="sm" disabled={unavailable} onClick={() => run(() => session.list())}>Refresh interfaces</Button></div>
        <p className="text-[13px] text-[var(--slate-muted)]">Import a schema, define routes, then explicitly enable its immutable pin on this run.</p>
        <Field label="Stored interface"><select className="sf-input" value={state.hash ?? ""} disabled={unavailable} onChange={(event) => {
            const hash = event.target.value;
            if (hash) run(async () => { const tracked = state.catalog.sources.find((item) => item.interfaceHash === hash);
                const resource = await session.select(hash, tracked?.id); if (resource) onAdopt(resource); });
        }}><option value="">Select an interface</option>{state.hash && !state.catalog.interfaces.some((item) => item.hash === state.hash)
            && <option value={state.hash}>{state.hash.slice(0, 16)}… (selected)</option>}
            {state.catalog.interfaces.map((item) => <option key={item.hash} value={item.hash}>{item.hash.slice(0, 16)}… · {item.routeCount} routes</option>)}</select></Field>
        <div className="grid gap-3 min-[700px]:grid-cols-2">{field("sourceId", "Source ID", "my-interface")}{field("schemaId", "Schema ID", "schema")}
            <Field label="Import format"><select className="sf-input" value={state.fields.kind} disabled={unavailable} onChange={(event) => session.set({ fields: { ...state.fields, kind: event.target.value } })}>
                <option value="proto">Proto files with imports</option><option value="descriptor">Binary FileDescriptorSet</option><option value="github">Public GitHub source</option><option value="interface">Interface JSON</option>
            </select></Field>
            {state.fields.kind === "github" && <>{field("url", "GitHub URL", "https://github.com/owner/repo")}{field("ref", "GitHub ref", "main")}</>}
            {["proto", "github"].includes(state.fields.kind) && <>{field("entryFiles", "Entry files", "messages.proto (comma separated)")}{field("includeDirs", "Include directories", ". (comma separated)")}</>}
        </div>
        {state.fields.kind === "github" ? <Button disabled={unavailable} onClick={() => importFiles([])}>Import GitHub schema</Button>
            : <Field label={state.fields.kind === "interface" ? "Interface JSON file" : "Schema files"}><input key={state.fields.kind} className="sf-input" type="file" multiple={state.fields.kind === "proto"}
                accept={state.fields.kind === "proto" ? ".proto" : state.fields.kind === "interface" ? ".json" : ".binpb,.pb,.protoset"} disabled={unavailable}
                onChange={(event) => { importFiles([...event.target.files]); event.target.value = ""; }} /></Field>}
        {state.fields.kind === "proto" && <Field label="Proto directory (preserve import paths)"><input className="sf-input" type="file" multiple webkitdirectory="" directory="" disabled={unavailable}
            onChange={(event) => { importFiles([...event.target.files].filter((file) => file.name.endsWith(".proto"))); event.target.value = ""; }} /></Field>}
        {state.document && <>
            <p className="break-all font-mono text-[11px] text-[var(--slate-muted)]">Interface@{state.document.version} · {state.hash}</p>
            <Field label="Routes and bootstrap JSON"><textarea id={`${id}-routes`} aria-label="Routes and bootstrap JSON" className="sf-input min-h-64 resize-y font-mono text-[12px]"
                spellCheck={false} value={state.text} disabled={state.busy} onChange={(event) => onRoutes(event.target.value)} /></Field>
            <div className="flex flex-wrap items-center gap-3"><Button disabled={unavailable} onClick={() => run(() => session.work(() => session.persist()))}>Save interface</Button>
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.protobuf?.mode === "zenoh"} disabled={unavailable || draft.version !== 13 || state.document.version !== 2}
                    onChange={(event) => onEnable(event.target.checked)} />Enable Zenoh for this run</label>
                {draft.version === 13 && draft.protobuf?.mode === "zenoh" && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.protobuf.externalController}
                    disabled={unavailable} onChange={(event) => onEnable(true, event.target.checked)} />External controller</label>}
            </div>
            {state.source && <div className="space-y-2 border-t border-[var(--slate-border)] pt-3">
                <p className="break-all text-[12px]">Source {state.source.id} · revision {state.source.revision}{selectedSource?.resolvedCommitSha ? ` · commit ${selectedSource.resolvedCommitSha}` : ""}</p>
                <Button disabled={unavailable || selectedSource?.kind !== "github"} onClick={() => run(() => session.checkUpdate())}>Check GitHub update</Button>
                {selectedSource && selectedSource.kind !== "github" && <Field label="Replacement schema files"><input className="sf-input" type="file" multiple={selectedSource.kind === "uploaded-proto"}
                    disabled={unavailable} onChange={(event) => { const files = [...event.target.files]; run(async () => {
                        const epoch = session.epoch; const uploaded = await source(files);
                        if (epoch === session.epoch) await session.checkUpdate(uploaded);
                    }); event.target.value = ""; }} /></Field>}
                {state.check && <details open><summary className="cursor-pointer text-[13px]">Update preview</summary>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(state.check, null, 2)}</pre>
                    <Button disabled={unavailable} onClick={() => run(async () => { const resource = await session.applyUpdate(false); if (resource) onAdopt(resource); })}>Apply valid update</Button>
                    {!!(state.check.invalidatedRoutes?.length || state.check.invalidatedBootstrap?.length) && <Button disabled={unavailable} onClick={() => run(async () => {
                        const resource = await session.applyUpdate(true); if (resource) onAdopt(resource);
                    })}>Apply and keep invalid entries disabled</Button>}
                </details>}
                {!!(state.source.invalidatedRoutes.length || state.source.invalidatedBootstrap.length) && <details><summary className="cursor-pointer text-[13px]">Disabled drafts to repair</summary>
                    <p className="text-[12px]">Copy a definition into the JSON editor, fix its mapping, and save to reactivate it.</p>
                    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify({ routes: state.source.invalidatedRoutes, bootstrap: state.source.invalidatedBootstrap }, null, 2)}</pre>
                </details>}
            </div>}
        </>}
        {draft.version !== 13 && <div className="space-y-2 border-t border-[var(--slate-border)] pt-3">
            <p className="text-[12px]">Browser Zenoh requires a reviewed native v13 run. Save your run before previewing migration.</p>
            <Button disabled={unavailable} onClick={() => run(() => onMigration("plan"))}>Preview native migration</Button>
            {state.migration && <><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify({ changes: state.migration.changes, blocked: state.migration.blocked, candidate: state.migration.candidate }, null, 2)}</pre>
                <Button disabled={unavailable || !state.migration.ok} onClick={() => run(() => onMigration("apply"))}>Apply reviewed native migration</Button></>}
        </div>}
        {state.error && <StatusMessage tone="danger" title="Interface needs attention">{state.error}</StatusMessage>}
    </section>;
}
