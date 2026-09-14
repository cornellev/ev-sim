'use client';

import {
    IconCopy,
    IconCube,
    IconId,
    IconPackages,
    IconPencil,
    IconTrash,
    IconWorld,
} from "@tabler/icons-react";
import { Button, Field, ScrollPane, StatusMessage, TextInput } from "../../ui";
import { canEditIdentity, sourceKindLabel } from "../environment/environmentPickerModel";
import { isValidEnvironmentId } from "../environment/EnvironmentCatalogClient";

const ICON_PROPS = { size: 22, stroke: 1.75 };
const SOURCE_KIND_ICONS = {
    blank: IconCube,
    google: IconWorld,
    gltf: IconPackages,
};

export function environmentKindIcon(kind) {
    return SOURCE_KIND_ICONS[kind] ?? IconCube;
}

export function EnvironmentPickerDialog({
    environments,
    inspected,
    activeEnvironmentId,
    name,
    environmentId,
    busy,
    error,
    listLoaded,
    onInspect,
    onOpen,
    onNameChange,
    onEnvironmentIdChange,
    onDuplicate,
    onRename,
    onChangeId,
    onDelete,
}) {
    const identityEditable = canEditIdentity(inspected);
    const idError = environmentId && !isValidEnvironmentId(environmentId.trim())
        ? "Use lowercase letters, numbers, and single hyphens."
        : undefined;
    const idHint = "ID is stable storage key.";

    return (
        <>
            <aside className="sf-environment-picker__rail">
                <Field label="Name">
                    <TextInput
                        value={name}
                        onChange={(event) => onNameChange(event.target.value)}
                        placeholder="Environment name"
                        disabled={busy || !inspected}
                    />
                </Field>
                <Field
                    label="Environment ID"
                    hint={idError ? undefined : idHint}
                    error={idError}
                >
                    <TextInput
                        value={environmentId}
                        onChange={(event) => onEnvironmentIdChange(event.target.value.toLowerCase())}
                        className="font-mono"
                        placeholder="environment-id"
                        disabled={busy || !identityEditable}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                    />
                </Field>
                {error && <StatusMessage tone="danger">{error}</StatusMessage>}
                <div className="sf-environment-picker__rail-actions">
                    <Button size="compact" onClick={onDuplicate} disabled={busy || !inspected}>
                        <IconCopy size={14} stroke={1.75} aria-hidden="true" />
                        Duplicate
                    </Button>
                    <Button size="compact" onClick={onRename} disabled={busy || !inspected || !name.trim()}>
                        <IconPencil size={14} stroke={1.75} aria-hidden="true" />
                        Rename
                    </Button>
                    <Button
                        size="compact"
                        onClick={onChangeId}
                        disabled={
                            busy
                            || !identityEditable
                            || environmentId.trim() === inspected?.id
                            || !isValidEnvironmentId(environmentId.trim())
                        }
                    >
                        <IconId size={14} stroke={1.75} aria-hidden="true" />
                        Change ID
                    </Button>
                    <Button size="compact" variant="danger" onClick={onDelete} disabled={busy || !identityEditable}>
                        <IconTrash size={14} stroke={1.75} aria-hidden="true" />
                        Delete
                    </Button>
                </div>
                <Button className="sf-environment-picker__open" variant="primary" onClick={() => onOpen()} disabled={busy || !inspected}>
                    Open environment
                </Button>
            </aside>
            <ScrollPane className="sf-environment-picker__grid-pane" viewportClassName="sf-environment-picker__viewport">
                {!listLoaded && environments.length === 0 && (
                    <div className="sf-environment-picker__list" aria-busy="true" aria-label="Loading environments">
                        {Array.from({ length: 8 }, (_, index) => (
                            <div key={index} className="sf-environment-picker__skeleton" />
                        ))}
                    </div>
                )}
                {listLoaded && environments.length === 0 && (
                    <StatusMessage title="No environments">Create one with New.</StatusMessage>
                )}
                {environments.length > 0 && (
                    <div role="listbox" aria-label="Saved environments" className="sf-environment-picker__list">
                        {environments.map((environment) => {
                            const selected = environment.id === inspected?.id;
                            const isOpen = environment.id === activeEnvironmentId;
                            const kind = environment.sourceKind ?? "blank";
                            const Icon = environmentKindIcon(kind);
                            const nameId = `environment-tile-${environment.id}-name`;
                            return (
                                <button
                                    type="button"
                                    key={environment.id}
                                    id={`environment-tile-${environment.id}`}
                                    role="option"
                                    aria-selected={selected}
                                    aria-labelledby={nameId}
                                    data-open={isOpen || undefined}
                                    data-source-kind={kind}
                                    className="sf-environment-picker__tile"
                                    onClick={() => onInspect(environment.id)}
                                    onDoubleClick={() => {
                                        onInspect(environment.id);
                                        onOpen(environment.id);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key !== "Enter") return;
                                        event.preventDefault();
                                        onInspect(environment.id);
                                        onOpen(environment.id);
                                    }}
                                >
                                    <span className="sf-environment-picker__icon" role="img" aria-label={sourceKindLabel(kind)}>
                                        <Icon {...ICON_PROPS} aria-hidden="true" />
                                    </span>
                                    <span id={nameId} className="sf-environment-picker__name">{environment.name}</span>
                                    {isOpen && <span className="sf-environment-picker__open-caption">Open</span>}
                                </button>
                            );
                        })}
                    </div>
                )}
            </ScrollPane>
        </>
    );
}
