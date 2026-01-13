'use client';

import { Canvas, useThree } from "@react-three/fiber";
import Basic from "./basic/Basic";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useState } from "react";
import { Shaders } from "./Shaders";

function SceneInit({ cameraPosition, cameraRotation }) {

    useThree(({camera}) => {
        camera.position.set(...cameraPosition);
        camera.rotation.set(...cameraRotation);
    });

    return null;
}

function Scene() {
    const [gridEnabled, setGridEnabled] = useState(true);
    const [cameraPosition, setCameraPosition] = useState([10, 10, 10]);
    const [cameraRotation, setCameraRotation] = useState([-0.5, 0.5, 0]);

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.key === 'g' || event.key === 'G') {
                setGridEnabled(prev => !prev);
            }
        };
        
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    const onOrbitChange = (event) => {
        const { position, rotation } = event.target.object;
        setCameraPosition([position.x, position.y, position.z]);
        setCameraRotation([rotation.x, rotation.y, rotation.z]);
    };

    return (
        <>
        <Canvas>
            <Shaders />
            <SceneInit cameraPosition={cameraPosition} cameraRotation={cameraRotation} />
            <color attach="background" args={['#87ceeb']} />
            {gridEnabled && <gridHelper args={[100, 100]} />}
            <ambientLight intensity={0.5} />
            <directionalLight position={[10, 10, 5]} intensity={1} />
            <Basic />
            <OrbitControls makeDefault enableDamping dampingFactor={0.45} onChange={onOrbitChange} />
        </Canvas>
        </>
    );
}

export default function TotalScene() {
    return (
        <div id="canvas-container" className="w-[100vw] h-[100vh]">
            <Scene />
        </div>
    )
}