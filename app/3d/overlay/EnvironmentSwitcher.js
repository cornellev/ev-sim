'use client';

import { useEffect, useMemo, useState } from "react";
import {
    FaChevronDown,
    FaCopy,
    FaPen,
    FaPlus,
    FaTrash,
} from "react-icons/fa";
import {
    createEnvironment,
    deleteEnvironment,
    duplicateEnvironment,
    environmentIdFromName,
    listEnvironments,
    renameEnvironment,
} from "../environment/EnvironmentCatalogClient";

export function EnvironmentSwitcher({ data, activeEnvironmentId, onEnvironmentChange }) {
    const [open, setOpen] = useState(false);
    const [environments, setEnvironments] = useState([]);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const active = useMemo(
        () => environments.find((environment) => environment.id === activeEnvironmentId) ?? null,
        [activeEnvironmentId, environments],
    );

    const refresh = async () => {
        const items = await listEnvironments();
        setEnvironments(Array.isArray(items) ? items : []);
    };

    useEffect(() => {
        refresh().catch((loadError) => setError(loadError.message));
    }, []);

    useEffect(() => {
        if (open) setName(active?.name ?? "");
    }, [active?.name, open]);

    const run = async (operation) => {
        setBusy(true);
        setError(null);
        try {
            await operation();
            await refresh();
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

    const createBlank = () => {
        const displayName = name.trim() || "Untitled Environment";
        const id = uniqueId(displayName);
        run(async () => {
            await createEnvironment({ id, name: displayName, templateId: "blank" });
            onEnvironmentChange?.(id);
            setOpen(false);
        });
    };

    const duplicateActive = () => {
        if (!active) return;
        const displayName = name.trim() || `${active.name} Copy`;
        const id = uniqueId(displayName);
        run(async () => {
            await data?.environment?.()?.persistence?.flush?.({ throwOnError: true });
            await duplicateEnvironment(active.id, { id, name: displayName });
            onEnvironmentChange?.(id);
            setOpen(false);
        });
    };

    const renameActive = () => {
        if (!active || !name.trim()) return;
        run(async () => {
            await data?.environment?.()?.persistence?.flush?.({ throwOnError: true });
            const renamed = await renameEnvironment(active.id, name.trim());
            if (data?.environment?.() && renamed?.name) {
                data.environment().name = renamed.name;
            }
        });
    };

    const removeActive = () => {
        if (!active || active.builtIn) return;
        if (!window.confirm(`Delete "${active.name}"? This cannot be undone.`)) return;
        run(async () => {
            const persistence = data?.environment?.()?.persistence;
            await persistence?.flush?.({ throwOnError: true });
            await persistence?.discard?.();
            try {
                await deleteEnvironment(active.id);
            } catch (deleteError) {
                persistence?.attach?.();
                throw deleteError;
            }
            onEnvironmentChange?.("igvc");
            setOpen(false);
        });
    };

    return (
        <div className="fixed left-1/2 top-3 z-40 w-[320px] max-w-[calc(100vw-24px)] -translate-x-1/2 pointer-events-auto text-zinc-100">
            <button
                type="button"
                className="mx-auto flex min-w-[190px] items-center justify-between gap-3 rounded-xl border border-zinc-700/80 bg-zinc-950/90 px-3 py-2.5 text-left shadow-[0_14px_44px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-colors hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
            >
                <span className="min-w-0">
                    <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                        Environment
                    </span>
                    <span className="block truncate text-[13px] font-semibold text-zinc-100">
                        {active?.name ?? activeEnvironmentId ?? "Loading"}
                    </span>
                </span>
                <FaChevronDown className={`h-3 w-3 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>

            {open && (
                <div className="mt-2 w-full overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950/95 shadow-[0_20px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl">
                    <div className="max-h-52 overflow-y-auto p-2">
                        {environments.map((environment) => (
                            <button
                                type="button"
                                key={environment.id}
                                onClick={() => {
                                    onEnvironmentChange?.(environment.id);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                                    environment.id === activeEnvironmentId
                                        ? "bg-sky-500/15 text-sky-100"
                                        : "text-zinc-300 hover:bg-zinc-800/80 hover:text-white"
                                }`}
                            >
                                <span className="truncate text-[12px] font-medium">{environment.name}</span>
                                <span className="ml-3 text-[9px] uppercase tracking-wider text-zinc-500">
                                    {environment.templateId}
                                </span>
                            </button>
                        ))}
                    </div>

                    <div className="border-t border-zinc-800 p-3">
                        <label className="block text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                            Name
                        </label>
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500/70 focus:ring-2 focus:ring-sky-500/20"
                            placeholder="Environment name"
                            disabled={busy}
                        />
                        {error && <p className="mt-2 text-[10px] leading-relaxed text-red-300">{error}</p>}

                        <div className="mt-3 grid grid-cols-2 gap-1.5">
                            <ActionButton icon={FaPlus} label="New blank" onClick={createBlank} disabled={busy} />
                            <ActionButton icon={FaCopy} label="Duplicate" onClick={duplicateActive} disabled={busy || !active} />
                            <ActionButton icon={FaPen} label="Rename" onClick={renameActive} disabled={busy || !active || !name.trim()} />
                            <ActionButton
                                icon={FaTrash}
                                label="Delete"
                                onClick={removeActive}
                                disabled={busy || !active || active.builtIn}
                                destructive
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function ActionButton({ icon: Icon, label, onClick, disabled, destructive = false }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                destructive
                    ? "border-red-900/60 bg-red-950/30 text-red-300 hover:bg-red-950/60"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
            }`}
        >
            <Icon className="h-2.5 w-2.5" />
            {label}
        </button>
    );
}

