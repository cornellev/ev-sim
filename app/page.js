'use client';

import { useCallback, useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import Menu from './3d/overlay/menu/Menu';
import { APP_VIEWS, THREE_D_MODES } from './3d/viewState';


export default function Home() {
    const [view, setView] = useState(APP_VIEWS.THREE_D);
    const [threeDMode, setThreeDMode] = useState(THREE_D_MODES.SIMULATION);
    const [menuVisible, setMenuVisible] = useState(false);

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
                />
            )
        }
        {
            view === APP_VIEWS.SCRIPTING && <Scripting />
        }
        {
            view === APP_VIEWS.THREE_D && <TotalScene mode={threeDMode} />
        }
        </>
    );
}
