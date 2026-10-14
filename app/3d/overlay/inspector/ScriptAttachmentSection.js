'use client';

import { useEffect, useState } from "react";
import { Button } from "../../../ui";
import { attachScript, clearAuthoredBy, detachScript, setScriptParameters } from "../../editor/commands/scriptAttachmentCommands.js";
import { applyObjectScript } from "../../editor/scripts/applyObjectScript.js";
import { attachmentContext, runObjectScript } from "../../editor/scripts/runObjectScript.js";
import { getScriptDocument, listScriptDocuments } from "../../../scripting/ScriptStorage.js";
import { artifactHasAuthoringBlocks } from "../../../scripting/units/world/AuthoringBlocks.block.js";
import { ATTACHMENT_HOSTS, readAttachmentFields, scriptHostType } from "../../../scripting/units/world/attachmentHosts.js";

const SCALAR_TYPES = new Set(["float64", "int32", "boolean", "string"]);

function runCommand(data, command, onResult) {
    const result = data?.commands?.()?.execute(command);
    data?.simulation?.()?.render?.();
    onResult?.(result);
    return result;
}

function hostLabel(hostType) {
    return ATTACHMENT_HOSTS[hostType]?.label ?? hostType ?? "any object";
}

export function ScriptAttachmentSection({ data, section, onResult }) {
    const document = data?.environment?.()?.getDocument?.();
    const record = document?.getObject?.(section.record?.id) ?? section.record;
    const attachments = Array.isArray(record?.components?.scripts) ? record.components.scripts : [];
    const [library, setLibrary] = useState([]);
    const [artifacts, setArtifacts] = useState({});
    const [scriptId, setScriptId] = useState("");
    const [status, setStatus] = useState("");

    useEffect(() => {
        let cancelled = false;
        listScriptDocuments()
            .then((documents) => { if (!cancelled) setLibrary(Array.isArray(documents) ? documents : []); })
            .catch((error) => { if (!cancelled) setStatus(error.message); });
        return () => { cancelled = true; };
    }, [record?.id, attachments.length]);

    useEffect(() => {
        let cancelled = false;
        const missing = attachments
            .map((entry) => entry.scriptId)
            .filter((id) => id && !artifacts[id]);
        if (missing.length === 0) return undefined;
        Promise.all(missing.map(async (id) => {
            const fromList = library.find((entry) => entry.id === id && entry.latestValidArtifact);
            return [id, fromList || await getScriptDocument(id)];
        })).then((pairs) => {
            if (cancelled) return;
            setArtifacts((current) => {
                const next = { ...current };
                for (const [id, doc] of pairs) next[id] = doc ?? null;
                return next;
            });
        }).catch((error) => { if (!cancelled) setStatus(error.message); });
        return () => { cancelled = true; };
    }, [attachments, artifacts, library]);

    if (!record) return null;
    const compatible = library.filter((entry) => {
        const host = scriptHostType(entry.latestValidArtifact);
        return host.ok && (!host.typeId || host.typeId === record.typeId);
    });

    const attach = () => {
        const chosen = library.find((entry) => entry.id === scriptId);
        const host = scriptHostType(chosen?.latestValidArtifact);
        if (!chosen || !host.ok) {
            onResult?.({ ok: false, error: host.error || "Choose a compiled script.", issues: [] });
            return;
        }
        runCommand(data, attachScript({
            objectId: record.id,
            scriptId: chosen.id,
            hostType: host.typeId,
            parameters: {},
            seed: 1,
        }), onResult);
    };

    return (
        <div className="space-y-3 py-1 text-[12px]">
            {attachments.length === 0 && <p className="text-[var(--slate-muted)]">No scripts attached.</p>}
            {attachments.map((attachment) => (
                <AttachmentCard
                    key={attachment.id}
                    data={data}
                    document={document}
                    record={record}
                    attachment={attachment}
                    script={artifacts[attachment.scriptId] ?? library.find((entry) => entry.id === attachment.scriptId) ?? null}
                    onResult={onResult}
                    onStatus={setStatus}
                />
            ))}
            <div className="flex items-center gap-1">
                <select
                    aria-label="Script to attach"
                    value={scriptId}
                    onChange={(event) => setScriptId(event.target.value)}
                    className="min-w-0 flex-1 rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1"
                >
                    <option value="">Attach a script</option>
                    {compatible.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>
                    ))}
                </select>
                <Button size="compact" variant="ghost" disabled={!scriptId} onClick={attach}>Attach</Button>
            </div>
            {status && <p role="status" className="text-[var(--slate-warning)]">{status}</p>}
        </div>
    );
}

