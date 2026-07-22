'use client';

import { useCallback, useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import BindingsPage from './scripting/bindings/BindingsPage';
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
            if (event.domain !== "environment" || event.action !== "active") return;
            if (!event.id) return;
            setActiveEnvironment(event.id);
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
            view === APP_VIEWS.THREE_D && activeEnvironmentId && (
                <TotalScene
                    mode={threeDMode}
                    environmentId={activeEnvironmentId}
                    onEnvironmentChange={selectEnvironment}
                />
            )
        }
        </>
    );
}
