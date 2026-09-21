'use client';

import { useCallback, useEffect, useRef, useState } from "react";

import { listLocalPlugins } from "../PluginClient.js";

export function usePluginLibrary() {
    const [state, setState] = useState({
        status: "loading",
        packages: [],
        error: null,
    });
    const mountedRef = useRef(true);
    const hasReadyRef = useRef(false);

    const refresh = useCallback(() => listLocalPlugins().then((payload) => {
        if (!mountedRef.current) return;
        hasReadyRef.current = true;
        setState({
            status: "ready",
            packages: Array.isArray(payload?.packages) ? payload.packages : [],
            error: null,
        });
    }).catch((caught) => {
        if (!mountedRef.current) return;
        const message = caught instanceof Error ? caught.message : "Could not load plugins.";
        setState((current) => ({
            status: "error",
            packages: hasReadyRef.current ? current.packages : [],
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