function AttachmentCard({ data, document, record, attachment, script, onResult, onStatus }) {
    const artifact = script?.latestValidArtifact ?? null;
    const host = scriptHostType(artifact);
    const inputs = artifact?.interface?.inputs ?? [];
    const derived = host.hostType ? readAttachmentFields(host.hostType, attachmentContext(record, document)) : null;
    const parameters = attachment.parameters ?? {};
    const objects = document?.objects ?? [];

    const commitParameters = (next, seed = attachment.seed) => runCommand(data, setScriptParameters({
        objectId: record.id,
        attachmentId: attachment.id,
        parameters: next,
        seed,
    }), onResult);

    const run = () => {
        const ran = runObjectScript({
            artifact,
            record,
            document,
            parameters,
            seed: attachment.seed ?? 1,
        });
        if (!ran.ok) {
            onStatus?.(ran.error);
            onResult?.({ ok: false, error: ran.error, issues: [] });
            return;
        }
        const applied = applyObjectScript(data.commands(), {
            attachmentId: attachment.id,
            scriptId: attachment.scriptId,
            ops: ran.ops,
            label: `Run ${script?.name || attachment.scriptId}`,
        });
        data?.simulation?.()?.render?.();
        onStatus?.(applied.ok ? "" : (applied.error || "Run failed."));
        onResult?.(applied);
    };

    return (
        <div className="space-y-2 rounded border border-[var(--slate-border-60)] p-2">
            <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate font-medium">{script?.name || attachment.scriptId}</p>
                <Button size="compact" variant="ghost" onClick={() => runCommand(data, detachScript({ objectId: record.id, attachmentId: attachment.id }), onResult)}>Detach</Button>
            </div>
            <p className="text-[var(--slate-muted)]">Host {hostLabel(host.hostType)}</p>
            {derived && (
                <div className="space-y-1">
                    {derived.found === false && <p className="text-[var(--slate-warning)]">Attachment does not match this host.</p>}
                    {Object.entries(derived.values).map(([label, value]) => (
                        <label key={label} className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
                            <span className="text-[var(--slate-muted)]">{label}</span>
                            <input readOnly aria-label={label} value={value} className="rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-1)] px-2 py-1 font-mono" />
                        </label>
                    ))}
                </div>
            )}
            {inputs.filter((port) => !derived?.values || !(port.label in derived.values)).map((port) => (
                <ParameterField
                    key={port.uuid || port.label}
                    port={port}
                    value={parameters[port.label]}
                    objects={objects}
                    onChange={(value) => commitParameters({ ...parameters, [port.label]: value })}
                />
            ))}
            <details>
                <summary className="cursor-pointer text-[var(--slate-muted)]">Advanced</summary>
                <label className="mt-1 grid grid-cols-[1fr_1.4fr] items-center gap-2">
                    <span>Seed</span>
                    <input
                        aria-label="Script seed"
                        type="number"
                        value={attachment.seed ?? 1}
                        onChange={(event) => commitParameters(parameters, Number(event.target.value))}
                        className="rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1"
                    />
                </label>
            </details>
            {artifactHasAuthoringBlocks(artifact) && (
                <div className="flex gap-1">
                    <Button size="compact" onClick={run}>Run</Button>
                    <Button size="compact" variant="ghost" onClick={() => runCommand(data, clearAuthoredBy({ attachmentId: attachment.id }), onResult)}>Bake</Button>
                </div>
            )}
        </div>
    );
}

function ParameterField({ port, value, objects, onChange }) {
    const current = value ?? "";
    if (port.type === "scene_object") {
        const choices = objects.filter((entry) => !port.sceneType || entry.typeId === port.sceneType);
        return (
            <label className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
                <span>{port.label}</span>
                <select
                    aria-label={port.label}
                    value={current}
                    onChange={(event) => onChange(event.target.value)}
                    className="rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1"
                >
                    {!port.sceneType && <option value="">Root</option>}
                    {port.sceneType && <option value="">Select {port.sceneType}</option>}
                    {choices.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>
                    ))}
                </select>
            </label>
        );
    }
    if (port.type === "boolean") {
        return (
            <label className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
                <span>{port.label}</span>
                <input aria-label={port.label} type="checkbox" checked={current === true} onChange={(event) => onChange(event.target.checked)} />
            </label>
        );
    }
    if (!SCALAR_TYPES.has(port.type)) return null;
    return (
        <label className="grid grid-cols-[1fr_1.4fr] items-center gap-2">
            <span>{port.label}</span>
            <input
                aria-label={port.label}
                type={port.type === "string" ? "text" : "number"}
                value={current}
                onChange={(event) => onChange(port.type === "string" ? event.target.value : Number(event.target.value))}
                className="rounded border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-2 py-1"
            />
        </label>
    );
}
