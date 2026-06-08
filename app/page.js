'use client';

import { useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import Menu from './3d/overlay/menu/Menu';


export default function Home() {
    const [state, set_state] = useState("scripting");
    const [menuVisible, setMenuVisible] = useState(false);

    const goToScene = () => {
        set_state("3d");
        setMenuVisible(false);
    }

    const goToScripting = () => {
        set_state("scripting");
        setMenuVisible(false);
    }

    useEffect(() => {
        const ev = (e) => {
            if (e.key == "Escape") {
                setMenuVisible(!menuVisible)
            }
        };
        document.addEventListener("keydown", ev);

        return () => {
            document.removeEventListener("keydown", ev);
        }
    })

    return (
        <>
        {
            menuVisible && <Menu onScene={goToScene} onScripting={goToScripting}></Menu>
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
