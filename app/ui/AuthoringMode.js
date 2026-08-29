'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { Switch } from "./FormControls.js";
import { StatusMessage } from "./WorkspaceFrame.js";
import {
    readAdvancedAuthoringPreference,
    validationIssueRequiresAdvanced,
    writeAdvancedAuthoringPreference,
} from "./authoringModeStorage.js";

const AuthoringModeContext = createContext({
    advanced: false,
    setAdvanced: () => {},
});

const authoringModeListeners = new Set();

function emitAuthoringModeChange() {
    authoringModeListeners.forEach((listener) => listener());
}

function subscribeAuthoringMode(listener) {
    authoringModeListeners.add(listener);
    if (typeof window !== "undefined") {
        window.addEventListener("storage", listener);
    }
    return () => {
        authoringModeListeners.delete(listener);
        if (typeof window !== "undefined") {
            window.removeEventListener("storage", listener);
        }
    };
}

function getAuthoringModeSnapshot() {
    return readAdvancedAuthoringPreference();
}

function getAuthoringModeServerSnapshot() {
    return false;
}

export function AuthoringModeProvider({ children }) {
    const advanced = useSyncExternalStore(
        subscribeAuthoringMode,
        getAuthoringModeSnapshot,
        getAuthoringModeServerSnapshot,
    );

    const setAdvanced = useCallback((value) => {
        const next = Boolean(value);
        writeAdvancedAuthoringPreference(next);
        emitAuthoringModeChange();
    }, []);

    const contextValue = useMemo(() => ({ advanced, setAdvanced }), [advanced, setAdvanced]);

    return (
        <AuthoringModeContext.Provider value={contextValue}>
            {children}
        </AuthoringModeContext.Provider>
    );
}

export function useAuthoringMode() {
    return useContext(AuthoringModeContext);
}

export function AdvancedSwitch({ className = "" }) {
    const { advanced, setAdvanced } = useAuthoringMode();
    return (
        <Switch
            className={className}
            label="Advanced"
            checked={advanced}
            onCheckedChange={setAdvanced}
        />
    );
}

export function AdvancedFields({ children, label = "Advanced settings" }) {
    const { advanced } = useAuthoringMode();
    if (!advanced) return null;
    return (
        <div className="advanced-fields space-y-4" data-advanced-fields>
            {label && <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--slate-muted)]">{label}</p>}
            {children}
        </div>
    );
}

export function AdvancedValidationBanner({ issues = [] }) {
    const { advanced, setAdvanced } = useAuthoringMode();
    const hiddenIssues = issues.filter((issue) => validationIssueRequiresAdvanced(issue?.path));
    if (advanced || hiddenIssues.length === 0) return null;
    return (
        <StatusMessage className="mb-4" tone="warning" title="Some errors are in Advanced settings">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px]">
                    {hiddenIssues.length === 1
                        ? "One validation issue is in a field hidden in simple mode."
                        : `${hiddenIssues.length} validation issues are in fields hidden in simple mode.`}
                </p>
                <button
                    type="button"
                    className="rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-surface-2)] px-3 py-1.5 text-[12px] font-medium text-[var(--slate-fg)] transition-colors hover:bg-[var(--slate-surface-3)]"
                    onClick={() => setAdvanced(true)}
                >
                    Show Advanced
                </button>
            </div>
        </StatusMessage>
    );
}
