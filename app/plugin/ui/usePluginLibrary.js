'use client';

import { useCallback, useEffect, useRef, useState } from "react";

import { listLocalPlugins, listPluginLibrary } from "../PluginClient.js";

export function usePluginLibrary() {
    const [state, setState] = useState({
        status: "loading",
        packages: [],
        installed: [],
        error: null,
    });
    const mountedRef = useRef(true);
    const hasReadyRef = useRef(false);

    const refresh = useCallback(() => Promise.all([listLocalPlugins(), listPluginLibrary()]).then(([local, library]) => {
        if (!mountedRef.current) return;
        hasReadyRef.current = true;
        setState({
            status: "ready",
            packages: Array.isArray(local?.packages) ? local.packages : [],
            installed: Array.isArray(library?.packages) ? library.packages : [],
            error: null,
        });
    }).catch((caught) => {
        if (!mountedRef.current) return;
        const message = caught instanceof Error ? caught.message : "Could not load plugins.";
        setState((current) => ({
            status: "error",
            packages: hasReadyRef.current ? current.packages : [],
            installed: hasReadyRef.current ? current.installed : [],
            error: message,
        }));
    }), []);

    useEffect(() => {
        mountedRef.current = true;
        refresh();
        return () => {
            mountedRef.current = false;
        };
    }, [refresh]);

    return { ...state, refresh };
}
