'use client';

import { createContext, useContext, useEffect, useMemo, useRef } from "react";

import { getShortcutCandidates } from "./shortcutUtils";

const ShortcutContext = createContext(null);

export function ShortcutProvider({ children }) {
    const shortcutsRef = useRef(new Map());

    useEffect(() => {
        const handleKeyDown = (event) => {
            const entries = getShortcutCandidates(shortcutsRef.current.values(), event, {
                overlayOpen: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')),
            });

            for (const entry of entries) {
                const handled = entry.handler(event);
                if (handled === false) continue;
                if (entry.preventDefault !== false) event.preventDefault();
                return;
            }
        };

        const releaseHeldKeys = () => window.dispatchEvent(new Event("sf:release-held-keys"));
        const handleVisibility = () => {
            if (document.visibilityState !== "visible") releaseHeldKeys();
        };

        document.addEventListener("keydown", handleKeyDown);
        window.addEventListener("blur", releaseHeldKeys);
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("blur", releaseHeldKeys);
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, []);

    const api = useMemo(() => ({
        register(entry) {
            shortcutsRef.current.set(entry.id, entry);
            return () => shortcutsRef.current.delete(entry.id);
        },
        update(id, entry) {
            shortcutsRef.current.set(id, entry);
        },
    }), []);

    return <ShortcutContext.Provider value={api}>{children}</ShortcutContext.Provider>;
}

export function useShortcut({
    id,
    keys,
    handler,
    enabled = true,
    priority = 0,
    scope = "workspace",
    allowInEditable = false,
    preventDefault = true,
}) {
    const registry = useContext(ShortcutContext);
    const handlerRef = useRef(handler);

    useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    useEffect(() => {
        if (!registry) return undefined;
        return registry.register({
            id,
            keys,
            enabled,
            priority,
            scope,
            allowInEditable,
            preventDefault,
            handler: (event) => handlerRef.current?.(event),
        });
    }, [allowInEditable, enabled, id, keys, preventDefault, priority, registry, scope]);
}
