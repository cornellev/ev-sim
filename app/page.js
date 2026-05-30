'use client';

import { useEffect, useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';
import Menu from './3d/overlay/menu/Menu';


export default function Home() {
    const [state, set_state] = useState("3d");
    const [menuVisible, setMenuVisible] = useState(false);

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
            menuVisible && <Menu></Menu>
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
