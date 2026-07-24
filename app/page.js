'use client';

import { useCallback, useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import BindingsPage from './scripting/bindings/BindingsPage';
import ReplayPage from './replay/ReplayPage';
import AnalysisPage from './analysis/AnalysisPage';
import Menu from './3d/overlay/menu/Menu';
import { APP_VIEWS, THREE_D_MODES } from './3d/viewState';
import {
    getActiveEnvironmentId,
    listEnvironments,
    setActiveEnvironmentId,
} from './3d/environment/EnvironmentCatalogClient';
import { subscribeStorageEvents } from './client/storageEvents';


export default function Home() {
    const [view, setView] = useState(APP_VIEWS.THREE_D);
    const [threeDMode, setThreeDMode] = useState(THREE_D_MODES.SIMULATION);
    const [menuVisible, setMenuVisible] = useState(false);
    const [activeEnvironmentId, setActiveEnvironment] = useState(null);
    const [selectedLogId, setSelectedLogId] = useState(null);
    const [replayCommand, setReplayCommand] = useState(null);

    const closeMenu = useCallback(() => {
        setMenuVisible(false);
    }, []);

    const goToSimulation = useCallback(() => {
        setView(APP_VIEWS.THREE_D);
        setThreeDMode(THREE_D_MODES.SIMULATION);
        setMenuVisible(false);
    }, []);

    const goToEnvironmentEditor = useCallback(() => {
        setView(APP_VIEWS.THREE_D);
        setThreeDMode(THREE_D_MODES.ENVIRONMENT);
        setMenuVisible(false);
    }, []);

    const goToScripting = useCallback(() => {
        setView(APP_VIEWS.SCRIPTING);
        setMenuVisible(false);
    }, []);

    const goToBindings = useCallback(() => {
        setView(APP_VIEWS.BINDINGS);
        setMenuVisible(false);
    }, []);

    const goToReplay = useCallback((logId = null) => {
        if (typeof logId === "string") setSelectedLogId(logId);
        setView(APP_VIEWS.REPLAY);
        setMenuVisible(false);
    }, []);

    const goToAnalysis = useCallback((logId = null) => {
        if (typeof logId === "string") setSelectedLogId(logId);
        setView(APP_VIEWS.ANALYSIS);
        setMenuVisible(false);
    }, []);

    const selectEnvironment = useCallback((environmentId) => {
        setActiveEnvironment(environmentId);
        setActiveEnvironmentId(environmentId).catch((error) => {
            console.error("Could not persist active environment:", error);
        });
    }, []);

    useEffect(() => {
        let cancelled = false;
        Promise.all([getActiveEnvironmentId(), listEnvironments()])
            .then(([environmentId, environments]) => {
                const exists = environments?.some?.((environment) => environment.id === environmentId);
                if (!cancelled) setActiveEnvironment(exists ? environmentId : "igvc");
            })
            .catch((error) => {
                console.warn("Could not load active environment; using IGVC:", error);
                if (!cancelled) setActiveEnvironment("igvc");
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        return subscribeStorageEvents((event) => {
            if (event.domain === "environment" && event.action === "active" && event.id) {
                setActiveEnvironment(event.id);
                return;
            }
            if (event.domain !== "replay" || !event.data?.logId) return;
            setSelectedLogId(event.data.logId);
            setReplayCommand({
                ...event.data,
                action: event.action,
                requestId: event.requestId || `${event.action}:${event.at}`,
            });
            setView(APP_VIEWS.REPLAY);
            setMenuVisible(false);
        });
    }, []);

    useEffect(() => {
        const ev = (e) => {
            if (e.key == "Escape") {
                if (window.__fusionEnvironmentEditorConsumesEscape) return;
                setMenuVisible((visible) => !visible);
            }
        };
        document.addEventListener("keydown", ev);

        return () => {
            document.removeEventListener("keydown", ev);
        }
    }, [])

    return (
        <>
        {
            menuVisible && (
                <Menu
                    activeView={view}
                    activeThreeDMode={threeDMode}
                    onClose={closeMenu}
                    onSimulation={goToSimulation}
                    onEnvironmentEditor={goToEnvironmentEditor}
                    onScripting={goToScripting}
                    onBindings={goToBindings}
                    onReplay={goToReplay}
                    onAnalysis={goToAnalysis}
                />
            )
        }
        {
            view === APP_VIEWS.SCRIPTING && <Scripting />
        }
        {
            view === APP_VIEWS.BINDINGS && <BindingsPage />
        }
        {
            view === APP_VIEWS.REPLAY && (
                <ReplayPage key={selectedLogId || "replay"} initialLogId={selectedLogId} mcpCommand={replayCommand} onOpenAnalysis={goToAnalysis} />
            )
        }
        {
            view === APP_VIEWS.ANALYSIS && (
                <AnalysisPage initialLogId={selectedLogId} onOpenReplay={goToReplay} />
            )
        }
        {
            activeEnvironmentId && (
                <TotalScene
                    mode={threeDMode}
                    visible={view === APP_VIEWS.THREE_D}
                    environmentId={activeEnvironmentId}
                    onEnvironmentChange={selectEnvironment}
                    onOpenReplay={goToReplay}
                />
            )
        }
        </>
    );
}
