'use client';

import { useCallback, useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import Menu from './3d/overlay/menu/Menu';


export default function Home() {
    const [state, set_state] = useState("3d");
    const [menuVisible, setMenuVisible] = useState(false);

    const closeMenu = useCallback(() => {
        setMenuVisible(false);
    }, []);

    const goToScene = useCallback(() => {
        set_state("3d");
        setMenuVisible(false);
    }, []);

    const goToScripting = useCallback(() => {
        set_state("scripting");
        setMenuVisible(false);
    }, []);

    useEffect(() => {
        const ev = (e) => {
            if (e.key == "Escape") {
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
                    activeView={state}
                    onClose={closeMenu}
                    onScene={goToScene}
                    onScripting={goToScripting}
                />
            )
        }
        {
            state === "scripting" && <Scripting />
        }
        {
            state === "3d" && <TotalScene />
        }
        </>
    );
}
