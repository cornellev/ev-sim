'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "radix-ui";

import { Button } from "./Button";
import { applyWorkspaceDecision, selectDirtyGuard } from "./workspaceGuardUtils";

const WorkspaceGuardContext = createContext(null);

export function WorkspaceGuardProvider({ children }) {
    const guardsRef = useRef(new Map());
    const [pending, setPending] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const registerGuard = useCallback((id, guard) => {
        guardsRef.current.set(id, guard);
        return () => guardsRef.current.delete(id);
    }, []);

    const requestNavigation = useCallback((action) => {
        const guard = selectDirtyGuard(guardsRef.current.values());
        if (!guard) {
            action();
            return true;
        }
        setError(null);
        setPending({ action, guard });
        return false;
    }, []);

    const complete = useCallback(async (mode) => {
        if (!pending || busy) return;
        setBusy(true);
        setError(null);
        try {
            const action = pending.action;
            await applyWorkspaceDecision({ decision: mode, guard: pending.guard, navigate: action });
            setPending(null);
        } catch (operationError) {
            setError(operationError?.message || "Changes could not be saved.");
        } finally {
            setBusy(false);
        }
    }, [busy, pending]);

    const value = useMemo(() => ({ registerGuard, requestNavigation }), [registerGuard, requestNavigation]);

    return (
        <WorkspaceGuardContext.Provider value={value}>
            {children}
            <AlertDialog.Root open={Boolean(pending)} onOpenChange={(open) => !open && !busy && setPending(null)}>
                <AlertDialog.Portal>
                    <AlertDialog.Overlay className="sf-dialog-overlay" />
                    <AlertDialog.Content className="sf-dialog sf-guard-dialog">
                        <header className="sf-dialog__header">
                            <div>
                                <AlertDialog.Title className="sf-dialog__title">Save changes before switching?</AlertDialog.Title>
                                <AlertDialog.Description className="sf-dialog__description">
                                    {pending?.guard?.label || "This workspace"} has changes that have not been saved.
                                </AlertDialog.Description>
                            </div>
                        </header>
                        {error && <div className="sf-guard-dialog__error" role="alert">{error}</div>}
                        <footer className="sf-dialog__footer">
                            <AlertDialog.Cancel asChild><Button disabled={busy}>Stay</Button></AlertDialog.Cancel>
                            {pending?.guard?.discard && <Button variant="danger" disabled={busy} onClick={() => complete("discard")}>Discard and switch</Button>}
                            {pending?.guard?.save && <Button variant="primary" loading={busy} onClick={() => complete("save")}>Save and switch</Button>}
                        </footer>
                    </AlertDialog.Content>
                </AlertDialog.Portal>
            </AlertDialog.Root>
        </WorkspaceGuardContext.Provider>
    );
}

export function useWorkspaceNavigation() {
    const context = useContext(WorkspaceGuardContext);
    if (!context) throw new Error("useWorkspaceNavigation must be used inside WorkspaceGuardProvider.");
    return context;
}

export function useWorkspaceGuard(id, { dirty, save, discard, label }) {
    const context = useContext(WorkspaceGuardContext);
    useEffect(() => {
        if (!context) return undefined;
        return context.registerGuard(id, { dirty, save, discard, label });
    }, [context, dirty, discard, id, label, save]);
}
