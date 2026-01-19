'use client';

import { useState } from 'react';
import TotalScene from './3d/Scene';
import Scripting from './scripting/Scripting';


export default function Home() {
    const [state, set_state] = useState("3d");

    return (
        <>
        {
            state === "scripting" && <Scripting />
        }
        {
            state === "3d" && <TotalScene />
        }
        </>
    );
}
