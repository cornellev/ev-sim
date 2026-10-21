'use client';

import { useState } from "react";
import { Button, NativeSelect, Switch, TextInput } from "../../../ui";
import { addRigidBody, removeRigidBody, setRigidBody } from "../../editor/commands/rigidBodyCommands.js";

function runCommand(data, command, onResult) {
    const result = data?.commands?.()?.execute(command);
    data?.simulation?.()?.render?.();
    onResult?.(result);
    return result;
}

function NumberField({ label, value, onCommit }) {
    const [draft, setDraft] = useState(null);
    const shown = draft ?? String(value);
    const commit = (text) => {
        setDraft(null);
        if (text !== String(value)) onCommit(text);
    };
    return (
        <label className="grid grid-cols-[minmax(0,88px)_minmax(0,1fr)] items-center gap-x-2 py-1 text-[12px]">
            <span className="truncate text-[var(--slate-fg-2)]">{label}</span>
            <TextInput
                className="sf-input--compact"
                aria-label={label}
                value={shown}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={(event) => { if (draft !== null) commit(event.target.value); }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") { event.preventDefault(); commit(event.currentTarget.value); }
                }}
            />
        </label>
    );
}

export function RigidBodySection({ data, section, onResult }) {
    const document = data?.environment?.()?.getDocument?.();
    const record = document?.getObject?.(section.record?.id) ?? section.record;
    const body = record?.components?.rigidBody ?? null;
    if (!record) return null;
    const edit = (patch) => runCommand(data, setRigidBody({ objectId: record.id, patch }), onResult);
    const force = body?.constantForce ?? { x: 0, y: 0, z: 0 };
    return (
        <div className="space-y-2 py-1">
            {!body && (
                <Button size="compact" onClick={() => runCommand(data, addRigidBody({ objectId: record.id }), onResult)}>
                    Add rigid body
                </Button>
            )}
            {body && (
                <>
                    <label className="grid grid-cols-[minmax(0,88px)_minmax(0,1fr)] items-center gap-x-2 py-1 text-[12px]">
                        <span className="text-[var(--slate-fg-2)]">Body</span>
                        <NativeSelect aria-label="Body type" value={body.bodyType} onChange={(event) => edit({ bodyType: event.target.value })}>
                            <option value="dynamic">Dynamic</option>
                            <option value="kinematic">Kinematic</option>
                        </NativeSelect>
                    </label>
                    <NumberField label="Mass" value={body.mass} onCommit={(text) => edit({ mass: Number(text) })} />
                    <Switch label="Use gravity" checked={body.useGravity === true} onCheckedChange={(checked) => edit({ useGravity: checked === true })} />
                    <NumberField label="Linear damping" value={body.linearDamping} onCommit={(text) => edit({ linearDamping: Number(text) })} />
                    <NumberField label="Angular damping" value={body.angularDamping} onCommit={(text) => edit({ angularDamping: Number(text) })} />
                    {["x", "y", "z"].map((axis) => (
                        <NumberField
                            key={axis}
                            label={`Force ${axis}`}
                            value={force[axis]}
                            onCommit={(text) => edit({ constantForce: { ...force, [axis]: Number(text) } })}
                        />
                    ))}
                    <Button size="compact" onClick={() => runCommand(data, removeRigidBody({ objectId: record.id }), onResult)}>
                        Remove rigid body
                    </Button>
                </>
            )}
        </div>
    );
}
