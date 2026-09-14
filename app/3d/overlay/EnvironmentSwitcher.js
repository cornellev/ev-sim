'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { Button, DialogSurface } from "../../ui";
import {
    changeEnvironmentId,
    deleteEnvironment,
    duplicateEnvironment,
    environmentIdFromName,
    isValidEnvironmentId,
    listEnvironments,
    renameEnvironment,
} from "../environment/EnvironmentCatalogClient";
import {
    canEditIdentity,
    inspectEnvironment,
    shouldLoadOnOpen,
} from "../environment/environmentPickerModel";
import { EnvironmentCreationDialog } from "./workspace/EnvironmentCreationDialog";
import { EnvironmentPickerDialog, environmentKindIcon } from "./EnvironmentPickerDialog";

export function EnvironmentSwitcher({ data, activeEnvironmentId, onEnvironmentChange }) {
    const [open, setOpen] = useState(false);
    const [instant, setInstant] = useState(false);
    const [environments, setEnvironments] = useState([]);
    const [listLoaded, setListLoaded] = useState(false);
    const [inspectedId, setInspectedId] = useState(null);
    const [name, setName] = useState("");
    const [environmentId, setEnvironmentId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [creationId, setCreationId] = useState(null);
    const activeEnvironmentIdRef = useRef(activeEnvironmentId);
    activeEnvironmentIdRef.current = activeEnvironmentId;

    const active = useMemo(
        () => inspectEnvironment(environments, activeEnvironmentId),
        [activeEnvironmentId, environments],
    );
    const inspected = useMemo(
        () => inspectEnvironment(environments, inspectedId) ?? active,
        [active, environments, inspectedId],
    );
    const ActiveKindIcon = environmentKindIcon(active?.sourceKind);

    const refresh = async () => {
        const items = await listEnvironments();
        setEnvironments(Array.isArray(items) ? items : []);
        setListLoaded(true);
        return Array.isArray(items) ? items : [];
    };

    useEffect(() => {
        refresh().catch((loadError) => {
            setListLoaded(true);
            setError(loadError.message);
        });
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        setInspectedId(activeEnvironmentIdRef.current ?? null);
        void refresh().catch((loadError) => setError(loadError.message));
        return undefined;
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setName(inspected?.name ?? "");
        setEnvironmentId(inspected?.id ?? "");
    }, [inspected?.id, inspected?.name, open]);

    useEffect(() => {
        if (!open && !creationId) return undefined;
        window.__fusionEnvironmentDialogConsumesEscape = true;
        return () => {
            window.__fusionEnvironmentDialogConsumesEscape = false;
        };
    }, [creationId, open]);

    const run = async (operation) => {
        setBusy(true);
        setError(null);
        try {
            const nextInspectedId = await operation();
            await refresh();
            if (typeof nextInspectedId === "string") setInspectedId(nextInspectedId);
        } catch (operationError) {
            setError(operationError.message);
        } finally {
            setBusy(false);
        }
    };

    const uniqueId = (label) => {
        const base = environmentIdFromName(label);
        if (!environments.some((environment) => environment.id === base)) return base;
        return `${base}-${Date.now().toString(36)}`;
    };

    const inspectingActive = inspected?.id === activeEnvironmentId;

    const expectedRevisionFor = (entry) => {
        if (entry?.id === activeEnvironmentId) {
            return data?.environment?.()?.persistence?.acknowledgedRevision ?? entry.revision ?? 0;
        }
        return entry?.revision ?? 0;
    };

    const flushInspectedIfActive = async ({ discard = false } = {}) => {
        const persistence = data?.environment?.()?.persistence;
        if (!inspectingActive) return persistence;
        await persistence?.flush?.({ throwOnError: true });
        if (discard) await persistence?.discard?.();
        return persistence;
    };

    const openInspected = (id) => {
        const targetId = typeof id === "string" && id ? id : inspected?.id;
        if (busy || !targetId) return;
        if (shouldLoadOnOpen(targetId, activeEnvironmentId)) onEnvironmentChange?.(targetId);
        setOpen(false);
    };

    const duplicateInspected = () => {
        if (!inspected) return;
        const displayName = name.trim() || `${inspected.name} Copy`;
        const id = uniqueId(displayName);
        run(async () => {
            await flushInspectedIfActive();
            await duplicateEnvironment(inspected.id, {
                id,
                name: displayName,
                expectedRevision: expectedRevisionFor(inspected),
            });
            return id;
        });
    };

    const renameInspected = () => {
        if (!inspected || !name.trim()) return;
        run(async () => {
            await flushInspectedIfActive();
            const renamed = await renameEnvironment(
                inspected.id,
                name.trim(),
                expectedRevisionFor(inspected),
            );
            if (inspectingActive && data?.environment?.() && renamed?.name) {
                data.environment().name = renamed.name;
            }
        });
    };

    const changeInspectedId = () => {
        const nextId = environmentId.trim();
        if (!canEditIdentity(inspected) || nextId === inspected.id || !isValidEnvironmentId(nextId)) return;
        run(async () => {
            const persistence = await flushInspectedIfActive({ discard: inspectingActive });
            try {
                const moved = await changeEnvironmentId(
                    inspected.id,
                    nextId,
                    expectedRevisionFor(inspected),
                );
                const resolvedId = moved?.environmentId ?? nextId;
                if (inspectingActive) {
                    onEnvironmentChange?.(resolvedId);
                    setOpen(false);
                }
                return resolvedId;
            } catch (changeError) {
                if (inspectingActive) {
                    persistence?.attach?.();
                    if (persistence && data?.environment?.()) {
                        data.environment().persistence = persistence;
                    }
                }
                throw changeError;
            }
        });
    };

    const removeInspected = () => {
        if (!canEditIdentity(inspected)) return;
        if (!window.confirm(`Delete "${inspected.name}"? This cannot be undone.`)) return;
        const deletingActive = inspectingActive;
        run(async () => {
            const persistence = await flushInspectedIfActive({ discard: deletingActive });
            try {
                await deleteEnvironment(inspected.id, expectedRevisionFor(inspected));
            } catch (deleteError) {
                if (deletingActive) persistence?.attach?.();
                throw deleteError;
            }
            if (deletingActive) {
                onEnvironmentChange?.("igvc");
                setOpen(false);
                return undefined;
            }
            return activeEnvironmentId ?? null;
        });
    };

    const beginCreate = () => {
        setOpen(false);
        setCreationId(uniqueId("Untitled Environment"));
    };

    return (
        <div className="relative z-40 pointer-events-auto" data-environment-switcher>
            {creationId && <EnvironmentCreationDialog
                data={data}
                initialId={creationId}
                onCancel={() => {
                    setCreationId(null);
                    setOpen(true);
                }}
                onCreated={(id) => {
                    setCreationId(null);
                    setOpen(false);
                    void refresh();
                    onEnvironmentChange?.(id);
                }}
            />}
            <button
                type="button"
                className="sf-button sf-button--compact sf-environment-switcher__trigger"
                onClick={(event) => {
                    setInstant(event.detail === 0);
                    setOpen(true);
                }}
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label="Environment"
            >
                <span className="sf-environment-switcher__trigger-copy">
                    {active && <ActiveKindIcon size={14} stroke={1.75} aria-hidden="true" />}
                    <span>{active?.name ?? activeEnvironmentId ?? "Loading"}</span>
                </span>
                <IconChevronDown
                    size={12}
                    stroke={1.75}
                    aria-hidden="true"
                    className="sf-environment-switcher__chevron"
                    data-open={open || undefined}
                />
            </button>
            <DialogSurface
                open={open}
                onOpenChange={setOpen}
                title="Environments"
                description=""
                className="sf-environment-picker"
                instant={instant}
                headerActions={(
                    <Button size="compact" onClick={beginCreate} disabled={busy}>
                        New
                    </Button>
                )}
            >
                <EnvironmentPickerDialog
                    environments={environments}
                    inspected={inspected}
                    activeEnvironmentId={activeEnvironmentId}
                    name={name}
                    environmentId={environmentId}
                    busy={busy}
                    error={error}
                    listLoaded={listLoaded}
                    onInspect={setInspectedId}
                    onOpen={openInspected}
                    onNameChange={setName}
                    onEnvironmentIdChange={setEnvironmentId}
                    onDuplicate={duplicateInspected}
                    onRename={renameInspected}
                    onChangeId={changeInspectedId}
                    onDelete={removeInspected}
                />
            </DialogSurface>
        </div>
    );
}
